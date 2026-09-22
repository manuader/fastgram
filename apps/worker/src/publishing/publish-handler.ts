/**
 * El handler de `publishing` — PRD §9.5 #8, `FR-060`, `NFR-005`, `NFR-015`.
 *
 * `POST /content/:id/schedule` crea un `Post` por (contenido × plataforma ×
 * cuenta) y encola uno de estos por fila, con `startAfter` en la hora pedida.
 * Del otro lado no había nadie: el post se quedaba en `SCHEDULED` para siempre
 * y nada fallaba. Es el mismo agujero que tenía `content-build`.
 *
 * ## Este handler es el opuesto del de build, y conviene entender por qué
 *
 * El de contenido **reintenta** un fallo transitorio, porque construir dos
 * veces no cuesta nada más que CPU. Publicar sí: un segundo intento después de
 * un timeout del proveedor puede dejar **dos posts en la cuenta del usuario**,
 * y eso no se deshace desde acá. Por eso el catálogo le pone `maxAttempts: 1` y
 * la ruta encola con `retryLimit: 0`, y por eso este archivo **nunca relanza**.
 * Un fallo se escribe en la fila y se muestra; reintentar es decisión de una
 * persona (`NFR-005`, `NFR-015`).
 *
 * De ahí salen las tres reglas que no se pueden romper:
 *
 * 1. **La `idempotencyKey` es el id del post, estable.** Si el proceso se cae
 *    entre el `publish()` y la escritura, y el job se vuelve a entregar, el
 *    adaptador devuelve el resultado anterior en vez de publicar de nuevo. Es
 *    la defensa de `NFR-004` bajada al puerto, y es lo único que hay entre un
 *    crash y un post duplicado.
 *
 * 2. **Después de `publish()`, la base tiene que reflejar la realidad, pase lo
 *    que pase.** El de build descarta su resultado si la pieza cambió mientras
 *    tanto; acá no se puede: el post ya existe en la plataforma. Si entre la
 *    lectura y la escritura alguien canceló, el post salió igual, y mostrarlo
 *    como `CANCELLED` sería mentirle al usuario sobre algo que cualquiera puede
 *    ver en su perfil. Se escribe el resultado real y se loguea la carrera.
 *
 * 3. **Nada se publica sin fila bloqueada.** `POST /posts/cancel` corre en otro
 *    proceso; sin el `FOR UPDATE` los dos deciden sobre la misma fila y el
 *    resultado es un post publicado que la UI muestra como cancelado.
 *
 * ## Lo que este handler NO hace, y por qué
 *
 * - **No reprograma ni espera el carril lento.** `processingDelayed` deja el
 *   post en `UPLOADING_TO_TIKTOK`; quien lo sigue hasta 72 h es el watcher de
 *   §9.5 #9, que es otro job. Acá sólo se escribe el estado.
 * - **No firma las URLs de la media.** El puerto pide URLs firmadas y de vida
 *   corta (`NFR-008`) y `contents.files` guarda las **canónicas**: desde una
 *   canónica no se puede firmar sin volver a derivar la clave, y la clave no
 *   está en ninguna columna. Con un publicador de memoria da igual; con uno
 *   real es un bloqueo. Está reportado.
 * - **No guarda el id del post en la plataforma**, porque no hay columna.
 *   `posts` tiene `postUrl` (el permalink) y nada más, así que `getStatus` y
 *   `cancel` del puerto —y el watcher entero— se quedan sin con qué preguntar.
 *   También reportado.
 */

import { parsePublishJob, type PublishJob } from "@fastgram/core";
import {
  contentRepository,
  postPublishStore,
  postRepository,
  withCompany,
  type Database,
  type Transaction,
} from "@fastgram/db";
import {
  PortError,
  type Clock,
  type JobContext,
  type JobHandler,
  type PublishMediaKind,
  type PublishRequest,
  type PublishStatus,
  type SocialPublisher,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";

export interface PublishDeps {
  readonly db: Database;
  /**
   * Un publicador **por plataforma**: las capacidades, los límites de copy y
   * los modos de publicación son distintos en cada una, y el puerto los declara
   * por adaptador. Un mapa y no un solo objeto para que agregar una plataforma
   * no obligue a tocar este archivo.
   */
  readonly publishers: Readonly<Record<string, SocialPublisher>>;
  readonly clock: Clock;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
}

/** Lo que se lee de la fila antes de publicar. */
interface PublishSubject {
  readonly platform: string;
  readonly accountType: "oauth" | "warmed";
  readonly accountId: string;
  readonly mediaKind: PublishMediaKind;
  readonly urls: readonly string[];
  readonly caption: string;
  readonly description: string | undefined;
  readonly postingMode: "inbox" | "direct" | undefined;
  readonly privacyLevel: PublishRequest["privacyLevel"];
  readonly aiGenerated: boolean | undefined;
  readonly paidPartnership: boolean | undefined;
}

type ReadOutcome =
  | { readonly kind: "publish"; readonly subject: PublishSubject }
  /** No hay nada que hacer y no es un error. */
  | { readonly kind: "skip"; readonly why: string }
  /** No se puede publicar nunca: se cierra la fila con el motivo. */
  | { readonly kind: "fail"; readonly code: string; readonly message: string };

/**
 * De qué tipo de media es una pieza, según su tipo de contenido.
 *
 * `slideshow` es su propio `PublishMediaKind` y no `carousel`: el puerto los
 * distingue porque Instagram los trata distinto (`instagramSlideshowFormat` del
 * contrato elige entre `carousel` y `reel`), y colapsarlos acá tomaría esa
 * decisión en el lugar equivocado. Los tres formatos de video son `video`.
 * `custom` también: es un video que subió el usuario.
 */
function mediaKindOf(contentType: string): PublishMediaKind {
  return contentType === "slideshow" ? "slideshow" : "video";
}

/** Los estados de `posts` que este handler escribe. */
type PostStatus =
  "POSTED" | "FAILED" | "CANCELLED" | "IN_USER_INBOX" | "UPLOADING_TO_TIKTOK";

/**
 * `PublishStatusKind` → el estado del post. Los cinco del puerto, sin default:
 * si el puerto agrega un estado, esto deja de compilar en vez de elegir uno por
 * descarte.
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
      // `FR-060`: **no es un error**. El post quedó como borrador dentro de la
      // app del creador y falta que él pulse Post. Mostrarlo como fallido haría
      // que el usuario lo reintente y termine con dos.
      return "IN_USER_INBOX";
    case "processing":
      // **El enum de la base sólo nombra el caso de TikTok**, porque es el único
      // carril lento que el PRD describe (`NFR-015`). Para cualquier otra
      // plataforma en `processing` es el estado menos malo que hay: forzarlo a
      // `POSTED` afirmaría que salió algo que todavía no salió, y `FAILED` sería
      // peor todavía, porque invita a reintentar y a duplicar. El nombre miente
      // para Instagram y YouTube; el estado, no. Queda reportado.
      return "UPLOADING_TO_TIKTOK";
  }
}

export function createPublishHandler(deps: PublishDeps): JobHandler<unknown> {
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
    return inCompany(job.companyId, async (tx) => {
      const post = await postPublishStore.lockPost(
        tx,
        { companyId: job.companyId },
        job.postId,
      );
      if (post === null) return { kind: "skip", why: "el post no existe" };

      if (post.status !== "SCHEDULED")
        return { kind: "skip", why: `el post ya está en ${post.status}` };

      // `cancellationPending` es de las cuentas warmed: el PRD dice que cancelar
      // ahí no es inmediato porque la opera una persona (`FR-060`). Publicar con
      // la bandera puesta publicaría justo lo que el usuario pidió frenar, y
      // como esto **no es idempotente**, no hay vuelta atrás. Se salta.
      if (post.cancellationPending)
        return { kind: "skip", why: "hay una cancelación pendiente sobre este post" };

      const accountId = post.connectionId ?? post.warmedAccountId;
      if (accountId === null || accountId === undefined) {
        // El CHECK `posts_account_exclusive` exige exactamente uno de los dos,
        // así que esto no debería pasar. Si pasa, la fila se escribió por fuera.
        return {
          kind: "fail",
          code: "invalid_state",
          message: "This post has no account to publish to.",
        };
      }

      const content = await contentRepository.findById(
        tx,
        { companyId: job.companyId },
        post.contentId,
      );
      if (content === null)
        return { kind: "skip", why: "el contenido del post fue borrado" };

      if (content.status !== "CREATED" || content.files.length === 0) {
        // Nada que entregar. Pasa si el build falló o si el post se programó
        // antes de que la pieza terminara. Es definitivo: este job no se
        // reintenta y el build no va a volver a correr por su cuenta.
        return {
          kind: "fail",
          code: "content_not_ready",
          message: "The content for this post isn't ready to publish.",
        };
      }

      return {
        kind: "publish",
        subject: {
          platform: post.platform,
          accountType: post.accountType,
          accountId,
          mediaKind: mediaKindOf(content.type),
          urls: content.files,
          // `FR-060` deja la copy opcional en la fila; la plataforma siempre
          // recibe una cadena, vacía si no hay.
          caption: post.caption ?? "",
          description: post.description ?? undefined,
          postingMode: post.postingMode ?? undefined,
          privacyLevel: post.privacyLevel ?? undefined,
          aiGenerated: post.aiContentDisclaimer ?? undefined,
          paidPartnership: post.discloseAsAds ?? undefined,
        },
      };
    });
  }

  /**
   * Transacción 2: escribir lo que de verdad pasó.
   *
   * Sin comprobación de que el estado siga en `SCHEDULED`, y es a propósito —
   * ver la regla 2 del encabezado. Después de `publish()` la plataforma ya tiene
   * el post; la base tiene que decir la verdad aunque alguien haya cancelado
   * mientras tanto.
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
              // El código es neutral (§10, regla 6) y el mensaje ya viene
              // "seguro de mostrar" del puerto: sin ids internos, sin nombre de
              // proveedor, sin trazas.
              errorCode: status.failure.reason,
              errorMessage: status.failure.message,
            }),
      });
      return "escrito";
    });
  }

  /** Cierra la fila sin haber llamado a la plataforma. */
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

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parsePublishJob(ctx.payload);
    if (!parsed.ok) {
      // No se relanza: un payload roto no mejora con el tiempo, y acá además no
      // hay reintentos que gastar.
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de publishing inválido",
      );
      return;
    }

    const job = parsed.payload;
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

    const subject = outcome.subject;
    const publisher = deps.publishers[subject.platform];
    if (publisher === undefined) {
      // Una plataforma sin adaptador montado. Fallar la fila es mejor que dejar
      // el post esperando para siempre: al menos se ve, y el usuario puede
      // reprogramarlo cuando el adaptador exista.
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

    const request: PublishRequest = {
      account: { accountType: subject.accountType, accountId: subject.accountId },
      media: { kind: subject.mediaKind, urls: subject.urls },
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
      // Estable y por post: es lo único que hay entre un crash a mitad de camino
      // y un post duplicado. Ver la regla 1 del encabezado.
      idempotencyKey: `publish:${job.postId}`,
    };

    let status: PublishStatus;
    try {
      status = await publisher.publish(request);
    } catch (error: unknown) {
      // Un throw del puerto significa que la llamada falló, **no** que el post
      // se publicó. Devolver `kind: "failed"` sería lo otro, y el puerto lo dice
      // explícito. Se cierra la fila con el motivo traducido.
      const code = error instanceof PortError ? error.code : "unknown";
      deps.logger.error({ ...base, code, error }, "la llamada a la plataforma falló");
      await fail(job, code, "We couldn't reach the platform to publish this post.");
      return;
    }

    const resultado = await write(job, status);
    if (resultado === "sin fila") {
      // El peor caso posible: el post **existe en la plataforma** y no queda
      // fila donde anotarlo. A nivel `error` y con todo lo que haya, porque es
      // lo único que va a quedar de un post real.
      deps.logger.error(
        { ...base, kind: status.kind, permalink: status.permalink },
        "se publicó y la fila ya no está: queda un post sin registro",
      );
      return;
    }

    deps.logger.info({ ...base, kind: status.kind }, "publicación resuelta");
  };
}
