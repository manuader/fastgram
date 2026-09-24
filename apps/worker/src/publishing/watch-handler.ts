/**
 * El watcher del carril lento / del inbox — `P3-PUB-004`, `NFR-015`,
 * `PU-PUB-006`, PRD §9.5 #9. Cola `tiktok-slow-lane-watcher`.
 *
 * Lo encola el handler de `publishing` cuando la plataforma devolvió
 * `processing` (TikTok todavía procesando la subida; un Reel de Facebook que no
 * terminó de publicarse) o `in_user_inbox` (el borrador llegó al inbox de
 * TikTok y falta que el creador pulse Post). Cada vuelta pregunta con
 * `getStatus` y decide con `slowLaneWatchDecision` de `@fastgram/core`:
 *
 * - `published` → `POSTED`. Es cómo se entera la app de que el creador
 *   terminó el borrador (`PUBLISH_COMPLETE`).
 * - `failed` / `cancelled` → se escribe y se para.
 * - `in_user_inbox` → `IN_USER_INBOX` y se sigue mirando hasta 72 h; ahí se
 *   para **sin** fallar (un borrador sin publicar no es un error).
 * - `processing` → se sigue mirando; a las 72 h, `FAILED` con
 *   `platform_processing_timeout`.
 *
 * **Nunca se republica ni se reprograma** (`NFR-015`: *"nunca duplicar un post
 * en carril lento"*). El watcher sólo lee y escribe la fila.
 *
 * Cada vuelta es un job nuevo con `startAfter` (+30 min) y su propia clave, en
 * vez de relanzar para gastar reintentos de la cola: así un error de verdad
 * (la base caída) sigue usando los reintentos del catálogo, y «todavía no»
 * no se registra como un fallo.
 */
import {
  SLOW_LANE_WATCH_WINDOW_MS,
  slowLaneWatchDecision,
  stablePublishError,
  type WatchStatus,
} from "@fastgram/core";
import {
  connectionRepository,
  postPublishStore,
  postRepository,
  withCompany,
  type Database,
  type Transaction,
} from "@fastgram/db";
import {
  isPortError,
  type Clock,
  type ConnectionTokens,
  type JobContext,
  type JobHandler,
  type PublishStatus,
  type Queue,
  type SocialPublisher,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";

import { parseWatchJob, watchJob, type WatchJobPayload } from "./jobs.js";

export interface WatchDeps {
  readonly db: Database;
  readonly publishers: Readonly<Record<string, SocialPublisher>>;
  readonly queue: Queue;
  readonly clock: Clock;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly tokens?: ConnectionTokens | undefined;
}

const WATCHED = ["UPLOADING_TO_TIKTOK", "IN_USER_INBOX"] as const;

export function createWatchHandler(deps: WatchDeps): JobHandler<unknown> {
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

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parseWatchJob(ctx.payload);
    if (parsed === null) {
      deps.logger.error({ jobId: ctx.jobId }, "payload del watcher inválido");
      return;
    }
    const job: WatchJobPayload = parsed;
    const scope = { companyId: job.companyId };
    const base = { jobId: ctx.jobId, postId: job.postId, round: job.round };

    const subject = await inCompany(job.companyId, async (tx) => {
      const post = await postRepository.findById(tx, scope, job.postId);
      if (post === null) return null;
      if (!(WATCHED as readonly string[]).includes(post.status)) return null;
      if (post.externalPostId === null || post.connectionId === null) return null;
      const connection = await connectionRepository.findById(
        tx,
        scope,
        post.connectionId,
      );
      return {
        platform: post.platform,
        externalPostId: post.externalPostId,
        connectionId: post.connectionId,
        platformUserId: connection?.platformUserId,
      };
    });
    if (subject === null) {
      deps.logger.info(base, "watcher: el post ya no está en un estado vigilado");
      return;
    }

    const publisher = deps.publishers[subject.platform];
    if (publisher === undefined) {
      deps.logger.warn(
        { ...base, platform: subject.platform },
        "watcher: sin publicador",
      );
      return keepWatching("processing");
    }

    let found: PublishStatus | null;
    try {
      const accessToken =
        deps.tokens === undefined
          ? undefined
          : await deps.tokens.getAccessToken(subject.connectionId, scope);
      found = await publisher.getStatus({
        account: {
          accountType: "oauth",
          accountId: subject.connectionId,
          ...(accessToken === undefined ? {} : { accessToken }),
          ...(subject.platformUserId === undefined
            ? {}
            : { platformUserId: subject.platformUserId }),
        },
        externalPostId: subject.externalPostId,
      });
    } catch (error: unknown) {
      // Sin token o sin plataforma: no se puede mirar, pero el post no cambió.
      // Se vuelve a intentar en la próxima vuelta (si no venció la ventana).
      deps.logger.warn(
        { ...base, code: isPortError(error) ? error.code : "unknown" },
        "watcher: no se pudo consultar el estado",
      );
      return keepWatching("processing");
    }

    const watchStatus: WatchStatus =
      found === null ? "gone" : found.kind === "cancelled" ? "failed" : found.kind;

    if (found !== null && found.kind !== "processing") {
      await writeFound(found);
    }
    return keepWatching(watchStatus);

    async function writeFound(status: PublishStatus): Promise<void> {
      await inCompany(job.companyId, async (tx) => {
        const post = await postPublishStore.lockPost(tx, scope, job.postId);
        if (post === null || !(WATCHED as readonly string[]).includes(post.status))
          return;
        const now = new Date(deps.clock.nowMs());
        const next =
          status.kind === "published"
            ? "POSTED"
            : status.kind === "in_user_inbox"
              ? "IN_USER_INBOX"
              : status.kind === "cancelled"
                ? "CANCELLED"
                : "FAILED";
        if (next === post.status) return;
        await postRepository.update(tx, scope, job.postId, {
          status: next,
          ...(status.permalink === undefined ? {} : { postUrl: status.permalink }),
          ...(next === "POSTED" ? { postedAt: now, tiktokProcessingDelayed: false } : {}),
          ...(status.failure === undefined
            ? {}
            : // P3-PUB-006: código y mensaje estables, nunca el crudo.
              stablePublishError(post.platform, status.failure)),
        });
      });
      deps.logger.info({ ...base, kind: status.kind }, "watcher: estado nuevo");
    }

    async function keepWatching(status: WatchStatus): Promise<void> {
      const nowMs = deps.clock.nowMs();
      const decision = slowLaneWatchDecision({
        status,
        watchStartedAtMs: job.startedAtMs,
        nowMs,
      });
      if (decision.kind === "keep_watching") {
        await deps.queue.enqueue(
          watchJob({ ...job, round: job.round + 1 }, new Date(nowMs + decision.delayMs)),
        );
        return;
      }
      if (decision.kind === "give_up") {
        await inCompany(job.companyId, async (tx) => {
          const post = await postPublishStore.lockPost(tx, scope, job.postId);
          if (post === null || post.status !== "UPLOADING_TO_TIKTOK") return;
          await postRepository.update(tx, scope, job.postId, {
            status: "FAILED",
            errorCode: "platform_processing_timeout",
            errorMessage: `The platform didn't finish processing this post within ${String(
              SLOW_LANE_WATCH_WINDOW_MS / 3_600_000,
            )} hours.`,
          });
        });
        deps.logger.warn(base, "watcher: venció la ventana de 72 h");
      }
    }
  };
}
