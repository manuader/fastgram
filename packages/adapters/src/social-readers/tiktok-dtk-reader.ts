/**
 * TikTok por el contenedor de Evil0ctal («DTK») — `PU-SCRAPE-001`, PRD
 * `FR-011.3`, `D-13`, `PLAN-USO-PERSONAL.md` §6.1.
 *
 * **Versión auditada**: commit `737bf3d` = tag `v5.1.1` más un commit que sólo
 * agrega `.github/RELEASE_v5.1.1.md` (comparado con la API de GitHub el
 * 2026-09-24). Imagen publicada: `evil0ctal/douyin_tiktok_download_api`, tag
 * `5.1.1` o, fijado a esa build, `sha-d21b92ec28e481795f4c8530ee6dc0f7d40da69d`.
 *
 * ## El contrato, tal como lo documenta el repo en ese commit
 *
 * Fuente: `documents/en/11-api.md` y `src/dtk/api/routes/content.py`.
 *
 *  - `GET /api/v1/tiktok/user?url=<perfil>` → el autor. `GET
 *    /api/v1/tiktok/user/posts?sec_user_id=<secUid>&count=<n>` → una página de
 *    posts, «newest first». TikTok rechaza `count` > 35.
 *  - Autenticación con API key: `X-API-Key: <key>` (o `Authorization: Bearer`).
 *    Toda ruta la exige salvo que el operador la abra.
 *  - Las rutas de datos son **asíncronas**: `202` con un task id. Con
 *    `?wait=<s>` (techo por defecto 30) la conexión espera: `200` con el
 *    resultado, o `202` si no terminó, «which is not an error and loses
 *    nothing».
 *  - Sobre: `{success, data, error: {code, message, retry_after?}, meta}`.
 *    «Branch on `error.code`, never on `error.message`».
 *  - Forma de `data` (`src/dtk/models/content.py`): `Author {uid, sec_uid,
 *    unique_id, nickname, signature, avatar{url}, web_url, verified,
 *    stats{follower_count, following_count, content_count, total_digg}}` y
 *    `Page {items: Content[], cursor, has_more}` con `Content {content_id,
 *    kind: video|image_album|live, web_url, title, description, created_at,
 *    stats{play_count, digg_count, comment_count, share_count}, media{covers,
 *    video, images}, music{music_id,…}, tags[]}`.
 *
 * Sin login (`D-13`): el contenedor usa **identidades de invitado** que acuña
 * un navegador headless propio. Nunca se le importa una cookie logueada.
 *
 * ## Tier `C_page_fetch`
 *
 * Es un scraper de la web de TikTok (firma sus pedidos como el navegador), no
 * la API oficial: fila C de `FR-011.4`. Montarlo —configurar su URL— es
 * activar el tier C para TikTok, que `D-13` levanta para uso personal.
 */
import {
  PortError,
  type SocialContentItem,
  type SocialContentKind,
  type SocialProfileSignals,
  type SocialReadCapabilities,
} from "@fastgram/ports";

import { BundleSocialReader, type BundleOutcome } from "./bundle-reader.js";
import {
  count,
  date,
  isRecord,
  newestFirst,
  opt,
  requestJson,
  retryAfterSeconds,
  text,
  trimBase,
  type HttpResult,
  type SocialFetch,
} from "./http.js";

const SOURCE = "SocialReader/tiktok-dtk";
const TIER = "C_page_fetch" as const;

/** «TikTok refuses more than 35» (`COUNT_QUERY` en `content.py`). */
export const TIKTOK_MAX_PAGE = 35;

/** Códigos del sobre que se resuelven solos (`11-api.md`, «Back off and retry»). */
const BACK_OFF = new Set([
  "RATE_LIMITED",
  "QUEUE_FULL",
  "IDENTITY_POOL_EXHAUSTED",
  "ENDPOINT_CIRCUIT_OPEN",
  "UPSTREAM_RISK_CONTROL",
]);
const TRANSIENT = new Set(["SIGNING_FAILED", "INTERNAL", "DOWNLOADER_UNAVAILABLE"]);
/** Problemas de **nuestra** configuración del contenedor, no de TikTok. */
const MISCONFIGURED = new Set(["UNAUTHENTICATED", "FORBIDDEN_SCOPE", "NOT_CONFIGURED"]);

export interface TikTokDtkReaderConfig {
  /** `TIKTOK_EXTRACTOR_URL`. Sin default: sin URL no se monta. */
  readonly baseUrl: string;
  /** API key del contenedor (consola → API keys). Sólo lectura (`tiktok:read`). */
  readonly apiKey?: string;
  /** Segundos de `?wait=`. Default 25, bajo el techo de 30 del contenedor. */
  readonly waitSeconds?: number;
  readonly timeoutMs?: number;
  /** Default 24 (`AI-016`). Techo {@link TIKTOK_MAX_PAGE}. */
  readonly contentLimit?: number;
  readonly fetch?: SocialFetch;
  readonly memoTtlMs?: number;
  readonly now?: () => number;
}

const KIND: Readonly<Record<string, SocialContentKind>> = {
  video: "video",
  image_album: "carousel",
  live: "other",
};

type Envelope =
  | { readonly kind: "data"; readonly data: unknown }
  | { readonly kind: "pending" }
  | {
      readonly kind: "error";
      readonly code: string;
      /** `error.retry_after` o el header `Retry-After`, en segundos. */
      readonly retryAfter: number | undefined;
      readonly status: number;
    };

function envelope(res: HttpResult): Envelope {
  const body = isRecord(res.json) ? res.json : {};
  if (res.status === 202) return { kind: "pending" };
  if (res.status === 200 && body["success"] === true) {
    return { kind: "data", data: body["data"] };
  }
  const error = isRecord(body["error"]) ? body["error"] : {};
  return {
    kind: "error",
    code:
      typeof error["code"] === "string" ? error["code"] : `HTTP_${String(res.status)}`,
    retryAfter: retryAfterSeconds(res.headers, error["retry_after"]),
    status: res.status,
  };
}

/** Un `Author` del contenedor, a señales de perfil. Exportada para los tests. */
export function parseTikTokAuthor(data: unknown): {
  readonly profile: SocialProfileSignals;
  readonly secUid: string | undefined;
} | null {
  if (!isRecord(data)) return null;
  const nickname = text(data["nickname"]);
  const uniqueId = text(data["unique_id"]);
  if (nickname === undefined && uniqueId === undefined) return null;
  const stats = isRecord(data["stats"]) ? data["stats"] : {};
  const avatar = isRecord(data["avatar"]) ? text(data["avatar"]["url"]) : undefined;
  const followers = count(stats["follower_count"]);
  const following = count(stats["following_count"]);
  const likes = count(stats["total_digg"]);
  return {
    profile: {
      ...opt("handle", uniqueId),
      ...opt("displayName", nickname),
      ...opt("bio", text(data["signature"])),
      ...opt("avatarUrl", avatar),
      ...opt("followerCount", followers),
      ...opt("followingCount", following),
      ...opt("likeCount", likes),
    },
    secUid: text(data["sec_uid"]),
  };
}

/** Un `Page[Content]` del contenedor, a ítems. Exportada para los tests. */
export function parseTikTokPosts(data: unknown): SocialContentItem[] | null {
  if (!isRecord(data) || !Array.isArray(data["items"])) return null;
  const items: SocialContentItem[] = [];
  for (const raw of data["items"]) {
    if (!isRecord(raw)) continue;
    const id = text(raw["content_id"]);
    if (id === undefined) continue;
    const description = text(raw["description"]) ?? text(raw["title"]);
    const stats = isRecord(raw["stats"]) ? raw["stats"] : {};
    const media = isRecord(raw["media"]) ? raw["media"] : {};
    const covers = Array.isArray(media["covers"]) ? media["covers"] : [];
    const images = Array.isArray(media["images"]) ? media["images"] : [];
    const urls = [...images, ...covers.slice(0, 1)]
      .map((c) => (isRecord(c) ? text(c["url"]) : undefined))
      .filter((u): u is string => u !== undefined);
    const music = isRecord(raw["music"]) ? text(raw["music"]["music_id"]) : undefined;
    const postedAt = date(raw["created_at"]);
    const tags = Array.isArray(raw["tags"])
      ? raw["tags"].filter((t): t is string => typeof t === "string" && t !== "")
      : [];
    const likes = count(stats["digg_count"]);
    const comments = count(stats["comment_count"]);
    const views = count(stats["play_count"]);
    const shares = count(stats["share_count"]);
    items.push({
      externalId: id,
      kind: KIND[String(raw["kind"])] ?? "other",
      ...opt("permalink", text(raw["web_url"])),
      ...opt("caption", description),
      hashtags: tags,
      mentions: [],
      ...opt("postedAt", postedAt),
      engagement: {
        ...opt("likes", likes),
        ...opt("comments", comments),
        ...opt("views", views),
        ...opt("shares", shares),
      },
      mediaUrls: urls,
      ...opt("soundId", music),
    });
  }
  return newestFirst(items);
}

export class TikTokDtkReader extends BundleSocialReader {
  readonly source = "tiktok" as const;
  protected readonly platform = "tiktok" as const;
  protected readonly errorSource = SOURCE;
  readonly #base: string;
  readonly #config: TikTokDtkReaderConfig;
  readonly #fetch: SocialFetch;

  constructor(config: TikTokDtkReaderConfig) {
    super({
      contentLimit: Math.min(config.contentLimit ?? 24, TIKTOK_MAX_PAGE),
      ...opt("memoTtlMs", config.memoTtlMs),
      ...opt("now", config.now),
    });
    if (config.baseUrl.trim() === "") throw new Error("TikTokDtkReader: baseUrl vacío");
    this.#base = trimBase(config.baseUrl);
    this.#config = config;
    this.#fetch = config.fetch ?? ((url, init) => fetch(url, init));
  }

  capabilities(): SocialReadCapabilities {
    return {
      source: "tiktok",
      tiers: [TIER],
      profileSignals: [
        "handle",
        "displayName",
        "bio",
        "avatarUrl",
        "followerCount",
        "followingCount",
        "likeCount",
      ],
      contentSignals: [
        "externalId",
        "kind",
        "permalink",
        "caption",
        "hashtags",
        "postedAt",
        "engagement",
        "mediaUrls",
        "soundId",
      ],
      maxContentItems: this.contentLimit,
      requiresConnection: false,
      renderedFetchEnabled: true,
    };
  }

  protected canonicalUrl(handle: string): string {
    return `https://tiktok.com/@${handle}`;
  }

  #get(path: string, query: Record<string, string>): Promise<HttpResult> {
    const wait = this.#config.waitSeconds ?? 25;
    const qs = new URLSearchParams({ ...query, wait: String(wait) }).toString();
    return requestJson(this.#fetch, `${this.#base}${path}?${qs}`, {
      source: SOURCE,
      // El contenedor espera `wait` segundos; se le da margen para contestar.
      timeoutMs: this.#config.timeoutMs ?? (wait + 10) * 1000,
      headers:
        this.#config.apiKey === undefined || this.#config.apiKey === ""
          ? {}
          : { "x-api-key": this.#config.apiKey },
    });
  }

  /** Error del sobre → resultado del puerto o `PortError`. */
  #unavailable(e: Extract<Envelope, { kind: "error" }>): BundleOutcome {
    if (e.code === "CONTENT_PRIVATE")
      return { status: "private", attemptedTiers: [TIER] };
    if (e.code === "NOT_FOUND") return { status: "not_found", attemptedTiers: [TIER] };
    if (MISCONFIGURED.has(e.code)) {
      return { status: "extractor_unavailable", attemptedTiers: [TIER] };
    }
    throw this.#portError(e);
  }

  #portError(e: Extract<Envelope, { kind: "error" }>): PortError {
    if (BACK_OFF.has(e.code) || e.status === 429) {
      const after = e.retryAfter;
      return new PortError("rate_limited", "TikTok is limiting reads right now.", {
        source: SOURCE,
        cause: { code: e.code },
        ...opt("retryAfterSeconds", after),
      });
    }
    // Antes que el 5xx genérico: llega con 502 y reintentarlo no lo arregla.
    if (e.code === "UPSTREAM_CHANGED") {
      return new PortError(
        "provider_contract_violation",
        "The TikTok extractor no longer understands TikTok's answer.",
        { source: SOURCE, cause: { code: e.code } },
      );
    }
    if (TRANSIENT.has(e.code) || e.status >= 500) {
      return new PortError("provider_unavailable", "TikTok isn't responding right now.", {
        source: SOURCE,
        cause: { code: e.code, status: e.status },
      });
    }
    return new PortError("bad_request", "The TikTok extractor refused the request.", {
      source: SOURCE,
      cause: { code: e.code, status: e.status },
    });
  }

  protected async fetchBundle(handle: string, limit: number): Promise<BundleOutcome> {
    const profileUrl = `https://www.tiktok.com/@${handle}`;
    const who = envelope(await this.#get("/api/v1/tiktok/user", { url: profileUrl }));
    if (who.kind === "pending") {
      throw new PortError("timeout", "The TikTok extractor is still working on it.", {
        source: SOURCE,
      });
    }
    if (who.kind === "error") return this.#unavailable(who);
    const author = parseTikTokAuthor(who.data);
    if (author === null) {
      throw new PortError(
        "provider_contract_violation",
        "The TikTok extractor answered with an unexpected author shape.",
        { source: SOURCE },
      );
    }

    // Los posts pueden fallar sin perder el perfil: `partial` (`FR-011.8`).
    let items: SocialContentItem[] = [];
    let itemsFailed = false;
    try {
      const page = envelope(
        await this.#get(
          "/api/v1/tiktok/user/posts",
          author.secUid === undefined
            ? { url: profileUrl, count: String(limit) }
            : { sec_user_id: author.secUid, count: String(limit) },
        ),
      );
      if (page.kind === "data") {
        const parsed = parseTikTokPosts(page.data);
        if (parsed === null) itemsFailed = true;
        else items = parsed.slice(0, limit);
      } else if (page.kind === "error" && page.code === "CONTENT_PRIVATE") {
        return { status: "private", attemptedTiers: [TIER] };
      } else {
        itemsFailed = true;
      }
    } catch (error: unknown) {
      // Timeout o red caída en la segunda llamada: el perfil sirve igual.
      if (!(error instanceof PortError)) throw error;
      itemsFailed = true;
    }

    const p = author.profile;
    // Sin bio y con cero posts leídos de verdad: no hay de qué sacar una marca
    // (`ERR-B09`). Si los posts fallaron, en cambio, hay perfil y va `partial`.
    if (p.bio === undefined && items.length === 0 && !itemsFailed) {
      return { status: "insufficient_content", attemptedTiers: [TIER] };
    }
    return { status: "ok", tier: TIER, data: { profile: p, items, itemsFailed } };
  }
}
