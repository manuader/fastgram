/**
 * Threads — métricas de un post publicado (`PU-AUTO-004`).
 *
 * Documentación, consultada el 2026-09-24:
 * https://developers.facebook.com/docs/threads/insights
 *
 *  - `GET https://graph.threads.net/v1.0/<THREADS_MEDIA_ID>/insights?metric=…`
 *  - Permisos: `threads_basic` + **`threads_manage_insights`** (este segundo
 *    no lo pedía el OAuth hasta este sprint: ver `core/connections/platforms.ts`).
 *  - Métricas de media: `views`, `likes`, `replies`, `reposts`, `quotes`,
 *    `shares`. «Views and shares metrics are in development».
 *  - «Returned metrics do not capture nested replies' metrics».
 *  - Respuesta con `values[0].value` y `period: "lifetime"`.
 *
 * Cómo se guarda: `replies` → `comments`; `shares` = `reposts` + `quotes` +
 * `shares` (las tres son «llevar el post a otra audiencia», que es lo que
 * `shares` significa en las otras redes para el engagement). Es una decisión
 * nuestra, no un dato de la plataforma.
 *
 * El token va en la query (`access_token`), como en los GET del publicador.
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

const SOURCE = "SocialMetrics/threads";

export const THREADS_METRICS_CAPABILITIES: SocialMetricsCapabilities = {
  platform: "threads",
  metrics: ["views", "likes", "comments", "shares"],
  maxBatch: 100,
  costPerPostReadUsd: 0,
  requiredScopes: ["threads_basic", "threads_manage_insights"],
};

export interface ThreadsMetricsConfig {
  readonly fetch?: MetricsFetch;
  /** Default `https://graph.threads.net`. */
  readonly host?: string;
  /** Default `v1.0`. */
  readonly apiVersion?: string;
  readonly requestTimeoutMs?: number;
}

export class ThreadsMetrics implements SocialMetrics {
  readonly #fetch: MetricsFetch;
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(config: ThreadsMetricsConfig = {}) {
    this.#fetch = config.fetch ?? ((url, init) => fetch(url, init));
    this.#base = `${(config.host ?? "https://graph.threads.net").replace(/\/$/, "")}/${config.apiVersion ?? "v1.0"}`;
    this.#timeoutMs = config.requestTimeoutMs ?? DEFAULT_METRICS_TIMEOUT_MS;
  }

  capabilities(): SocialMetricsCapabilities {
    return THREADS_METRICS_CAPABILITIES;
  }

  fetch(request: MetricsRequest): Promise<MetricsFetchResult> {
    return fetchMetaInsights(
      {
        fetch: this.#fetch,
        source: SOURCE,
        timeoutMs: this.#timeoutMs,
        caps: THREADS_METRICS_CAPABILITIES,
        url: (id, token) => {
          const query = new URLSearchParams({
            metric: "views,likes,replies,reposts,quotes,shares",
            access_token: token,
          });
          return `${this.#base}/${encodeURIComponent(id)}/insights?${query.toString()}`;
        },
        headers: () => ({}),
        map: (m) =>
          snapshotOf({
            views: count(m.get("views")),
            likes: count(m.get("likes")),
            comments: count(m.get("replies")),
            shares: sumDefined(
              count(m.get("reposts")),
              count(m.get("quotes")),
              count(m.get("shares")),
            ),
          }),
      },
      request,
    );
  }
}
