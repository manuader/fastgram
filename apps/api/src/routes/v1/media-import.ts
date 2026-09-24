/**
 * Importar por link — `POST /media/import`, `GET /media/import/:id`,
 * `GET /media/meta` (`PU-MEME-001`, `PU-MEME-002`, `PU-MEME-003`, D-12).
 *
 * Las monta `registerMediaRoutes` (`media.ts`): son del Media Bank.
 *
 * ## El estado vive en el storage, no en la base
 *
 * Sin migración para esta tarea, `DATA-010` no tiene dónde guardar el estado
 * del import, el motivo de un fallo, la URL de origen ni las etiquetas. Van a
 * objetos JSON bajo prefijos con el `companyId` (`importStatusKey`,
 * `mediaMetaKey` de `@fastgram/core`): pedir el import de otra marca busca en
 * otro prefijo, no encuentra nada, y es 404 como cualquier cruce de tenant.
 *
 * ## Los códigos de fallo no son códigos HTTP
 *
 * `unsupported_url`, `too_long`, `too_large` y `download_failed` no están en
 * `errorCodeSchema` (la v1 sólo emite códigos del PRD). Viajan en el campo
 * `error` del estado del import, que es un dato del recurso. El único que se
 * sabe al hacer el `POST` —una URL que no es http(s) o apunta a la red local—
 * sale como `400 bad_request` con `details.reason = "unsupported_url"`.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  mediaImportRequestSchema,
  mediaMetaQuerySchema,
  optionalIdempotencyHeaderSchema,
  type MediaImport,
  type MediaMetaView,
} from "@fastgram/contracts";
import {
  JOB_QUEUES,
  checkImportUrl,
  importStatusKey,
  mediaImportSingletonKey,
  mediaMetaKey,
  parseMediaImportStatus,
  type MediaImportJob,
  type MediaImportStatus,
} from "@fastgram/core";
import { mediaRepository } from "@fastgram/db";
import { PortError, type Storage } from "@fastgram/ports";

import { ApiRejection } from "../../http/errors.js";
import { rateLimit } from "../../plugins/rate-limit.js";
import { crossTenant, data, idempotencyKeyOf, withIdempotency } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

/** Los `maxAttempts: 2` de `mediaImport` en el catálogo del worker, en reintentos. */
export const MEDIA_IMPORT_RETRY_LIMIT = 1;

const IMPORT_ROUTE = "POST /media/import";
const MAX_META_IDS = 100;
const MAX_JSON_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const importParams = z.object({ id: z.string().min(1) });

async function readJson(storage: Storage, key: string): Promise<unknown> {
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

/** Lo guardado → la vista pública. Sin `jobId`: es un id interno de la cola. */
function toView(
  status: MediaImportStatus,
  mediaStatus: MediaImport["mediaStatus"],
): MediaImport {
  const view: Record<string, unknown> = {
    importId: status.importId,
    kind: status.kind,
    state: status.state,
    sourceUrl: status.sourceUrl,
    updatedAt: status.updatedAt,
  };
  for (const k of [
    "error",
    "mediaId",
    "cutoutMediaId",
    "background",
    "tagging",
    "tags",
    "audioUrl",
  ] as const) {
    if (status[k] !== undefined) view[k] = status[k];
  }
  if (mediaStatus !== undefined) view["mediaStatus"] = mediaStatus;
  return view as MediaImport;
}

export function registerMediaImportRoutes(app: ZodApp): void {
  const { clock, idempotency, limiter, storage, queue } = app.deps;

  // ── POST /media/import ──
  app.post(
    "/media/import",
    {
      schema: {
        body: mediaImportRequestSchema,
        headers: optionalIdempotencyHeaderSchema,
      },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      if (queue === undefined) {
        // Antes de consumir la `Idempotency-Key` (mismo criterio que brand-kit).
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Importing from a link is temporarily unavailable.",
          },
        });
      }
      const body = request.body;
      const companyId = request.auth.companyId;

      const url = checkImportUrl(body.url);
      if (!url.ok) {
        throw new ApiRejection(400, "bad_request", url.message, { reason: url.code });
      }
      if (body.kind === "audio" && (body.categories?.length ?? 0) > 0) {
        throw new ApiRejection(
          400,
          "bad_request",
          "Audio imports don't take categories.",
        );
      }

      const run = async (): Promise<MediaImport> => {
        const job: MediaImportJob = {
          companyId,
          importId: randomUUID(),
          // Lo elige la API para que el reintento del worker cree la misma fila.
          mediaId: randomUUID(),
          url: url.url,
          kind: body.kind,
          categories: [...new Set(body.categories ?? [])],
        };
        const enqueued = await queue.enqueue<MediaImportJob>({
          queue: JOB_QUEUES.mediaImport,
          payload: job,
          options: {
            singletonKey: mediaImportSingletonKey(job.importId),
            retryLimit: MEDIA_IMPORT_RETRY_LIMIT,
            retryBackoff: true,
          },
        });
        const status: MediaImportStatus = {
          importId: job.importId,
          kind: job.kind,
          state: "queued",
          sourceUrl: job.url,
          jobId: enqueued.jobId,
          updatedAt: clock.nowMs(),
        };
        // Después de encolar: un estado `queued` sin job sería eterno. Si esto
        // falla, el worker escribe el estado al tomar el job.
        await storage.put({
          key: importStatusKey(companyId, job.importId),
          body: new TextEncoder().encode(JSON.stringify(status)),
          contentType: "application/json",
          cacheControl: "no-store",
        });
        return toView(status, undefined);
      };

      const key = idempotencyKeyOf({ ...request.headers });
      if (key === "") return reply.status(202).send(data(await run()));
      return withIdempotency(
        idempotency,
        request,
        reply,
        { key, route: IMPORT_ROUTE, body, successStatus: 202 },
        run,
      );
    },
  );

  // ── GET /media/import/:id ──
  app.get("/media/import/:id", { schema: { params: importParams } }, async (request) => {
    const { id } = request.params;
    const companyId = request.auth.companyId;
    // El id entra en una clave de storage: sólo un uuid, nada de `../`.
    if (!UUID.test(id)) throw crossTenant("media import", id, companyId);
    const stored = parseMediaImportStatus(
      await readJson(storage, importStatusKey(companyId, id)),
    );
    if (stored === null) throw crossTenant("media import", id, companyId);

    let status = stored;
    // Un job que la cola dio por muerto (timeout, reintentos agotados) sin
    // que el worker llegara a escribir: se informa como fallido, no `queued`
    // para siempre.
    if (
      (status.state === "queued" || status.state === "downloading") &&
      status.jobId !== undefined &&
      queue !== undefined
    ) {
      // La cola caída no rompe el estado: se informa lo que dice el objeto.
      const job = await queue.getJob(status.jobId).catch((error: unknown) => {
        request.log.warn({ error }, "no se pudo consultar el job del import");
        return null;
      });
      if (
        job !== null &&
        (job.state === "failed" || job.state === "expired" || job.state === "cancelled")
      ) {
        status = { ...status, state: "failed", error: "download_failed" };
      }
    }

    let mediaStatus: MediaImport["mediaStatus"];
    if (status.mediaId !== undefined) {
      const mediaId = status.mediaId;
      const row = await request.tx((tx) =>
        mediaRepository.findById(tx, { companyId }, mediaId),
      );
      mediaStatus = row?.status;
    }
    return data(toView(status, mediaStatus));
  });

  // ── GET /media/meta?ids=… ──
  app.get(
    "/media/meta",
    { schema: { querystring: mediaMetaQuerySchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const ids = [...new Set(request.query.ids.split(",").map((s) => s.trim()))].filter(
        (s) => s.length > 0,
      );
      if (ids.length > MAX_META_IDS || ids.some((s) => !UUID.test(s))) {
        throw new ApiRejection(
          400,
          "bad_request",
          `Pass up to ${MAX_META_IDS} media ids.`,
        );
      }
      const found = await Promise.all(
        ids.map(async (mediaId): Promise<MediaMetaView | null> => {
          const raw = await readJson(storage, mediaMetaKey(companyId, mediaId));
          if (typeof raw !== "object" || raw === null) return null;
          const meta = raw as Record<string, unknown>;
          // Es nuestro JSON, pero de un bucket: sólo los campos conocidos.
          if (meta["mediaId"] !== mediaId) return null;
          const out: Record<string, unknown> = { mediaId };
          for (const k of [
            "sourceUrl",
            "tags",
            "background",
            "cutoutMediaId",
            "cutoutOf",
          ]) {
            if (meta[k] !== undefined) out[k] = meta[k];
          }
          return out as MediaMetaView;
        }),
      );
      return data(found.filter((m): m is MediaMetaView => m !== null));
    },
  );
}
