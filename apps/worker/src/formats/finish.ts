/**
 * El último paso de un formato generativo — sprint 7 (agente G),
 * `P4-FORMAT-001`.
 *
 * Lo llama el handler de `ai-studio-generation` (`../genai/handler.ts`,
 * `afterReady`) cuando **cualquier** generación queda `ready`. Si esa
 * generación no tiene corrida de formato (`~/.fastgram/format-runs/<marca>/
 * <id>.json`), no hace nada: es una generación normal de AI Studio.
 *
 * ```
 *   corrida sin pieza ─► el clip (media de la generación) ─► payload
 *   wall-of-text con el texto ─► `contents` (BUILDING, id = id de la corrida)
 *   + `content-build` en la MISMA transacción ─► corrida.contentId
 * ```
 *
 * ## Idempotente
 *
 * La pieza usa el id de la corrida. Si una entrega anterior la creó y murió
 * antes de anotarla, ésta la encuentra por id y sólo anota. El build se
 * encola con la clave `content-build:<id>:<revision>` de siempre: repetirlo no
 * duplica nada.
 *
 * ## Sin content save
 *
 * Como `POST /content/custom/video`, la pieza nace sin `saveBucket`: lo que
 * costó ya se cobró en el tope mensual de generación (el clip), y en el modo
 * personal no hay cuotas (D-06). Un build fallido no tiene nada que devolver.
 */
import { contentBuildPayloadSchema } from "@fastgram/contracts";
import {
  CONTENT_BUILD_QUEUE,
  generativeFormatBuildPayload,
  parseFormatRunRecord,
  type ContentBuildJob,
  type FormatRunRecord,
  type GenerationRecord,
} from "@fastgram/core";
import {
  contentRepository,
  mediaRepository,
  withCompany,
  type Database,
  type Transaction,
} from "@fastgram/db";
import type { Queue } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";

/** Lo que hace falta de `JsonFileCollection`. */
export interface FormatRunStore {
  get(scope: string, id: string): Promise<unknown>;
  update<T>(
    scope: string,
    id: string,
    fn: (current: unknown) => { next?: unknown; result: T },
  ): Promise<T>;
}

export interface FormatFinisherDeps {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly queue: Queue;
  readonly runs: FormatRunStore;
  readonly logger: BuildLogger;
  readonly now?: () => Date;
}

class ClipMissing extends Error {
  override readonly name = "ClipMissing";
}

export function createFormatRunFinisher(
  deps: FormatFinisherDeps,
): (generation: GenerationRecord) => Promise<void> {
  const now = deps.now ?? (() => new Date());
  const log = deps.logger;

  async function note(
    run: FormatRunRecord,
    change: Partial<Pick<FormatRunRecord, "contentId" | "error">>,
  ): Promise<void> {
    await deps.runs.update(run.companyId, run.id, (raw) => {
      const current = parseFormatRunRecord(raw) ?? run;
      return {
        next: { ...current, ...change, updatedAt: now().toISOString() },
        result: null,
      };
    });
  }

  return async function finish(generation: GenerationRecord): Promise<void> {
    const run = parseFormatRunRecord(
      await deps.runs.get(generation.companyId, generation.id),
    );
    if (run === null || run.companyId !== generation.companyId) return;
    if (run.contentId !== null || run.error !== null) return;
    const base = { runId: run.id, companyId: run.companyId, format: run.formatId };

    try {
      const contentId = await withCompany(
        deps.db,
        run.companyId,
        async (tx: Transaction) => {
          const scope = { companyId: run.companyId };
          const existing = await contentRepository.findById(tx, scope, run.id);
          if (existing !== null) return existing.id;

          const clipId = generation.mediaIds[0];
          const clip =
            clipId === undefined
              ? undefined
              : (
                  await mediaRepository.list(tx, scope, {
                    limit: 1,
                    filter: { mediaId: { eq: clipId } },
                  })
                ).items[0];
          if (clip === undefined || clip.mediaType !== "video") {
            throw new ClipMissing("the generated clip is not in the Media Bank");
          }
          const payload = contentBuildPayloadSchema.parse(
            generativeFormatBuildPayload({
              clip: { mediaId: clip.mediaId, url: clip.r2Url },
              overlayText: run.overlayText,
            }),
          );
          const row = await contentRepository.create(tx, scope, {
            id: run.id,
            type: "wall-of-text",
            status: "BUILDING",
            generatedText: run.overlayText,
            buildPayload: payload,
          });
          const job: ContentBuildJob = {
            companyId: run.companyId,
            contentId: row.id,
            contentType: "wall-of-text",
            revision: row.revision,
            reason: "create",
          };
          // ADR-005: la pieza y su build en la misma transacción.
          await deps.queue.enqueue<ContentBuildJob>({
            queue: CONTENT_BUILD_QUEUE,
            payload: job,
            options: {
              transaction: tx,
              singletonKey: `${CONTENT_BUILD_QUEUE}:${row.id}:${String(row.revision)}`,
              retryLimit: 2,
              retryBackoff: true,
            },
          });
          return row.id;
        },
        deps.appRole === undefined ? {} : { role: deps.appRole },
      );
      await note(run, { contentId });
      log.info({ ...base, contentId }, "formato generativo: pieza encolada");
    } catch (error) {
      const missing = error instanceof ClipMissing;
      await note(run, {
        error: missing
          ? {
              code: "clip_missing",
              message: "The generated clip was deleted before the video was built.",
            }
          : { code: "content_failed", message: "The video could not be started." },
      });
      log.error(
        { ...base, why: error instanceof Error ? error.message : "unknown" },
        "formato generativo: no se pudo armar la pieza",
      );
    }
  };
}
