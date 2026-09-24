/**
 * Entrenar un modelo de la biblioteca del dueño — sprint 8 (agente K).
 *
 * Es el `train` de `pipeline-handler.ts` a nivel **dueño**: las fotos ya están
 * copiadas en `models/{ownerUserId}/{modelId}/` (las copió la API al
 * importar), se suben a Higgsfield, se crea el personaje (Soul ID, el id se
 * guarda **antes** del polling) y se hace polling hasta `completed` o
 * `failed`. Viaja por la misma cola (`influencer-pipeline`) y se despacha por
 * payload (`op: "model-train"`, `parseCharacterModelTrainJob`).
 *
 * ## Por qué no reusa `train` tal cual
 *
 * `train` escribe el estado en `influencers` (con RLS de una marca), lee las
 * fotos del Media Bank y devuelve créditos de AI Studio al fallar. Nada de eso
 * aplica: el modelo no es de una marca, las fotos son claves propias y no hay
 * créditos (modo personal; el tope mensual se chequea en la API antes de
 * encolar, igual que para un influencer). Lo que sí se comparte es todo lo
 * que decide: `phaseFromCharacter`, `uploadProgress`, `pollDelayMs`, los
 * códigos de falla y `RetryLater`.
 *
 * ## Qué conexión usa
 *
 * `character_models` no tiene RLS (scope por dueño en el repositorio), así
 * que va con `withoutCompany`, con el rol de la app si hay uno: la tabla no
 * tiene política que lo impida y los grants son los por defecto (`0002`).
 */
import {
  INFLUENCER_REFERENCE_LIMITS,
  influencerFailureFromPort,
  phaseFromCharacter,
  pollDelayMs,
  uploadProgress,
  type CharacterGen,
  type CharacterSnapshot,
  type InfluencerFailure,
} from "@fastgram/core";
import {
  characterModelDirectory,
  withoutCompany,
  type CharacterModelPatch,
  type CharacterModelTrainJob,
  type Database,
  type Transaction,
} from "@fastgram/db";
import { PortError, isPortError, type Clock, type JobContext } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import {
  RetryLater,
  higgsfieldConfig,
  readAll,
  type InfluencerCharacterMount,
} from "./image-handler.js";

const DEFAULT_TRAIN_POLL_BUDGET_MS = 40 * 60_000;
const MAX_POLL_ERRORS = 8;

export interface ModelTrainDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly mount: InfluencerCharacterMount;
}

export function createModelTrainer(
  deps: ModelTrainDeps,
): (ctx: JobContext<unknown>, job: CharacterModelTrainJob) => Promise<void> {
  const { mount } = deps;
  const owner = <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
    withoutCompany(deps.db, fn, deps.appRole === undefined ? {} : { role: deps.appRole });
  const sleep =
    mount.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const random = mount.random ?? Math.random;

  return async function trainModel(ctx, job): Promise<void> {
    const scope = { ownerUserId: job.ownerUserId };
    const base = { jobId: ctx.jobId, modelId: job.modelId };
    const lastAttempt = ctx.attempt >= ctx.maxAttempts;

    const set = (patch: CharacterModelPatch) =>
      owner((tx) => characterModelDirectory.update(tx, scope, job.modelId, patch));
    const fail = async (failure: InfluencerFailure): Promise<void> => {
      await set({
        status: "failed",
        progress: 100,
        failureCode: failure.code,
        failureMessage: failure.message,
      });
      deps.logger.warn({ ...base, code: failure.code }, "modelo de la biblioteca: falló");
    };
    const portFailure = (
      error: unknown,
      fallback: InfluencerFailure,
    ): InfluencerFailure =>
      isPortError(error)
        ? { code: influencerFailureFromPort(error.code), message: error.message }
        : fallback;

    const row = await owner((tx) => characterModelDirectory.find(tx, scope, job.modelId));
    if (row === null) {
      deps.logger.warn(base, "modelo inexistente (¿borrado?): nada que hacer");
      return;
    }
    if (row.status !== "training") {
      deps.logger.info({ ...base, status: row.status }, "modelo ya cerrado");
      return;
    }

    const config = higgsfieldConfig(await mount.registry.read(), mount.secrets);
    if (config === null) {
      await fail({
        code: "not_configured",
        message: "Higgsfield is no longer set up in Settings → Models.",
      });
      return;
    }
    let client: CharacterGen;
    try {
      client = mount.clientFor(config);
    } catch (error) {
      await fail(
        portFailure(error, { code: "unauthorized", message: "Invalid Higgsfield key." }),
      );
      return;
    }

    let soulId = row.soulId;
    if (soulId === null) {
      const keys = row.referenceKeys;
      if (keys.length < INFLUENCER_REFERENCE_LIMITS.min) {
        await fail({
          code: "references_missing",
          message: `The model needs at least ${String(INFLUENCER_REFERENCE_LIMITS.min)} photos.`,
        });
        return;
      }
      const urls: string[] = [];
      try {
        for (const [i, key] of keys.entries()) {
          const head = await mount.storage.head(key);
          if (head === null) {
            throw new PortError("not_found", "A model photo is missing from storage", {
              source: "worker/character-models",
            });
          }
          const body = await readAll(await mount.storage.get(key));
          urls.push(await client.uploadImage({ body, contentType: head.contentType }));
          await set({ progress: uploadProgress(i + 1, keys.length) });
        }
      } catch (error) {
        const failure = portFailure(error, {
          code: "upload_failed",
          message: "The photos could not be sent to Higgsfield.",
        });
        await fail({
          code: failure.code === "bad_request" ? "upload_failed" : failure.code,
          message: failure.message,
        });
        return;
      }

      let created: CharacterSnapshot;
      try {
        created = await client.createCharacter({ name: row.name, imageUrls: urls });
      } catch (error) {
        // No se reintenta: Higgsfield no acepta clave de idempotencia.
        await fail(
          portFailure(error, {
            code: "provider_unavailable",
            message: "Higgsfield could not create the character.",
          }),
        );
        return;
      }
      soulId = created.id;
      const phase = phaseFromCharacter(created.status);
      // El id va a la fila antes que cualquier otra cosa: una reentrega retoma.
      await set({
        soulId,
        progress: phase.status === "training" ? phase.progress : 50,
      });
      deps.logger.info(
        { ...base, status: created.status },
        "Soul ID creado para el modelo",
      );
    }

    const deadline =
      deps.clock.nowMs() + (mount.trainPollBudgetMs ?? DEFAULT_TRAIN_POLL_BUDGET_MS);
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
          await fail(
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
        await set({
          status: "ready",
          progress: 100,
          failureCode: null,
          failureMessage: null,
        });
        deps.logger.info(base, "modelo de la biblioteca listo");
        return;
      }
      if (phase.status === "failed") {
        await fail({
          code: "training_failed",
          message: state.failReason ?? "Higgsfield could not train the character.",
        });
        return;
      }
      if (phase.progress !== lastProgress) {
        lastProgress = phase.progress;
        await set({ progress: phase.progress });
      }
      if (deps.clock.nowMs() > deadline) {
        if (!lastAttempt) throw new RetryLater("character still training");
        await fail({
          code: "timeout",
          message: "Higgsfield did not finish the character in time.",
        });
        return;
      }
      await sleep(pollDelayMs(attempt++, random()));
    }
  };
}
