/**
 * Inspiration como tablero de referencias propio — `FR-040` adaptado,
 * `F-041`, `F-042`, `OQ-13`, `D-12`. Migración `0022`.
 *
 * `OQ-13` / PRD §2.5: el catálogo de trending de Fastlane son datos
 * licenciados o scrapeados de terceros, y el clon **no** lo replica. Para uso
 * personal, Inspiration es lo que el dueño guarda: pega un link (o elige un
 * clip ya subido), la referencia queda en `trending_items` con
 * `origin = 'owner'` y el `companyId` de la marca, y desde ahí se remixa.
 *
 * ## Qué pasa al guardar un link
 *
 * ```
 *   [tx] fila `pending` + job en `media-import` con `inspirationItemId`
 *        (+ el import del clip, si `saveClip`)
 *   worker  yt-dlp --dump-single-json (sin login) → título, autor, caption,
 *           hashtags, métricas públicas, miniatura → OCR si hay `vision`
 *           → `ready` | `failed` con un código estable
 * ```
 *
 * El job viaja por la cola `media-import` con un campo que la distingue (ver
 * `core/src/inspiration/ingest-job.ts`): una cola nueva tocaba cinco archivos
 * compartidos para la misma política. Sin cola montada → `503` antes de
 * escribir nada.
 *
 * ## «Remix this»
 *
 * **Es** `POST /blitz/generate` con la referencia como contexto: mismo
 * `blitz_prompt_requests` (con `source_trending_item_id`), mismo job en
 * `discovery-refill`, misma respuesta `202 {requestId}` y mismo polling en
 * `GET /blitz/generate/:requestId`. Al cerrar, las piezas heredan
 * `remix_source_url` y el deck muestra "Remixed From" (F-056).
 *
 * ## 404
 *
 * Ajena, inexistente, del catálogo global o con id que no es uuid: el mismo
 * 404 (§9.2). El parámetro se llama `itemId` a propósito: el hook de
 * `route-ids.ts` neutraliza los `…Id` que no son uuid (trampa 56).
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";
import {
  INSPIRATION_REMIX_DEFAULT_COUNT,
  createInspirationRequestSchema,
  listInspirationQuerySchema,
  optionalIdempotencyHeaderSchema,
  remixInspirationRequestSchema,
  updateInspirationRequestSchema,
  type InspirationItem,
} from "@fastgram/contracts";
import {
  JOB_QUEUES,
  REMIX_DEFAULT_PROMPT,
  checkImportUrl,
  importStatusKey,
  inspirationIngestSingletonKey,
  mediaImportSingletonKey,
  platformFromUrl,
  remixContentType,
  type DiscoveryRefillJob,
  type InspirationIngestJob,
  type MediaImportJob,
  type MediaImportStatus,
  type ReferenceFormat,
} from "@fastgram/core";
import {
  createOwnerReference,
  createPromptRequest,
  deleteOwnerReference,
  findOwnerReference,
  listOwnerReferenceTags,
  listOwnerReferences,
  mediaRepository,
  setOwnerReferenceTags,
  type TrendingItemRow,
} from "@fastgram/db";

import { ApiRejection } from "../../http/errors.js";
import { numberedPageEnvelope } from "./angles.js";
import { MEDIA_IMPORT_RETRY_LIMIT } from "./media-import.js";
import { crossTenant, data, idempotencyKeyOf, withIdempotency } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const itemParams = z.object({ itemId: z.string().min(1) });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PLATFORMS = new Set(["tiktok", "instagram", "youtube", "x"]);

function absolute(url: string | null): string | undefined {
  if (url === null || url === "") return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Fila → vista pública. Sin `companyId` ni claves de storage (NFR-007). */
export function toInspirationItem(row: TrendingItemRow): InspirationItem {
  const out: Record<string, unknown> = {
    id: row.id,
    platform: row.platform !== null && PLATFORMS.has(row.platform) ? row.platform : null,
    url: absolute(row.permalink) ?? null,
    hashtags: row.hashtags,
    tags: row.niches,
    format: row.format ?? null,
    slideCount: row.slideCount,
    onScreenText: row.textOverlays,
    ingestState: row.ingestState,
    createdAt: row.createdAt.getTime(),
  };
  const opt = (key: string, value: unknown) => {
    if (value !== null && value !== undefined && value !== "") out[key] = value;
  };
  opt("thumbnailUrl", absolute(row.thumbnailUrl));
  opt("title", row.title);
  opt("author", row.author);
  opt("caption", row.caption);
  opt("views", row.views);
  opt("likes", row.likes);
  opt("comments", row.comments);
  opt("durationSeconds", row.durationSeconds);
  opt("ingestError", row.ingestError);
  opt("mediaId", row.mediaId);
  opt("importId", row.importId);
  return out as InspirationItem;
}

function uniqueTags(tags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const t of tags ?? []) {
    const clean = t.trim().toLowerCase();
    if (clean !== "" && !out.includes(clean)) out.push(clean);
  }
  return out;
}

export function registerInspirationRoutes(app: ZodApp): void {
  const { clock, idempotency, storage, queue } = app.deps;

  // ── POST /inspiration ──
  app.post(
    "/inspiration",
    {
      schema: {
        body: createInspirationRequestSchema,
        headers: optionalIdempotencyHeaderSchema,
      },
    },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const body = request.body;
      const hasUrl = body.url !== undefined;
      const hasMedia = body.mediaId !== undefined;
      if (hasUrl === hasMedia) {
        throw new ApiRejection(
          400,
          "bad_request",
          "Pass a link or a clip from your Media Bank, not both.",
        );
      }
      if (hasMedia && body.saveClip === true) {
        throw new ApiRejection(
          400,
          "bad_request",
          "The clip is already in your Media Bank.",
        );
      }
      const tags = uniqueTags(body.tags);
      const respond = async (fn: () => Promise<InspirationItem>) => {
        const key = idempotencyKeyOf({ ...request.headers });
        if (key === "") return reply.status(201).send(data(await fn()));
        return withIdempotency(
          idempotency,
          request,
          reply,
          { key, route: "POST /inspiration", body, successStatus: 201 },
          fn,
        );
      };

      // ── Un clip ya subido: nada que leer de afuera ──
      if (body.mediaId !== undefined) {
        const mediaId = body.mediaId;
        // Un id que no es uuid haría fallar el cast en Postgres (500): es el
        // mismo 404 que uno ajeno.
        if (!UUID.test(mediaId)) throw crossTenant("media", mediaId, companyId);
        const run = async (): Promise<InspirationItem> => {
          const row = await request.tx(async (tx) => {
            const clip = await mediaRepository.findById(tx, { companyId }, mediaId);
            if (clip === null) return null;
            return createOwnerReference(
              tx,
              { companyId },
              {
                platform: null,
                permalink: null,
                niches: tags,
                ingestState: "ready",
                format: clip.mediaType === "image" ? "image" : "video",
                title: clip.filename,
                mediaId: clip.mediaId,
                // Una imagen es su propia miniatura; un video subido no trae una.
                thumbnailUrl: clip.mediaType === "image" ? clip.r2Url : null,
              },
            );
          });
          if (row === null) throw crossTenant("media", mediaId, companyId);
          return toInspirationItem(row);
        };
        return respond(run);
      }

      // ── Un link ──
      if (queue === undefined) {
        // Sin cola la referencia quedaría `pending` para siempre.
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Saving inspiration from a link is temporarily unavailable.",
          },
        });
      }
      const url = checkImportUrl(body.url ?? "");
      if (!url.ok) {
        throw new ApiRejection(400, "bad_request", url.message, { reason: url.code });
      }
      const saveClip = body.saveClip === true;

      const run = async (): Promise<InspirationItem> => {
        const clip = saveClip ? { importId: randomUUID(), mediaId: randomUUID() } : null;
        const row = await request.tx(async (tx) => {
          const created = await createOwnerReference(
            tx,
            { companyId },
            {
              platform: platformFromUrl(url.url),
              permalink: url.url,
              niches: tags,
              ingestState: "pending",
              ...(clip === null ? {} : clip),
            },
          );
          const job: InspirationIngestJob = {
            companyId,
            inspirationItemId: created.id,
            url: url.url,
          };
          // En la transacción de la fila (ADR-005): sin job no hay referencia
          // `pending`, y al revés.
          await queue.enqueue<InspirationIngestJob>({
            queue: JOB_QUEUES.mediaImport,
            payload: job,
            options: {
              transaction: tx,
              singletonKey: inspirationIngestSingletonKey(created.id),
              retryLimit: MEDIA_IMPORT_RETRY_LIMIT,
              retryBackoff: true,
            },
          });
          if (clip !== null) {
            // El import por link de siempre (`PU-MEME-001`), con el mismo payload.
            await queue.enqueue<MediaImportJob>({
              queue: JOB_QUEUES.mediaImport,
              payload: {
                companyId,
                importId: clip.importId,
                mediaId: clip.mediaId,
                url: url.url,
                kind: "video",
                categories: [],
              },
              options: {
                transaction: tx,
                singletonKey: mediaImportSingletonKey(clip.importId),
                retryLimit: MEDIA_IMPORT_RETRY_LIMIT,
                retryBackoff: true,
              },
            });
          }
          return created;
        });
        if (clip !== null) {
          // Después del commit, como `POST /media/import`: si esto falla, el
          // worker escribe el estado al tomar el job.
          const status: MediaImportStatus = {
            importId: clip.importId,
            kind: "video",
            state: "queued",
            sourceUrl: url.url,
            updatedAt: clock.nowMs(),
          };
          try {
            await storage.put({
              key: importStatusKey(companyId, clip.importId),
              body: new TextEncoder().encode(JSON.stringify(status)),
              contentType: "application/json",
              cacheControl: "no-store",
            });
          } catch (error: unknown) {
            request.log.warn(
              { error },
              "no se pudo escribir el estado inicial del import",
            );
          }
        }
        return toInspirationItem(row);
      };
      return respond(run);
    },
  );

  // ── GET /inspiration ──
  app.get(
    "/inspiration",
    { schema: { querystring: listInspirationQuerySchema } },
    async (request) => {
      const q = request.query;
      const result = await request.tx((tx) =>
        listOwnerReferences(
          tx,
          { companyId: request.auth.companyId },
          { q: q.q, format: q.format, tag: q.tag, page: q.page, limit: q.limit },
        ),
      );
      return numberedPageEnvelope(result, toInspirationItem);
    },
  );

  // ── GET /inspiration/tags ── (segmento estático: Fastify lo prefiere a `:itemId`)
  app.get("/inspiration/tags", async (request) => {
    const tags = await request.tx((tx) =>
      listOwnerReferenceTags(tx, { companyId: request.auth.companyId }),
    );
    return data([...tags]);
  });

  // ── GET /inspiration/:itemId ──
  app.get("/inspiration/:itemId", { schema: { params: itemParams } }, async (request) => {
    const companyId = request.auth.companyId;
    const { itemId } = request.params;
    const row = await request.tx((tx) => findOwnerReference(tx, { companyId }, itemId));
    if (row === null) throw crossTenant("inspiration", itemId, companyId);
    return data(toInspirationItem(row));
  });

  // ── PATCH /inspiration/:itemId ──
  app.patch(
    "/inspiration/:itemId",
    { schema: { params: itemParams, body: updateInspirationRequestSchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const { itemId } = request.params;
      const row = await request.tx((tx) =>
        setOwnerReferenceTags(tx, { companyId }, itemId, uniqueTags(request.body.tags)),
      );
      if (row === null) throw crossTenant("inspiration", itemId, companyId);
      return data(toInspirationItem(row));
    },
  );

  // ── DELETE /inspiration/:itemId ──
  app.delete(
    "/inspiration/:itemId",
    { schema: { params: itemParams } },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const { itemId } = request.params;
      const deleted = await request.tx((tx) =>
        deleteOwnerReference(tx, { companyId }, itemId),
      );
      if (!deleted) throw crossTenant("inspiration", itemId, companyId);
      return reply.status(204).send();
    },
  );

  // ── POST /inspiration/:itemId/remix ──
  app.post(
    "/inspiration/:itemId/remix",
    {
      schema: {
        params: itemParams,
        // Sin cuerpo (Fastify lo ve `null`) = todo por defecto.
        body: remixInspirationRequestSchema.nullish(),
        headers: optionalIdempotencyHeaderSchema,
      },
    },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const { itemId } = request.params;
      const body = request.body ?? {};

      if (queue === undefined) {
        // Mismo 503 que `POST /blitz/generate`: sin cola, el pedido quedaría
        // `queued` para siempre.
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Remixing is temporarily unavailable.",
          },
        });
      }

      const run = (): Promise<{ requestId: string }> =>
        request.tx(async (tx) => {
          const scope = { companyId };
          const item = await findOwnerReference(tx, scope, itemId);
          if (item === null) throw crossTenant("inspiration", itemId, companyId);
          const row = await createPromptRequest(tx, scope, {
            prompt: body.prompt ?? REMIX_DEFAULT_PROMPT,
            contentType:
              body.contentType ??
              remixContentType((item.format ?? null) as ReferenceFormat | null),
            count: body.count ?? INSPIRATION_REMIX_DEFAULT_COUNT,
            sourceTrendingItemId: item.id,
          });
          // La misma clave que `POST /blitz/generate`: el requestId es nuevo en
          // cada pedido y no se repite (trampas 39 y 45).
          const singletonKey = `${JOB_QUEUES.discoveryRefill}:prompt:${row.id}`;
          const { created } = await queue.enqueue<DiscoveryRefillJob>({
            queue: JOB_QUEUES.discoveryRefill,
            payload: { companyId, promptRequestId: row.id },
            options: { transaction: tx, singletonKey },
          });
          if (!created) {
            throw new Error(`discovery-refill no encoló el remix: ${singletonKey}`);
          }
          return { requestId: row.id };
        });

      const key = idempotencyKeyOf({ ...request.headers });
      if (key === "") return reply.status(202).send(data(await run()));
      return withIdempotency(
        idempotency,
        request,
        reply,
        {
          key,
          route: "POST /inspiration/:itemId/remix",
          body: { itemId, ...body },
          successStatus: 202,
        },
        run,
      );
    },
  );
}
