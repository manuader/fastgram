/**
 * Instagram por **Business Discovery**, la vía oficial — `PU-SCRAPE-002`,
 * PRD `FR-011.4` (fila B), `D-13`, `PLAN-USO-PERSONAL.md` §6.
 *
 * Documentación verificada el 2026-09-24:
 * https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery
 *
 *  - Request: `GET https://graph.facebook.com/<VERSION>/<IG_USER_ID>?fields=business_discovery.username(<USERNAME>){<FIELDS>}`.
 *  - Token: **User access token de Facebook Login** con `instagram_basic`,
 *    `instagram_manage_insights` y `pages_read_engagement` (más `ads_management`
 *    o `ads_read` si el rol de la página vino por Business Manager).
 *    **No sirve el token de Instagram Login** (`graph.instagram.com`), que es el
 *    que guarda hoy la conexión de Instagram de este repo (`oauth/meta.ts`).
 *  - Sólo cuentas **Business o Creator**; las age-gated no devuelven nada.
 *  - Campos públicos del IG User (referencia de IG User): `username`,
 *    `biography`, `website`, `followers_count`, `media_count`. `name` y
 *    `profile_picture_url` **no** están marcados como públicos, así que no se
 *    piden: pedir un campo no público de otra cuenta es un error, no un vacío.
 *  - Campos del IG Media: `id`, `comments_count`, `like_count`, `media_type`,
 *    `permalink`, `timestamp` son públicos; `caption` está «available for
 *    Instagram API with Facebook Login only», que es justo este caso.
 *
 * ## Tier `B_public_api`
 *
 * Es la API oficial leyendo datos **públicos** de otra cuenta: la fila B de
 * `FR-011.4`. Por eso, cuando está configurado, va **antes** que el scraper
 * anónimo (tier C) en {@link LadderSocialReader}: el orden B → C es normativo.
 *
 * ## Errores de la Graph API
 *
 * Los códigos `4`, `17`, `32` y `613` son los de límite de uso; `190` es token
 * inválido o vencido. Cualquier otro 4xx sobre `business_discovery` se lee como
 * «esta cuenta no califica» (no es Business/Creator, no existe o es age-gated):
 * `not_found` **de este tier**, y la escalera sigue con el scraper.
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
  hashtagsOf,
  isRecord,
  mentionsOf,
  newestFirst,
  opt,
  requestJson,
  retryAfterSeconds,
  text,
  trimBase,
  type SocialFetch,
} from "./http.js";

const SOURCE = "SocialReader/instagram-business-discovery";
const TIER = "B_public_api" as const;
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** Una credencial de Facebook Login con una cuenta de IG profesional vinculada. */
export interface BusinessDiscoveryCredentials {
  /** El IG User id **propio** (el que hace la consulta), no el de la marca leída. */
  readonly igUserId: string;
  readonly accessToken: string;
}

export interface InstagramBusinessDiscoveryReaderConfig {
  /**
   * De dónde sale la credencial. `null` ⇒ no hay: el adaptador devuelve
   * `extractor_unavailable` y la escalera sigue. Se pide en cada lectura para
   * que un token renovado se use sin reiniciar.
   */
  readonly credentials: () => Promise<BusinessDiscoveryCredentials | null>;
  /** Default `https://graph.facebook.com`. */
  readonly graphBaseUrl?: string;
  /** Default `v26.0`, la misma que usan los publicadores de Meta del repo. */
  readonly apiVersion?: string;
  readonly timeoutMs?: number;
  /** Default 24 (`AI-016`). */
  readonly contentLimit?: number;
  readonly fetch?: SocialFetch;
  readonly memoTtlMs?: number;
  readonly now?: () => number;
}

const KIND: Readonly<Record<string, SocialContentKind>> = {
  IMAGE: "image",
  CAROUSEL_ALBUM: "carousel",
  VIDEO: "video",
};

/** Exportada para los tests. */
export function businessDiscoveryFields(handle: string, limit: number): string {
  return (
    `business_discovery.username(${handle})` +
    `{username,biography,website,followers_count,media_count,` +
    `media.limit(${String(limit)}){id,caption,comments_count,like_count,media_type,permalink,timestamp}}`
  );
}

/** El `business_discovery` de la respuesta, a perfil + ítems. */
export function parseBusinessDiscovery(json: unknown): {
  readonly profile: SocialProfileSignals;
  readonly items: SocialContentItem[];
} | null {
  if (!isRecord(json) || !isRecord(json["business_discovery"])) return null;
  const bd = json["business_discovery"];
  const username = text(bd["username"]);
  if (username === undefined) return null;
  const website = text(bd["website"]);
  const profile: SocialProfileSignals = {
    handle: username,
    ...opt("bio", text(bd["biography"])),
    ...(website === undefined ? {} : { links: [website] }),
    ...opt("followerCount", count(bd["followers_count"])),
  };
  const media =
    isRecord(bd["media"]) && Array.isArray(bd["media"]["data"])
      ? bd["media"]["data"]
      : [];
  const items: SocialContentItem[] = [];
  for (const m of media) {
    if (!isRecord(m)) continue;
    const id = text(m["id"]);
    if (id === undefined) continue;
    const caption = text(m["caption"]);
    const postedAt = date(m["timestamp"]);
    items.push({
      externalId: id,
      kind: KIND[String(m["media_type"])] ?? "other",
      ...opt("permalink", text(m["permalink"])),
      ...opt("caption", caption),
      hashtags: hashtagsOf(caption),
      mentions: mentionsOf(caption),
      ...opt("postedAt", postedAt),
      engagement: {
        ...opt("likes", count(m["like_count"])),
        ...opt("comments", count(m["comments_count"])),
      },
      mediaUrls: [],
    });
  }
  return { profile, items: newestFirst(items) };
}

export class InstagramBusinessDiscoveryReader extends BundleSocialReader {
  readonly source = "instagram" as const;
  protected readonly platform = "instagram" as const;
  protected readonly errorSource = SOURCE;
  readonly #config: InstagramBusinessDiscoveryReaderConfig;
  readonly #fetch: SocialFetch;

  constructor(config: InstagramBusinessDiscoveryReaderConfig) {
    super({
      contentLimit: Math.min(config.contentLimit ?? 24, 24),
      ...opt("memoTtlMs", config.memoTtlMs),
      ...opt("now", config.now),
    });
    this.#config = config;
    this.#fetch = config.fetch ?? ((url, init) => fetch(url, init));
  }

  capabilities(): SocialReadCapabilities {
    return {
      source: "instagram",
      tiers: [TIER],
      profileSignals: ["handle", "bio", "links", "followerCount"],
      contentSignals: [
        "externalId",
        "kind",
        "permalink",
        "caption",
        "hashtags",
        "mentions",
        "postedAt",
        "engagement",
      ],
      maxContentItems: this.contentLimit,
      requiresConnection: false,
      renderedFetchEnabled: false,
    };
  }

  protected canonicalUrl(handle: string): string {
    return `https://instagram.com/${handle}`;
  }

  protected async fetchBundle(handle: string, limit: number): Promise<BundleOutcome> {
    const creds = await this.#config.credentials();
    if (creds === null)
      return { status: "extractor_unavailable", attemptedTiers: [TIER] };

    const base = trimBase(this.#config.graphBaseUrl ?? "https://graph.facebook.com");
    const version = this.#config.apiVersion ?? "v26.0";
    const url =
      `${base}/${version}/${encodeURIComponent(creds.igUserId)}?` +
      new URLSearchParams({
        fields: businessDiscoveryFields(handle, limit),
        // En la query, como en los GET de Facebook Reels del repo y en el
        // ejemplo de la doc. **Esta URL no se loguea nunca**: lleva el token.
        access_token: creds.accessToken,
      }).toString();
    const res = await requestJson(this.#fetch, url, {
      source: SOURCE,
      timeoutMs: this.#config.timeoutMs ?? 20_000,
    });

    if (res.status === 200) {
      const parsed = parseBusinessDiscovery(res.json);
      if (parsed === null) {
        throw new PortError(
          "provider_contract_violation",
          "Business Discovery answered with an unexpected shape.",
          { source: SOURCE },
        );
      }
      if (parsed.profile.bio === undefined && parsed.items.length === 0) {
        return { status: "insufficient_content", attemptedTiers: [TIER] };
      }
      return {
        status: "ok",
        tier: TIER,
        data: { profile: parsed.profile, items: parsed.items, itemsFailed: false },
      };
    }

    const error =
      isRecord(res.json) && isRecord(res.json["error"]) ? res.json["error"] : {};
    const code = typeof error["code"] === "number" ? error["code"] : undefined;
    if (code !== undefined && RATE_LIMIT_CODES.has(code)) {
      const after = retryAfterSeconds(res.headers);
      throw new PortError(
        "rate_limited",
        "The Instagram API is rate limiting this app.",
        {
          source: SOURCE,
          ...opt("retryAfterSeconds", after),
        },
      );
    }
    if (code === 190 || res.status === 401) {
      // Token vencido o revocado: no es de la cuenta leída. La escalera sigue
      // con el scraper; el log dice qué pasó.
      return { status: "extractor_unavailable", attemptedTiers: [TIER] };
    }
    if (res.status >= 500) {
      throw new PortError("provider_unavailable", "The Instagram API isn't responding.", {
        source: SOURCE,
        cause: { status: res.status, code },
      });
    }
    // 4xx sobre la cuenta leída: no es Business/Creator, no existe o es
    // age-gated. Para este tier, no hay nada que leer.
    return { status: "not_found", attemptedTiers: [TIER] };
  }
}
