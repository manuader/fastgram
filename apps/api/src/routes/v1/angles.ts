/**
 * Content angles — `GET /blitz/angles`, `POST /blitz/angles/generate`.
 *
 * Fuente: PRD §9.3, FR-056, AI-005.
 *
 * ## Qué falta acá y por qué
 *
 * `POST /blitz/angles`, `PATCH /blitz/angles/:id` y `DELETE /blitz/angles/:id` no están
 * implementados: los tres escriben y `@fastgram/db` no expone escritura. `DELETE`
 * tampoco se salva con `softDelete`, porque en este recurso borrar es **desactivar**
 * (FR-056, PRD:1319) — un `UPDATE isActive = false`, no un soft-delete.
 *
 * `GET /blitz/angles/page` tampoco: es paginación **numerada** (§9.10, `Page X of Y`) y
 * el repositorio sólo pagina por cursor, sin `offset`.
 *
 * Los tres de escritura arrastran además el requisito de §9.4 —*"crear ángulo **y**
 * reescribir `angleWeights` en la misma transacción"*—, así que quien los implemente
 * necesita que el método de repositorio acepte un `Executor` y no abra transacción
 * propia. `core` ya tiene `reconcileAngleWeights` listo para eso.
 */
import { cursorQuerySchema } from "@fastgram/contracts";
import { contentAngleRepository } from "@fastgram/db";

import { consumeOnSuccess } from "../../plugins/rate-limit.js";
import { toContentAngle } from "../../support/serializers.js";
import { data, page } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

export function registerAngleRoutes(app: ZodApp): void {
  const { limiter, angleGenerator } = app.deps;

  // ── GET /blitz/angles ──
  app.get(
    "/blitz/angles",
    { schema: { querystring: cursorQuerySchema } },
    async (request) => {
      const q = request.query;
      const result = await request.tx((tx) =>
        contentAngleRepository.list(
          tx,
          { companyId: request.auth.companyId },
          { limit: q.limit, ...(q.cursor === undefined ? {} : { cursor: q.cursor }) },
        ),
      );
      return page(result, toContentAngle);
    },
  );

  // ── POST /blitz/angles/generate ──
  app.post("/blitz/angles/generate", async (request, reply) => {
    if (angleGenerator === undefined) {
      // Sin adaptador de LLM no hay sugerencia que dar. `service_unavailable` es un
      // código del PRD (§19, ERR-R06); inventar un ángulo de relleno sería peor que
      // decir que el servicio no está.
      return reply.status(503).send({
        error: {
          code: "service_unavailable",
          message: "Angle generation is temporarily unavailable.",
        },
      });
    }

    const generated = await angleGenerator.generate({
      companyId: request.auth.companyId,
    });

    // §9.6: "5 sugerencias **exitosas** por minuto". Se cobra acá, después del éxito,
    // no en un preHandler. Ver la nota en `plugins/rate-limit.ts`.
    const limited = await consumeOnSuccess(limiter, "angleGeneration", request, reply);
    if (limited !== null) return limited;

    // AI-005: la sugerencia **no se persiste**. `brandRevision` vuelve al cliente para
    // que la reenvíe como `expectedBrandRevision` al crear.
    return reply.status(200).send(data(generated));
  });
}
