/**
 * `AdsPlatform` sobre la Marketing API de Meta — sprint 9 (R), `D-21`.
 * `fetch` directo, sin SDK (como los publicadores).
 *
 * Cada llamada cita la referencia de la que sale (consultadas el 2026-09-28;
 * los ejemplos de la doc usan **v25.0**, la misma versión por defecto que el
 * OAuth de Meta del repo — `oauth/meta.ts`). Lo que la doc no confirmó en esas
 * lecturas está marcado **[sin verificar]** en el comentario de la llamada.
 *
 * ## `PAUSED` no es un parámetro
 *
 * `createCampaign`, `createAdSet` y `createAd` mandan `status=PAUSED` escrito
 * acá. El puerto no tiene por dónde pedir otro estado (`D-21`).
 *
 * ## Cómo viaja el token
 *
 * Como en los ejemplos `curl -F … -F 'access_token=<ACCESS_TOKEN>'` de la
 * referencia de Ad: cuerpo `application/x-www-form-urlencoded` en los POST y
 * `access_token` en la query de los GET. Los objetos (targeting, creative,
 * object_story_spec, cells) van como JSON dentro del campo, igual que en la
 * doc (`creative={"creative_id": "<CREATIVE_ID>"}`).
 */
import {
  AdsPlatformError,
  type AdAccountSummary,
  type AdInsightRow,
  type AdInsightsQuery,
  type AdObjective,
  type AdPageSummary,
  type AdRunStatus,
  type AdsAuth,
  type AdsPlatform,
  type CreateAdInput,
  type CreateAdSetInput,
  type CreateCampaignInput,
  type CreateCreativeInput,
  type CreateSplitTestInput,
} from "@fastgram/ports";

import { call, type PublisherFetch } from "../../publishers/shared/http.js";
import { adsError, classifyAdsError } from "./meta-ads-errors.js";

export interface MetaAdsConfig {
  /** Default `globalThis.fetch`, resuelto en cada llamada. */
  readonly fetch?: PublisherFetch;
  /** Default `v25.0`. */
  readonly graphVersion?: string;
  /** Default `https://graph.facebook.com`. */
  readonly host?: string;
  readonly timeoutMs?: number;
  /** Tope de páginas de insights por consulta. */
  readonly maxInsightPages?: number;
}

export const META_ADS_DEFAULT_GRAPH_VERSION = "v25.0";
const SOURCE = "AdsPlatform/meta";

/**
 * Evento de cobro y objetivo de optimización por objetivo de campaña. La doc
 * de Ad Set lista los valores (`IMPRESSIONS`, `LINK_CLICKS`, `REACH`,
 * `POST_ENGAGEMENT`…) y exige los dos campos, pero **no** confirmamos en ella
 * qué combinación acepta cada objetivo ODAX: **[sin verificar]**, la elegimos
 * conservadora (cobro por impresión, que es el mínimo más bajo que publica la
 * doc: US$0,50 diario).
 */
const DELIVERY: Readonly<
  Partial<
    Record<AdObjective, { readonly billing: string; readonly optimization: string }>
  >
> = {
  OUTCOME_AWARENESS: { billing: "IMPRESSIONS", optimization: "REACH" },
  OUTCOME_TRAFFIC: { billing: "IMPRESSIONS", optimization: "LINK_CLICKS" },
  OUTCOME_ENGAGEMENT: { billing: "IMPRESSIONS", optimization: "POST_ENGAGEMENT" },
};

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null;
const str = (o: Json, k: string): string | undefined =>
  typeof o[k] === "string" ? o[k] : typeof o[k] === "number" ? String(o[k]) : undefined;

/** Número de un campo de insights: la doc los devuelve como string numérico. */
function numeric(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/u.test(v.trim())) return Number(v);
  return null;
}

const OFFSET_ONE = new Set([
  "CLP",
  "COP",
  "CRC",
  "HUF",
  "ISK",
  "IDR",
  "JPY",
  "KRW",
  "PYG",
  "TWD",
  "VND",
]);
/** Ver `core/ads/money.ts` (misma tabla: el adaptador no importa `core`). */
const toMinor = (major: number, currency: string): number =>
  Math.round(major * (OFFSET_ONE.has(currency.toUpperCase()) ? 1 : 100));

/** `[{action_type, value}]` → `{type: número}` (sumado si se repite). */
function actionMap(v: unknown, convert: (n: number) => number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(v)) return out;
  for (const item of v as unknown[]) {
    if (!isObj(item)) continue;
    const type = str(item, "action_type");
    const value = numeric(item["value"]);
    if (type === undefined || value === null) continue;
    out[type] = (out[type] ?? 0) + convert(value);
  }
  return out;
}

export class MetaAdsPlatform implements AdsPlatform {
  readonly #fetch: PublisherFetch;
  readonly #base: string;
  readonly #timeoutMs: number;
  readonly #maxPages: number;

  constructor(config: MetaAdsConfig = {}) {
    this.#fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const host = (config.host ?? "https://graph.facebook.com").replace(/\/+$/u, "");
    this.#base = `${host}/${config.graphVersion ?? META_ADS_DEFAULT_GRAPH_VERSION}`;
    this.#timeoutMs = config.timeoutMs ?? 20_000;
    this.#maxPages = config.maxInsightPages ?? 20;
  }

  /* ---------------------------------------------------------------- *
   * HTTP
   * ---------------------------------------------------------------- */

  async #get(path: string, token: string, params: Record<string, string>): Promise<Json> {
    const query = new URLSearchParams({ ...params, access_token: token });
    return this.#send(`${this.#base}${path}?${query.toString()}`, "GET");
  }

  async #post(
    path: string,
    token: string,
    params: Record<string, string>,
  ): Promise<Json> {
    const body = new URLSearchParams({ ...params, access_token: token }).toString();
    return this.#send(`${this.#base}${path}`, "POST", body);
  }

  async #send(url: string, method: "GET" | "POST", body?: string): Promise<Json> {
    let result;
    try {
      result = await call(
        this.#fetch,
        url,
        {
          method,
          ...(body === undefined
            ? {}
            : {
                body,
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
              }),
        },
        // Todo es `prepare`: crear en PAUSED o leer no publica ni gasta.
        { source: SOURCE, phase: "prepare", timeoutMs: this.#timeoutMs },
      );
    } catch (e: unknown) {
      // Timeout o sin red: el `PortError` del transporte, como motivo estable.
      throw adsError("provider_unavailable", SOURCE, e);
    }
    if (result.status >= 200 && result.status < 300) {
      if (!isObj(result.json)) throw adsError("unexpected_response", SOURCE);
      return result.json;
    }
    throw classifyAdsError(result, SOURCE);
  }

  #id(json: Json, what: string): string {
    const id = str(json, "id");
    if (id === undefined)
      throw adsError("unexpected_response", SOURCE, { missing: what });
    return id;
  }

  /* ---------------------------------------------------------------- *
   * Conexión
   * ---------------------------------------------------------------- */

  /**
   * `GET /me/adaccounts` — https://developers.facebook.com/docs/marketing-api/reference/ad-account
   * (`id` con `act_`, `name`, `currency`, `timezone_name`, `account_status`).
   */
  async listAdAccounts(accessToken: string): Promise<readonly AdAccountSummary[]> {
    const json = await this.#get("/me/adaccounts", accessToken, {
      fields: "id,name,currency,timezone_name,account_status",
      limit: "100",
    });
    const data = Array.isArray(json["data"]) ? (json["data"] as unknown[]) : null;
    if (data === null) throw adsError("unexpected_response", SOURCE, { missing: "data" });
    const out: AdAccountSummary[] = [];
    for (const item of data) {
      if (!isObj(item)) continue;
      const id = str(item, "id");
      const currency = str(item, "currency");
      if (id === undefined || currency === undefined) continue;
      out.push({
        id: id.startsWith("act_") ? id : `act_${id}`,
        name: str(item, "name") ?? id,
        currency,
        timezoneName: str(item, "timezone_name") ?? null,
        accountStatus: numeric(item["account_status"]) ?? 0,
      });
    }
    return out;
  }

  /**
   * `GET /me/accounts` con `instagram_business_account{id,username}` —
   * https://developers.facebook.com/docs/graph-api/reference/user/accounts/ .
   * Que ese id sea el que `object_story_spec.instagram_user_id` espera
   * (*"The Instagram user account that the ad will be posted to"*) es
   * **[sin verificar]**: se confirma con la primera cuenta real.
   */
  async listPages(accessToken: string): Promise<readonly AdPageSummary[]> {
    const json = await this.#get("/me/accounts", accessToken, {
      fields: "id,name,instagram_business_account{id,username}",
      limit: "100",
    });
    const data = Array.isArray(json["data"]) ? (json["data"] as unknown[]) : null;
    if (data === null) throw adsError("unexpected_response", SOURCE, { missing: "data" });
    const out: AdPageSummary[] = [];
    for (const item of data) {
      if (!isObj(item)) continue;
      const id = str(item, "id");
      if (id === undefined) continue;
      const ig = isObj(item["instagram_business_account"])
        ? item["instagram_business_account"]
        : null;
      out.push({
        id,
        name: str(item, "name") ?? id,
        instagramUserId: ig === null ? null : (str(ig, "id") ?? null),
        instagramUsername: ig === null ? null : (str(ig, "username") ?? null),
      });
    }
    return out;
  }

  async whoAmI(accessToken: string): Promise<{ id: string; name: string }> {
    const json = await this.#get("/me", accessToken, { fields: "id,name" });
    return { id: this.#id(json, "me.id"), name: str(json, "name") ?? "" };
  }

  /* ---------------------------------------------------------------- *
   * Crear — siempre PAUSED
   * ---------------------------------------------------------------- */

  /**
   * `POST /act_{id}/campaigns` —
   * https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group
   * `special_ad_categories` es obligatorio (`[]` si no aplica). Sin
   * presupuesto de campaña ni `spend_cap` (ver `core/ads/caps.ts`): el
   * presupuesto va en los conjuntos. `is_adset_budget_sharing_enabled=false`
   * para que el diario de cada variante del A/B sea el suyo.
   */
  async createCampaign(
    auth: AdsAuth,
    input: CreateCampaignInput,
  ): Promise<{ id: string }> {
    const json = await this.#post(`/${auth.adAccountId}/campaigns`, auth.accessToken, {
      name: input.name,
      objective: input.objective,
      status: "PAUSED",
      special_ad_categories: "[]",
      is_adset_budget_sharing_enabled: "false",
    });
    return { id: this.#id(json, "campaign.id") };
  }

  /**
   * `POST /act_{id}/adsets` —
   * https://developers.facebook.com/docs/marketing-api/reference/ad-campaign
   * `daily_budget` en unidades mínimas; `targeting.geo_locations.countries`
   * obligatorio; `age_min`/`age_max`; intereses en `flexible_spec`.
   */
  async createAdSet(auth: AdsAuth, input: CreateAdSetInput): Promise<{ id: string }> {
    const delivery = DELIVERY[input.objective];
    if (delivery === undefined)
      throw adsError("invalid_parameter", SOURCE, {
        unsupportedObjective: input.objective,
      });
    const targeting: Json = {
      geo_locations: { countries: [...input.targeting.countries] },
    };
    if (input.targeting.ageMin !== undefined)
      targeting["age_min"] = input.targeting.ageMin;
    if (input.targeting.ageMax !== undefined)
      targeting["age_max"] = input.targeting.ageMax;
    if (
      input.targeting.interestIds !== undefined &&
      input.targeting.interestIds.length > 0
    )
      targeting["flexible_spec"] = [
        { interests: input.targeting.interestIds.map((id) => ({ id })) },
      ];
    const params: Record<string, string> = {
      name: input.name,
      campaign_id: input.campaignId,
      daily_budget: String(input.dailyBudgetMinor),
      billing_event: delivery.billing,
      optimization_goal: delivery.optimization,
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      targeting: JSON.stringify(targeting),
      status: "PAUSED",
    };
    if (input.endTime !== undefined) params["end_time"] = input.endTime.toISOString();
    const json = await this.#post(
      `/${auth.adAccountId}/adsets`,
      auth.accessToken,
      params,
    );
    return { id: this.#id(json, "adset.id") };
  }

  /**
   * `POST /act_{id}/advideos` con `file_url` —
   * https://developers.facebook.com/docs/marketing-api/reference/ad-account/advideos
   * (devuelve `id`). Meta baja el archivo de la URL pública del túnel. El
   * estado de procesamiento no se consulta acá: **[sin verificar]** si crear
   * el creativo antes de que termine falla (la referencia no documenta el
   * campo de estado).
   */
  async uploadVideo(
    auth: AdsAuth,
    input: { readonly fileUrl: string; readonly name: string },
  ): Promise<{ videoId: string }> {
    const json = await this.#post(`/${auth.adAccountId}/advideos`, auth.accessToken, {
      file_url: input.fileUrl,
      name: input.name,
    });
    const id = str(json, "id") ?? str(json, "video_id");
    if (id === undefined)
      throw adsError("unexpected_response", SOURCE, { missing: "id" });
    return { videoId: id };
  }

  /**
   * `POST /act_{id}/adimages` con `bytes` (base64) —
   * https://developers.facebook.com/docs/marketing-api/reference/ad-account/adimages
   * No hay parámetro de URL. Respuesta `{"images": {"<nombre>": {"hash", "url"}}}`.
   */
  async uploadImage(
    auth: AdsAuth,
    input: { readonly bytes: Uint8Array; readonly filename: string },
  ): Promise<{ imageHash: string }> {
    const json = await this.#post(`/${auth.adAccountId}/adimages`, auth.accessToken, {
      bytes: Buffer.from(input.bytes).toString("base64"),
      name: input.filename,
    });
    const images = isObj(json["images"]) ? json["images"] : null;
    const first = images === null ? undefined : Object.values(images)[0];
    const hash = isObj(first) ? str(first, "hash") : undefined;
    if (hash === undefined)
      throw adsError("unexpected_response", SOURCE, { missing: "hash" });
    return { imageHash: hash };
  }

  /**
   * `POST /act_{id}/adcreatives` con `object_story_spec` —
   * https://developers.facebook.com/docs/marketing-api/reference/ad-creative-object-story-spec
   * (`page_id`, `instagram_user_id`, `video_data`, `link_data`) y
   * https://developers.facebook.com/docs/marketing-api/reference/ad-creative-video-data
   * (`video_id`, `image_url` de miniatura, `message`, `title`,
   * `call_to_action`). Para imagen, `link_data` con `image_hash`, `link` y
   * `message`.
   */
  async createCreative(
    auth: AdsAuth,
    input: CreateCreativeInput,
  ): Promise<{ id: string }> {
    const spec: Json = { page_id: input.pageId };
    if (input.instagramUserId !== undefined)
      spec["instagram_user_id"] = input.instagramUserId;
    const cta =
      input.link === undefined
        ? undefined
        : { type: "LEARN_MORE", value: { link: input.link } };
    if (input.media.kind === "video") {
      const video: Json = { video_id: input.media.videoId, message: input.message };
      if (input.media.thumbnailUrl !== undefined)
        video["image_url"] = input.media.thumbnailUrl;
      if (input.title !== undefined) video["title"] = input.title;
      if (cta !== undefined) video["call_to_action"] = cta;
      spec["video_data"] = video;
    } else {
      if (input.link === undefined)
        throw adsError("invalid_parameter", SOURCE, {
          missing: "link for image creative",
        });
      spec["link_data"] = {
        image_hash: input.media.imageHash,
        link: input.link,
        message: input.message,
        ...(input.title === undefined ? {} : { name: input.title }),
        ...(cta === undefined ? {} : { call_to_action: cta }),
      };
    }
    const json = await this.#post(`/${auth.adAccountId}/adcreatives`, auth.accessToken, {
      name: input.name,
      object_story_spec: JSON.stringify(spec),
    });
    return { id: this.#id(json, "creative.id") };
  }

  /**
   * `POST /act_{id}/ads` — https://developers.facebook.com/docs/marketing-api/reference/adgroup
   * (`name`, `adset_id`, `creative={"creative_id": …}`, `status`).
   */
  async createAd(auth: AdsAuth, input: CreateAdInput): Promise<{ id: string }> {
    const json = await this.#post(`/${auth.adAccountId}/ads`, auth.accessToken, {
      name: input.name,
      adset_id: input.adSetId,
      creative: JSON.stringify({ creative_id: input.creativeId }),
      status: "PAUSED",
    });
    return { id: this.#id(json, "ad.id") };
  }

  /**
   * `POST /{user_id|business_id}/ad_studies`, `type=SPLIT_TEST` —
   * https://developers.facebook.com/docs/marketing-api/guides/split-testing y
   * https://developers.facebook.com/docs/marketing-api/reference/ad-study
   * (`cells` con `name`, `treatment_percentage` y `adsets`; tiempos en unix).
   */
  async createSplitTest(
    auth: AdsAuth,
    input: CreateSplitTestInput,
  ): Promise<{ id: string }> {
    const json = await this.#post(`/${input.ownerId}/ad_studies`, auth.accessToken, {
      name: input.name,
      type: "SPLIT_TEST",
      start_time: String(Math.floor(input.startTime.getTime() / 1000)),
      end_time: String(Math.floor(input.endTime.getTime() / 1000)),
      cells: JSON.stringify(
        input.cells.map((c) => ({
          name: c.name,
          treatment_percentage: c.treatmentPercentage,
          adsets: [...c.adSetIds],
        })),
      ),
    });
    return { id: this.#id(json, "ad_study.id") };
  }

  /* ---------------------------------------------------------------- *
   * Operar
   * ---------------------------------------------------------------- */

  /** `POST /{id}` con `status` — referencia de Ad ("Updating an Ad"), igual en campaña y conjunto. */
  async setStatus(auth: AdsAuth, objectId: string, status: AdRunStatus): Promise<void> {
    await this.#post(`/${objectId}`, auth.accessToken, { status });
  }

  /** `POST /{adset_id}` con `daily_budget`. Meta permite 4 cambios por hora por conjunto. */
  async updateAdSetDailyBudget(
    auth: AdsAuth,
    adSetId: string,
    dailyBudgetMinor: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(dailyBudgetMinor) || dailyBudgetMinor <= 0)
      throw adsError("invalid_parameter", SOURCE, { dailyBudgetMinor });
    await this.#post(`/${adSetId}`, auth.accessToken, {
      daily_budget: String(dailyBudgetMinor),
    });
  }

  /**
   * `GET /{campaign_id}/insights` con `level=ad`, `time_increment=1` y
   * `time_range={"since","until"}` —
   * https://developers.facebook.com/docs/marketing-api/reference/ad-account/insights
   * Las métricas vienen como **strings numéricos**; `spend` y
   * `action_values` en unidades mayores de la moneda de la cuenta. Sigue
   * `paging.next` hasta {@link MetaAdsConfig.maxInsightPages}.
   */
  async getInsights(
    auth: AdsAuth,
    query: AdInsightsQuery,
  ): Promise<readonly AdInsightRow[]> {
    const out: AdInsightRow[] = [];
    let json = await this.#get(`/${query.campaignId}/insights`, auth.accessToken, {
      level: "ad",
      time_increment: "1",
      time_range: JSON.stringify({ since: query.since, until: query.until }),
      fields: "ad_id,spend,impressions,clicks,reach,actions,action_values",
      limit: "100",
    });
    for (let page = 0; page < this.#maxPages; page++) {
      const data = Array.isArray(json["data"]) ? (json["data"] as unknown[]) : null;
      if (data === null)
        throw adsError("unexpected_response", SOURCE, { missing: "data" });
      for (const item of data) {
        if (!isObj(item)) continue;
        const adId = str(item, "ad_id");
        const date = str(item, "date_start");
        const spend = numeric(item["spend"]);
        if (adId === undefined || date === undefined || spend === null) continue;
        out.push({
          adId,
          date,
          spendMinor: toMinor(spend, query.currency),
          impressions: numeric(item["impressions"]) ?? 0,
          clicks: numeric(item["clicks"]) ?? 0,
          reach: numeric(item["reach"]),
          actions: actionMap(item["actions"], (n) => n),
          actionValuesMinor: actionMap(item["action_values"], (n) =>
            toMinor(n, query.currency),
          ),
        });
      }
      const paging = isObj(json["paging"]) ? json["paging"] : null;
      const next = paging === null ? undefined : str(paging, "next");
      if (next === undefined) return out;
      // `next` es una URL absoluta de Meta que ya trae el token: se sigue tal cual,
      // pero sólo si es del mismo host (no mandamos el token a otro lado).
      if (!next.startsWith(this.#base.slice(0, this.#base.lastIndexOf("/"))))
        throw adsError("unexpected_response", SOURCE, { foreignPaging: true });
      json = await this.#send(next, "GET");
    }
    return out;
  }
}

export function isMetaAdsError(e: unknown): e is AdsPlatformError {
  return e instanceof AdsPlatformError && e.source === SOURCE;
}
