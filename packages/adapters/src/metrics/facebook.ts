/**
 * Facebook Pages · Reels — métricas de un reel publicado (`PU-AUTO-004`).
 *
 * Documentación, consultada el 2026-09-24:
 * https://developers.facebook.com/docs/graph-api/reference/video/video_insights
 * (enlazada desde la guía de publicación de Reels como «Get insights for your
 * reels to track engagement»).
 *
 *  - `GET https://graph.facebook.com/<ver>/<VIDEO_ID>/video_insights?metric=…`
 *    con **token de Página**. `VIDEO_ID` es el `externalPostId` que guarda el
 *    publicador (`video_id` de `video_reels`).
 *  - Permisos: **`read_insights`** y **`pages_manage_engagement`** (ninguno de
 *    los dos lo pedía el OAuth: ver `core/connections/platforms.ts`), y que el
 *    usuario tenga la tarea `ANALYZE` en la Página.
 *  - Métricas de Reels, todas `lifetime`: `blue_reels_play_count` («the number
 *    of times your reel starts to play after an impression is already
 *    counted») → `views`; `post_video_likes_by_reaction_type` → `likes`;
 *    `post_video_social_actions` («the number of comments on your reel and the
 *    number of times your reel was shared») → `comments` y `shares`.
 *
 * **NO VERIFICADO: la forma del valor** de `post_video_likes_by_reaction_type`
 * y `post_video_social_actions`. La página describe las métricas pero no da
 * un ejemplo de su `value`. Por el nombre, lo esperable es un objeto por tipo
 * (de reacción, de acción); se lee defensivamente:
 *  - un número → es el total (likes); para `social_actions` un número no se
 *    puede partir en comentarios y compartidos, así que los dos quedan
 *    `undefined` (desconocido, **no cero**);
 *  - un objeto → likes = suma de sus valores numéricos; comments/shares = las
 *    claves que contienen `COMMENT` / `SHARE` (sin distinguir mayúsculas).
 * Se confirma con la primera Página real; el test fija esta lectura.
 */
import type {
  MetricsFetchResult,
  MetricsRequest,
  SocialMetrics,
  SocialMetricsCapabilities,
} from "@fastgram/ports";

import { fetchMetaInsights } from "./meta-insights.js";
import {
  DEFAULT_METRICS_TIMEOUT_MS,
  count,
  snapshotOf,
  sumDefined,
  type MetricsFetch,
} from "./shared.js";

const SOURCE = "SocialMetrics/facebook";

export const FACEBOOK_METRICS_CAPABILITIES: SocialMetricsCapabilities = {
  platform: "facebook",
  metrics: ["views", "likes", "comments", "shares"],
  maxBatch: 100,
  costPerPostReadUsd: 0,
  requiredScopes: ["read_insights", "pages_manage_engagement"],
};

export interface FacebookMetricsConfig {
  readonly fetch?: MetricsFetch;
  /** Default `https://graph.facebook.com`. */
  readonly host?: string;
  /** Default `v26.0`, la misma que el publicador. */
  readonly apiVersion?: string;
  readonly requestTimeoutMs?: number;
}

/** Los valores numéricos de un objeto `{clave: número}`. */
function numericEntries(value: unknown): [string, number][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const out: [string, number][] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const n = count(v);
    if (n !== undefined) out.push([key, n]);
  }
  return out;
}

export function facebookLikes(value: unknown): number | undefined {
  const direct = count(value);
  if (direct !== undefined) return direct;
  const entries = numericEntries(value);
  return entries.length === 0 ? undefined : sumDefined(...entries.map(([, n]) => n));
}

export function facebookSocialAction(
  value: unknown,
  kind: "COMMENT" | "SHARE",
): number | undefined {
  const entries = numericEntries(value).filter(([key]) =>
    key.toUpperCase().includes(kind),
  );
  return entries.length === 0 ? undefined : sumDefined(...entries.map(([, n]) => n));
}

export class FacebookReelsMetrics implements SocialMetrics {
  readonly #fetch: MetricsFetch;
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(config: FacebookMetricsConfig = {}) {
    this.#fetch = config.fetch ?? ((url, init) => fetch(url, init));
    this.#base = `${(config.host ?? "https://graph.facebook.com").replace(/\/$/, "")}/${config.apiVersion ?? "v26.0"}`;
    this.#timeoutMs = config.requestTimeoutMs ?? DEFAULT_METRICS_TIMEOUT_MS;
  }

  capabilities(): SocialMetricsCapabilities {
    return FACEBOOK_METRICS_CAPABILITIES;
  }

  fetch(request: MetricsRequest): Promise<MetricsFetchResult> {
    return fetchMetaInsights(
      {
        fetch: this.#fetch,
        source: SOURCE,
        timeoutMs: this.#timeoutMs,
        caps: FACEBOOK_METRICS_CAPABILITIES,
        url: (id, token) => {
          const query = new URLSearchParams({
            metric:
              "blue_reels_play_count,post_video_likes_by_reaction_type,post_video_social_actions",
            access_token: token,
          });
          return `${this.#base}/${encodeURIComponent(id)}/video_insights?${query.toString()}`;
        },
        headers: () => ({}),
        map: (m) => {
          const social = m.get("post_video_social_actions");
          return snapshotOf({
            views: count(m.get("blue_reels_play_count")),
            likes: facebookLikes(m.get("post_video_likes_by_reaction_type")),
            comments: facebookSocialAction(social, "COMMENT"),
            shares: facebookSocialAction(social, "SHARE"),
          });
        },
      },
      request,
    );
  }
}
