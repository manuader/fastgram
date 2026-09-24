/**
 * El handler de `influencer-pipeline` — PRD §9.5 #5, `FR-080`, §9.4.
 *
 * `POST /influencers` crea la fila, **cobra 250 créditos de AI Studio** y encola
 * esto. Del otro lado no había nadie, así que el influencer se quedaba en
 * `generating_variations` para siempre y **los 250 créditos no volvían nunca**.
 * Es el mismo agujero que tuvo el content save hasta hace dos tandas, con el
 * mismo final: un cargo sin quien lo devuelva no se devuelve.
 *
 * ## Lo que hoy hace, y por qué es poco a propósito
 *
 * **No hay adaptador de `MediaGeneration`.** El puerto existe
 * (`generateImages`, `trainCharacter`), y no hay ninguna implementación real: el
 * pipeline de `FR-080` son 15–20 minutos de GPU contra un proveedor que todavía
 * no se eligió. Así que sin generador montado este handler hace **lo único
 * honesto que se puede hacer**: marca el influencer `failed` y **devuelve los
 * 250 créditos**. El motivo va al log y no a la fila, porque `DATA-013` no
 * define un campo de error — ver el comentario en `failAndRefund`.
 *
 * Es exactamente el mismo criterio que el handler de `publishing` con su mapa de
 * publicadores vacío. Dejar el influencer en `generating_variations` sería
 * ocultar que no pasa nada; marcarlo `ready` sería mentir sobre un personaje que
 * no se puede usar. Fallar y devolver la plata es la verdad, y es reversible: el
 * usuario lo vuelve a crear cuando el generador exista.
 *
 * ## El reembolso, que es la parte que no se puede romper
 *
 * La guarda contra el doble reembolso **no está acá**: está en
 * `influencerCreditsStore.claimCreditsRefund`, que marca `creditsRefundedAt` y
 * devuelve el cargo **en la misma sentencia**. Quien recibe un objeto es el
 * único que lo va a recibir; quien recibe `null` no tiene nada que hacer. Un
 * `SELECT` seguido de un `UPDATE` no tendría esa propiedad — las dos
 * transacciones leerían `null` y las dos devolverían— y es la misma carrera que
 * dejó pasar 120 de 120 peticiones contra un límite de 60.
 *
 * El monto sale de `influencers.credits_charged`, o sea **lo que de verdad se
 * cobró**, no lo que costaría hoy: `OQ-21` está abierta sobre el tarifario y una
 * tarifa que cambie entre el cobro y el fallo devolvería un número distinto del
 * que se sacó.
 *
 * Y el reembolso va en **la misma transacción** que marca el estado. Si fueran
 * dos, entre ellas habría una ventana donde el personaje ya está muerto y el
 * usuario todavía no tiene sus créditos.
 *
 * ## Con personajes de Higgsfield — `PU-LATER-004`
 *
 * Con `characters` montado (`mount.ts`), la misma cola hace el trabajo real:
 *
 * ```
 *   train: leer las fotos (4–20) de nuestro storage → subirlas a Higgsfield
 *          (generating_variations, 5→40) → crear el personaje (se guarda el id
 *          ANTES de hacer polling) → polling (training 50/75) → ready | failed
 *   image: ver `image-handler.ts`
 * ```
 *
 * Crear el personaje **no se reintenta** (Higgsfield no acepta clave de
 * idempotencia): con `soulId` guardado, una reentrega sólo retoma el polling.
 * Un fallo cierra el personaje con `failure_code` / `failure_message`
 * (migración `0020`) — el motivo ya no se queda sólo en el log — y devuelve los
 * créditos si los hubo. Sin `characters`, todo sigue como antes.
 */

import {
  INFLUENCER_REFERENCE_LIMITS,
  influencerFailureFromPort,
  parseInfluencerPipelineJob,
  parseInfluencerQueueJob,
  phaseFromCharacter,
  pollDelayMs,
  uploadProgress,
  type CharacterGen,
  type CharacterSnapshot,
  type InfluencerFailure,
  type InfluencerPipelineJob,
} from "@fastgram/core";
import {
  influencerCreditsStore,
  influencerRepository,
  mediaRepository,
  withCompany,
  type Database,
  type Transaction,
} from "@fastgram/db";
import {
  isPortError,
  PortError,
  type Clock,
  type JobContext,
  type JobHandler,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { refundAiCredits } from "../support/quota.js";
import {
  createInfluencerImageHandler,
  RetryLater,
  higgsfieldConfig,
  readAll,
  type InfluencerCharacterMount,
} from "./image-handler.js";

/**
 * Lo mínimo del puerto `MediaGeneration` que este handler usa.
 *
 * Se declara acá en vez de importar el puerto entero porque hoy **no hay
 * adaptador** y el handler sólo necesita saber arrancar el pipeline. Cuando
 * exista uno real, esto se reemplaza por el puerto y el cambio es de una línea.
 */
export interface PipelineGenerator {
  start(job: InfluencerPipelineJob): Promise<void>;
}

export interface InfluencerPipelineDeps {
  readonly db: Database;
  /** `undefined` = no hay generador montado. Ver el encabezado. */
  readonly generator?: PipelineGenerator | undefined;
  readonly clock: Clock;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  /**
   * `PU-LATER-004`: personajes e imágenes con Higgsfield. Ausente = el
   * comportamiento de antes (sin generador: `failed` y reembolso).
   */
  readonly characters?: InfluencerCharacterMount | undefined;
}

/** 40 min: por debajo de los 45 (`timeoutSeconds`) de la cola. */
const DEFAULT_TRAIN_POLL_BUDGET_MS = 40 * 60_000;
/** Errores seguidos de polling (red, 5xx) antes de soltar la entrega. */
const MAX_POLL_ERRORS = 8;

/** Los estados de `DATA-013` que significan "el pipeline está corriendo". */
const EN_VUELO: ReadonlySet<string> = new Set(["generating_variations", "training"]);

export function createInfluencerPipelineHandler(
  deps: InfluencerPipelineDeps,
): JobHandler<unknown> {
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

  /**
   * Cierra el personaje como fallido y devuelve los créditos, en una sola
   * transacción.
   *
   * Devuelve cuántos créditos volvieron: `0` significa que no había nada que
   * devolver —nunca se cobró, o alguien ya reembolsó— y es un resultado normal,
   * no un error.
   */
  async function failAndRefund(
    job: Pick<InfluencerPipelineJob, "companyId" | "influencerId">,
    failure?: InfluencerFailure,
  ): Promise<number> {
    return inCompany(job.companyId, async (tx) => {
      const scope = { companyId: job.companyId };
      const row = await influencerCreditsStore.lockInfluencer(
        tx,
        scope,
        job.influencerId,
      );
      if (row === null) return 0;

      // Un pipeline que ya se resolvió no se vuelve a cerrar. Sin esto, un job
      // reentregado marcaría `failed` un personaje que quedó `ready`.
      if (!EN_VUELO.has(row.status)) return 0;

      const charge = await influencerCreditsStore.claimCreditsRefund(
        tx,
        scope,
        job.influencerId,
        new Date(deps.clock.nowMs()),
      );

      if (charge !== null) {
        await refundAiCredits(tx, scope, charge.period, charge.charged);
      }

      // **El motivo no se persiste, porque no hay dónde.** `DATA-013` no define
      // un campo de error en `Influencer` y la tabla no tiene columna: las
      // únicas candidatas serían `internalRefs` —el `jsonb` del que la
      // migración `0007` acaba de sacar el cargo, justamente porque un `update`
      // lo reemplaza entero— o inventar una columna desde acá, que es un cambio
      // de schema y de contrato. Así que el mensaje va al log y el usuario ve
      // un `failed` pelado. Queda reportado.
      //
      // Desde `0020` sí hay dónde (`failure_code` / `failure_message`): lo usa
      // el camino de personajes. El de sin generador sigue sin motivo.
      await influencerRepository.update(tx, scope, job.influencerId, {
        status: "failed",
        ...(failure === undefined
          ? {}
          : { failureCode: failure.code, failureMessage: failure.message }),
      });

      return charge?.charged ?? 0;
    });
  }

  const chars = deps.characters;
  const images =
    chars === undefined ? null : createInfluencerImageHandler({ ...deps, mount: chars });
  const sleep =
    chars?.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const random = chars?.random ?? Math.random;
  const nowMs = (): number => deps.clock.nowMs();

  async function setPhase(
    companyId: string,
    influencerId: string,
    values: { status: "generating_variations" | "training" | "ready"; progress: number },
    extra: { soulId?: string } = {},
  ): Promise<void> {
    await inCompany(companyId, (tx) =>
      influencerRepository.update(tx, { companyId }, influencerId, {
        ...values,
        ...extra,
      }),
    );
  }

  function portFailure(error: unknown, fallback: InfluencerFailure): InfluencerFailure {
    if (isPortError(error)) {
      return { code: influencerFailureFromPort(error.code), message: error.message };
    }
    return fallback;
  }

  /** Crear el personaje: fotos → Higgsfield → id guardado → polling. */
  async function train(
    ctx: JobContext<unknown>,
    mount: InfluencerCharacterMount,
    job: { companyId: string; influencerId: string },
  ): Promise<void> {
    const base = { jobId: ctx.jobId, influencerId: job.influencerId };
    const lastAttempt = ctx.attempt >= ctx.maxAttempts;
    const scope = { companyId: job.companyId };
    const row = await inCompany(job.companyId, (tx) =>
      influencerRepository.findById(tx, scope, job.influencerId),
    );
    if (row === null) {
      deps.logger.warn(base, "influencer inexistente: nada que hacer");
      return;
    }
    if (!EN_VUELO.has(row.status)) {
      deps.logger.info({ ...base, status: row.status }, "influencer ya cerrado");
      return;
    }
    if (row.referenceMediaIds.length === 0) {
      // Una fila del camino viejo (imagen base): no hay generador para eso.
      const devueltos = await failAndRefund(job, {
        code: "references_missing",
        message: "Create the influencer again from 4–20 reference photos.",
      });
      deps.logger.warn({ ...base, devueltos }, "influencer sin fotos de referencia");
      return;
    }

    const config = higgsfieldConfig(await mount.registry.read(), mount.secrets);
    if (config === null) {
      await failAndRefund(job, {
        code: "not_configured",
        message: "Higgsfield is no longer set up in Settings → Models.",
      });
      return;
    }
    let client: CharacterGen;
    try {
      client = mount.clientFor(config);
    } catch (error) {
      await failAndRefund(
        job,
        portFailure(error, { code: "unauthorized", message: "Invalid Higgsfield key." }),
      );
      return;
    }

    let soulId = row.soulId;
    if (soulId === null) {
      // 1. Las fotos, de nuestro storage al de Higgsfield.
      const found = await inCompany(job.companyId, (tx) =>
        mediaRepository.list(tx, scope, {
          limit: row.referenceMediaIds.length,
          filter: { mediaId: { in: [...row.referenceMediaIds] } },
        }),
      );
      const usable = found.items.filter(
        (m) => m.mediaType === "image" && m.status === "ready",
      );
      if (usable.length < INFLUENCER_REFERENCE_LIMITS.min) {
        await failAndRefund(job, {
          code: "references_missing",
          message: `Only ${String(usable.length)} of the reference photos are still in the Media Bank.`,
        });
        return;
      }
      const urls: string[] = [];
      try {
        for (const [i, m] of usable.entries()) {
          const head = await mount.storage.head(m.storageKey);
          if (head === null) {
            throw new PortError(
              "not_found",
              "A reference photo is missing from storage",
              {
                source: "worker/influencers",
              },
            );
          }
          const body = await readAll(await mount.storage.get(m.storageKey));
          urls.push(await client.uploadImage({ body, contentType: head.contentType }));
          await setPhase(job.companyId, job.influencerId, {
            status: "generating_variations",
            progress: uploadProgress(i + 1, usable.length),
          });
        }
      } catch (error) {
        const failure = portFailure(error, {
          code: "upload_failed",
          message: "The reference photos could not be sent to Higgsfield.",
        });
        await failAndRefund(job, {
          code: failure.code === "bad_request" ? "upload_failed" : failure.code,
          message: failure.message,
        });
        deps.logger.error({ ...base, code: failure.code }, "subida de fotos fallida");
        return;
      }

      // 2. Crear el personaje. El id se guarda antes de cualquier otra cosa.
      let created: CharacterSnapshot;
      try {
        created = await client.createCharacter({ name: row.name, imageUrls: urls });
      } catch (error) {
        await failAndRefund(
          job,
          portFailure(error, {
            code: "provider_unavailable",
            message: "Higgsfield could not create the character.",
          }),
        );
        deps.logger.error(
          { ...base, code: isPortError(error) ? error.code : "internal" },
          "crear el personaje falló",
        );
        return;
      }
      soulId = created.id;
      const phase = phaseFromCharacter(created.status);
      await setPhase(
        job.companyId,
        job.influencerId,
        phase.status === "failed"
          ? { status: "training", progress: 50 }
          : { status: phase.status, progress: phase.progress },
        { soulId },
      );
      deps.logger.info(
        { ...base, status: created.status },
        "personaje creado en Higgsfield",
      );
    }

    // 3. Polling hasta `completed` o `failed`.
    const deadline = nowMs() + (mount.trainPollBudgetMs ?? DEFAULT_TRAIN_POLL_BUDGET_MS);
    let attempt = 0;
    let errors = 0;
    let lastProgress = -1;
    for (;;) {
      let state: CharacterSnapshot;
      try {
        state = await client.getCharacter(soulId);
        errors = 0;
      } catch (error) {
        const retryable = isPortError(error) ? error.isRetryable : true;
        errors += 1;
        if (!retryable || errors >= MAX_POLL_ERRORS) {
          if (retryable && !lastAttempt) throw new RetryLater("too many polling errors");
          await failAndRefund(
            job,
            portFailure(error, {
              code: "provider_unavailable",
              message: "Higgsfield did not answer about the character.",
            }),
          );
          return;
        }
        await sleep(pollDelayMs(attempt++, random()));
        continue;
      }
      const phase = phaseFromCharacter(state.status);
      if (phase.status === "ready") {
        await setPhase(job.companyId, job.influencerId, {
          status: "ready",
          progress: 100,
        });
        deps.logger.info(base, "personaje listo");
        return;
      }
      if (phase.status === "failed") {
        await failAndRefund(job, {
          code: "training_failed",
          message: state.failReason ?? "Higgsfield could not train the character.",
        });
        deps.logger.warn(base, "Higgsfield cerró el personaje como fallido");
        return;
      }
      if (phase.progress !== lastProgress) {
        lastProgress = phase.progress;
        await setPhase(job.companyId, job.influencerId, {
          status: "training",
          progress: phase.progress,
        });
      }
      if (nowMs() > deadline) {
        if (!lastAttempt) throw new RetryLater("character still training");
        await failAndRefund(job, {
          code: "timeout",
          message: "Higgsfield did not finish the character in time.",
        });
        return;
      }
      await sleep(pollDelayMs(attempt++, random()));
    }
  }

  async function legacy(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parseInfluencerPipelineJob(ctx.payload);
    if (!parsed.ok) {
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de influencer-pipeline inválido",
      );
      return;
    }

    const job = parsed.payload;
    const base = { jobId: ctx.jobId, influencerId: job.influencerId };

    if (deps.generator === undefined) {
      const devueltos = await failAndRefund(job);
      deps.logger.warn(
        { ...base, devueltos, motivo: "no hay adaptador de MediaGeneration montado" },
        "no hay generador montado: el personaje se cierra y los créditos vuelven",
      );
      return;
    }

    try {
      await deps.generator.start(job);
      deps.logger.info(base, "pipeline de influencer arrancado");
    } catch (error: unknown) {
      const code = error instanceof PortError ? error.code : "unknown";
      const devueltos = await failAndRefund(job);
      deps.logger.error({ ...base, code, devueltos, error }, "el pipeline falló");
    }
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    if (chars === undefined || images === null) {
      await legacy(ctx);
      return;
    }
    const parsed = parseInfluencerQueueJob(ctx.payload);
    if (!parsed.ok) {
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de influencer-pipeline inválido",
      );
      return;
    }
    const job = parsed.payload;
    try {
      if (job.op === "image") {
        await images(ctx, job);
      } else {
        await train(ctx, chars, job);
      }
    } catch (error) {
      if (error instanceof RetryLater) {
        deps.logger.warn(
          { jobId: ctx.jobId, influencerId: job.influencerId, why: error.message },
          "influencer-pipeline: se retoma después",
        );
      }
      throw error;
    }
  };
}
