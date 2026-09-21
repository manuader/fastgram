/**
 * Content — `GET /content`, `GET /content/:id`, `DELETE /content/:id`.
 *
 * Fuente: PRD §9.3, FR-051, DATA-008, ERR-P02.
 *
 * ## Qué falta acá y por qué
 *
 * `POST /content`, `PATCH /content/:id`, `POST /content/:id/regenerate`,
 * `GET /content/:id/editable` y los dos de `custom/video` no están implementados.
 * Los cuatro primeros escriben y `@fastgram/db` no expone escritura; `editable` lee
 * `content_text_boxes`, que **no tiene repositorio propio con scope** (hay
 * `contentTextBoxRepository`, pero listar las cajas *de un contenido* necesita filtrar
 * por `contentId`, y `ListOptions.where` pide un `SQL` que no se puede construir desde
 * acá).
 *
 * `DELETE` sí está: es soft-delete y el repositorio lo cubre, con scope en la firma.
 *
 * ## Lo que sí queda garantizado en lo que hay
 *
 * `buildPayload` y `studioState` **nunca** salen por la API (DATA-008). No están en
 * `toContent`, y como el tipo de retorno es explícito, agregarlos sería un error de
 * compilación y no un descuido de revisión.
 */
import { z } from "zod";
import {
  CONTENT_BUILD_DELETE_GRACE_MINUTES,
  cursorQuerySchema,
} from "@fastgram/contracts";
import { contentRepository } from "@fastgram/db";

import { rateLimit } from "../../plugins/rate-limit.js";
import { toContent } from "../../support/serializers.js";
import { crossTenant, data, page, unsupportedFilter } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const contentParams = z.object({ id: z.string().min(1) });

/** ERR-P02 (PRD:3184) — margen antes de poder borrar un contenido colgado. */
const BUILD_GRACE_MS = CONTENT_BUILD_DELETE_GRACE_MINUTES * 60 * 1000;

/**
 * Query de `GET /content`.
 *
 * El contrato define `type` y `status` como listas separadas por comas (§12). Acá se
 * aceptan como strings crudos y se rechazan explícitamente: filtrar necesita
 * `ListOptions.where`, que es un `SQL`. Ver `unsupportedFilter`.
 */
const listQuery = cursorQuerySchema.extend({
  type: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
});

export function registerContentRoutes(app: ZodApp): void {
  const { limiter, clock } = app.deps;

  // ── GET /content ──
  app.get("/content", { schema: { querystring: listQuery } }, async (request, reply) => {
    const q = request.query;
    if (q.type !== undefined || q.status !== undefined) {
      return unsupportedFilter(reply, "GET /content", ["type", "status"]);
    }

    const result = await request.tx((tx) =>
      contentRepository.list(
        tx,
        { companyId: request.auth.companyId },
        { limit: q.limit, ...(q.cursor === undefined ? {} : { cursor: q.cursor }) },
      ),
    );
    return reply.send(page(result, toContent));
  });

  // ── GET /content/:id ──
  app.get("/content/:id", { schema: { params: contentParams } }, async (request) => {
    const { id } = request.params;
    const companyId = request.auth.companyId;
    const row = await request.tx((tx) =>
      contentRepository.findById(tx, { companyId }, id),
    );
    // Ajeno e inexistente devuelven el mismo `null` desde el repositorio, y el mismo
    // 404 desde acá. Son indistinguibles a propósito (§9.2).
    if (row === null) throw crossTenant("content", id, companyId);
    return data(toContent(row));
  });

  // ── DELETE /content/:id ──
  app.delete(
    "/content/:id",
    {
      schema: { params: contentParams },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const { id } = request.params;
      const companyId = request.auth.companyId;

      const outcome = await request.tx(async (tx) => {
        const row = await contentRepository.findById(tx, { companyId }, id);
        if (row === null) return { kind: "not_found" as const };

        // ERR-P02: un contenido en `BUILDING` se puede borrar **pasados 15 minutos**.
        // Antes de eso el build sigue vivo y borrarlo dejaría el job huérfano.
        if (
          row.status === "BUILDING" &&
          clock.nowMs() - row.createdAt.getTime() < BUILD_GRACE_MS
        ) {
          return { kind: "building" as const };
        }

        await contentRepository.softDelete(tx, { companyId }, id);
        return { kind: "deleted" as const };
      });

      if (outcome.kind === "not_found") throw crossTenant("content", id, companyId);
      if (outcome.kind === "building") {
        return reply.status(409).send({
          error: {
            code: "content_still_building",
            message: `Content that is still building can be deleted after ${CONTENT_BUILD_DELETE_GRACE_MINUTES} minutes.`,
          },
        });
      }
      return reply.status(204).send();
    },
  );
}
