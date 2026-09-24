/**
 * YouTube — estadísticas públicas de los videos subidos (`PU-LATER-001`,
 * `PU-AUTO-004`).
 *
 * Documentación, consultada el 2026-09-24:
 *  - https://developers.google.com/youtube/v3/docs/videos/list
 *    · `GET https://www.googleapis.com/youtube/v3/videos?part=statistics&id=…`
 *      con `id` *"comma-separated list of the YouTube video ID(s)"*; *"A call
 *      to this method has a quota cost of 1 unit"* (del bucket general de
 *      10 000 por día, **no** del de subidas).
 *    · El máximo de ids por llamada no está en la referencia: se usa 50, el
 *      mismo `maxResults` máximo de la página. **No verificado** que acepte más.
 *  - https://developers.google.com/youtube/v3/docs/videos
 *    · `statistics.viewCount`, `likeCount`, `commentCount` (*"unsigned
 *      long"*; la API los manda como texto); `dislikeCount` es privado desde
 *      2021; no hay «compartidos».
 *  - Un id que no existe (o de un video borrado) simplemente no vuelve en
 *    `items`: `missing`.
 *  - Scope: `youtube.readonly` (lo pide la conexión), para leer también los
 *    videos **privados** — que es como quedan todos sin la auditoría.
 *
 * Mapeo: `viewCount` → `views`, `likeCount` → `likes`, `commentCount` →
 * `comments`. `shares` no se informa (no es cero: no está).
 */
import {
  PortError,
  type MetricsFetchResult,
  type MetricsRequest,
  type PostMetricsSnapshot,
  type SocialMetrics,
  type SocialMetricsCapabilities,
} from "@fastgram/ports";

import {
  contractViolation,
  field,
  retryAfterOf,
  serverError,
  str,
  transportError,
} from "../publishers/shared/http.js";
import { youtubeReasons } from "../publishers/youtube/youtube-shorts-publisher.js";
import {
  DEFAULT_METRICS_TIMEOUT_MS,
  assertRequest,
  getJson,
  snapshotOf,
  type MetricsFetch,
} from "./shared.js";

const SOURCE = "SocialMetrics/youtube";

export const YOUTUBE_METRICS_CAPABILITIES: SocialMetricsCapabilities = {
  platform: "youtube",
  metrics: ["views", "likes", "comments"],
  maxBatch: 50,
  costPerPostReadUsd: 0,
  requiredScopes: ["https://www.googleapis.com/auth/youtube.readonly"],
};

export interface YouTubeMetricsConfig {
  readonly fetch?: MetricsFetch;
  /** Default `https://www.googleapis.com`. */
  readonly apiBase?: string;
  readonly requestTimeoutMs?: number;
}

/** Un conteo de la API: número o texto de dígitos. */
function countOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return Math.round(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

export class YouTubeMetrics implements SocialMetrics {
  readonly #fetch: MetricsFetch;
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(config: YouTubeMetricsConfig = {}) {
    this.#fetch = config.fetch ?? ((url, init) => fetch(url, init));
    this.#base = (config.apiBase ?? "https://www.googleapis.com").replace(/\/$/, "");
    this.#timeoutMs = config.requestTimeoutMs ?? DEFAULT_METRICS_TIMEOUT_MS;
  }

  capabilities(): SocialMetricsCapabilities {
    return YOUTUBE_METRICS_CAPABILITIES;
  }

  async fetch(request: MetricsRequest): Promise<MetricsFetchResult> {
    assertRequest(request, YOUTUBE_METRICS_CAPABILITIES, SOURCE);
    const ids = [...new Set(request.externalPostIds)];
    if (ids.length === 0) return { items: [], missing: [], unavailable: [] };

    const q = new URLSearchParams({ part: "statistics", id: ids.join(",") });
    const res = await getJson(
      this.#fetch,
      `${this.#base}/youtube/v3/videos?${q.toString()}`,
      { Authorization: `Bearer ${request.account.accessToken}` },
      { source: SOURCE, timeoutMs: this.#timeoutMs },
    );

    if (res.status < 200 || res.status >= 300) {
      const reasons = youtubeReasons(res.json);
      const cause = { status: res.status, reasons };
      if (res.status === 401)
        throw new PortError("unauthorized", "The account needs to be reconnected.", {
          source: SOURCE,
          cause,
        });
      if (res.status === 429 || reasons.includes("quotaExceeded"))
        throw transportError(
          "rate_limited",
          "The platform asked to slow down.",
          { source: SOURCE, phase: "prepare" },
          cause,
          retryAfterOf(res.headers),
        );
      if (res.status === 403)
        throw new PortError(
          "forbidden",
          "The connected account can't read these videos. Reconnect it.",
          { source: SOURCE, cause },
        );
      if (res.status >= 500) throw serverError(res, { source: SOURCE, phase: "prepare" });
      throw new PortError(
        "provider_contract_violation",
        "The platform rejected the request.",
        { source: SOURCE, cause },
      );
    }

    const items = field(res.json, "items");
    if (items !== undefined && !Array.isArray(items))
      throw contractViolation(SOURCE, "items no es un array");
    const out: PostMetricsSnapshot[] = [];
    for (const video of (items ?? []) as unknown[]) {
      const id = str(video, "id");
      if (id === undefined) throw contractViolation(SOURCE, "video sin id");
      const s = field(video, "statistics");
      out.push({
        externalPostId: id,
        ...snapshotOf({
          views: countOf(field(s, "viewCount")),
          likes: countOf(field(s, "likeCount")),
          comments: countOf(field(s, "commentCount")),
        }),
      });
    }
    const found = new Set(out.map((i) => i.externalPostId));
    return { items: out, missing: ids.filter((id) => !found.has(id)), unavailable: [] };
  }
}
