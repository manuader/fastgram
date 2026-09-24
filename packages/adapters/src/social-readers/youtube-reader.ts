/**
 * YouTube **sin login** — sprint 7 (agente G), `P1-BRAND-010`, PRD `FR-011.3`,
 * `D-02`, `D-13`.
 *
 * Dos vías, en el orden de `FR-011.4` (B → C):
 *
 * - **B — YouTube Data API v3**, si hay `YOUTUBE_API_KEY` (una API key de
 *   Google Cloud, sin OAuth: lee datos públicos). Documentado en
 *   `developers.google.com/youtube/v3/docs`:
 *   `channels.list` (`part=snippet,statistics,contentDetails`, por
 *   `forHandle=@h` o `id=UC…`) → la playlist de subidas
 *   (`contentDetails.relatedPlaylists.uploads`) → `playlistItems.list`
 *   (`maxResults` ≤ 50) → `videos.list` (`part=statistics`) para el
 *   engagement. Cuesta 1 unidad por llamada de la cuota diaria (10 000).
 * - **C — `yt-dlp`** (ya lo usa `media-import`), sin cookies:
 *   `yt-dlp --flat-playlist --dump-single-json --playlist-end N
 *   https://www.youtube.com/@h/videos`. Trae del canal `channel`,
 *   `channel_id`, `channel_follower_count`, `description`, `uploader_id` y
 *   `thumbnails`, y de cada video `id`, `title`, `url`, `view_count` y a veces
 *   `description`. En modo `--flat-playlist` **no trae fecha**: los ítems
 *   quedan en el orden de la pestaña Videos, que es de más nuevo a más viejo.
 *
 * Un canal inexistente es `not_found` en las dos (lista vacía en la API,
 * «does not exist» / 404 en yt-dlp). `yt-dlp` sin instalar es
 * `extractor_unavailable`: el worker degrada la fuente a tier D.
 *
 * La API key es un secreto: viaja sólo como query param a `googleapis.com`
 * (así lo documenta Google) y nunca se loguea ni se devuelve en un error.
 */
import {
  PortError,
  type AcquisitionTier,
  type ReadContentRequest,
  type ReadProfileRequest,
  type ResolvedSocialSource,
  type ResolveSourceRequest,
  type SocialContentItem,
  type SocialProfileSignals,
  type SocialReadCapabilities,
  type SocialReader,
  type SocialReadOutcome,
} from "@fastgram/ports";

import {
  minimalChildEnv,
  runProcess,
  type ProcessRunner,
} from "../media-import/run-process.js";
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
  type HttpResult,
  type SocialFetch,
} from "./http.js";

const SOURCE = "SocialReader/youtube";
const API_BASE = "https://www.googleapis.com/youtube/v3";
/** `playlistItems.list`: `maxResults` 0–50. */
const API_MAX_RESULTS = 50;

/** Un canal: por `@handle`, por id (`UC…`) o por URL vieja (`c/…`, `user/…`). */
export type YouTubeChannelRef =
  | { readonly kind: "handle"; readonly value: string }
  | { readonly kind: "id"; readonly value: string }
  | { readonly kind: "legacy"; readonly path: "c" | "user"; readonly value: string };

const HANDLE = /^[A-Za-z0-9._-]{3,30}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const LEGACY = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * De lo que guarda la fila (`https://youtube.com/@h`, `…/channel/UC…`,
 * `…/c/nombre`), un `@handle` o un handle pelado, a una referencia. `null` si
 * no es un canal de YouTube.
 */
export function youtubeChannelFrom(input: string): YouTubeChannelRef | null {
  let raw = input.trim();
  if (raw === "") return null;
  if (/^https?:\/\//i.test(raw) || /^(www\.|m\.)?youtube\.com\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
    if (host !== "youtube.com") return null;
    raw = url.pathname.replace(/^\/+|\/+$/g, "");
  }
  const parts = raw.split("/").filter((p) => p !== "");
  const [first, second] = parts;
  if (first === undefined) return null;
  if (first === "channel" && second !== undefined) {
    return CHANNEL_ID.test(second) ? { kind: "id", value: second } : null;
  }
  if ((first === "c" || first === "user") && second !== undefined) {
    return LEGACY.test(second) ? { kind: "legacy", path: first, value: second } : null;
  }
  if (CHANNEL_ID.test(first)) return { kind: "id", value: first };
  const handle = first.replace(/^@/, "");
  return HANDLE.test(handle) ? { kind: "handle", value: handle.toLowerCase() } : null;
}

export function youtubeChannelUrl(ref: YouTubeChannelRef): string {
  switch (ref.kind) {
    case "handle":
      return `https://www.youtube.com/@${ref.value}`;
    case "id":
      return `https://www.youtube.com/channel/${ref.value}`;
    case "legacy":
      return `https://www.youtube.com/${ref.path}/${ref.value}`;
  }
}

interface Bundle {
  readonly tier: AcquisitionTier;
  readonly profile: SocialProfileSignals;
  readonly items: readonly SocialContentItem[];
}

type BundleOutcome =
  | { readonly status: "ok"; readonly data: Bundle }
  | {
      readonly status: "not_found" | "insufficient_content" | "extractor_unavailable";
      readonly attemptedTiers: readonly AcquisitionTier[];
    };

/* ------------------------------------------------------------------------ *
 * Parsers (exportados para los tests)
 * ------------------------------------------------------------------------ */

/** `channels.list` → perfil + id de la playlist de subidas. */
export function parseYouTubeChannel(
  json: unknown,
): { readonly profile: SocialProfileSignals; readonly uploads: string | null } | null {
  if (!isRecord(json) || !Array.isArray(json["items"])) return null;
  const item = json["items"][0];
  if (!isRecord(item)) return null;
  const snippet = isRecord(item["snippet"]) ? item["snippet"] : {};
  const stats = isRecord(item["statistics"]) ? item["statistics"] : {};
  const details = isRecord(item["contentDetails"]) ? item["contentDetails"] : {};
  const related = isRecord(details["relatedPlaylists"])
    ? details["relatedPlaylists"]
    : {};
  const thumbs = isRecord(snippet["thumbnails"]) ? snippet["thumbnails"] : {};
  const thumb = ["high", "medium", "default"]
    .map((k) => (isRecord(thumbs[k]) ? text(thumbs[k]["url"]) : undefined))
    .find((u) => u !== undefined);
  const customUrl = text(snippet["customUrl"]);
  return {
    profile: {
      ...opt("displayName", text(snippet["title"])),
      ...opt("handle", customUrl?.replace(/^@/, "")),
      ...opt("bio", text(snippet["description"])),
      ...opt("country", text(snippet["country"])),
      ...opt("avatarUrl", thumb),
      // `hiddenSubscriberCount: true` = el número no es público.
      ...(stats["hiddenSubscriberCount"] === true
        ? {}
        : opt("subscriberCount", count(stats["subscriberCount"]))),
    },
    uploads: text(related["uploads"]) ?? null,
  };
}

/** `playlistItems.list` → ítems (sin engagement todavía). */
export function parseYouTubePlaylistItems(json: unknown): SocialContentItem[] | null {
  if (!isRecord(json) || !Array.isArray(json["items"])) return null;
  const out: SocialContentItem[] = [];
  for (const it of json["items"]) {
    if (!isRecord(it)) continue;
    const snippet = isRecord(it["snippet"]) ? it["snippet"] : {};
    const details = isRecord(it["contentDetails"]) ? it["contentDetails"] : {};
    const resource = isRecord(snippet["resourceId"]) ? snippet["resourceId"] : {};
    const id = text(details["videoId"]) ?? text(resource["videoId"]);
    if (id === undefined) continue;
    const description = text(snippet["description"]);
    const title = text(snippet["title"]);
    const thumbs = isRecord(snippet["thumbnails"]) ? snippet["thumbnails"] : {};
    const thumb = ["high", "medium", "default"]
      .map((k) => (isRecord(thumbs[k]) ? text(thumbs[k]["url"]) : undefined))
      .find((u) => u !== undefined);
    out.push({
      externalId: id,
      kind: "video",
      permalink: `https://www.youtube.com/watch?v=${id}`,
      ...opt("title", title),
      ...opt("caption", description),
      hashtags: hashtagsOf(`${title ?? ""} ${description ?? ""}`),
      mentions: mentionsOf(description),
      ...opt("postedAt", date(details["videoPublishedAt"] ?? snippet["publishedAt"])),
      engagement: {},
      mediaUrls: thumb === undefined ? [] : [thumb],
    });
  }
  return out;
}

/** `videos.list?part=statistics` → engagement por id. */
export function parseYouTubeStatistics(
  json: unknown,
): Map<string, SocialContentItem["engagement"]> {
  const out = new Map<string, SocialContentItem["engagement"]>();
  if (!isRecord(json) || !Array.isArray(json["items"])) return out;
  for (const it of json["items"]) {
    if (!isRecord(it)) continue;
    const id = text(it["id"]);
    const s = isRecord(it["statistics"]) ? it["statistics"] : null;
    if (id === undefined || s === null) continue;
    out.set(id, {
      ...opt("views", count(s["viewCount"])),
      ...opt("likes", count(s["likeCount"])),
      ...opt("comments", count(s["commentCount"])),
    });
  }
  return out;
}

/** La salida de `yt-dlp --flat-playlist --dump-single-json` de `…/videos`. */
export function parseYtDlpChannel(json: unknown): {
  readonly profile: SocialProfileSignals;
  readonly items: SocialContentItem[];
} | null {
  if (!isRecord(json)) return null;
  const name = text(json["channel"]) ?? text(json["uploader"]) ?? text(json["title"]);
  if (name === undefined) return null;
  const thumbs = Array.isArray(json["thumbnails"]) ? json["thumbnails"] : [];
  const avatar = thumbs
    .filter(isRecord)
    .find((t) => typeof t["id"] === "string" && t["id"].startsWith("avatar"));
  const entries = Array.isArray(json["entries"]) ? json["entries"] : [];
  const items: SocialContentItem[] = [];
  for (const e of entries) {
    if (!isRecord(e)) continue;
    const id = text(e["id"]);
    if (id === undefined) continue;
    const title = text(e["title"]);
    const description = text(e["description"]);
    const isShort = typeof e["url"] === "string" && e["url"].includes("/shorts/");
    const ts = count(e["timestamp"]);
    items.push({
      externalId: id,
      kind: isShort ? "short" : "video",
      permalink: text(e["url"]) ?? `https://www.youtube.com/watch?v=${id}`,
      ...opt("title", title),
      ...opt("caption", description),
      hashtags: hashtagsOf(`${title ?? ""} ${description ?? ""}`),
      mentions: mentionsOf(description),
      ...opt("postedAt", ts === undefined ? undefined : new Date(ts * 1000)),
      engagement: { ...opt("views", count(e["view_count"])) },
      mediaUrls: [],
    });
  }
  return {
    profile: {
      displayName: name,
      ...opt("handle", text(json["uploader_id"])?.replace(/^@/, "")),
      ...opt("bio", text(json["description"])),
      ...opt("avatarUrl", avatar === undefined ? undefined : text(avatar["url"])),
      ...opt("subscriberCount", count(json["channel_follower_count"])),
    },
    items,
  };
}

/* ------------------------------------------------------------------------ *
 * El adaptador
 * ------------------------------------------------------------------------ */

export interface YouTubeReaderConfig {
  /** `YOUTUBE_API_KEY`. Sin key, sólo `yt-dlp`. */
  readonly apiKey?: string;
  /** Default `yt-dlp` (o `YTDLP_PATH`, lo resuelve quien monta). `null` = sin yt-dlp. */
  readonly ytDlpBinary?: string | null;
  readonly run?: ProcessRunner;
  readonly fetch?: SocialFetch;
  readonly timeoutMs?: number;
  /** Default 24 (`AI-016`). Techo 50. */
  readonly contentLimit?: number;
  readonly memoTtlMs?: number;
  readonly now?: () => number;
}

export class YouTubeReader implements SocialReader {
  readonly source = "youtube" as const;
  readonly #config: YouTubeReaderConfig;
  readonly #fetch: SocialFetch;
  readonly #run: ProcessRunner;
  readonly #limit: number;
  readonly #memo = new Map<string, { at: number; promise: Promise<BundleOutcome> }>();

  constructor(config: YouTubeReaderConfig) {
    if (config.apiKey === undefined && config.ytDlpBinary === null) {
      throw new Error("YouTubeReader: hace falta una API key o yt-dlp");
    }
    this.#config = config;
    this.#fetch = config.fetch ?? ((url, init) => fetch(url, init));
    this.#run = config.run ?? runProcess;
    this.#limit = Math.max(1, Math.min(config.contentLimit ?? 24, API_MAX_RESULTS));
  }

  #tiers(): AcquisitionTier[] {
    return [
      ...(this.#config.apiKey === undefined ? [] : ["B_public_api" as const]),
      ...(this.#config.ytDlpBinary === null ? [] : ["C_page_fetch" as const]),
    ];
  }

  capabilities(): SocialReadCapabilities {
    return {
      source: "youtube",
      tiers: this.#tiers(),
      profileSignals: [
        "displayName",
        "handle",
        "bio",
        "country",
        "avatarUrl",
        "subscriberCount",
      ],
      contentSignals: [
        "externalId",
        "kind",
        "permalink",
        "title",
        "caption",
        "hashtags",
        "mentions",
        "postedAt",
        "engagement",
        "mediaUrls",
      ],
      maxContentItems: this.#limit,
      requiresConnection: false,
      renderedFetchEnabled: this.#config.ytDlpBinary !== null,
    };
  }

  #ref(input: string): YouTubeChannelRef {
    const ref = youtubeChannelFrom(input);
    if (ref === null) {
      throw new PortError("bad_request", "Not a YouTube channel.", { source: SOURCE });
    }
    return ref;
  }

  #bundle(ref: YouTubeChannelRef): Promise<BundleOutcome> {
    const key = `${ref.kind}:${ref.value}`;
    const now = (this.#config.now ?? Date.now)();
    const hit = this.#memo.get(key);
    if (hit !== undefined && now - hit.at < (this.#config.memoTtlMs ?? 60_000)) {
      return hit.promise;
    }
    const promise = this.#read(ref);
    this.#memo.set(key, { at: now, promise });
    promise.catch(() => {
      if (this.#memo.get(key)?.promise === promise) this.#memo.delete(key);
    });
    return promise;
  }

  async #read(ref: YouTubeChannelRef): Promise<BundleOutcome> {
    const attempted: AcquisitionTier[] = [];
    if (this.#config.apiKey !== undefined && ref.kind !== "legacy") {
      attempted.push("B_public_api");
      try {
        const viaApi = await this.#readApi(ref, this.#config.apiKey);
        if (viaApi.status === "ok" || this.#config.ytDlpBinary === null) return viaApi;
        if (viaApi.status === "not_found") return viaApi;
      } catch (error) {
        // Sin yt-dlp detrás, el error de la API es el resultado.
        if (this.#config.ytDlpBinary === null) throw error;
      }
    }
    if (this.#config.ytDlpBinary !== null) {
      attempted.push("C_page_fetch");
      return this.#readYtDlp(ref, attempted);
    }
    return { status: "extractor_unavailable", attemptedTiers: attempted };
  }

  #api(path: string, params: Record<string, string>, key: string): Promise<HttpResult> {
    const q = new URLSearchParams({ ...params, key });
    return requestJson(this.#fetch, `${API_BASE}/${path}?${q.toString()}`, {
      source: SOURCE,
      timeoutMs: this.#config.timeoutMs ?? 15_000,
    });
  }

  #apiFailure(res: HttpResult): never {
    // Nunca el cuerpo: podría repetir la URL con la key.
    if (res.status === 429) {
      throw new PortError("rate_limited", "YouTube reads are being limited right now.", {
        source: SOURCE,
        ...opt("retryAfterSeconds", retryAfterSeconds(res.headers)),
      });
    }
    if (res.status === 403) {
      // `quotaExceeded` y key inválida/restringida devuelven 403.
      throw new PortError(
        "quota_exceeded",
        "The YouTube API key was refused or is out of quota.",
        {
          source: SOURCE,
          cause: { status: res.status },
        },
      );
    }
    if (res.status === 400 || res.status === 401) {
      throw new PortError("unauthorized", "The YouTube API key is not valid.", {
        source: SOURCE,
        cause: { status: res.status },
      });
    }
    throw new PortError(
      res.status >= 500 ? "provider_unavailable" : "provider_contract_violation",
      `YouTube answered ${String(res.status)}.`,
      { source: SOURCE, cause: { status: res.status } },
    );
  }

  async #readApi(ref: YouTubeChannelRef, key: string): Promise<BundleOutcome> {
    const params: Record<string, string> = {
      part: "snippet,statistics,contentDetails",
      ...(ref.kind === "handle" ? { forHandle: `@${ref.value}` } : { id: ref.value }),
    };
    const ch = await this.#api("channels", params, key);
    if (ch.status !== 200) this.#apiFailure(ch);
    const channel = parseYouTubeChannel(ch.json);
    if (channel === null)
      return { status: "not_found", attemptedTiers: ["B_public_api"] };

    let items: SocialContentItem[] = [];
    if (channel.uploads !== null) {
      const pl = await this.#api(
        "playlistItems",
        {
          part: "snippet,contentDetails",
          playlistId: channel.uploads,
          maxResults: String(this.#limit),
        },
        key,
      );
      if (pl.status === 200) items = parseYouTubePlaylistItems(pl.json) ?? [];
      else if (pl.status !== 404) this.#apiFailure(pl);
    }
    if (items.length > 0) {
      const st = await this.#api(
        "videos",
        { part: "statistics", id: items.map((i) => i.externalId).join(",") },
        key,
      );
      if (st.status === 200) {
        const stats = parseYouTubeStatistics(st.json);
        items = items.map((i) => ({ ...i, engagement: stats.get(i.externalId) ?? {} }));
      }
    }
    if (channel.profile.bio === undefined && items.length === 0) {
      return { status: "insufficient_content", attemptedTiers: ["B_public_api"] };
    }
    return {
      status: "ok",
      data: {
        tier: "B_public_api",
        profile: {
          ...channel.profile,
          ...(ref.kind === "handle" && channel.profile.handle === undefined
            ? { handle: ref.value }
            : {}),
        },
        items: newestFirst(items),
      },
    };
  }

  async #readYtDlp(
    ref: YouTubeChannelRef,
    attempted: readonly AcquisitionTier[],
  ): Promise<BundleOutcome> {
    const binary = this.#config.ytDlpBinary ?? "yt-dlp";
    const run = await this.#run(
      binary,
      [
        "--flat-playlist",
        "--dump-single-json",
        "--no-warnings",
        "--ignore-config",
        "--playlist-end",
        String(this.#limit),
        "--",
        `${youtubeChannelUrl(ref)}/videos`,
      ],
      {
        timeoutMs: this.#config.timeoutMs ?? 60_000,
        maxStdoutBytes: 20 * 1024 * 1024,
        env: minimalChildEnv(),
      },
    );
    if (run.spawnError !== null) {
      return { status: "extractor_unavailable", attemptedTiers: attempted };
    }
    if (run.timedOut) {
      throw new PortError("timeout", "YouTube did not answer in time.", {
        source: SOURCE,
      });
    }
    if (run.exitCode !== 0) {
      const tail = run.stderrTail.toLowerCase();
      if (/does not exist|404|not found|this channel is not available/.test(tail)) {
        return { status: "not_found", attemptedTiers: attempted };
      }
      if (/429|too many requests|sign in to confirm/.test(tail)) {
        throw new PortError(
          "rate_limited",
          "YouTube is limiting reads from this machine.",
          {
            source: SOURCE,
          },
        );
      }
      throw new PortError("provider_unavailable", "yt-dlp could not read the channel.", {
        source: SOURCE,
        cause: { exitCode: run.exitCode },
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(run.stdout);
    } catch {
      throw new PortError(
        "provider_contract_violation",
        "yt-dlp answered something else.",
        {
          source: SOURCE,
        },
      );
    }
    const parsed = parseYtDlpChannel(json);
    if (parsed === null) return { status: "not_found", attemptedTiers: attempted };
    if (parsed.profile.bio === undefined && parsed.items.length === 0) {
      return { status: "insufficient_content", attemptedTiers: attempted };
    }
    return {
      status: "ok",
      data: {
        tier: "C_page_fetch",
        profile: {
          ...parsed.profile,
          ...(ref.kind === "handle" && parsed.profile.handle === undefined
            ? { handle: ref.value }
            : {}),
        },
        // Sin fechas en modo plano: el orden de la pestaña Videos ya es el
        // del más nuevo al más viejo.
        items: parsed.items.slice(0, this.#limit),
      },
    };
  }

  async resolve(
    request: ResolveSourceRequest,
  ): Promise<SocialReadOutcome<ResolvedSocialSource>> {
    const ref = this.#ref(request.input);
    const read = await this.#bundle(ref);
    if (read.status !== "ok") return read;
    const p = read.data.profile;
    const handle =
      ref.kind === "id"
        ? `channel/${ref.value}`
        : ref.kind === "legacy"
          ? `c/${ref.value}`
          : ref.value;
    return {
      status: "ok",
      tier: read.data.tier,
      data: {
        sourceType: "youtube",
        handle,
        canonicalUrl: youtubeChannelUrl(ref),
        available: true,
        ...opt("displayName", p.displayName),
        ...opt("avatarUrl", p.avatarUrl),
      },
    };
  }

  async readProfile(
    request: ReadProfileRequest,
  ): Promise<SocialReadOutcome<SocialProfileSignals>> {
    const read = await this.#bundle(this.#ref(request.handle));
    if (read.status !== "ok") return read;
    return { status: "ok", tier: read.data.tier, data: read.data.profile };
  }

  async readRecentContent(
    request: ReadContentRequest,
  ): Promise<SocialReadOutcome<readonly SocialContentItem[]>> {
    const read = await this.#bundle(this.#ref(request.handle));
    if (read.status !== "ok") return read;
    const limit = Math.max(0, Math.min(request.limit ?? this.#limit, this.#limit));
    const items = read.data.items.slice(0, limit);
    if (items.length === 0) {
      return { status: "insufficient_content", attemptedTiers: [read.data.tier] };
    }
    return { status: "ok", tier: read.data.tier, data: items };
  }
}
