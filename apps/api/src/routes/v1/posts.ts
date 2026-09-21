/**
 * Posts — `GET /posts`, `GET /posts/:id`, `POST /analytics/posts`.
 *
 * Fuente: PRD §9.3, FR-060, NFR-012, ERR-F02.
 *
 * ## Qué falta acá y por qué
 *
 * `POST /content/:id/schedule`, `POST /posts/cancel` y `POST /posts/delete` no están
 * implementados: los tres escriben y `@fastgram/db` no expone escritura.
 *
 * Los dos de lote arrastran además la semántica **todo-o-nada** de NFR-011 (PRD:2961):
 * si un solo id falla no se aplica ninguno, y el error lleva `details.failures` con el
 * motivo por id (ERR-F01). Eso obliga a que el método de repositorio acepte un
 * `Executor` —para que la comprobación y la escritura commiteen juntas— y no abra
 * transacción propia.
 *
 * ## `POST /analytics/posts` sí está, y es el caso opuesto
 *
 * Es **éxito parcial** (ERR-F02, PRD:3201): un id desconocido vuelve como
 * `{"_id":"…","notFound":true}` dentro de un `200`. Leer métricas no muta nada, así que
 * abortar el lote entero por un id viejo sería hostil. Y como sólo lee, se puede
 * implementar con `findById` — que exige `companyId` en la firma, de modo que un id de
 * otro workspace cae en la rama `notFound` igual que un id inventado.
 */
import { z } from "zod";
import { cursorQuerySchema, postAnalyticsRequestSchema } from "@fastgram/contracts";
import { postRepository } from "@fastgram/db";

import { toPost } from "../../support/serializers.js";
import { crossTenant, data, page, unsupportedFilter } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const idParams = z.object({ id: z.string().min(1) });

/** `status` se acepta y se rechaza explícitamente: ver `unsupportedFilter`. */
const listQuery = cursorQuerySchema.extend({
  status: z.string().min(1).optional(),
});

export function registerPostRoutes(app: ZodApp): void {
  // ── GET /posts ──
  app.get("/posts", { schema: { querystring: listQuery } }, async (request, reply) => {
    const q = request.query;
    if (q.status !== undefined) {
      return unsupportedFilter(reply, "GET /posts", ["status"]);
    }

    const result = await request.tx((tx) =>
      postRepository.list(
        tx,
        { companyId: request.auth.companyId },
        { limit: q.limit, ...(q.cursor === undefined ? {} : { cursor: q.cursor }) },
      ),
    );
    return reply.send(page(result, toPost));
  });

  // ── GET /posts/:id ──
  app.get("/posts/:id", { schema: { params: idParams } }, async (request) => {
    const { id } = request.params;
    const companyId = request.auth.companyId;
    const row = await request.tx((tx) => postRepository.findById(tx, { companyId }, id));
    if (row === null) throw crossTenant("post", id, companyId);
    return data(toPost(row));
  });

  // ── POST /analytics/posts ──
  app.post(
    "/analytics/posts",
    { schema: { body: postAnalyticsRequestSchema } },
    async (request) => {
      const { postIds } = request.body;
      const companyId = request.auth.companyId;

      // Los ids ya vienen **deduplicados y capados a 100** por `batchPostIdsSchema`
      // (NFR-012: el orden importa — 150 ids con 60 repetidos son 90 únicos y la
      // llamada es válida). Con ese techo, N lecturas por id dentro de una sola
      // transacción es un coste acotado y conocido; el alternativo sería un
      // `findManyByIds` scopeado en el repositorio, que hoy no existe.
      const rows = await request.tx(async (tx) => {
        const found = new Map<
          string,
          Awaited<ReturnType<typeof postRepository.findById>>
        >();
        for (const id of postIds) {
          found.set(id, await postRepository.findById(tx, { companyId }, id));
        }
        return found;
      });

      // El orden de la respuesta sigue al del pedido para que el cliente pueda
      // emparejar por posición sin buscar por id.
      return data(
        postIds.map((id) => {
          const row = rows.get(id);
          // Ajeno e inexistente caen los dos acá, indistinguibles (§9.2).
          if (row === null || row === undefined) {
            return { _id: id, notFound: true as const };
          }
          return {
            _id: id,
            views: row.views,
            likes: row.likes,
            comments: row.comments,
            ...(row.postUrl === null ? {} : { postUrl: row.postUrl }),
            ...(row.postedAt === null ? {} : { postedAt: row.postedAt.getTime() }),
          };
        }),
      );
    },
  );
}
