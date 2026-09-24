/**
 * X — métricas públicas de un post (`PU-AUTO-004`). **Apagado por defecto:
 * leer cuesta plata.**
 *
 * Documentación, consultada el 2026-09-24:
 *  - https://docs.x.com/x-api/posts/get-posts-by-ids
 *    · `GET https://api.x.com/2/tweets?ids=…&post.fields=public_metrics`,
 *      `ids` de 1 a **100**.
 *    · `public_metrics`: `repost_count`, `reply_count`, `like_count`,
 *      `quote_count`, `bookmark_count`, `impression_count`.
 *    · Scopes OAuth 2.0: `tweet.read`, `users.read` — ya los pide la conexión.
 *    · Un id que no existe vuelve en `errors[]` con
 *      `type: "https://api.x.com/2/problems/resource-not-found"` y
 *      `resource_id`, en una respuesta **200** (éxito parcial).
 *  - https://docs.x.com/x-api/getting-started/pricing
 *    · «Posts: Read» **US$0,005 por recurso**. Las «Owned Reads» a US$0,001
 *      son sólo los endpoints `GET /2/users/{id}/…`; `GET /2/tweets` no está
 *      en esa lista.
 *  - https://docs.x.com/x-api/fundamentals/post-cap — tope de 3 millones de
 *    lecturas por mes en pago por uso.
 *
 * Por eso: `costPerPostReadUsd: 0.005` y el worker sólo monta este adaptador
 * con `METRICS_X_ENABLED=true`, y aun así lo lee cada 24 h (ver
 * `core/metrics/sync-policy.ts`): ~30 lecturas por post en su ventana de 30
 * días ≈ US$0,15 por post.
 *
 * Mapeo: `impression_count` → `views`; `reply_count` → `comments`;
 * `repost_count` + `quote_count` → `shares` (mismo criterio que Threads).
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
import {
  DEFAULT_METRICS_TIMEOUT_MS,
  assertRequest,
  count,
  getJson,
  snapshotOf,
  sumDefined,
  type MetricsFetch,
} from "./shared.js";

const SOURCE = "SocialMetrics/x";

export const X_POST_READ_USD = 0.005;

export const X_METRICS_CAPABILITIES: SocialMetricsCapabilities = {
  platform: "x",
  metrics: ["views", "likes", "comments", "shares"],
  maxBatch: 100,
  costPerPostReadUsd: X_POST_READ_USD,
  requiredScopes: ["tweet.read", "users.read"],
};

const NOT_FOUND_TYPE = "https://api.x.com/2/problems/resource-not-found";

export interface XMetricsConfig {
  readonly fetch?: MetricsFetch;
  /** Default `https://api.x.com`. */
  readonly apiBase?: string;
  readonly requestTimeoutMs?: number;
}

export class XMetrics implements SocialMetrics {
  readonly #fetch: MetricsFetch;
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(config: XMetricsConfig = {}) {
    this.#fetch = config.fetch ?? ((url, init) => fetch(url, init));
    this.#base = (config.apiBase ?? "https://api.x.com").replace(/\/$/, "");
    this.#timeoutMs = config.requestTimeoutMs ?? DEFAULT_METRICS_TIMEOUT_MS;
  }

  capabilities(): SocialMetricsCapabilities {
    return X_METRICS_CAPABILITIES;
  }

  async fetch(request: MetricsRequest): Promise<MetricsFetchResult> {
    assertRequest(request, X_METRICS_CAPABILITIES, SOURCE);
    const ids = [...new Set(request.externalPostIds)];
    if (ids.length === 0) return { items: [], missing: [], unavailable: [] };

    const query = new URLSearchParams({
      ids: ids.join(","),
      "post.fields": "public_metrics",
    });
    const res = await getJson(
      this.#fetch,
      `${this.#base}/2/tweets?${query.toString()}`,
      { Authorization: `Bearer ${request.account.accessToken}` },
      { source: SOURCE, timeoutMs: this.#timeoutMs },
    );

    if (res.status < 200 || res.status >= 300) {
      // Por código HTTP, igual que el publicador (`classifyXError`), pero con
      // el vocabulario de lectura: 401 reconectar, 403 sin permiso de lectura,
      // 429 límite, 5xx transitorio; cualquier otro 4xx, un pedido rechazado.
      const cause = { status: res.status, type: str(res.json, "type") };
      if (res.status === 401)
        throw new PortError("unauthorized", "The account needs to be reconnected.", {
          source: SOURCE,
          cause,
        });
      if (res.status === 403)
        throw new PortError(
          "forbidden",
          "The connected account can't read these posts. Reconnect it.",
          { source: SOURCE, cause },
        );
      if (res.status === 429)
        throw transportError(
          "rate_limited",
          "The platform asked to slow down.",
          { source: SOURCE, phase: "prepare" },
          cause,
          retryAfterOf(res.headers),
        );
      if (res.status >= 500) throw serverError(res, { source: SOURCE, phase: "prepare" });
      throw new PortError(
        "provider_contract_violation",
        "The platform rejected the request.",
        { source: SOURCE, cause },
      );
    }

    const data = field(res.json, "data");
    const errors = field(res.json, "errors");
    if (data !== undefined && !Array.isArray(data))
      throw contractViolation(SOURCE, "data no es un array");

    const items: PostMetricsSnapshot[] = [];
    for (const post of (data ?? []) as unknown[]) {
      const id = str(post, "id");
      if (id === undefined) throw contractViolation(SOURCE, "post sin id");
      const m = field(post, "public_metrics");
      items.push({
        externalPostId: id,
        ...snapshotOf({
          views: count(field(m, "impression_count")),
          likes: count(field(m, "like_count")),
          comments: count(field(m, "reply_count")),
          shares: sumDefined(
            count(field(m, "repost_count")),
            count(field(m, "quote_count")),
          ),
        }),
      });
    }

    const found = new Set(items.map((i) => i.externalPostId));
    const missing: string[] = [];
    const unavailable: string[] = [];
    if (Array.isArray(errors)) {
      for (const e of errors as unknown[]) {
        const id = str(e, "resource_id");
        if (id === undefined || found.has(id)) continue;
        if (str(e, "type") === NOT_FOUND_TYPE) missing.push(id);
        else unavailable.push(id);
      }
    }
    // Un id pedido que no vino ni en `data` ni en `errors`: no se afirma nada.
    const reported = new Set([...found, ...missing, ...unavailable]);
    for (const id of ids) if (!reported.has(id)) unavailable.push(id);
    return { items, missing, unavailable };
  }
}
