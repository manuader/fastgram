/**
 * «Crear desde prompt» en el worker — `EXT-009`, `PU-BLITZ-003`.
 *
 * ## Mismo pipeline que el refill, a propósito
 *
 * El usuario escribe un tema («hacé un meme sobre los lunes para mi
 * cafetería») y, si quiere, fuerza el formato y la cantidad. Lo que sale tiene
 * que ser **indistinguible** de una sugerencia del refill salvo por su origen:
 * mismo editor, mismo aceptar, mismo `build_plan`. Por eso esto no reimplementa
 * nada:
 *
 *  - **leer** es `readRefillSubject` (preferencias, Media Bank, perfil…);
 *  - **planificar** es `planPromptSuggestion` de `core`, que es
 *    `planBlitzSuggestion` con el formato forzado y sin ángulo;
 *  - **escribir la copy** es `withCopy` del refill, con el tema como directiva
 *    principal (y como dato: ver `suggestion-copy.ts`).
 *
 * ## Por qué viaja por la cola `discovery-refill`
 *
 * Una cola nueva pedía tocar `JOB_QUEUES`, el catálogo, el invariante de
 * `check-consistency` y los grants — cinco archivos compartidos — para una
 * política (3 intentos, backoff, 120 s) que es **la misma** del refill: los dos
 * son LLM + selección y ninguno cobra (la trampa 49 separa colas cuando
 * difieren las reglas de cierre, y acá no difieren). El payload lleva
 * `promptRequestId` y {@link createDiscoveryDispatcher} lo manda acá.
 *
 * La `singletonKey` la pone la API con el `requestId`, un UUID nuevo por
 * pedido: nunca se repite (trampas 39 y 45).
 *
 * ## El estado vive en `blitz_prompt_requests`
 *
 * La web pregunta en qué quedó. Cada salida de este handler **cierra** el
 * pedido —`done` con sus sugerencias o `failed` con un código estable— salvo
 * un fallo transitorio con intentos por delante, que se relanza para que la
 * cola reintente y el pedido queda `running`. En el último intento, un fallo
 * transitorio también cierra: si no, el pedido quedaría `running` para siempre
 * y la web haciendo polling contra nada.
 *
 * ## Lo que no hace
 *
 * - **No respeta el objetivo de 5**: el usuario pidió N y entran N.
 * - **No cobra**: igual que el refill. Aceptar la pieza cobra, como siempre.
 */
import {
  BlitzPromptError,
  DomainError,
  isBlitzPromptPayload,
  parseBlitzPromptJob,
  planPromptSuggestion,
  type BlitzContentType,
  type BlitzPromptJob,
  type PlannedBlitzSuggestion,
  type PromptFailureReason,
} from "@fastgram/core";
import {
  completePromptRequest,
  failPromptRequest,
  isOpenPromptRequest,
  lockPromptRequest,
  markPromptRequestRunning,
  withCompany,
  type Database,
  type QueuedSuggestionDraft,
  type Transaction,
} from "@fastgram/db";
import { PortError, type JobContext, type JobHandler, type Rng } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import type { SuggestionCopywriter } from "./copywriter.js";
import {
  readRefillSubject,
  withCopy,
  type CopywriterProvider,
  type RefillSubject,
} from "./refill-handler.js";

export interface BlitzPromptDeps {
  readonly db: Database;
  /** Ver `DiscoveryRefillDeps.rng`: en producción `systemRng`. */
  readonly rng: Rng;
  /** El mismo que el refill: fijo, `null`, o resuelto en cada job. */
  readonly copywriter: SuggestionCopywriter | null | CopywriterProvider;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
}

/** Lo que el handler lee del pedido. */
interface PromptSubject {
  readonly prompt: string;
  readonly contentType: BlitzContentType | null;
  readonly count: number;
}

export function createBlitzPromptHandler(deps: BlitzPromptDeps): JobHandler<unknown> {
  const inCompany = <T>(
    companyId: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> =>
    withCompany(
      deps.db,
      companyId,
      fn,
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );

  /** Cierra el pedido como `failed`. Idempotente: no toca uno ya cerrado. */
  async function fail(job: BlitzPromptJob, reason: PromptFailureReason): Promise<void> {
    await inCompany(job.companyId, (tx) =>
      failPromptRequest(tx, { companyId: job.companyId }, job.promptRequestId, reason),
    );
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parseBlitzPromptJob(ctx.payload);
    if (!parsed.ok) {
      // Bug del productor: no se reintenta (mismo criterio que el refill).
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de crear-desde-prompt inválido",
      );
      return;
    }
    const job = parsed.payload;
    const base = {
      jobId: ctx.jobId,
      companyId: job.companyId,
      promptRequestId: job.promptRequestId,
    };

    // Abrir: leer el pedido y pasarlo a `running`. Uno cerrado es una
    // reentrega de un job que ya terminó: no hay nada que hacer.
    const request = await inCompany(job.companyId, async (tx) => {
      const scope = { companyId: job.companyId };
      const row = await lockPromptRequest(tx, scope, job.promptRequestId);
      if (row === null || !isOpenPromptRequest(row)) return row;
      await markPromptRequestRunning(tx, scope, job.promptRequestId);
      return row;
    });
    if (request === null) {
      deps.logger.error({ ...base }, "pedido de prompt inexistente en este workspace");
      return;
    }
    if (!isOpenPromptRequest(request)) {
      deps.logger.info(
        { ...base, status: request.status },
        "pedido de prompt ya cerrado",
      );
      return;
    }
    const subject: PromptSubject = {
      prompt: request.prompt,
      contentType: request.contentType,
      count: request.count,
    };

    const copywriter =
      typeof deps.copywriter === "function" ? await deps.copywriter() : deps.copywriter;
    if (copywriter === null) {
      // No es silencioso como en el refill: acá hay un usuario esperando, y
      // el código le dice adónde ir (Settings → Models).
      deps.logger.warn({ ...base }, "pedido de prompt sin LLM configurado");
      await fail(job, "llm_not_configured");
      return;
    }

    let refill: RefillSubject;
    let planned: PlannedBlitzSuggestion[];
    try {
      refill = await inCompany(job.companyId, (tx) =>
        readRefillSubject(tx, job.companyId),
      );
      planned = Array.from({ length: subject.count }, () =>
        planPromptSuggestion(deps.rng, refill.preferences, refill.planning, {
          topic: subject.prompt,
          contentType: subject.contentType,
        }),
      );
    } catch (error: unknown) {
      const reason = planningFailure(error);
      if (reason === null) throw error;
      deps.logger.warn(
        {
          ...base,
          reason,
          details: error instanceof BlitzPromptError ? error.details : undefined,
        },
        "pedido de prompt imposible de planificar",
      );
      await fail(job, reason);
      return;
    }

    const drafts: QueuedSuggestionDraft[] = [];
    let lastPortError: PortError | null = null;
    let rejected = 0;
    for (const p of planned) {
      try {
        const draft = await withCopy(copywriter, refill, p, subject.prompt);
        if (draft.ok) {
          drafts.push(draft.draft);
        } else {
          rejected += 1;
          deps.logger.warn(
            { ...base, contentType: p.plan.contentType, reason: draft.reason },
            "pieza de prompt descartada: la copy del modelo no sirve",
          );
        }
      } catch (error: unknown) {
        if (!(error instanceof PortError)) throw error;
        // El mensaje del `PortError` no lleva la key (lo garantiza el
        // adaptador); el código es lo que sirve.
        deps.logger.warn(
          { ...base, contentType: p.plan.contentType, code: error.code },
          "pieza de prompt descartada: el LLM falló",
        );
        lastPortError = error;
      }
    }

    if (drafts.length === 0) {
      // Todas fallaron. Transitorio con intentos por delante: que la cola
      // reintente y el pedido siga `running`. Si no, se cierra.
      if (
        lastPortError !== null &&
        lastPortError.isRetryable &&
        ctx.attempt < ctx.maxAttempts
      ) {
        throw lastPortError;
      }
      const reason: PromptFailureReason =
        lastPortError !== null && rejected === 0 ? "llm_failed" : "copy_rejected";
      deps.logger.error(
        { ...base, planned: planned.length, reason },
        "pedido de prompt sin piezas",
      );
      await fail(job, reason);
      return;
    }

    // Cerrar: con el pedido bloqueado, y sólo si sigue abierto. Es la guarda
    // contra la reentrega (ver `db/repositories/blitz-prompt.ts`).
    const ids = await inCompany(job.companyId, async (tx) => {
      const scope = { companyId: job.companyId };
      const row = await lockPromptRequest(tx, scope, job.promptRequestId);
      if (row === null || !isOpenPromptRequest(row)) return null;
      return completePromptRequest(tx, scope, job.promptRequestId, drafts);
    });

    deps.logger.info(
      {
        ...base,
        requested: subject.count,
        written: drafts.length,
        inserted: ids?.length ?? 0,
      },
      ids === null
        ? "pedido de prompt sin efecto: otra entrega lo cerró primero"
        : "pedido de prompt listo",
    );
  };
}

/** El código estable de un fallo de planificación, o `null` si no es uno. */
function planningFailure(error: unknown): PromptFailureReason | null {
  if (error instanceof BlitzPromptError) return error.reason;
  if (error instanceof DomainError) return "invalid_state";
  return null;
}

/**
 * La cola `discovery-refill` atiende dos cosas: el relleno y los pedidos de
 * prompt (ver la cabecera). Esto elige por el payload: con `promptRequestId`,
 * prompt; sin él, relleno — exactamente lo que el relleno recibía antes.
 */
export function createDiscoveryDispatcher(handlers: {
  readonly refill: JobHandler<unknown>;
  readonly prompt: JobHandler<unknown>;
}): JobHandler<unknown> {
  return (ctx) =>
    isBlitzPromptPayload(ctx.payload) ? handlers.prompt(ctx) : handlers.refill(ctx);
}
