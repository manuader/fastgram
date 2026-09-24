/**
 * Reintentos, reconexión y carril lento — `PU-PUB-008` (`= P3-PUB-002`),
 * `P3-PUB-004`, `FR-060`, `NFR-005`, `NFR-015`.
 *
 * Lógica pura: qué hacer con un fallo, con un post en `AWAITING_RECONNECT` y
 * con uno que TikTok todavía no terminó. El worker aplica la decisión.
 *
 * ## Reintentar sin duplicar
 *
 * La cola de `publishing` tiene `maxAttempts: 1`, y no cambia: un reintento
 * **a ciegas** puede dejar dos posts en la cuenta. Lo que sí se puede es
 * reintentar **sabiendo** que no llegó nada: el adaptador distingue un fallo
 * antes de entregar (`PortError` con `isRetryable`: un 5xx al crear el
 * contenedor, un 429, un timeout subiendo la media) de uno en el paso que
 * publica (`PublishDeliveryUncertainError`), y sólo el primero se reintenta.
 * El reintento es un job **nuevo** con otra clave, así que la política vive
 * acá y no en la cola.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Esperas antes de cada reintento, en segundos. Tres reintentos: 1, 5 y 15
 * minutos. Los números son nuestros (ni el PRD ni las plataformas publican
 * uno); el criterio es que el último caiga dentro de la media hora de la hora
 * programada, y que un 429 de Meta (código 4/17, «wait and retry») tenga
 * tiempo de vaciarse.
 */
export const PUBLISH_RETRY_DELAYS_SECONDS = [60, 300, 900] as const;

/** Tope a un `Retry-After` de la plataforma: más que esto, se espera esto. */
export const PUBLISH_RETRY_AFTER_MAX_SECONDS = 3600;

export interface PublishFailureFacts {
  /** Reintentos ya hechos (0 en el primer intento). */
  readonly retriesSoFar: number;
  /** `PortError.isRetryable` — transitorio. */
  readonly retryable: boolean;
  /** `PublishDeliveryUncertainError`: la plataforma pudo haber publicado. */
  readonly deliveryUncertain: boolean;
  readonly retryAfterSeconds?: number;
}

export type PublishRetryDecision =
  | { readonly kind: "retry"; readonly delayMs: number; readonly retryNumber: number }
  | { readonly kind: "give_up" };

export function nextPublishRetry(facts: PublishFailureFacts): PublishRetryDecision {
  if (!facts.retryable || facts.deliveryUncertain) return { kind: "give_up" };
  const base = PUBLISH_RETRY_DELAYS_SECONDS[facts.retriesSoFar];
  if (base === undefined) return { kind: "give_up" };
  const hinted =
    facts.retryAfterSeconds !== undefined && facts.retryAfterSeconds > 0
      ? Math.min(facts.retryAfterSeconds, PUBLISH_RETRY_AFTER_MAX_SECONDS)
      : 0;
  return {
    kind: "retry",
    delayMs: Math.max(base, hinted) * SECOND_MS,
    retryNumber: facts.retriesSoFar + 1,
  };
}

/* ------------------------------------------------------------------------ *
 * AWAITING_RECONNECT
 * ------------------------------------------------------------------------ */

/**
 * Cuánto después de su hora un post en `AWAITING_RECONNECT` todavía se
 * reanuda al reconectar.
 *
 * `FR-060` dice: *"se reanuda a `SCHEDULED` cuando el usuario reconecta, o
 * pasa a `FAILED` si la hora programada ya pasó"*. Tomado al pie de la letra
 * no se reanudaría nunca: el post entra en ese estado **a** su hora (la
 * conexión estaba caída al ejecutar), así que al reconectar la hora siempre
 * pasó. Y `NFR-015` pide *"reanudación automática"*. La lectura que concilia
 * las dos: un margen. Dentro de él, se reanuda; fuera, `FAILED`. 24 h es
 * nuestro número: publicar la pieza de ayer hoy todavía tiene sentido, la de
 * la semana pasada no. Decisión que el PRD no cubre; queda en el reporte.
 */
export const AWAITING_RECONNECT_GRACE_MS = 24 * HOUR_MS;

/** Margen desde «ahora» para la hora nueva de un post reanudado. */
export const RESUME_LEAD_MS = MINUTE_MS;

export type ResumeDecision =
  { readonly kind: "resume"; readonly atMs: number } | { readonly kind: "expire" };

export function resumeAfterReconnect(params: {
  readonly scheduledAtMs: number;
  readonly nowMs: number;
  readonly graceMs?: number;
}): ResumeDecision {
  const grace = params.graceMs ?? AWAITING_RECONNECT_GRACE_MS;
  if (params.nowMs - params.scheduledAtMs > grace) return { kind: "expire" };
  return {
    kind: "resume",
    atMs: Math.max(params.scheduledAtMs, params.nowMs + RESUME_LEAD_MS),
  };
}

/* ------------------------------------------------------------------------ *
 * Watcher del carril lento / del inbox de TikTok
 * ------------------------------------------------------------------------ */

/** `NFR-015`: hasta 72 h. */
export const SLOW_LANE_WATCH_WINDOW_MS = 72 * HOUR_MS;
/** Cada cuánto se vuelve a preguntar. El del catálogo del worker (30 min). */
export const SLOW_LANE_POLL_INTERVAL_MS = 30 * MINUTE_MS;

export type WatchStatus =
  "processing" | "in_user_inbox" | "published" | "failed" | "gone";

export type WatchDecision =
  /** Volver a mirar en `delayMs`. El estado del post no cambia (o pasa a inbox). */
  | { readonly kind: "keep_watching"; readonly delayMs: number }
  /** Dejar de mirar sin tocar nada más: terminó o el usuario tiene que actuar. */
  | { readonly kind: "stop" }
  /**
   * Venció la ventana con el post todavía procesando: `FAILED`. **Nunca** se
   * reprograma (`NFR-015`: crearía un duplicado).
   */
  | { readonly kind: "give_up" };

/**
 * Qué hacer después de mirar. `in_user_inbox` sigue mirando hasta la ventana
 * (así se ve cuando el usuario pulsa Post en la app → `PUBLISH_COMPLETE`) y ahí
 * para **sin** fallar: un borrador sin publicar no es un error (`FR-060`).
 */
export function slowLaneWatchDecision(params: {
  readonly status: WatchStatus;
  readonly watchStartedAtMs: number;
  readonly nowMs: number;
  readonly windowMs?: number;
  readonly intervalMs?: number;
}): WatchDecision {
  const windowMs = params.windowMs ?? SLOW_LANE_WATCH_WINDOW_MS;
  const interval = params.intervalMs ?? SLOW_LANE_POLL_INTERVAL_MS;
  if (params.status === "published" || params.status === "failed")
    return { kind: "stop" };
  const expired = params.nowMs - params.watchStartedAtMs >= windowMs;
  if (params.status === "in_user_inbox")
    return expired ? { kind: "stop" } : { kind: "keep_watching", delayMs: interval };
  // `processing` y `gone` (la plataforma no lo encuentra todavía).
  return expired ? { kind: "give_up" } : { kind: "keep_watching", delayMs: interval };
}

/* ------------------------------------------------------------------------ *
 * Códigos estables del worker de publicación
 * ------------------------------------------------------------------------ */

/**
 * `errorCode` que el worker escribe en un post por motivos **nuestros**, no de
 * la plataforma (los de la plataforma salen de `PUBLISH_ERROR_TABLE`). El PRD
 * no los enumera: son decisiones de este sprint, neutrales y estables, y
 * están en el reporte como tales.
 *
 * - `delivery_unconfirmed`: el paso que publica falló de una forma que no dice
 *   si salió (timeout, 5xx). **No** se reintenta: el usuario mira la cuenta.
 * - `awaiting_reconnect_expired`: la conexión no volvió dentro del margen.
 * - `platform_processing_timeout`: 72 h procesando sin terminar (`NFR-015`).
 * - `public_media_unavailable`: sin túnel, la plataforma no puede bajar la
 *   media (mismo código que `PublicMediaUnavailableError` del puerto).
 */
export const PUBLISH_WORKER_ERROR_CODES = [
  "delivery_unconfirmed",
  "awaiting_reconnect_expired",
  "platform_processing_timeout",
  "public_media_unavailable",
] as const;
export type PublishWorkerErrorCode = (typeof PUBLISH_WORKER_ERROR_CODES)[number];
