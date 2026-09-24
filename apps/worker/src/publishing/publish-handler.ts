/**
 * El handler de `publishing` — PRD §9.5 #8, `FR-060`, `NFR-005`, `NFR-015`,
 * `PU-PUB-003…008`.
 *
 * `POST /content/:id/schedule` (y el auto-slot del calendario) crea un `Post`
 * por (contenido × plataforma × cuenta) y encola uno de estos por fila, con
 * `startAfter` en la hora pedida.
 *
 * ## Este handler es el opuesto del de build, y conviene entender por qué
 *
 * El de contenido **reintenta** un fallo transitorio, porque construir dos
 * veces no cuesta nada más que CPU. Publicar sí: un segundo intento después de
 * un timeout del proveedor puede dejar **dos posts en la cuenta del usuario**,
 * y eso no se deshace desde acá. Por eso el catálogo le pone `maxAttempts: 1` y
 * la ruta encola con `retryLimit: 0`, y por eso este archivo **nunca relanza**.
 *
 * Las reglas que no se pueden romper:
 *
 * 1. **La `idempotencyKey` es el id del post, estable.** Si el proceso se cae
 *    entre el `publish()` y la escritura, y el job se vuelve a entregar, el
 *    adaptador devuelve el resultado anterior en vez de publicar de nuevo
 *    (mientras el proceso viva: ver `IdempotencyCache` en los adaptadores).
 *
 * 2. **Después de `publish()`, la base tiene que reflejar la realidad, pase lo
 *    que pase.** Si entre la lectura y la escritura alguien canceló, el post
 *    salió igual: se escribe el resultado real y se loguea la carrera.
 *
 * 3. **Nada se publica sin fila bloqueada.** `POST /posts/cancel` corre en otro
 *    proceso; sin el `FOR UPDATE` los dos deciden sobre la misma fila.
 *
 * 4. **Sólo se reintenta lo que no llegó** (`PU-PUB-008`). El adaptador separa
 *    un fallo antes de entregar (`PortError` reintentable: se reintenta con un
 *    job **nuevo**, 1/5/15 min, `nextPublishRetry`) de uno en el paso que
 *    publica (`PublishDeliveryUncertainError`: `FAILED` con
 *    `delivery_unconfirmed`, nunca solo). Sin `queue` no hay reintentos.
 *
 * ## Lo que agrega el sprint 3
 *
 * - **Un post con hora futura se saltea.** Mover un post en el calendario
 *   puede ser actualizar la hora: el job viejo dispara, ve la hora nueva en el
 *   futuro y no hace nada; el job de la hora nueva es el que publica.
 * - **`AWAITING_RECONNECT`** (`FR-060`, `P3-PUB-002`): una conexión que no
 *   está `active`, o un token que la plataforma rechaza, deja el post
 *   esperando en vez de fallarlo. El barrido por marca
 *   (`sweep-handler.ts`) lo reanuda cuando la conexión vuelve.
 * - **Guardas anti-bot** (`PU-PUB-007`) justo antes de hablar con la
 *   plataforma: tope por red y día, separación entre marcas (→ se
 *   **reprograma**) y la misma pieza en dos marcas (→ se falla). Lógica pura
 *   en `@fastgram/core` (`evaluatePublishGuards`).
 * - **La media por la URL que la plataforma necesita** (`media.ts`): pública
 *   por el túnel, o firmada del bucket.
 * - **El token**, del puerto `ConnectionTokens` (descifra y refresca).
 * - **El carril lento / el inbox** (`P3-PUB-004`): `processing` o
 *   `in_user_inbox` encolan el watcher (`watch-handler.ts`), que mira hasta
 *   72 h. Nunca se reprograma.
 * - **`externalPostId`** se guarda (columna de `0008`): es lo que el watcher
 *   necesita para volver a preguntar.
 */

import {
  PUBLISH_PLATFORMS,
  PortError,
  isPortError,
  isPublicMediaUnavailable,
  isPublishDeliveryUncertain,
  type Clock,
  type ConnectionTokens,
  type JobContext,
  type JobHandler,
  type PublishMediaKind,
  type PublishRequest,
  type PublishStatus,
  type Queue,
  type SocialPublisher,
} from "@fastgram/ports";
import {
  evaluatePublishGuards,
  nextPublishRetry,
  parsePublishJob,
  publishGuardPolicyFor,
  translatePublishFailure,
  PUBLISH_GUARD_HORIZON_DAYS,
  SLOW_LANE_POLL_INTERVAL_MS,
  type PublishJob,
  type StoredStrategyForGuards,
} from "@fastgram/core";
import {
  brandStrategyRepository,
  connectionRepository,
  contentRepository,
  postPublishStore,
  postRepository,
  withCompany,
  type Database,
  type Transaction,
} from "@fastgram/db";

import type { BuildLogger } from "../content/build-handler.js";
import type { ContentFingerprinter } from "./fingerprint.js";
import {
  SWEEP_REARM_MS,
  publishJob,
  rescheduleKey,
  retryKey,
  retryOf,
  sweepJob,
  watchJob,
} from "./jobs.js";
import { mediaSourceFor, resolveMediaUrls, type MediaResolverDeps } from "./media.js";
import { loadGuardNeighbors } from "./neighbors.js";

export interface PublishDeps {
  readonly db: Database;
  /**
   * Un publicador **por plataforma**: las capacidades, los límites de copy y
   * los modos de publicación son distintos en cada una, y el puerto los declara
   * por adaptador.
   */
  readonly publishers: Readonly<Record<string, SocialPublisher>>;
  readonly clock: Clock;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  /**
   * Para reprogramar (guardas), reintentar, encolar el watcher y el barrido.
   * Sin cola: ni guardas ni reintentos — el comportamiento de antes.
   */
  readonly queue?: Queue | undefined;
  /** Sin esto, la cuenta viaja sin token (sólo sirve con publicadores de memoria). */
  readonly tokens?: ConnectionTokens | undefined;
  /** Sin esto, las URLs de `contents.files` se pasan tal cual. */
  readonly media?: MediaResolverDeps | undefined;
  /** Sin esto, la regla «la misma pieza en dos marcas» no se evalúa. */
  readonly fingerprinter?: ContentFingerprinter | null | undefined;
  /** Default: encendidas si hay `queue` (reprogramar exige encolar). */
  readonly guards?: boolean | undefined;
}

/** Lo que se lee de la fila antes de publicar. */
interface PublishSubject {
  readonly postId: string;
  readonly platform: string;
  readonly accountType: "oauth" | "warmed";
  readonly accountId: string;
  readonly connectionId: string | null;
  readonly platformUserId: string | undefined;
  readonly contentId: string;
  readonly revision: number;
  readonly mediaKind: PublishMediaKind;
  readonly files: readonly string[];
  /** Del `canvas` del payload de build (`renderDimensionsOf`). */
  readonly dimensions: { readonly width: number; readonly height: number } | null;
  readonly scheduledAtMs: number;
  readonly caption: string;
  readonly description: string | undefined;
  readonly postingMode: "inbox" | "direct" | undefined;
  readonly privacyLevel: PublishRequest["privacyLevel"];
  readonly aiGenerated: boolean | undefined;
  readonly paidPartnership: boolean | undefined;
  readonly strategy: StoredStrategyForGuards | null;
  readonly timezone: string;
}

type ReadOutcome =
  | { readonly kind: "publish"; readonly subject: PublishSubject }
  /** No hay nada que hacer y no es un error. */
  | { readonly kind: "skip"; readonly why: string }
  /** La conexión no está activa: la fila ya quedó en `AWAITING_RECONNECT`. */
  | { readonly kind: "awaiting_reconnect" }
  /** No se puede publicar nunca: se cierra la fila con el motivo. */
  | { readonly kind: "fail"; readonly code: string; readonly message: string };

/**
 * De qué tipo de media es una pieza, según su tipo de contenido.
 *
 * `slideshow` es su propio `PublishMediaKind` y no `carousel`: el puerto los
 * distingue, y cada adaptador decide (Instagram: una sola imagen es `image`,
 * varias son carrusel). Los formatos de video y `custom` son `video`.
 */
function mediaKindOf(contentType: string): PublishMediaKind {
  return contentType === "slideshow" ? "slideshow" : "video";
}

/**
 * Ancho y alto del render, leídos del `canvas` del payload de build
 * (`FR-070`: `{canvas:{width,height},…}` en los formatos de video,
 * `{images:[{canvas}]}` en slideshow). `null` si el payload no los trae.
 *
 * YouTube los necesita para saber si la pieza es un Short **antes** de gastar
 * una subida de la cuota (`PU-LATER-001`); el resto de los publicadores los
 * ignora.
 */
export function renderDimensionsOf(
  buildPayload: unknown,
): { readonly width: number; readonly height: number } | null {
  const dims = (canvas: unknown) => {
    if (typeof canvas !== "object" || canvas === null) return null;
    const { width, height } = canvas as { width?: unknown; height?: unknown };
    return typeof width === "number" &&
      typeof height === "number" &&
      width > 0 &&
      height > 0
      ? { width, height }
      : null;
  };
  if (typeof buildPayload !== "object" || buildPayload === null) return null;
  const payload = buildPayload as { canvas?: unknown; images?: unknown };
  const direct = dims(payload.canvas);
  if (direct !== null) return direct;
  if (Array.isArray(payload.images) && payload.images.length > 0) {
    const first: unknown = payload.images[0];
    return typeof first === "object" && first !== null
      ? dims((first as { canvas?: unknown }).canvas)
      : null;
  }
  return null;
}

/** Los estados de `posts` que este handler escribe tras publicar. */
type PostStatus =
  "POSTED" | "FAILED" | "CANCELLED" | "IN_USER_INBOX" | "UPLOADING_TO_TIKTOK";

/**
 * `PublishStatusKind` → el estado del post. Los cinco del puerto, sin default.
 */
function statusFor(kind: PublishStatus["kind"]): PostStatus {
  switch (kind) {
    case "published":
      return "POSTED";
    case "failed":
      return "FAILED";
    case "cancelled":
      return "CANCELLED";
    case "in_user_inbox":
      // `FR-060`: **no es un error**. Falta que el creador pulse Post.
      return "IN_USER_INBOX";
    case "processing":
      // El enum de la base sólo nombra el caso de TikTok, el único carril lento
      // del PRD. Para Facebook Reels procesando es el menos malo: `POSTED`
      // afirmaría algo que no pasó y `FAILED` invita a duplicar.
      return "UPLOADING_TO_TIKTOK";
  }
}

const RECONNECT_MESSAGE = "Reconnect the account to publish this post.";

export function createPublishHandler(deps: PublishDeps): JobHandler<unknown> {
  const guardsOn = deps.guards ?? deps.queue !== undefined;

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

  /** Transacción 1: bloquear, decidir, soltar. */
  async function read(job: PublishJob): Promise<ReadOutcome> {
    const nowMs = deps.clock.nowMs();
    return inCompany(job.companyId, async (tx) => {
      const scope = { companyId: job.companyId };
      const post = await postPublishStore.lockPost(tx, scope, job.postId);
      if (post === null) return { kind: "skip", why: "el post no existe" };

      if (post.status !== "SCHEDULED")
        return { kind: "skip", why: `el post ya está en ${post.status}` };

      // Mover un post puede ser cambiar la hora: este job es el de la hora
      // vieja, y el de la nueva ya está encolado.
      if (post.scheduledAtUtc.getTime() > nowMs)
        return { kind: "skip", why: "la hora programada todavía no llegó" };

      // `cancellationPending` es de las cuentas warmed (`FR-060`). Publicar con
      // la bandera puesta publicaría justo lo que el usuario pidió frenar.
      if (post.cancellationPending)
        return { kind: "skip", why: "hay una cancelación pendiente sobre este post" };

      const accountId = post.connectionId ?? post.warmedAccountId;
      if (accountId === null || accountId === undefined) {
        return {
          kind: "fail",
          code: "invalid_state",
          message: "This post has no account to publish to.",
        };
      }

      let platformUserId: string | undefined;
      if (post.connectionId !== null) {
        const connection = await connectionRepository.findById(
          tx,
          scope,
          post.connectionId,
        );
        if (connection === null) {
          return {
            kind: "fail",
            code: "invalid_state",
            message: "This post has no account to publish to.",
          };
        }
        if (connection.status !== "active") {
          // FR-060: «la conexión OAuth estaba inactiva en el momento de
          // ejecución». Se escribe acá, con la fila bloqueada.
          await postRepository.update(tx, scope, job.postId, {
            status: "AWAITING_RECONNECT",
            errorMessage: RECONNECT_MESSAGE,
          });
          return { kind: "awaiting_reconnect" };
        }
        platformUserId = connection.platformUserId;
      }

      const content = await contentRepository.findById(tx, scope, post.contentId);
      if (content === null)
        return { kind: "skip", why: "el contenido del post fue borrado" };

      if (content.status !== "CREATED" || content.files.length === 0) {
        return {
          kind: "fail",
          code: "content_not_ready",
          message: "The content for this post isn't ready to publish.",
        };
      }

      const strategyRow = guardsOn ? await brandStrategyRepository.find(tx, scope) : null;
      const timezone = guardsOn
        ? await brandStrategyRepository.timezone(tx, scope)
        : null;

      return {
        kind: "publish",
        subject: {
          postId: post.id,
          platform: post.platform,
          accountType: post.accountType,
          accountId,
          connectionId: post.connectionId,
          platformUserId,
          contentId: content.id,
          revision: content.revision,
          mediaKind: mediaKindOf(content.type),
          files: content.files,
          dimensions: renderDimensionsOf(content.buildPayload),
          scheduledAtMs: post.scheduledAtUtc.getTime(),
          caption: post.caption ?? "",
          description: post.description ?? undefined,
          postingMode: post.postingMode ?? undefined,
          privacyLevel: post.privacyLevel ?? undefined,
          aiGenerated: post.aiContentDisclaimer ?? undefined,
          paidPartnership: post.discloseAsAds ?? undefined,
          strategy:
            strategyRow === null
              ? null
              : {
                  networks: strategyRow.networks,
                  brandGapMinutes: strategyRow.brandGapMinutes,
                },
          timezone: timezone ?? "UTC",
        },
      };
    });
  }

  /**
   * Transacción 2: escribir lo que de verdad pasó. Sin comprobar que siga en
   * `SCHEDULED` (regla 2).
   */
  async function write(
    job: PublishJob,
    status: PublishStatus,
  ): Promise<"escrito" | "sin fila"> {
    return inCompany(job.companyId, async (tx) => {
      const post = await postPublishStore.lockPost(
        tx,
        { companyId: job.companyId },
        job.postId,
      );
      if (post === null) return "sin fila";

      if (post.status !== "SCHEDULED") {
        deps.logger.warn(
          { postId: job.postId, era: post.status, ahora: statusFor(status.kind) },
          "el post cambió de estado mientras se publicaba: gana lo que pasó en la plataforma",
        );
      }

      const now = new Date(deps.clock.nowMs());
      const nuevo = statusFor(status.kind);

      await postRepository.update(tx, { companyId: job.companyId }, job.postId, {
        status: nuevo,
        ...(status.externalPostId === undefined
          ? {}
          : { externalPostId: status.externalPostId }),
        ...(status.permalink === undefined ? {} : { postUrl: status.permalink }),
        ...(status.publishedCaption === undefined
          ? {}
          : { publishedCaption: status.publishedCaption }),
        ...(status.captionAdjustmentReason === undefined
          ? {}
          : { captionAdjustmentReason: status.captionAdjustmentReason }),
        ...(status.processingDelayed === undefined
          ? {}
          : { tiktokProcessingDelayed: status.processingDelayed }),
        ...(nuevo === "POSTED" ? { postedAt: now } : {}),
        ...(status.failure === undefined
          ? {}
          : {
              errorCode: errorCodeFor(post.platform, status.failure),
              errorMessage: status.failure.message,
            }),
      });
      return "escrito";
    });
  }

  /** Cierra la fila sin haber llamado a la plataforma (o sin saber si llegó). */
  async function fail(job: PublishJob, code: string, message: string): Promise<void> {
    await inCompany(job.companyId, async (tx) => {
      const post = await postPublishStore.lockPost(
        tx,
        { companyId: job.companyId },
        job.postId,
      );
      if (post === null || post.status !== "SCHEDULED") return;
      await postRepository.update(tx, { companyId: job.companyId }, job.postId, {
        status: "FAILED",
        errorCode: code,
        errorMessage: message,
      });
    });
  }

  /** `AWAITING_RECONNECT` + un barrido para dentro de un rato (se reanuda solo). */
  async function awaitReconnect(job: PublishJob, alreadyWritten: boolean): Promise<void> {
    if (!alreadyWritten) {
      await inCompany(job.companyId, async (tx) => {
        const post = await postPublishStore.lockPost(
          tx,
          { companyId: job.companyId },
          job.postId,
        );
        if (post === null || post.status !== "SCHEDULED") return;
        await postRepository.update(tx, { companyId: job.companyId }, job.postId, {
          status: "AWAITING_RECONNECT",
          errorMessage: RECONNECT_MESSAGE,
        });
      });
    }
    if (deps.queue !== undefined) {
      await deps.queue.enqueue(
        sweepJob(job.companyId, new Date(deps.clock.nowMs() + SWEEP_REARM_MS)),
      );
    }
  }

  /**
   * Reintenta con un job nuevo si el fallo fue **antes de entregar** y quedan
   * reintentos; si no, cierra la fila.
   */
  async function retryOrFail(
    job: PublishJob,
    retriesSoFar: number,
    error: unknown,
    code: string,
    message: string,
  ): Promise<void> {
    const retryable =
      isPublicMediaUnavailable(error) || (isPortError(error) && error.isRetryable);
    const decision = nextPublishRetry({
      retriesSoFar,
      retryable: deps.queue !== undefined && retryable,
      deliveryUncertain: isPublishDeliveryUncertain(error),
      ...(isPortError(error) && error.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    });
    if (decision.kind === "retry" && deps.queue !== undefined) {
      const at = new Date(deps.clock.nowMs() + decision.delayMs);
      await deps.queue.enqueue(
        publishJob(
          { companyId: job.companyId, postId: job.postId, retry: decision.retryNumber },
          at,
          retryKey(job.postId, decision.retryNumber),
        ),
      );
      deps.logger.warn(
        { postId: job.postId, code, retry: decision.retryNumber, at: at.toISOString() },
        "fallo antes de entregar: se reintenta",
      );
      return;
    }
    await fail(job, code, message);
  }

  /** Mueve la hora (guardas) y encola el job de la hora nueva. */
  async function reschedule(
    job: PublishJob,
    atMs: number,
    reason: string,
  ): Promise<void> {
    const queue = deps.queue;
    if (queue === undefined) return;
    await inCompany(job.companyId, async (tx) => {
      const post = await postPublishStore.lockPost(
        tx,
        { companyId: job.companyId },
        job.postId,
      );
      if (post === null || post.status !== "SCHEDULED") return;
      await postRepository.update(tx, { companyId: job.companyId }, job.postId, {
        scheduledAtUtc: new Date(atMs),
      });
      // ADR-005: el job en la misma transacción que la fila.
      await queue.enqueue(
        publishJob(
          { companyId: job.companyId, postId: job.postId },
          new Date(atMs),
          rescheduleKey(job.postId, atMs),
          tx,
        ),
      );
    });
    deps.logger.info(
      { postId: job.postId, reason, at: new Date(atMs).toISOString() },
      "guarda anti-bot: post reprogramado",
    );
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parsePublishJob(ctx.payload);
    if (!parsed.ok) {
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de publishing inválido",
      );
      return;
    }

    const job = parsed.payload;
    const retriesSoFar = retryOf(ctx.payload);
    const base = { jobId: ctx.jobId, postId: job.postId };

    const outcome = await read(job);
    if (outcome.kind === "skip") {
      deps.logger.info({ ...base, why: outcome.why }, "publicación omitida");
      return;
    }
    if (outcome.kind === "fail") {
      await fail(job, outcome.code, outcome.message);
      deps.logger.warn({ ...base, code: outcome.code }, "el post no se puede publicar");
      return;
    }
    if (outcome.kind === "awaiting_reconnect") {
      await awaitReconnect(job, true);
      deps.logger.warn(base, "la conexión no está activa: AWAITING_RECONNECT");
      return;
    }

    const subject = outcome.subject;
    const publisher = deps.publishers[subject.platform];
    if (publisher === undefined) {
      await fail(
        job,
        "provider_unavailable",
        "Publishing to this platform isn't available right now.",
      );
      deps.logger.error(
        { ...base, platform: subject.platform },
        "no hay publicador para la plataforma",
      );
      return;
    }

    // ── Guardas anti-bot (PU-PUB-007) ──────────────────────────────────────
    if (guardsOn) {
      const nowMs = deps.clock.nowMs();
      const fingerprinter = deps.fingerprinter ?? null;
      const fingerprint =
        fingerprinter === null
          ? null
          : await fingerprinter.of({
              contentId: subject.contentId,
              revision: subject.revision,
              files: subject.files,
            });
      const { neighbors, crossBrand } = await loadGuardNeighbors(
        { db: deps.db, appRole: deps.appRole },
        {
          companyId: job.companyId,
          nowMs,
          horizonDays: PUBLISH_GUARD_HORIZON_DAYS,
          fingerprinter,
          wantDuplicates: fingerprint !== null,
        },
      );
      if (!crossBrand) {
        deps.logger.warn(
          base,
          "no se pudieron leer las otras marcas del dueño: guardas sólo de esta",
        );
      }
      const decision = evaluatePublishGuards({
        subject: {
          id: subject.postId,
          brandId: job.companyId,
          network: subject.platform,
          scheduledAtMs: subject.scheduledAtMs,
          fingerprint,
        },
        nowMs,
        policy: publishGuardPolicyFor(
          subject.strategy,
          subject.platform,
          subject.timezone,
        ),
        neighbors,
      });
      if (decision.kind === "reject") {
        await fail(job, decision.code, decision.message);
        deps.logger.warn({ ...base, code: decision.code }, "guarda anti-bot: rechazado");
        return;
      }
      if (decision.kind === "reschedule") {
        await reschedule(job, decision.atMs, decision.reason);
        return;
      }
    }

    // ── Token (ConnectionTokens) ───────────────────────────────────────────
    let accessToken: string | undefined;
    if (deps.tokens !== undefined && subject.connectionId !== null) {
      try {
        accessToken = await deps.tokens.getAccessToken(subject.connectionId, {
          companyId: job.companyId,
        });
      } catch (error: unknown) {
        if (isPortError(error) && error.code === "unauthorized") {
          await awaitReconnect(job, false);
          deps.logger.warn(base, "el token no sirve: AWAITING_RECONNECT");
          return;
        }
        const code = isPortError(error) ? error.code : "unknown";
        deps.logger.error({ ...base, code }, "no se pudo obtener el token");
        await retryOrFail(
          job,
          retriesSoFar,
          error,
          code,
          "We couldn't reach the account to publish this post.",
        );
        return;
      }
    }

    // ── Media (PublicMediaUrls / Storage) ──────────────────────────────────
    let urls: readonly string[] = subject.files;
    if (deps.media !== undefined) {
      try {
        urls = await resolveMediaUrls(
          deps.media,
          subject.files,
          mediaSourceFor(publisher.capabilities(), subject.mediaKind),
        );
      } catch (error: unknown) {
        if (isPublicMediaUnavailable(error)) {
          deps.logger.warn(base, "sin URL pública de la media (¿túnel caído?)");
          await retryOrFail(job, retriesSoFar, error, error.code, error.message);
          return;
        }
        const code = isPortError(error) ? error.code : "unknown";
        deps.logger.error({ ...base, code, error }, "no se pudo preparar la media");
        await retryOrFail(
          job,
          retriesSoFar,
          error,
          code,
          "We couldn't prepare the media for this post.",
        );
        return;
      }
    }

    const request: PublishRequest = {
      account: {
        accountType: subject.accountType,
        accountId: subject.accountId,
        ...(accessToken === undefined ? {} : { accessToken }),
        ...(subject.platformUserId === undefined
          ? {}
          : { platformUserId: subject.platformUserId }),
      },
      media: {
        kind: subject.mediaKind,
        urls,
        ...(subject.dimensions === null ? {} : subject.dimensions),
      },
      caption: subject.caption,
      ...(subject.description === undefined ? {} : { description: subject.description }),
      ...(subject.postingMode === undefined ? {} : { postingMode: subject.postingMode }),
      ...(subject.privacyLevel === undefined
        ? {}
        : { privacyLevel: subject.privacyLevel }),
      ...(subject.aiGenerated === undefined ? {} : { aiGenerated: subject.aiGenerated }),
      ...(subject.paidPartnership === undefined
        ? {}
        : { paidPartnership: subject.paidPartnership }),
      // Estable y por post (regla 1).
      idempotencyKey: `publish:${job.postId}`,
    };

    let status: PublishStatus;
    try {
      status = await publisher.publish(request);
    } catch (error: unknown) {
      if (isPortError(error) && error.code === "unauthorized") {
        await awaitReconnect(job, false);
        deps.logger.warn(base, "la plataforma rechazó el token: AWAITING_RECONNECT");
        return;
      }
      if (isPublishDeliveryUncertain(error)) {
        // No se sabe si salió: ni `POSTED` (mentira posible) ni reintento
        // (duplicado posible). Se dice la verdad y decide una persona.
        deps.logger.error(
          { ...base, code: error.code },
          "entrega incierta: no se reintenta",
        );
        await fail(
          job,
          "delivery_unconfirmed",
          "We couldn't confirm whether the platform published this post. Check the account before trying again.",
        );
        return;
      }
      const code = isPortError(error) ? error.code : "unknown";
      deps.logger.error({ ...base, code, error }, "la llamada a la plataforma falló");
      await retryOrFail(
        job,
        retriesSoFar,
        error,
        code,
        error instanceof PortError && code === "bad_request"
          ? error.message
          : "We couldn't reach the platform to publish this post.",
      );
      return;
    }

    const resultado = await write(job, status);
    if (resultado === "sin fila") {
      deps.logger.error(
        { ...base, kind: status.kind, permalink: status.permalink },
        "se publicó y la fila ya no está: queda un post sin registro",
      );
      return;
    }

    // Carril lento / inbox: el watcher sigue hasta 72 h (P3-PUB-004).
    if (
      (status.kind === "processing" || status.kind === "in_user_inbox") &&
      status.externalPostId !== undefined &&
      deps.queue !== undefined
    ) {
      const nowMs = deps.clock.nowMs();
      await deps.queue.enqueue(
        watchJob(
          { companyId: job.companyId, postId: job.postId, startedAtMs: nowMs, round: 0 },
          new Date(nowMs + SLOW_LANE_POLL_INTERVAL_MS),
        ),
      );
    }

    deps.logger.info({ ...base, kind: status.kind }, "publicación resuelta");
  };
}

/**
 * `errorCode` de un fallo que devolvió la plataforma — `P3-PUB-006`, DP-006.
 * La tabla de `@fastgram/core` es la primera línea; en `uncoded`/`escalate` se
 * deja el motivo neutral del puerto.
 */
export function errorCodeFor(
  platform: string,
  failure: NonNullable<PublishStatus["failure"]>,
): string {
  if (!(PUBLISH_PLATFORMS as readonly string[]).includes(platform)) return failure.reason;
  const t = translatePublishFailure({
    platform: platform as (typeof PUBLISH_PLATFORMS)[number],
    failure,
  });
  return t.kind === "coded" ? t.errorCode : failure.reason;
}
