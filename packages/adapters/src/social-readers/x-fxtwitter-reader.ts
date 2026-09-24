/**
 * X por FxTwitter, **sin login** — `PU-SCRAPE-001`, PRD `FR-011.3`, `D-13`.
 *
 * `D-13` (corregida 2026-09-24) descarta twscrape y cualquier cookie: en X sólo
 * vale lo que se pueda leer sin cuenta. La pregunta era si FxTwitter expone
 * perfil y bio, y **sí**: la especificación OpenAPI del propio proyecto
 * (`docs/specs/fxtwitter-openapi.json` en `github.com/FxEmbed/FxEmbed`, rama
 * `main` en el commit `c422d52`, leída el 2026-09-24; licencia MIT; servidor
 * `https://api.fxtwitter.com`) declara, sin autenticación:
 *
 *  - `GET /2/profile/{handle}` → `UserAPIResponse {code, message, user?,
 *    reason?}` con `APIUser {screen_name, name, description, location, url,
 *    protected, followers, following, statuses, media_count, likes, joined,
 *    website{url, display_url}|null, avatar_url, …}`. 404 = no existe o
 *    suspendido (`reason: "suspended"`).
 *  - `GET /2/profile/{handle}/statuses?count=1..100` → `APISearchResults
 *    {code, results: APITwitterStatus[], cursor{top, bottom}}` con `{id, url,
 *    text, created_at, created_timestamp, likes, reposts, quotes, replies,
 *    views?, media{photos[], videos[]}, reposted_by|null, …}`. 404 = no existe
 *    o timeline vacío.
 *
 * Es un servicio de un tercero que lee X por su cuenta: nosotros no mandamos
 * ninguna credencial, sólo el handle público. Tier **C** (`FR-011.4`, lectura
 * no oficial): montarlo —configurar `X_EXTRACTOR_URL`— es activar el tier C
 * para X, que `D-13` levanta para uso personal.
 *
 * Los reposts (`reposted_by` no nulo) **no** entran: son la voz de otro, y
 * meterlos como captions le diría a la síntesis que la marca habla así.
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
  type HttpResult,
  type SocialFetch,
} from "./http.js";

const SOURCE = "SocialReader/x-fxtwitter";
const TIER = "C_page_fetch" as const;

export interface XFxTwitterReaderConfig {
  /** `X_EXTRACTOR_URL`, p. ej. `https://api.fxtwitter.com`. Sin default. */
  readonly baseUrl: string;
  /** Se identifica quién pregunta. Default `FastGram/0 (personal brand analysis)`. */
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  /** Default 24 (`AI-016`). Techo 100 (el `maximum` del OpenAPI). */
  readonly contentLimit?: number;
  readonly fetch?: SocialFetch;
  readonly memoTtlMs?: number;
  readonly now?: () => number;
}

/** El `user` de `/2/profile/{handle}`. Exportada para los tests. */
export function parseFxUser(
  json: unknown,
): { readonly profile: SocialProfileSignals; readonly isProtected: boolean } | null {
  if (!isRecord(json) || !isRecord(json["user"])) return null;
  const u = json["user"];
  const screenName = text(u["screen_name"]);
  if (screenName === undefined) return null;
  const website = isRecord(u["website"]) ? text(u["website"]["url"]) : undefined;
  const followers = count(u["followers"]);
  const following = count(u["following"]);
  return {
    profile: {
      handle: screenName,
      ...opt("displayName", text(u["name"])),
      ...opt("bio", text(u["description"])),
      ...opt("location", text(u["location"])),
      ...(website === undefined ? {} : { links: [website] }),
      ...opt("avatarUrl", text(u["avatar_url"])),
      ...opt("followerCount", followers),
      ...opt("followingCount", following),
    },
    isProtected: u["protected"] === true,
  };
}

/** `results` de `/2/profile/{handle}/statuses`. Exportada para los tests. */
export function parseFxStatuses(json: unknown): SocialContentItem[] | null {
  if (!isRecord(json) || !Array.isArray(json["results"])) return null;
  const items: SocialContentItem[] = [];
  for (const s of json["results"]) {
    if (!isRecord(s)) continue;
    const id = text(s["id"]);
    if (id === undefined) continue;
    // Un repost es la voz de otra cuenta.
    if (s["reposted_by"] !== undefined && s["reposted_by"] !== null) continue;
    const body = text(s["text"]);
    const media = isRecord(s["media"]) ? s["media"] : {};
    const photos = Array.isArray(media["photos"]) ? media["photos"] : [];
    const videos = Array.isArray(media["videos"]) ? media["videos"] : [];
    const urls = [
      ...photos.map((p) => (isRecord(p) ? text(p["url"]) : undefined)),
      ...videos.map((v) => (isRecord(v) ? text(v["thumbnail_url"]) : undefined)),
    ].filter((u): u is string => u !== undefined);
    const kind: SocialContentKind =
      videos.length > 0
        ? "video"
        : photos.length > 1
          ? "carousel"
          : photos.length === 1
            ? "image"
            : "text";
    const ts = count(s["created_timestamp"]);
    const postedAt = ts === undefined ? date(s["created_at"]) : new Date(ts * 1000);
    const likes = count(s["likes"]);
    const replies = count(s["replies"]);
    const views = count(s["views"]);
    const reposts = count(s["reposts"]);
    items.push({
      externalId: id,
      kind,
      ...opt("permalink", text(s["url"])),
      ...opt("caption", body),
      hashtags: hashtagsOf(body),
      mentions: mentionsOf(body),
      ...opt("postedAt", postedAt),
      engagement: {
        ...opt("likes", likes),
        ...opt("comments", replies),
        ...opt("views", views),
        ...opt("shares", reposts),
      },
      mediaUrls: urls,
    });
  }
  return newestFirst(items);
}

export class XFxTwitterReader extends BundleSocialReader {
  readonly source = "x" as const;
  protected readonly platform = "x" as const;
  protected readonly errorSource = SOURCE;
  readonly #base: string;
  readonly #config: XFxTwitterReaderConfig;
  readonly #fetch: SocialFetch;

  constructor(config: XFxTwitterReaderConfig) {
    super({
      contentLimit: Math.min(config.contentLimit ?? 24, 100),
      ...opt("memoTtlMs", config.memoTtlMs),
      ...opt("now", config.now),
    });
    if (config.baseUrl.trim() === "") throw new Error("XFxTwitterReader: baseUrl vacío");
    this.#base = trimBase(config.baseUrl);
    this.#config = config;
    this.#fetch = config.fetch ?? ((url, init) => fetch(url, init));
  }

  capabilities(): SocialReadCapabilities {
    return {
      source: "x",
      tiers: [TIER],
      profileSignals: [
        "handle",
        "displayName",
        "bio",
        "location",
        "links",
        "avatarUrl",
        "followerCount",
        "followingCount",
      ],
      contentSignals: [
        "externalId",
        "kind",
        "permalink",
        "caption",
        "hashtags",
        "mentions",
        "postedAt",
        "engagement",
        "mediaUrls",
      ],
      maxContentItems: this.contentLimit,
      requiresConnection: false,
      renderedFetchEnabled: true,
    };
  }

  protected canonicalUrl(handle: string): string {
    return `https://x.com/${handle}`;
  }

  #get(path: string): Promise<HttpResult> {
    return requestJson(this.#fetch, `${this.#base}${path}`, {
      source: SOURCE,
      timeoutMs: this.#config.timeoutMs ?? 15_000,
      headers: {
        "user-agent": this.#config.userAgent ?? "FastGram/0 (personal brand analysis)",
      },
    });
  }

  #throwFor(res: HttpResult): never {
    if (res.status === 429) {
      const after = retryAfterSeconds(res.headers);
      throw new PortError("rate_limited", "X reads are being limited right now.", {
        source: SOURCE,
        ...opt("retryAfterSeconds", after),
      });
    }
    if (res.status >= 500) {
      throw new PortError("provider_unavailable", "X isn't responding right now.", {
        source: SOURCE,
        cause: { status: res.status },
      });
    }
    throw new PortError(
      "provider_contract_violation",
      `FxTwitter answered ${String(res.status)}.`,
      { source: SOURCE, cause: { status: res.status } },
    );
  }

  protected async fetchBundle(handle: string, limit: number): Promise<BundleOutcome> {
    const who = await this.#get(`/2/profile/${encodeURIComponent(handle)}`);
    if (who.status === 404) return { status: "not_found", attemptedTiers: [TIER] };
    if (who.status !== 200) this.#throwFor(who);
    const user = parseFxUser(who.json);
    if (user === null) {
      throw new PortError(
        "provider_contract_violation",
        "FxTwitter answered with an unexpected profile shape.",
        { source: SOURCE },
      );
    }
    if (user.isProtected) return { status: "private", attemptedTiers: [TIER] };

    let items: SocialContentItem[] = [];
    let itemsFailed = false;
    try {
      const page = await this.#get(
        `/2/profile/${encodeURIComponent(handle)}/statuses?count=${String(limit)}`,
      );
      if (page.status === 200) {
        const parsed = parseFxStatuses(page.json);
        if (parsed === null) itemsFailed = true;
        else items = parsed.slice(0, limit);
      } else if (page.status !== 404) {
        // 404 acá es «timeline vacío» según el OpenAPI: cero ítems, no falla.
        itemsFailed = true;
      }
    } catch (error: unknown) {
      if (!(error instanceof PortError)) throw error;
      itemsFailed = true;
    }

    if (user.profile.bio === undefined && items.length === 0 && !itemsFailed) {
      return { status: "insufficient_content", attemptedTiers: [TIER] };
    }
    return {
      status: "ok",
      tier: TIER,
      data: { profile: user.profile, items, itemsFailed },
    };
  }
}
