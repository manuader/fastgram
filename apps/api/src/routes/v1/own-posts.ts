/**
 * Importar posts propios al Media Bank — `POST /media/own-posts/import`,
 * `GET /media/own-posts/imports`, `GET /media/own-posts/import/:id`
 * (`FR-011.5.1`, D-04, `P1-ONB-008`, cola `own-post-import` §9.5 #21).
 *
 * Opt-in: nada se importa si el usuario no lo pide (en la UI el checkbox
 * arranca desmarcado). La ruta valida, crea la fila `queued` y encola en la
 * **misma transacción** (ADR-005): sin cola no hay fila (`503`), y al revés.
 *
 * ## Qué fuentes
 *
 * - `connection`: una cuenta conectada de la marca, por la API oficial que ya
 *   usamos para publicar y leer métricas — Instagram (Graph, Instagram Login)
 *   y YouTube (Data API, `uploads`). Otra plataforma → `400` con
 *   `unsupported_platform`: sus APIs de lectura de posts propios no están
 *   cableadas.
 * - `profile`: un link de perfil público, leído por `yt-dlp` sin login (D-13):
 *   TikTok y YouTube. Medido el 2026-09-24 con el `yt-dlp` de la máquina:
 *   un canal de YouTube lista bien (`/@canal/shorts`); un perfil de TikTok
 *   falla con *«Unable to extract secondary user ID»* (depende de la versión
 *   de `yt-dlp`: el import cierra `failed`/`listing_failed`, no cuelga); X
 *   responde *«Unsupported URL»* para un perfil, así que no se ofrece.
 *   Instagram por perfil necesita login y tampoco (usar la conexión).
 *
 * El worker (`apps/worker/src/own-posts`) lista, deduplica por
 * `media.source_ref` y baja; los assets nacen con `origin: "imported"`.
 */
import { z } from "zod";
import {
  OWN_POST_IMPORT_DEFAULT_LIMIT,
  ownPostImportRequestSchema,
  type OwnPostImport,
} from "@fastgram/contracts";
import { JOB_QUEUES, checkImportUrl } from "@fastgram/core";
import {
  connectionRepository,
  ownPostImportRepository,
  type OwnPostImportRow,
} from "@fastgram/db";

import { ApiRejection } from "../../http/errors.js";
import { rateLimit } from "../../plugins/rate-limit.js";
import { crossTenant, data } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

/** Plataformas con lectura oficial de posts propios cableada en el worker. */
export const OWN_POST_CONNECTION_PLATFORMS = ["instagram", "youtube"] as const;

/** Los `maxAttempts: 3` de `ownPostImport` en el catálogo del worker, en reintentos. */
const OWN_POST_IMPORT_RETRY_LIMIT = 2;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Payload de `own-post-import`. Escrito dos veces —acá y en
 * `apps/worker/src/own-posts/handler.ts`— como el de `media-normalization`;
 * el nombre de la cola sale de `JOB_QUEUES` (trampa 19).
 */
interface OwnPostImportJob {
  readonly companyId: string;
  readonly importId: string;
}

/**
 * La plataforma de un link de perfil, por host. `null` = no se lee sin login
 * (o no es una red que conozcamos).
 */
export function profilePlatformOf(url: string): "tiktok" | "youtube" | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\.|^m\./, "");
  } catch {
    return null;
  }
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "tiktok";
  if (host === "youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com"))
    return "youtube";
  return null;
}

export function toOwnPostImport(row: OwnPostImportRow): OwnPostImport {
  return {
    id: row.id,
    source: row.source,
    platform: row.platform,
    state: row.state,
    limit: row.maxItems,
    found: row.found,
    imported: row.imported,
    skipped: row.skipped,
    failed: row.failed,
    ...(row.errorCode === null
      ? {}
      : { error: row.errorCode as NonNullable<OwnPostImport["error"]> }),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

const importParams = z.object({ id: z.string().min(1) });

export function registerOwnPostImportRoutes(app: ZodApp): void {
  const { limiter, queue } = app.deps;

  // ── POST /media/own-posts/import ──
  app.post(
    "/media/own-posts/import",
    {
      schema: { body: ownPostImportRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      if (queue === undefined) {
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Importing posts is temporarily unavailable.",
          },
        });
      }
      const body = request.body;
      const companyId = request.auth.companyId;
      const limit = body.limit ?? OWN_POST_IMPORT_DEFAULT_LIMIT;

      let values:
        | { source: "connection"; connectionId: string; platform: string }
        | { source: "profile"; profileUrl: string; platform: string };

      if (body.source === "profile") {
        const url = checkImportUrl(body.url);
        if (!url.ok) {
          throw new ApiRejection(400, "bad_request", url.message, { reason: url.code });
        }
        const platform = profilePlatformOf(url.url);
        if (platform === null) {
          throw new ApiRejection(
            400,
            "bad_request",
            "Paste a TikTok or YouTube profile link. Instagram needs a connected account.",
            { reason: "unsupported_platform" },
          );
        }
        values = { source: "profile", profileUrl: url.url, platform };
      } else {
        if (!UUID.test(body.connectionId)) {
          throw crossTenant("connection", body.connectionId, companyId);
        }
        const connection = await request.tx((tx) =>
          connectionRepository.findById(tx, { companyId }, body.connectionId),
        );
        if (connection === null) {
          throw crossTenant("connection", body.connectionId, companyId);
        }
        if (
          !(OWN_POST_CONNECTION_PLATFORMS as readonly string[]).includes(
            connection.platform,
          )
        ) {
          throw new ApiRejection(
            400,
            "bad_request",
            "Importing your posts works with a connected Instagram or YouTube account.",
            { reason: "unsupported_platform" },
          );
        }
        if (connection.status !== "active") {
          throw new ApiRejection(
            400,
            "bad_request",
            "Reconnect this account before importing its posts.",
            { reason: "connection_unavailable" },
          );
        }
        values = {
          source: "connection",
          connectionId: connection.id,
          platform: connection.platform,
        };
      }

      const row = await request.tx(async (tx) => {
        const created = await ownPostImportRepository.create(
          tx,
          { companyId },
          { ...values, maxItems: limit, state: "queued" },
        );
        await queue.enqueue<OwnPostImportJob>({
          queue: JOB_QUEUES.ownPostImport,
          payload: { companyId, importId: created.id },
          options: {
            transaction: tx,
            // Una vez por import: el id es nuevo en cada pedido (trampa 39 no
            // aplica, no hay nada que tenga que volver a disparar).
            singletonKey: `${JOB_QUEUES.ownPostImport}:${created.id}`,
            retryLimit: OWN_POST_IMPORT_RETRY_LIMIT,
            retryBackoff: true,
          },
        });
        return created;
      });
      return reply.status(202).send(data(toOwnPostImport(row)));
    },
  );

  // ── GET /media/own-posts/imports ──
  app.get("/media/own-posts/imports", async (request) => {
    const result = await request.tx((tx) =>
      ownPostImportRepository.list(
        tx,
        { companyId: request.auth.companyId },
        { limit: 10 },
      ),
    );
    return data(result.items.map(toOwnPostImport));
  });

  // ── GET /media/own-posts/import/:id ──
  app.get(
    "/media/own-posts/import/:id",
    { schema: { params: importParams } },
    async (request) => {
      const { id } = request.params;
      const companyId = request.auth.companyId;
      const row = await request.tx((tx) =>
        ownPostImportRepository.findById(tx, { companyId }, id),
      );
      if (row === null) throw crossTenant("own post import", id, companyId);
      return data(toOwnPostImport(row));
    },
  );
}
