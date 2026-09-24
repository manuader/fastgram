/**
 * Media Sets — `GET /media/sets`, `POST /media/sets`, `DELETE /media/sets/:id`
 * (`DATA-011`, `F-127`, `P2-MEDIA-005/006`).
 *
 * Las monta `registerMediaRoutes` (`media.ts`): son del Media Bank.
 *
 * ## Decisiones que el PRD no cubre
 *
 * - **El PRD no documenta la API** (§ tabla de cobertura: *«API no
 *   documentada»*). Las rutas cuelgan de `/media` porque un set es una vista
 *   del Media Bank, no un recurso de otro módulo.
 * - **Mínimo 5 assets, vivos y de la marca.** El 5 es el del modo
 *   `CREATING SET` (*«need 5 more»*). Un id borrado, ajeno o inexistente es
 *   `400` con la lista de los que no sirven: un set con huecos rompería en
 *   silencio a quien lo use para generar.
 * - **Borrar un set es borrado real** (`DATA-011` no tiene `deletedAt`) y
 *   **no** toca los assets.
 * - **Sin `PATCH`** por ahora: el modo del PRD es crear; para cambiarlo se
 *   borra y se crea otro.
 */
import { z } from "zod";
import { createMediaSetRequestSchema, type MediaSet } from "@fastgram/contracts";
import { mediaRepository, mediaSetRepository, type mediaSets } from "@fastgram/db";

import { rateLimit } from "../../plugins/rate-limit.js";
import { crossTenant, data } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const setParams = z.object({ id: z.string().min(1) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Los sets de una marca son pocos; la lista no pagina (tope defensivo). */
const MAX_SETS_LISTED = 100;

type MediaSetRow = (typeof mediaSets)["$inferSelect"];

export function toMediaSet(row: MediaSetRow): MediaSet {
  return {
    id: row.id as MediaSet["id"],
    name: row.name,
    kind: row.kind,
    mediaIds: row.mediaIds as MediaSet["mediaIds"],
    createdAt: row.createdAt.getTime(),
  };
}

export function registerMediaSetRoutes(app: ZodApp): void {
  const { limiter } = app.deps;

  // ── GET /media/sets ──
  app.get("/media/sets", async (request) => {
    const result = await request.tx((tx) =>
      mediaSetRepository.list(
        tx,
        { companyId: request.auth.companyId },
        { limit: MAX_SETS_LISTED },
      ),
    );
    return data(result.items.map(toMediaSet));
  });

  // ── POST /media/sets ──
  app.post(
    "/media/sets",
    {
      schema: { body: createMediaSetRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const body = request.body;
      const companyId = request.auth.companyId;

      const outcome = await request.tx(async (tx) => {
        // Un id que no es uuid no llega a la base (Postgres lo rechazaría con
        // `invalid input syntax`, un 500): cuenta como inexistente.
        const candidates = body.mediaIds.filter((id) => UUID.test(id));
        const found = await mediaRepository.list(
          tx,
          { companyId },
          { limit: candidates.length, filter: { mediaId: { in: candidates } } },
        );
        const live = new Set(found.items.map((row) => row.mediaId));
        const missing = body.mediaIds.filter((id) => !live.has(id));
        if (missing.length > 0) return { ok: false as const, missing };

        const row = await mediaSetRepository.create(
          tx,
          { companyId },
          { name: body.name, kind: body.kind, mediaIds: [...body.mediaIds] },
        );
        return { ok: true as const, row };
      });

      if (!outcome.ok) {
        return reply.status(400).send({
          error: {
            code: "bad_request",
            message: "Some of the selected media no longer exist. Refresh and try again.",
            details: { missingMediaIds: outcome.missing },
          },
        });
      }
      return reply.status(201).send(data(toMediaSet(outcome.row)));
    },
  );

  // ── DELETE /media/sets/:id ──
  app.delete(
    "/media/sets/:id",
    {
      schema: { params: setParams },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const { id } = request.params;
      const companyId = request.auth.companyId;
      const deleted = await request.tx((tx) =>
        mediaSetRepository.hardDelete(tx, { companyId }, id),
      );
      // Ajeno e inexistente, iguales: 404 (regla del repo, cross-tenant → 404).
      if (!deleted) throw crossTenant("media set", id, companyId);
      return reply.status(204).send();
    },
  );
}
