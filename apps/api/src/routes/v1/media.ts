/**
 * Media Bank — reserva, finalización, listado, detalle, categorías y borrado.
 *
 * Fuente: PRD §9.3, FR-100, §9.2, §9.8, §9.11.
 *
 * ## El flujo de subida vive en tres piezas y ninguna es opcional
 *
 * §9.8 fija **reserva → PUT directo → finalización**. La política (tipos, topes,
 * extensión que tiene que coincidir) está en `@fastgram/contracts`; la máquina de
 * estados de la finalización está en `src/http/uploads.ts`; acá sólo se cablean las
 * dos a la base y al puerto `Storage`.
 *
 * Las validaciones de la reserva se hacen con el schema del contrato y **no** con
 * `validateUploadReservation` de `http/uploads.ts`, aunque comprueben exactamente lo
 * mismo. La razón no es de gusto: los tres códigos que esa función devuelve
 * —`unsupported_content_type`, `file_too_large`, `extension_mismatch`— **no están en
 * `errorCodeSchema`**, y el contrato dice que un código que el PRD no nombra no puede
 * salir por la v1. El schema produce `bad_request` con los `issues` de Zod, que sí es
 * del PRD y además es accionable.
 *
 * De ese mismo schema sale gratis una regla que nadie va a recordar: **el Media Bank no
 * acepta subidas de audio** (FR-053). No hay un chequeo que lo diga porque no hace falta
 * —el enum de content types no incluye ninguno—, y ése es el punto: el día que alguien
 * agregue `audio/mpeg` al enum para otra cosa, esta ruta lo aceptaría sin que nada
 * proteste. El catálogo de audio es global y de sólo lectura (`GET /audio`).
 *
 * ## Dos vocabularios para la misma máquina de estados
 *
 * `upload_reservations.state` (DATA-028) usa `reserved` y `committed`;
 * `ReservationStatus` de `http/uploads.ts` usa `pending` y `completed`. Son la misma
 * máquina con dos nombres, así que la traducción es explícita (`RESERVATION_STATUS`) y
 * está en un solo lugar: si alguien la hace a ojo en otra ruta, `committed` se va a
 * leer como "no terminado" y la finalización se dejaría repetir.
 *
 * ## El borrado de este recurso es distinto al del resto de la API
 *
 * §9.2: *"los borrados idempotentes de media tratan ids ajenos/desconocidos como no-ops
 * seguros que **no revelan si el registro existe**"*. Por eso `DELETE /media/:id`
 * devuelve `204` siempre — es la única ruta de la v1 donde un id ajeno **no** produce
 * 404, y es deliberado: acá ni el 404 debe distinguirse del éxito.
 *
 * ## Lo que falta y por qué no se inventó
 *
 * - **La cuota de storage de §9.11** (`402 payment_required` al excederse) no se
 *   aplica. No hay con qué: `PLANS` no tiene un límite de bytes por plan y
 *   `quota_ledgers` no tiene un contador de storage. Poner un número acá sería
 *   inventar el límite y el comportamiento de facturación a la vez.
 * - **`409 media_in_use`** en el borrado (FR-100: se rechaza si el asset sigue
 *   referenciado) necesita consultar `contents`, `influencer_configs` y
 *   `media_sets` por pertenencia a un array; el filtro declarativo de los
 *   repositorios no tiene un operador de "contiene".
 */
import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import {
  BYTES_PER_MB,
  brandKitRequestSchema,
  finalizeMediaRequestSchema,
  imageMediaCategorySchema,
  listMediaQuerySchema,
  mediaUploadReservationRequestSchema,
  optionalIdempotencyHeaderSchema,
  updateImageMediaRequestSchema,
  updateMediaRequestSchema,
  updateVideoMediaRequestSchema,
  videoMediaCategorySchema,
  type BrandKitJob,
} from "@fastgram/contracts";
import {
  DEFAULT_BRAND_KIT_IMAGES,
  DEFAULT_BRAND_KIT_VIDEOS,
  JOB_QUEUES,
  brandKitSingletonKey,
  type BrandBackgroundsJob,
} from "@fastgram/core";
import { mediaRepository, uploadReservationRepository, type media } from "@fastgram/db";

import { ApiRejection } from "../../http/errors.js";
import { rateLimit } from "../../plugins/rate-limit.js";
import {
  canonicalObjectUrl,
  claimReservation,
  reserveUpload,
  type UploadRejection,
} from "../../support/upload-reservations.js";
import { toMedia } from "../../support/serializers.js";
import { registerMediaImportRoutes } from "./media-import.js";
import { crossTenant, data, idempotencyKeyOf, page, withIdempotency } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const mediaParams = z.object({ id: z.string().min(1) });

type MediaRow = (typeof media)["$inferSelect"];

/** Respuesta de error con la forma de §9.3, para los rechazos que viajan como dato. */
export function sendRejection(
  reply: FastifyReply,
  rejection: UploadRejection,
): FastifyReply {
  return reply
    .status(rejection.status)
    .send({ error: { code: rejection.code, message: rejection.message } });
}

/** FR-100: las categorías válidas dependen del tipo del asset, no del request. */
export const CATEGORY_SCHEMA = {
  image: updateImageMediaRequestSchema,
  video: updateVideoMediaRequestSchema,
} as const;

export const ALLOWED_CATEGORIES = {
  image: imageMediaCategorySchema.options,
  video: videoMediaCategorySchema.options,
} as const;

/**
 * Payload de `media-normalization` (§9.5 #7, `NFR-014`).
 *
 * Escrito dos veces —acá y en `apps/worker/src/media/normalization-handler.ts`,
 * que lo parsea—; su lugar es `@fastgram/core`. El nombre de la cola sí sale de
 * `JOB_QUEUES`, que es lo que ya divergió una vez (trampa 19).
 */
interface MediaNormalizationRequest {
  readonly companyId: string;
  readonly mediaId: string;
}

/**
 * Intentos totales del job: los `maxAttempts: 3` de `mediaNormalization` en
 * `apps/worker/src/jobs/catalog.ts`. pg-boss cuenta reintentos, no intentos.
 */
const MEDIA_NORMALIZATION_RETRY_LIMIT = 2;

/** Los `maxAttempts: 3` de `brandBackgrounds` en el catálogo del worker. */
const BRAND_KIT_RETRY_LIMIT = 2;

/** §9.3 — la ruta tal como la nombra el registro de idempotencia. */
const BRAND_KIT_ROUTE = "POST /media/brand-kit";

/**
 * Orígenes que el Media Bank **lista**. FR-100: generados, de demo e internos
 * nunca. `brand_kit` (`PU-MEDIA-002`, migración `0013`) sí: son fondos que la
 * app generó *para* el usuario y que él tiene que poder ver, recategorizar y
 * borrar como si los hubiera subido.
 */
const LISTED_ORIGINS = ["manual_upload", "brand_kit"] as const;

type FinalizeOutcome =
  | { readonly ok: true; readonly row: MediaRow }
  | { readonly ok: false; readonly rejection: UploadRejection }
  /** Un video sin cola no se crea: ver la ruta. */
  | { readonly ok: false; readonly queueUnavailable: true };

type PatchOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_categories"; readonly mediaType: MediaRow["mediaType"] }
  | { readonly kind: "ok"; readonly row: MediaRow };

export function registerMediaRoutes(app: ZodApp): void {
  const { clock, idempotency, limiter, storage, queue } = app.deps;

  // `PU-MEME-001`: importar por link (`POST /media/import`, estado y metadata).
  registerMediaImportRoutes(app);

  // ── POST /media/upload-url ──
  app.post(
    "/media/upload-url",
    {
      schema: { body: mediaUploadReservationRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const body = request.body;
      const companyId = request.auth.companyId;

      const reservation = await request.tx((tx) =>
        reserveUpload({
          tx,
          storage,
          companyId,
          apiKeyId: request.auth.apiKeyId,
          prefix: `media/${companyId}`,
          filename: body.filename,
          contentType: body.contentType,
          sizeBytes: body.sizeBytes,
        }),
      );

      // 200 y no 201: lo que vuelve es una capacidad con fecha de caducidad, no un
      // recurso con URL propia. No hay `GET` que la devuelva, así que no hay nada que
      // un `Location` pudiera apuntar. El 201 se reserva para `POST /media`.
      //
      // `uploadUrl` está firmada: no entra en ningún log (§9.10).
      return reply.status(200).send(data(reservation));
    },
  );

  // ── POST /media ──
  app.post(
    "/media",
    {
      schema: { body: finalizeMediaRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const { uploadId } = request.body;
      const companyId = request.auth.companyId;

      // Todo en una transacción: commitear la reserva y crear la fila de `media` son
      // una sola cosa. Separarlas deja el par roto en los dos sentidos —una reserva
      // `committed` sin asset, o un asset que se puede volver a finalizar—. El precio
      // es que el `head` del storage ocurre con la transacción abierta.
      const outcome = await request.tx(async (tx): Promise<FinalizeOutcome> => {
        const claim = await claimReservation({
          tx,
          storage,
          companyId,
          uploadId,
          nowMs: clock.nowMs(),
        });
        if (!claim.ok) return claim;

        const reservation = claim.row;
        const mediaType = reservation.contentType.startsWith("image/")
          ? ("image" as const)
          : ("video" as const);

        // **Sin cola, un video no se crea.** Nacería `processing` sin job que
        // lo saque de ahí, y FR-100 no tiene camino de vuelta: quedaría
        // `processing` para siempre y sin fallar nunca. Es el mismo criterio
        // que las rutas de `content.ts` (503 antes de escribir). Va acá y no
        // antes de la transacción porque el tipo sólo se sabe leyendo la
        // reserva; `claimReservation` no escribe, así que devolver ahora
        // deja la reserva `reserved` y reintentable. Las imágenes no
        // necesitan cola y siguen funcionando.
        if (mediaType === "video" && queue === undefined) {
          return { ok: false, queueUnavailable: true };
        }

        const created = await mediaRepository.create(
          tx,
          { companyId },
          {
            mediaType,
            filename: reservation.filename,
            r2Url: await canonicalObjectUrl(storage, reservation.storageKey),
            storageKey: reservation.storageKey,
            // FR-100 literal: *"Las imágenes quedan `ready` al instante; los videos
            // quedan `processing` y se normalizan en background"*. Lo saca de
            // ahí el job de `media-normalization` que se encola abajo; decir
            // `ready` acá sería afirmar que pasó por MOV→MP4, faststart y HDR→SDR.
            status: mediaType === "image" ? "ready" : "processing",
            // El tamaño real del objeto, no el declarado en la reserva. Son el mismo
            // número cuando el cliente no miente, y cuando miente el que vale es éste.
            sizeMb: claim.sizeBytes / BYTES_PER_MB,
            // `videoDurationSec` queda nulo: el cuerpo de la reserva que fija el
            // contrato no tiene `durationSec`, así que nadie lo declaró. Lo llena la
            // normalización, que es la que mide el archivo.
            ...(reservation.durationSec === null
              ? {}
              : { videoDurationSec: reservation.durationSec }),
            // FR-100: *"Lista vacía = el asset sale de todos los pools automáticos"*.
            // Es el estado correcto al subir: las categorías se ponen con PATCH.
            categories: [],
            origin: "manual_upload",
          },
        );

        await uploadReservationRepository.update(tx, { companyId }, uploadId, {
          state: "committed",
        });

        // §9.5 #7 / NFR-014: el productor de `media-normalization`. **Dentro**
        // de la transacción (ADR-005): si el encolado falla, ni la fila ni el
        // commit de la reserva existen, y el cliente reintenta la misma
        // reserva. Al revés —fila sin job— es el `processing` eterno.
        //
        // `singletonKey` fijo por media, sin nada que rote, y acá está bien a
        // pesar de la trampa 39: una clave fija dispara **una vez en la
        // vida**, y la normalización de un asset es exactamente eso — una vez
        // por asset. El `mediaId` es nuevo en cada finalización (la reserva
        // sólo se commitea una vez), así que la clave nunca choca contra el
        // job de otro asset; lo único que deduplica es un reintento del
        // propio encolado. Si algún día hiciera falta re-normalizar (un
        // motor nuevo), esa clave **no** serviría: tendría que rotar.
        if (mediaType === "video" && queue !== undefined) {
          await queue.enqueue<MediaNormalizationRequest>({
            queue: JOB_QUEUES.mediaNormalization,
            payload: { companyId, mediaId: created.mediaId },
            options: {
              transaction: tx,
              singletonKey: `${JOB_QUEUES.mediaNormalization}:${created.mediaId}`,
              retryLimit: MEDIA_NORMALIZATION_RETRY_LIMIT,
              retryBackoff: true,
            },
          });
        }

        return { ok: true, row: created };
      });

      if (!outcome.ok) {
        if ("queueUnavailable" in outcome) {
          return reply.status(503).send({
            error: {
              code: "service_unavailable",
              message: "Video uploads are temporarily unavailable. Retry shortly.",
            },
          });
        }
        return sendRejection(reply, outcome.rejection);
      }
      return reply.status(201).send(data(toMedia(outcome.row)));
    },
  );

  // ── GET /media ──
  app.get(
    "/media",
    { schema: { querystring: listMediaQuerySchema } },
    async (request, reply) => {
      const q = request.query;

      const result = await request.tx((tx) =>
        mediaRepository.list(
          tx,
          { companyId: request.auth.companyId },
          {
            limit: q.limit,
            ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
            filter: {
              mediaType: q.type === undefined ? undefined : { eq: q.type },
              // FR-100: *"Assets generados, de demo e internos **nunca** se listan"*. Es
              // el listado del Media Bank, no un índice de todo lo que hay en el bucket:
              // sin este filtro, cada imagen que genera el pipeline aparecería en la grid
              // del usuario como si la hubiera subido él.
              //
              // `brand_kit` sí se lista: ver `LISTED_ORIGINS`.
              origin: { in: [...LISTED_ORIGINS] },
            },
          },
        ),
      );
      return reply.send(page(result, toMedia));
    },
  );

  // ── POST /media/brand-kit ──
  //
  // `PU-MEDIA-002`: fondos de marca generados por `services/render` (sin keys
  // ni proveedores) para que una marca sin media pueda usar Blitz. `202`: lo
  // que termina es el encolado; las filas aparecen en el Media Bank cuando el
  // worker (`brand-backgrounds`) termina, ya `ready` y categorizadas.
  //
  // Sin worker con servicio de render, el job espera en la cola —igual que
  // `media-normalization`— y el arranque del worker lo dice.
  app.post(
    "/media/brand-kit",
    {
      schema: {
        // El cuerpo entero es opcional: `POST` sin body = kit por defecto.
        // `nullish` y no `optional`: sin cuerpo, Fastify entrega `null`.
        body: brandKitRequestSchema.nullish(),
        headers: optionalIdempotencyHeaderSchema,
      },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      if (queue === undefined) {
        // Antes de consumir la `Idempotency-Key`: quemarla por una caída de
        // infraestructura impediría el reintento (mismo criterio que
        // `POST /brand/sources`).
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Brand backgrounds are temporarily unavailable.",
          },
        });
      }
      const body = request.body ?? {};
      const companyId = request.auth.companyId;
      const images = body.images ?? DEFAULT_BRAND_KIT_IMAGES;
      const videos = body.videos ?? DEFAULT_BRAND_KIT_VIDEOS;
      if (images + videos === 0) {
        throw new ApiRejection(
          400,
          "bad_request",
          "Ask for at least one image or video.",
        );
      }

      const run = async (): Promise<BrandKitJob> => {
        const job: BrandBackgroundsJob = {
          companyId,
          // Sin semilla, una nueva: pedir el kit otra vez es pedir **otros**
          // fondos. Con `Idempotency-Key`, el replay devuelve esta misma.
          seed: body.seed ?? `kit-${randomUUID()}`,
          images,
          videos,
        };
        // Clave por marca + semilla + cantidades, fija a propósito (trampa 39):
        // la misma semilla produce los mismos bytes, así que repetir el job no
        // daría nada nuevo. `created: false` se devuelve como `enqueued: false`
        // en vez de fingir que se encoló (trampa 45).
        const enqueued = await queue.enqueue<BrandBackgroundsJob>({
          queue: JOB_QUEUES.brandBackgrounds,
          payload: job,
          options: {
            singletonKey: brandKitSingletonKey(job),
            retryLimit: BRAND_KIT_RETRY_LIMIT,
            retryBackoff: true,
          },
        });
        return { seed: job.seed, images, videos, enqueued: enqueued.created };
      };

      const key = idempotencyKeyOf({ ...request.headers });
      if (key === "") return reply.status(202).send(data(await run()));
      return withIdempotency(
        idempotency,
        request,
        reply,
        { key, route: BRAND_KIT_ROUTE, body, successStatus: 202 },
        run,
      );
    },
  );

  // ── GET /media/:id ──
  // Sin el filtro de `origin` que sí lleva el listado, y la asimetría es deliberada:
  // FR-100 dice que los assets generados, de demo e internos no se **listan**, no que
  // no existan. El contenido ya creado los referencia por id, y un 404 acá rompería el
  // detalle de una pieza que el usuario está viendo.
  app.get("/media/:id", { schema: { params: mediaParams } }, async (request) => {
    const { id } = request.params;
    const companyId = request.auth.companyId;
    const row = await request.tx((tx) => mediaRepository.findById(tx, { companyId }, id));
    if (row === null) throw crossTenant("media", id, companyId);
    return data(toMedia(row));
  });

  // ── PATCH /media/:id ──
  app.patch(
    "/media/:id",
    {
      schema: { params: mediaParams, body: updateMediaRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const { id } = request.params;
      const companyId = request.auth.companyId;
      const body = request.body;

      const outcome = await request.tx(async (tx): Promise<PatchOutcome> => {
        const current = await mediaRepository.findById(tx, { companyId }, id);
        if (current === null) return { kind: "not_found" };

        // El contrato tiene tres schemas para este cuerpo y no es redundancia: cuál
        // aplica depende del tipo del asset, que sólo se sabe leyendo la fila. El
        // schema de la ruta acepta la unión; el estrecho se aplica acá.
        const narrowed = CATEGORY_SCHEMA[current.mediaType].safeParse(body);
        if (!narrowed.success) {
          return { kind: "invalid_categories", mediaType: current.mediaType };
        }

        // FR-100: *"Cambiar categorías es un **reemplazo total**"*. Por eso se escribe
        // el array entero y no hay operación de añadir ni de quitar.
        const updated = await mediaRepository.update(tx, { companyId }, id, {
          categories: [...narrowed.data.categories],
        });
        // `null` acá sólo puede ser una carrera con un borrado entre la lectura y la
        // escritura. Misma respuesta que si nunca hubiera existido.
        if (updated === null) return { kind: "not_found" };
        return { kind: "ok", row: updated };
      });

      if (outcome.kind === "not_found") throw crossTenant("media", id, companyId);

      if (outcome.kind === "invalid_categories") {
        // F-129 / FR-100: las categorías son válidas **por tipo**. El PRD lo llama
        // `400 bad_request`, no un aviso, y `details` dice cuáles entran para que el
        // cliente no tenga que adivinar cuál de las cinco sobraba.
        return reply.status(400).send({
          error: {
            code: "bad_request",
            message: `Those categories are not valid for a ${outcome.mediaType}.`,
            details: {
              mediaType: outcome.mediaType,
              allowedCategories: [...ALLOWED_CATEGORIES[outcome.mediaType]],
            },
          },
        });
      }

      return reply.status(200).send(data(toMedia(outcome.row)));
    },
  );

  // ── DELETE /media/:id ──
  app.delete(
    "/media/:id",
    {
      schema: { params: mediaParams },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const { id } = request.params;
      const companyId = request.auth.companyId;

      // `softDelete` ya está scopeado y devuelve `false` para ajeno, inexistente o ya
      // borrado. Los tres responden 204: ver la cabecera del archivo. El booleano va
      // al log —donde sí queremos saberlo— y nunca al cuerpo.
      const deleted = await request.tx((tx) =>
        mediaRepository.softDelete(tx, { companyId }, id),
      );
      request.log.info({ mediaId: id, deleted }, "media delete (idempotent no-op)");

      return reply.status(204).send();
    },
  );
}
