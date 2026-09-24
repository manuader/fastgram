/**
 * Lo común de los cinco publicadores: validar contra las propias capacidades,
 * idempotencia por `idempotencyKey`, y las partes del puerto que ninguno
 * implementa todavía (métricas, cancelación).
 */
import {
  MAX_METRICS_BATCH,
  PortError,
  isPublishDeliveryUncertain,
  type CancelOutcome,
  type PostMetrics,
  type PublishFailure,
  type PublishFailureReason,
  type PublishRef,
  type PublishRequest,
  type PublishStatus,
  type SocialPublishCapabilities,
} from "@fastgram/ports";

import type { Sleep } from "./http.js";

/**
 * Rechaza (`bad_request`) lo que contradice las capacidades declaradas. Es la
 * aserción de contrato «rechaza un payload que contradice sus propias
 * capacidades», y va **antes** de cualquier llamada: un `bad_request` acá no
 * gasta cuota de la plataforma.
 */
export function assertPublishable(
  request: PublishRequest,
  caps: SocialPublishCapabilities,
  source: string,
): void {
  const reject = (message: string): never => {
    throw new PortError("bad_request", message, { source });
  };
  if (!caps.accountTypes.includes(request.account.accountType))
    reject(
      `This platform route doesn't publish to ${request.account.accountType} accounts.`,
    );
  if (!caps.mediaKinds.includes(request.media.kind))
    reject(`This platform route doesn't publish ${request.media.kind} posts.`);
  if (request.media.kind !== "text" && request.media.urls.length === 0)
    reject("There is no media to publish.");
  if ([...request.caption].length > caps.captionLimits.caption)
    reject(
      `The caption is longer than ${String(caps.captionLimits.caption)} characters.`,
    );
  if (
    request.postingMode !== undefined &&
    !caps.postingModes.includes(request.postingMode)
  )
    reject("This posting mode isn't available for this platform.");
  if (request.aiGenerated === true && !caps.supportsAiLabel)
    reject("This platform route can't label AI-generated content.");
}

/** Un token es obligatorio para los cinco: la plataforma no tiene otra forma. */
export function requireToken(
  request: { readonly account: { readonly accessToken?: string } },
  source: string,
): string {
  const token = request.account.accessToken;
  if (token === undefined || token.length === 0) {
    throw new PortError("unauthorized", "The account has no valid access token.", {
      source,
    });
  }
  return token;
}

export function requirePlatformUserId(
  account: { readonly platformUserId?: string },
  source: string,
): string {
  const id = account.platformUserId;
  if (id === undefined || id.length === 0) {
    throw new PortError("bad_request", "The connected account id is missing.", {
      source,
    });
  }
  return id;
}

/** Un `PublishStatus` fallido con motivo neutral y mensaje seguro. */
export function failed(reason: PublishFailureReason, message: string): PublishStatus {
  const failure: PublishFailure = { reason, message };
  return { kind: "failed", failure };
}

/**
 * Idempotencia por `idempotencyKey` en el proceso (`NFR-015`).
 *
 * - Mientras un intento corre, un segundo con la misma clave **espera al
 *   primero** en vez de publicar en paralelo.
 * - Un resultado (publicado, fallido, en inbox) queda: el reintento devuelve
 *   el mismo.
 * - Un error **antes de entregar** se olvida, para que el reintento pueda
 *   volver a probar. Uno de **entrega incierta** queda: repetirlo podría
 *   duplicar.
 *
 * Es memoria del proceso: si el worker se reinicia entre `publish()` y la
 * escritura en la base, esto no lo salva. Lo que queda después es el
 * `externalPostId` guardado en `posts` y la regla del handler de no tocar un
 * post que ya no está en `SCHEDULED`. Queda en el reporte.
 */
export class IdempotencyCache {
  readonly #entries = new Map<string, Promise<PublishStatus>>();
  readonly #max: number;

  constructor(max = 1000) {
    this.#max = max;
  }

  run(key: string, attempt: () => Promise<PublishStatus>): Promise<PublishStatus> {
    const existing = this.#entries.get(key);
    if (existing !== undefined) return existing;
    const promise = attempt().catch((error: unknown) => {
      if (!isPublishDeliveryUncertain(error)) this.#entries.delete(key);
      throw error;
    });
    this.#entries.set(key, promise);
    if (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    return promise;
  }
}

/**
 * Métricas: **no implementadas** en este sprint (son de `PU-AUTO-*`, sprint
 * 5). Se respeta el tope de `NFR-012` y se devuelve vacío, que el puerto
 * define como «la plataforma no reconoce estos ids» — no «tienen cero».
 */
export function metricsNotImplemented(
  refs: readonly PublishRef[],
  source: string,
): readonly PostMetrics[] {
  if (refs.length > MAX_METRICS_BATCH) {
    throw new PortError(
      "bad_request",
      `At most ${String(MAX_METRICS_BATCH)} posts per metrics request.`,
      { source },
    );
  }
  return [];
}

/**
 * Cancelar un post ya entregado: ninguna de estas rutas lo ofrece como
 * «cancelar» (borrar un post publicado es otra operación, y destructiva). El
 * worker cancela **antes** de publicar, sobre la fila.
 */
export const NOT_CANCELLABLE: CancelOutcome = { cancelled: false, pending: false };

/**
 * Espera a que `check` diga que terminó. Devuelve el último valor si se acaba
 * el tiempo (quien llama decide qué significa).
 */
export async function pollUntil<T>(
  check: () => Promise<T>,
  done: (value: T) => boolean,
  options: {
    readonly intervalMs: number;
    readonly timeoutMs: number;
    readonly sleep: Sleep;
  },
): Promise<{ readonly value: T; readonly timedOut: boolean }> {
  let waited = 0;
  for (;;) {
    const value = await check();
    if (done(value)) return { value, timedOut: false };
    if (waited >= options.timeoutMs) return { value, timedOut: true };
    await options.sleep(options.intervalMs);
    waited += options.intervalMs;
  }
}
