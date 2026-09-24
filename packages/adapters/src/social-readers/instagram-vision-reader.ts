/**
 * Instagram por `services/vision` (instaloader anónimo) — `PU-SCRAPE-001`,
 * PRD `FR-011.3`, `D-13`.
 *
 * El scraper es Python y vive en el servicio de visión
 * (`POST /social/instagram/profile`, ver `services/vision/app/social/instagram.py`,
 * que es donde está el cache, el enfriamiento ante 429 y por qué no reintenta
 * adentro). Este adaptador sólo traduce su contrato al puerto.
 *
 * ## Tier: `C_page_fetch`
 *
 * Leer una cuenta de Instagram sin la API oficial ni credencial propia es
 * exactamente la fila C de `FR-011.4` («fetch de la página pública… sujeto a
 * ToS»). Montar este adaptador **es** activar el tier C para Instagram: `D-13`
 * lo levanta para uso personal, y por eso `renderedFetchEnabled` es `true`
 * sólo porque alguien configuró la URL del servicio. La vía oficial
 * (Business Discovery, tier B) es otro adaptador.
 *
 * ## Qué se traduce a qué
 *
 * | servicio | puerto |
 * |---|---|
 * | 200, `is_private: true` | `private` (`ERR-B05`) |
 * | 200 sin bio, nombre ni posts | `insufficient_content` (`ERR-B09`) |
 * | 404 `profile_unavailable` | `not_found` (`ERR-B04`) |
 * | 403 `profile_unavailable` | `private` |
 * | 429 `platform_rate_limited` | `PortError rate_limited` con `Retry-After` (`ERR-B08`) |
 * | 502 `platform_unavailable` | `PortError provider_unavailable` (`ERR-B07`) |
 * | 503 `extractor_unavailable` | `extractor_unavailable` (instaloader no instalado) |
 * | red caída / timeout | `PortError provider_unavailable` / `timeout` |
 * | cualquier otra forma | `PortError provider_contract_violation` |
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
  type SocialFetch,
} from "./http.js";

const SOURCE = "SocialReader/instagram-vision";
const TIER = "C_page_fetch" as const;

/**
 * Lo que `web_profile_info` trae de una (`FIRST_PAGE_POSTS` del servicio).
 * Pedir más obliga a una segunda consulta anónima: más 429.
 */
export const INSTAGRAM_FIRST_PAGE = 12;

export interface InstagramVisionReaderConfig {
  /** Base del servicio de visión, p. ej. `http://127.0.0.1:8000`. Sin default. */
  readonly baseUrl: string;
  /** Default 45 s: el servicio tiene su propio timeout de 20 s contra Instagram. */
  readonly timeoutMs?: number;
  /** Default {@link INSTAGRAM_FIRST_PAGE}. Techo 24 (`AI-016`). */
  readonly contentLimit?: number;
  readonly fetch?: SocialFetch;
  readonly memoTtlMs?: number;
  readonly now?: () => number;
}

const KIND: Readonly<Record<string, SocialContentKind>> = {
  image: "image",
  carousel: "carousel",
  video: "video",
};

function errorOf(json: unknown): {
  code?: string;
  reason?: string;
  retryAfter?: unknown;
} {
  if (!isRecord(json) || !isRecord(json["error"])) return {};
  const e = json["error"];
  return {
    ...(typeof e["code"] === "string" ? { code: e["code"] } : {}),
    ...(typeof e["reason"] === "string" ? { reason: e["reason"] } : {}),
    retryAfter: e["retry_after"],
  };
}

/** La respuesta 200 del servicio, a perfil + ítems. Exportada para los tests. */
export function parseInstagramProfileResponse(json: unknown): {
  readonly profile: SocialProfileSignals;
  readonly items: SocialContentItem[];
  readonly isPrivate: boolean;
  readonly postsFailed: boolean;
} | null {
  if (!isRecord(json) || !isRecord(json["profile"]) || !Array.isArray(json["posts"])) {
    return null;
  }
  const p = json["profile"];
  const username = text(p["username"]);
  if (username === undefined) return null;
  const external = text(p["external_url"]);
  const profile: SocialProfileSignals = {
    handle: username,
    ...opt("displayName", text(p["full_name"])),
    ...opt("bio", text(p["biography"])),
    ...opt("category", text(p["business_category"])),
    ...(external === undefined ? {} : { links: [external] }),
    ...opt("avatarUrl", text(p["profile_pic_url"])),
    ...opt("followerCount", count(p["followers"])),
    ...opt("followingCount", count(p["following"])),
  };

  const items: SocialContentItem[] = [];
  for (const raw of json["posts"]) {
    if (!isRecord(raw)) continue;
    const shortcode = text(raw["shortcode"]);
    if (shortcode === undefined) continue;
    const caption = text(raw["caption"]);
    const postedAt = date(raw["posted_at"]);
    const media = text(raw["media_url"]);
    const strings = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string" && x !== "")
        : [];
    items.push({
      externalId: shortcode,
      kind: KIND[String(raw["kind"])] ?? "other",
      ...opt("permalink", text(raw["permalink"])),
      ...opt("caption", caption),
      hashtags: strings(raw["hashtags"]),
      mentions: strings(raw["mentions"]),
      ...opt("postedAt", postedAt),
      engagement: {
        ...opt("likes", count(raw["likes"])),
        ...opt("comments", count(raw["comments"])),
        ...opt("views", count(raw["video_views"])),
      },
      mediaUrls: media === undefined ? [] : [media],
    });
  }
  return {
    profile,
    items: newestFirst(items),
    isPrivate: p["is_private"] === true,
    postsFailed: typeof json["posts_error"] === "string",
  };
}

export class InstagramVisionReader extends BundleSocialReader {
  readonly source = "instagram" as const;
  protected readonly platform = "instagram" as const;
  protected readonly errorSource = SOURCE;
  readonly #base: string;
  readonly #timeoutMs: number;
  readonly #fetch: SocialFetch;

  constructor(config: InstagramVisionReaderConfig) {
    super({
      contentLimit: Math.min(config.contentLimit ?? INSTAGRAM_FIRST_PAGE, 24),
      ...opt("memoTtlMs", config.memoTtlMs),
      ...opt("now", config.now),
    });
    if (config.baseUrl.trim() === "")
      throw new Error("InstagramVisionReader: baseUrl vacío");
    this.#base = trimBase(config.baseUrl);
    this.#timeoutMs = config.timeoutMs ?? 45_000;
    this.#fetch = config.fetch ?? ((url, init) => fetch(url, init));
  }

  capabilities(): SocialReadCapabilities {
    return {
      source: "instagram",
      tiers: [TIER],
      profileSignals: [
        "displayName",
        "handle",
        "bio",
        "category",
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
    return `https://instagram.com/${handle}`;
  }

  protected async fetchBundle(handle: string, limit: number): Promise<BundleOutcome> {
    const res = await requestJson(this.#fetch, `${this.#base}/social/instagram/profile`, {
      source: SOURCE,
      timeoutMs: this.#timeoutMs,
      method: "POST",
      body: { username: handle, limit },
    });

    if (res.status === 200) {
      const parsed = parseInstagramProfileResponse(res.json);
      if (parsed === null) {
        throw new PortError(
          "provider_contract_violation",
          "The Instagram extractor answered with an unexpected shape.",
          { source: SOURCE },
        );
      }
      if (parsed.isPrivate) return { status: "private", attemptedTiers: [TIER] };
      const p = parsed.profile;
      if (
        p.bio === undefined &&
        p.displayName === undefined &&
        parsed.items.length === 0
      ) {
        return { status: "insufficient_content", attemptedTiers: [TIER] };
      }
      return {
        status: "ok",
        tier: TIER,
        data: { profile: p, items: parsed.items, itemsFailed: parsed.postsFailed },
      };
    }

    const err = errorOf(res.json);
    if (err.code === "profile_unavailable") {
      return {
        status: err.reason === "private" || res.status === 403 ? "private" : "not_found",
        attemptedTiers: [TIER],
      };
    }
    if (err.code === "extractor_unavailable") {
      return { status: "extractor_unavailable", attemptedTiers: [TIER] };
    }
    if (res.status === 429 || err.code === "platform_rate_limited") {
      const after = retryAfterSeconds(res.headers, err.retryAfter);
      throw new PortError("rate_limited", "Instagram is rate limiting anonymous reads.", {
        source: SOURCE,
        ...opt("retryAfterSeconds", after),
      });
    }
    if (res.status === 400 && err.code === "invalid_username") {
      throw new PortError("bad_request", "Not an Instagram username.", {
        source: SOURCE,
      });
    }
    if (res.status >= 500 || err.code === "platform_unavailable") {
      throw new PortError(
        "provider_unavailable",
        "Instagram isn't responding right now.",
        {
          source: SOURCE,
          cause: { status: res.status, code: err.code, reason: err.reason },
        },
      );
    }
    throw new PortError(
      "provider_contract_violation",
      `The Instagram extractor answered ${String(res.status)}.`,
      { source: SOURCE, cause: { status: res.status, code: err.code } },
    );
  }
}
