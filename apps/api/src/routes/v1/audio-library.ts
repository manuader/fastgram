/**
 * La biblioteca de audio de la marca — `/audio/library` (sprint 7, migración
 * `0025`). PRD `FR-053` (Select Audio), `FR-070`, §9.8 (subidas).
 *
 * ## Qué es y qué no
 *
 * `GET /audio?for=` (en `catalog.ts`) es el catálogo **global** del PRD y sigue
 * vacío. Esto es lo que el dueño sube o importa por link para **su** marca, y
 * es lo único que hoy llega al video: el build firma `audio/{companyId}/` como
 * librería (`apps/worker/src/content/media-authorization.ts`).
 *
 * ## La subida es la de siempre, con otro prefijo
 *
 * §9.8: reserva → PUT directo → finalización, con `reserveUpload` y
 * `claimReservation` de `support/upload-reservations.ts`, que son el mismo
 * procedimiento del Media Bank. Dos diferencias:
 *
 * - El prefijo es `brandAudioKeyPrefix(companyId)` (`audio/{companyId}`), no
 *   `media/{companyId}`: es lo que separa "audio de la marca" de "cualquier
 *   objeto del workspace" para la política del render.
 * - La clave **no lleva extensión**: `extensionFor` sólo conoce los tipos del
 *   Media Bank y `primitives/uploads.ts` no es de esta tanda. No hace falta:
 *   el content-type viaja en el PUT y ffmpeg detecta el formato por contenido.
 *
 * ## Borrar
 *
 * Soft delete de la fila; el objeto **queda** en el bucket. Una pieza que ya la
 * usa guarda la URL en su `buildPayload`, y re-renderizarla (editar el texto)
 * tiene que seguir funcionando. El tope de espacio no existe para uso personal.
 *
 * ## Duración
 *
 * `durationSec` queda vacío en una subida: la API no corre ffprobe. El import
 * por link sí la trae (la midió el worker).
 */
import { z } from "zod";
import {
  BYTES_PER_MB,
  brandAudioKeyPrefix,
  brandAudioUploadRequestSchema,
  finalizeBrandAudioRequestSchema,
  listBrandAudioQuerySchema,
  updateBrandAudioRequestSchema,
  type BrandAudioTrack,
} from "@fastgram/contracts";
import {
  brandAudioRepository,
  uploadReservationRepository,
  type BrandAudioTrackRow,
} from "@fastgram/db";

import { rateLimit } from "../../plugins/rate-limit.js";
import {
  canonicalObjectUrl,
  claimReservation,
  reserveUpload,
  type UploadRejection,
} from "../../support/upload-reservations.js";
import { sendRejection } from "./media.js";
import { crossTenant, data, page } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const audioParams = z.object({ audioId: z.string().min(1) });

/**
 * Un id que no es uuid no existe (`malformed-ids.int.test.ts`): la columna es
 * `uuid` y Postgres levantaría `22P02` → 500. Se contesta el mismo 404.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** El nombre del archivo sin extensión: el título por defecto de una subida. */
export function titleFromFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim();
  return (stem === "" ? "Untitled track" : stem).slice(0, 200);
}

export function toBrandAudioTrack(row: BrandAudioTrackRow): BrandAudioTrack {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    origin: row.origin,
    contentType: row.contentType,
    sizeMb: row.sizeMb,
    ...(row.durationSec === null ? {} : { durationSec: row.durationSec }),
    ...(row.sourceUrl === null ? {} : { sourceUrl: row.sourceUrl }),
    autoUse: row.autoUse,
    createdAt: row.createdAt.getTime(),
  };
}

type FinalizeOutcome =
  | { readonly ok: true; readonly row: BrandAudioTrackRow }
  | { readonly ok: false; readonly rejection: UploadRejection };

export function registerAudioLibraryRoutes(app: ZodApp): void {
  const { clock, limiter, storage } = app.deps;

  // ── GET /audio/library ──
  app.get(
    "/audio/library",
    { schema: { querystring: listBrandAudioQuerySchema } },
    async (request) => {
      const q = request.query;
      const result = await request.tx((tx) =>
        brandAudioRepository.list(
          tx,
          { companyId: request.auth.companyId },
          {
            limit: q.limit,
            ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
            ...(q.q === undefined ? {} : { q: q.q }),
          },
        ),
      );
      return page(result, toBrandAudioTrack);
    },
  );

  // ── POST /audio/library/upload-url ──
  app.post(
    "/audio/library/upload-url",
    {
      schema: { body: brandAudioUploadRequestSchema },
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
          prefix: brandAudioKeyPrefix(companyId),
          filename: body.filename,
          contentType: body.contentType,
          sizeBytes: body.sizeBytes,
        }),
      );
      // 200 y no 201, como `POST /media/upload-url`: es una capacidad con
      // vencimiento, no un recurso. `uploadUrl` está firmada: no va a logs.
      return reply.status(200).send(data(reservation));
    },
  );

  // ── POST /audio/library ──
  app.post(
    "/audio/library",
    {
      schema: { body: finalizeBrandAudioRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const { uploadId, title } = request.body;
      const companyId = request.auth.companyId;

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
        // Una reserva del Media Bank (imagen/video) no se finaliza acá: sería
        // meter un objeto de `media/` en la biblioteca de audio, que el render
        // autoriza como librería. Mismo 404 que una reserva ajena.
        if (!reservation.storageKey.startsWith(`${brandAudioKeyPrefix(companyId)}/`)) {
          return {
            ok: false,
            rejection: {
              status: 404,
              code: "not_found",
              message: "upload reservation not found",
            },
          };
        }
        const row = await brandAudioRepository.create(
          tx,
          { companyId },
          {
            title: title ?? titleFromFilename(reservation.filename),
            origin: "upload",
            storageKey: reservation.storageKey,
            url: await canonicalObjectUrl(storage, reservation.storageKey),
            contentType: reservation.contentType,
            // El tamaño real del objeto, no el declarado.
            sizeMb: claim.sizeBytes / BYTES_PER_MB,
          },
        );
        await uploadReservationRepository.update(tx, { companyId }, uploadId, {
          state: "committed",
        });
        return { ok: true, row };
      });

      if (!outcome.ok) return sendRejection(reply, outcome.rejection);
      return reply.status(201).send(data(toBrandAudioTrack(outcome.row)));
    },
  );

  // ── PATCH /audio/library/:audioId ──
  app.patch(
    "/audio/library/:audioId",
    { schema: { params: audioParams, body: updateBrandAudioRequestSchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const { audioId } = request.params;
      if (!UUID.test(audioId)) throw crossTenant("audio track", audioId, companyId);
      const body = request.body;
      const row = await request.tx((tx) =>
        brandAudioRepository.update(tx, { companyId }, audioId, {
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.autoUse === undefined ? {} : { autoUse: body.autoUse }),
        }),
      );
      if (row === null) throw crossTenant("audio track", audioId, companyId);
      return data(toBrandAudioTrack(row));
    },
  );

  // ── DELETE /audio/library/:audioId ──
  app.delete(
    "/audio/library/:audioId",
    { schema: { params: audioParams } },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const { audioId } = request.params;
      if (!UUID.test(audioId)) throw crossTenant("audio track", audioId, companyId);
      const deleted = await request.tx((tx) =>
        brandAudioRepository.softDelete(tx, { companyId }, audioId),
      );
      if (!deleted) throw crossTenant("audio track", audioId, companyId);
      return reply.status(204).send();
    },
  );
}
