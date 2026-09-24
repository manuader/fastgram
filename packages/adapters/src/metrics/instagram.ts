/**
 * Instagram — métricas de un post publicado (`PU-AUTO-004`).
 *
 * Documentación, consultada el 2026-09-24:
 * https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
 *
 *  - `GET https://graph.instagram.com/<API_VERSION>/<INSTAGRAM_MEDIA_ID>/insights?metric=…`
 *    (Instagram Login; con Facebook Login el host es `graph.facebook.com`).
 *  - Permisos con Instagram Login: `instagram_business_basic` +
 *    **`instagram_business_manage_insights`** — el segundo no lo pedía el
 *    OAuth hasta este sprint (ver `core/connections/platforms.ts`): una
 *    conexión anterior responde permiso faltante → `forbidden` → reconectar.
 *    Confirmación del scope: https://developers.facebook.com/blog/post/2025/03/24/user-and-media-insights-on-instagram-api-with-instagram-login/
 *    («Advanced access is required to request this permission from any app
 *    user»: con la app en modo desarrollo y la cuenta con rol, alcanza el
 *    acceso estándar — NO VERIFICADO con una cuenta real).
 *  - Métricas pedidas: `views`, `likes`, `comments`, `shares` — las cuatro
 *    figuran para FEED y REELS en la tabla de la página. `impressions` está
 *    deprecada para media posterior al 2/7/2024 y no se pide. `saved` y `reach`
 *    existen pero FastGram no las guarda.
 *  - «Data used to calculate metrics can be delayed up to 48 hours» y «the API
 *    returns empty set instead of 0 when data unavailable»: una métrica que no
 *    viene queda `undefined`, nunca `0`.
 *  - Respuesta: `{"data":[{"name":"likes","period":"lifetime","values":[{"value":N}],…}]}`.
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
  type MetricsFetch,
} from "./shared.js";

const SOURCE = "SocialMetrics/instagram";

export const INSTAGRAM_METRICS_CAPABILITIES: SocialMetricsCapabilities = {
  platform: "instagram",
  metrics: ["views", "likes", "comments", "shares"],
  // Un GET por post; el lote es el del puerto (`NFR-012`).
  maxBatch: 100,
  costPerPostReadUsd: 0,
  requiredScopes: ["instagram_business_basic", "instagram_business_manage_insights"],
};

export interface InstagramMetricsConfig {
  readonly fetch?: MetricsFetch;
  /** Default `https://graph.instagram.com` (Instagram Login). */
  readonly host?: string;
  /** Default `v26.0`, la misma que el publicador. */
  readonly apiVersion?: string;
  readonly requestTimeoutMs?: number;
}

export class InstagramMetrics implements SocialMetrics {
  readonly #fetch: MetricsFetch;
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(config: InstagramMetricsConfig = {}) {
    this.#fetch = config.fetch ?? ((url, init) => fetch(url, init));
    this.#base = `${(config.host ?? "https://graph.instagram.com").replace(/\/$/, "")}/${config.apiVersion ?? "v26.0"}`;
    this.#timeoutMs = config.requestTimeoutMs ?? DEFAULT_METRICS_TIMEOUT_MS;
  }

  capabilities(): SocialMetricsCapabilities {
    return INSTAGRAM_METRICS_CAPABILITIES;
  }

  fetch(request: MetricsRequest): Promise<MetricsFetchResult> {
    return fetchMetaInsights(
      {
        fetch: this.#fetch,
        source: SOURCE,
        timeoutMs: this.#timeoutMs,
        caps: INSTAGRAM_METRICS_CAPABILITIES,
        url: (id) =>
          `${this.#base}/${encodeURIComponent(id)}/insights?metric=views,likes,comments,shares`,
        // Mismo lugar del token que el publicador (content-publishing: Bearer).
        headers: (token) => ({ Authorization: `Bearer ${token}` }),
        map: (m) =>
          snapshotOf({
            views: count(m.get("views")),
            likes: count(m.get("likes")),
            comments: count(m.get("comments")),
            shares: count(m.get("shares")),
          }),
      },
      request,
    );
  }
}
