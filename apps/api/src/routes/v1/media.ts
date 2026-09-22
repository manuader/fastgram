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
import type { FastifyReply } from "fastify";
import { z } from "zod";
import {
  BYTES_PER_MB,
  finalizeMediaRequestSchema,
  imageMediaCategorySchema,
  listMediaQuerySchema,
  mediaUploadReservationRequestSchema,
  updateImageMediaRequestSchema,
  updateMediaRequestSchema,
  updateVideoMediaRequestSchema,
  videoMediaCategorySchema,
} from "@fastgram/contracts";
import { mediaRepository, uploadReservationRepository, type media } from "@fastgram/db";

import { rateLimit } from "../../plugins/rate-limit.js";
import {
  canonicalObjectUrl,
  claimReservation,
  reserveUpload,
  type UploadRejection,
} from "../../support/upload-reservations.js";
import { toMedia } from "../../support/serializers.js";
import { crossTenant, data, page } from "./shared.js";
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

type PatchOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_categories"; readonly mediaType: MediaRow["mediaType"] }
  | { readonly kind: "ok"; readonly row: MediaRow };

export function registerMediaRoutes(app: ZodApp): void {
  const { clock, limiter, storage } = app.deps;

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
      const outcome = await request.tx(
        async (
          tx,
        ): Promise<
          { ok: true; row: MediaRow } | { ok: false; rejection: UploadRejection }
        > => {
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

          const created = await mediaRepository.create(
            tx,
            { companyId },
            {
              mediaType,
              filename: reservation.filename,
              r2Url: await canonicalObjectUrl(storage, reservation.storageKey),
              storageKey: reservation.storageKey,
              // FR-100 literal: *"Las imágenes quedan `ready` al instante; los videos
              // quedan `processing` y se normalizan en background"*. El video sale
              // `processing` aunque nadie esté normalizando todavía: decir `ready`
              // sería afirmar que pasó por MOV→MP4, faststart y HDR→SDR.
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

          return { ok: true, row: created };
        },
      );

      if (!outcome.ok) return sendRejection(reply, outcome.rejection);
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
              origin: { eq: "manual_upload" },
            },
          },
        ),
      );
      return reply.send(page(result, toMedia));
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
