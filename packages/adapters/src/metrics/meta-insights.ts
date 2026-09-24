/**
 * El recorrido común de los tres adaptadores de Meta (Instagram, Threads,
 * Facebook Reels): **un GET de insights por post**, con a lo sumo
 * {@link META_INSIGHTS_CONCURRENCY} en vuelo, éxito parcial por post y
 * errores de sesión/permiso/límite que cortan el lote entero.
 *
 * Ninguna de las tres documenta un endpoint de insights por lote; la Graph API
 * tiene «batch requests», pero eso es otra superficie (y otro formato de
 * error) que no se usa en ningún otro lado del repo. No se agrega por esto.
 */
import type {
  MetricsFetchResult,
  MetricsRequest,
  PostMetricsSnapshot,
  SocialMetricsCapabilities,
} from "@fastgram/ports";

import {
  assertRequest,
  getJson,
  graphReadError,
  insightsByName,
  mapLimited,
  type MetricsFetch,
} from "./shared.js";

/** Requests simultáneos por token. Nuestro, no de la plataforma. */
export const META_INSIGHTS_CONCURRENCY = 4;

export interface MetaInsightsSpec {
  readonly fetch: MetricsFetch;
  readonly source: string;
  readonly timeoutMs: number;
  readonly caps: SocialMetricsCapabilities;
  /** La URL completa del GET de insights de un post (con el token si va en la query). */
  readonly url: (externalPostId: string, token: string) => string;
  /** Headers del GET (el `Authorization` si va en header). */
  readonly headers: (token: string) => Record<string, string>;
  /** De las métricas por nombre a lo que guarda FastGram. */
  readonly map: (
    byName: ReadonlyMap<string, unknown>,
  ) => Omit<PostMetricsSnapshot, "externalPostId">;
}

export async function fetchMetaInsights(
  spec: MetaInsightsSpec,
  request: MetricsRequest,
): Promise<MetricsFetchResult> {
  assertRequest(request, spec.caps, spec.source);
  const token = request.account.accessToken;
  const ids = [...new Set(request.externalPostIds)];

  const results = await mapLimited(ids, META_INSIGHTS_CONCURRENCY, async (id) => {
    const res = await getJson(spec.fetch, spec.url(id, token), spec.headers(token), {
      source: spec.source,
      timeoutMs: spec.timeoutMs,
    });
    if (res.status >= 200 && res.status < 300) {
      const byName = insightsByName(res.json, spec.source);
      return { id, item: { externalPostId: id, ...spec.map(byName) } };
    }
    return { id, outcome: graphReadError(res, spec.source) };
  });

  const items: PostMetricsSnapshot[] = [];
  const unavailable: string[] = [];
  for (const r of results) {
    if ("item" in r) items.push(r.item);
    else unavailable.push(r.id);
  }
  return { items, missing: [], unavailable };
}
