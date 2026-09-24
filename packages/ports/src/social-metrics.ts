/**
 * Puerto SocialMetrics — `PU-AUTO-004` (`= P3-METRIC-001`), `FR-120`,
 * `NFR-012`, `NFR-016`, PRD §9.5 #10 (`metrics-sync`).
 *
 * ## Por qué un puerto aparte y no `SocialPublisher.fetchMetrics`
 *
 * `SocialPublisher` ya declara `fetchMetrics`, pero lo que hace falta para
 * leer métricas no es lo que hace falta para publicar:
 *
 *  - **Otro scope.** Leer insights pide permisos que publicar no pide
 *    (`instagram_business_manage_insights`, `threads_manage_insights`,
 *    `read_insights`). Un adaptador que publica bien puede no poder leer, y la
 *    diferencia tiene que llegar hasta la pantalla («reconectá para dar
 *    permiso de métricas»), no quedar en un array vacío.
 *  - **Otro costo.** En X leer un post **se cobra** (US$0,005 por post, ver
 *    el adaptador). Publicar ya se cobraba, pero un job que corre cada hora
 *    sobre todos los posts es otra escala: la capacidad dice cuánto cuesta y
 *    quien programa decide.
 *  - **Éxito parcial.** El publicador devuelve «lo que la plataforma
 *    reconoció»; acá hace falta distinguir un id que la plataforma no conoce
 *    (`missing`) de un post que existe y tiene cero (`NFR-016`).
 *
 * `SocialPublisher.fetchMetrics` queda como está (los publicadores lo
 * implementan vacío); este puerto es el que usa el worker de `metrics-sync`.
 *
 * ## Errores (`PortError`) — de la llamada entera, no de un post
 *
 *  - `unauthorized` — el token no vale: la conexión hay que reconectarla.
 *  - `forbidden` — el token vale pero **no tiene el scope de lectura** (se
 *    conectó antes de que se pidiera). Lo mismo: reconectar, pero el motivo es
 *    otro y la pantalla lo dice distinto.
 *  - `rate_limited` (con `retryAfterSeconds` si vino), `provider_unavailable`,
 *    `timeout` — transitorios.
 *  - `bad_request` — más de {@link SocialMetricsCapabilities.maxBatch} ids.
 *  - `provider_contract_violation` — 2xx con una forma no documentada.
 *
 * Ningún mensaje del proveedor sale por acá: los adaptadores lo mandan a
 * `cause` y el mensaje es una constante segura de mostrar.
 */

/** Las redes que tienen adaptador de métricas. TikTok no: ver `adapters/metrics`. */
export const METRICS_PLATFORMS = ["instagram", "threads", "facebook", "x"] as const;
export type MetricsPlatform = (typeof METRICS_PLATFORMS)[number];

/** Lo que una red puede devolver por post. Cada adaptador declara el subconjunto. */
export const POST_METRIC_NAMES = ["views", "likes", "comments", "shares"] as const;
export type PostMetricName = (typeof POST_METRIC_NAMES)[number];

export interface SocialMetricsCapabilities {
  readonly platform: MetricsPlatform;
  /**
   * Las métricas que la red da para un post publicado por esta app. Una
   * métrica que no está acá vuelve `undefined`, que **no es cero**.
   */
  readonly metrics: readonly PostMetricName[];
  /** Ids por llamada a {@link SocialMetrics.fetch}. */
  readonly maxBatch: number;
  /**
   * US$ por post leído, si la plataforma cobra la lectura. `0` = no cobra (o
   * no está documentado que cobre). Lo usa el worker para decidir si lee.
   */
  readonly costPerPostReadUsd: number;
  /** Scopes OAuth sin los que la lectura devuelve `forbidden`. */
  readonly requiredScopes: readonly string[];
}

export interface MetricsAccount {
  /** Credencial ya descifrada. Nunca se loguea ni se devuelve (`NFR-007`). */
  readonly accessToken: string;
}

export interface MetricsRequest {
  readonly account: MetricsAccount;
  /** `posts.externalPostId`. Máx. `maxBatch`, sin repetidos. */
  readonly externalPostIds: readonly string[];
}

export interface PostMetricsSnapshot {
  readonly externalPostId: string;
  /** `undefined` = la red no la da (o no la dio): **no es cero**. */
  readonly views?: number;
  readonly likes?: number;
  readonly comments?: number;
  readonly shares?: number;
}

export interface MetricsFetchResult {
  readonly items: readonly PostMetricsSnapshot[];
  /**
   * Ids que la plataforma no reconoce (borrado, o de otra cuenta). Éxito
   * parcial, como `ERR-F02`: un id perdido no tira el lote.
   */
  readonly missing: readonly string[];
  /**
   * Ids que existen pero cuyas métricas la plataforma se negó a dar para ese
   * post (p. ej. una métrica que no aplica a ese tipo de media). Tampoco tira
   * el lote, y tampoco es cero.
   */
  readonly unavailable: readonly string[];
}

export interface SocialMetrics {
  /** Estático por adaptador. No hace red. */
  capabilities(): SocialMetricsCapabilities;

  fetch(request: MetricsRequest): Promise<MetricsFetchResult>;
}
