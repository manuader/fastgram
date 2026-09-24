/**
 * Los jobs que encola el lado de publicación del worker — `PU-PUB-007/008`,
 * `P3-PUB-002`, `P3-PUB-004`.
 *
 * ## Cada encolado lleva una clave distinta, y es a propósito
 *
 * El adaptador de pg-boss deriva el **id del job** de `(cola, singletonKey)`
 * y hace `ON CONFLICT DO NOTHING` (trampa 10 del HANDOFF). La ruta que
 * programa usa `publishing:<postId>`; si una reprogramación, un reintento o
 * una reanudación usaran la misma clave, el job **no se crearía** (la fila del
 * job anterior, ya completado, sigue en la tabla) y el post quedaría en
 * `SCHEDULED` para siempre sin que nada falle. Por eso cada una lleva su
 * sufijo: la hora nueva, el número de reintento, el número de vuelta del
 * watcher. Todas siguen siendo deterministas: repetir la misma decisión no
 * duplica el job.
 */
import { JOB_QUEUES } from "@fastgram/core";
import type { JobSpec, QueueTransaction } from "@fastgram/ports";

/** El payload de `publishing` más el número de reintento (el parser lo ignora). */
export interface PublishJobPayload {
  readonly companyId: string;
  readonly postId: string;
  readonly retry?: number;
}

export function publishJob(
  payload: PublishJobPayload,
  at: Date,
  singletonKey: string,
  transaction?: QueueTransaction,
): JobSpec<PublishJobPayload> {
  return {
    queue: JOB_QUEUES.publishing,
    payload,
    options: {
      startAfter: at,
      singletonKey,
      // NFR-015: ningún reintento de la cola. Los reintentos seguros los decide
      // el handler y son jobs nuevos (ver `@fastgram/core` · `nextPublishRetry`).
      retryLimit: 0,
      ...(transaction === undefined ? {} : { transaction }),
    },
  };
}

/** `publishing:<postId>:at:<ms>` — la guarda anti-bot movió la hora. */
export const rescheduleKey = (postId: string, atMs: number): string =>
  `${JOB_QUEUES.publishing}:${postId}:at:${String(atMs)}`;
/** `publishing:<postId>:retry:<n>`. */
export const retryKey = (postId: string, n: number): string =>
  `${JOB_QUEUES.publishing}:${postId}:retry:${String(n)}`;
/** `publishing:<postId>:resume:<ms>` — reanudado tras reconectar. */
export const resumeKey = (postId: string, atMs: number): string =>
  `${JOB_QUEUES.publishing}:${postId}:resume:${String(atMs)}`;
/** Igual que `publishJobFor` de la API: el primer job de un post nuevo. */
export const firstPublishKey = (postId: string): string =>
  `${JOB_QUEUES.publishing}:${postId}`;

/** El watcher del carril lento / del inbox. */
export interface WatchJobPayload {
  readonly companyId: string;
  readonly postId: string;
  /** Desde cuándo se mira: la ventana de 72 h corre desde acá. */
  readonly startedAtMs: number;
  /** Vuelta del watcher (0 = la primera). */
  readonly round: number;
}

export function watchJob(payload: WatchJobPayload, at: Date): JobSpec<WatchJobPayload> {
  return {
    queue: JOB_QUEUES.tiktokSlowLaneWatcher,
    payload,
    options: {
      startAfter: at,
      singletonKey: `${JOB_QUEUES.tiktokSlowLaneWatcher}:${payload.postId}:${String(payload.round)}`,
    },
  };
}

export function parseWatchJob(raw: unknown): WatchJobPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const { companyId, postId, startedAtMs, round } = r;
  if (typeof companyId !== "string" || companyId.length === 0) return null;
  if (typeof postId !== "string" || postId.length === 0) return null;
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) return null;
  if (typeof round !== "number" || !Number.isInteger(round) || round < 0) return null;
  return { companyId, postId, startedAtMs, round };
}

/** El barrido por marca. */
export interface SweepJobPayload {
  readonly companyId: string;
}

/** Cada cuánto se vuelve a mirar una marca con posts esperando reconexión. */
export const SWEEP_REARM_MS = 30 * 60_000;

/**
 * `startAfter` en `at`; la clave va por ventana de 30 min, así que varios
 * pedidos de barrido para la misma ventana son uno solo.
 */
export function sweepJob(companyId: string, at: Date): JobSpec<SweepJobPayload> {
  const bucket = Math.floor(at.getTime() / SWEEP_REARM_MS);
  return {
    queue: JOB_QUEUES.publishingSweep,
    payload: { companyId },
    options: {
      startAfter: at,
      singletonKey: `${JOB_QUEUES.publishingSweep}:${companyId}:${String(bucket)}`,
    },
  };
}

export function parseSweepJob(raw: unknown): SweepJobPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const companyId = (raw as Record<string, unknown>)["companyId"];
  return typeof companyId === "string" && companyId.length > 0 ? { companyId } : null;
}

/** El número de reintento del payload de `publishing`; 0 si no viene. */
export function retryOf(raw: unknown): number {
  if (typeof raw !== "object" || raw === null) return 0;
  const n = (raw as Record<string, unknown>)["retry"];
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 100 ? n : 0;
}
