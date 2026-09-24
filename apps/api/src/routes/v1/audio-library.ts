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
 * por link sí la trae (la midió el worker), y la extracción también.
 *
 * ## Extraer de un video (sprint 7, segunda tanda, H)
 *
 * `POST /audio/library/extract` elige un video del Media Bank y encola
 * `audio-extract`; el worker corre FFmpeg y crea la pista con origen
 * `extracted`. El estado consultable (`GET /audio/library/extractions/:id`)
 * es un JSON en el storage bajo el prefijo de la marca, igual que el de
 * `media-import`: sin tabla, y una extracción ajena es 404 porque vive en
 * otro prefijo. El tope de duración es `AUDIO_EXTRACT_MAX_SECONDS` (300 s).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  BYTES_PER_MB,
  audioExtractRequestSchema,
  brandAudioKeyPrefix,
  brandAudioUploadRequestSchema,
  finalizeBrandAudioRequestSchema,
  listBrandAudioQuerySchema,
  updateBrandAudioRequestSchema,
  type AudioExtraction,
  type BrandAudioTrack,
} from "@fastgram/contracts";
import {
  AUDIO_EXTRACT_MAX_SECONDS,
  JOB_QUEUES,
  audioExtractionStatusKey,
  parseAudioExtractionStatus,
  type AudioExtractJob,
  type AudioExtractionStatus,
} from "@fastgram/core";
import {
  brandAudioRepository,
  mediaRepository,
  uploadReservationRepository,
  type BrandAudioTrackRow,
} from "@fastgram/db";
import { PortError, type Storage } from "@fastgram/ports";

import { ApiRejection } from "../../http/errors.js";

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

/** Los `maxAttempts: 2` de `audioExtract` en el catálogo del worker, en reintentos. */
const AUDIO_EXTRACT_RETRY_LIMIT = 1;

const extractionParams = z.object({ extraction: z.string().min(1) });

/** Un JSON de estado no pasa de unos KB; más es un objeto que no es nuestro. */
const MAX_JSON_BYTES = 64 * 1024;

async function readStatusJson(storage: Storage, key: string): Promise<unknown> {
  let stream: AsyncIterable<Uint8Array>;
  try {
    stream = await storage.get(key);
  } catch (error) {
    if (error instanceof PortError && error.code === "not_found") return null;
    throw error;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > MAX_JSON_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

export function toAudioExtraction(status: AudioExtractionStatus): AudioExtraction {
  return {
    id: status.id,
    mediaId: status.mediaId as AudioExtraction["mediaId"],
    state: status.state,
    ...(status.trackId === undefined ? {} : { trackId: status.trackId }),
    ...(status.error === undefined ? {} : { error: status.error }),
    updatedAt: status.updatedAt,
  };
}

type FinalizeOutcome =
  | { readonly ok: true; readonly row: BrandAudioTrackRow }
  | { readonly ok: false; readonly rejection: UploadRejection };

export function registerAudioLibraryRoutes(app: ZodApp): void {
  const { clock, limiter, storage, queue } = app.deps;

  // ── POST /audio/library/extract ──
  app.post(
    "/audio/library/extract",
    {
      schema: { body: audioExtractRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      if (queue === undefined) {
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Extracting audio is temporarily unavailable.",
          },
        });
      }
      const companyId = request.auth.companyId;
      const { mediaId, title } = request.body;
      if (!UUID.test(mediaId)) throw crossTenant("media", mediaId, companyId);
      const media = await request.tx((tx) =>
        mediaRepository.findById(tx, { companyId }, mediaId),
      );
      if (media === null) throw crossTenant("media", mediaId, companyId);
      if (media.mediaType !== "video") {
        throw new ApiRejection(400, "bad_request", "Pick a video to extract its audio.", {
          reason: "not_a_video",
        });
      }
      if (
        media.videoDurationSec !== null &&
        media.videoDurationSec > AUDIO_EXTRACT_MAX_SECONDS + 1
      ) {
        throw new ApiRejection(
          400,
          "bad_request",
          `That video is longer than ${String(AUDIO_EXTRACT_MAX_SECONDS / 60)} minutes.`,
          { reason: "too_long", maxSeconds: AUDIO_EXTRACT_MAX_SECONDS },
        );
      }

      const job: AudioExtractJob = {
        companyId,
        extractionId: randomUUID(),
        mediaId: media.mediaId,
        ...(title === undefined ? {} : { title }),
      };
      const status: AudioExtractionStatus = {
        id: job.extractionId,
        mediaId: job.mediaId,
        state: "queued",
        updatedAt: clock.nowMs(),
      };
      // Antes de encolar: si el worker lo toma enseguida, su `extracting` no
      // lo pisa un `queued` tardío. Si encolar falla, el objeto queda
      // huérfano y nadie lo consulta (el POST respondió error).
      await storage.put({
        key: audioExtractionStatusKey(companyId, job.extractionId),
        body: new TextEncoder().encode(JSON.stringify(status)),
        contentType: "application/json",
        cacheControl: "no-store",
      });
      await queue.enqueue<AudioExtractJob>({
        queue: JOB_QUEUES.audioExtract,
        payload: job,
        options: {
          singletonKey: `${JOB_QUEUES.audioExtract}:${job.extractionId}`,
          retryLimit: AUDIO_EXTRACT_RETRY_LIMIT,
          retryBackoff: true,
        },
      });
      return reply.status(202).send(data(toAudioExtraction(status)));
    },
  );

  // ── GET /audio/library/extractions/:extraction ──
  // (El parámetro no termina en `Id` a propósito: trampa 56.)
  app.get(
    "/audio/library/extractions/:extraction",
    { schema: { params: extractionParams } },
    async (request) => {
      const companyId = request.auth.companyId;
      const id = request.params.extraction;
      // El id entra en una clave de storage: sólo un uuid, nada de `../`.
      if (!UUID.test(id)) throw crossTenant("audio extraction", id, companyId);
      const stored = parseAudioExtractionStatus(
        await readStatusJson(storage, audioExtractionStatusKey(companyId, id)),
      );
      if (stored === null || stored.id !== id) {
        throw crossTenant("audio extraction", id, companyId);
      }
      let status = stored;
      // Un job que la cola dio por muerto sin que el worker escribiera el
      // final: se informa como fallido, no `extracting` para siempre.
      if (
        (status.state === "queued" || status.state === "extracting") &&
        status.jobId !== undefined
      ) {
        const jobId = status.jobId;
        const job = await queue?.getJob(jobId).catch((error: unknown) => {
          request.log.warn({ error }, "no se pudo consultar el job de la extracción");
          return null;
        });
        if (
          job !== undefined &&
          job !== null &&
          (job.state === "failed" || job.state === "expired" || job.state === "cancelled")
        ) {
          status = { ...status, state: "failed", error: "extract_failed" };
        }
      }
      return data(toAudioExtraction(status));
    },
  );

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
