/**
 * Media Bank — `GET /media`, `GET /media/:id`, `DELETE /media/:id`.
 *
 * Fuente: PRD §9.3, FR-100, §9.2, §9.8.
 *
 * ## Qué falta acá y por qué
 *
 * `POST /media/upload-url`, `POST /media` y `PATCH /media/:id` no están implementados:
 * los tres escriben (la reserva de subida crea y después muta
 * `upload_reservations.state`) y `@fastgram/db` no expone escritura. Se suma que no hay
 * adaptador S3/MinIO todavía —`packages/adapters` sólo trae `MemoryStorage`—, así que
 * la `uploadUrl` no podría firmarse de verdad aunque la fila se pudiera crear.
 *
 * ## El borrado de este recurso es distinto al del resto de la API
 *
 * §9.2: *"los borrados idempotentes de media tratan ids ajenos/desconocidos como no-ops
 * seguros que **no revelan si el registro existe**"*. Por eso `DELETE /media/:id`
 * devuelve `204` siempre — es la única ruta de la v1 donde un id ajeno **no** produce
 * 404, y es deliberado: acá ni el 404 debe distinguirse del éxito.
 */
import { z } from "zod";
import { cursorQuerySchema } from "@fastgram/contracts";
import { mediaRepository } from "@fastgram/db";

import { rateLimit } from "../../plugins/rate-limit.js";
import { toMedia } from "../../support/serializers.js";
import { crossTenant, data, page, unsupportedFilter } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const mediaParams = z.object({ id: z.string().min(1) });

/** `type` se acepta y se rechaza explícitamente: ver `unsupportedFilter`. */
const listQuery = cursorQuerySchema.extend({
  type: z.enum(["image", "video"]).optional(),
});

export function registerMediaRoutes(app: ZodApp): void {
  const { limiter } = app.deps;

  // ── GET /media ──
  app.get("/media", { schema: { querystring: listQuery } }, async (request, reply) => {
    const q = request.query;
    if (q.type !== undefined) {
      return unsupportedFilter(reply, "GET /media", ["type"]);
    }

    const result = await request.tx((tx) =>
      mediaRepository.list(
        tx,
        { companyId: request.auth.companyId },
        { limit: q.limit, ...(q.cursor === undefined ? {} : { cursor: q.cursor }) },
      ),
    );
    return reply.send(page(result, toMedia));
  });

  // ── GET /media/:id ──
  app.get("/media/:id", { schema: { params: mediaParams } }, async (request) => {
    const { id } = request.params;
    const companyId = request.auth.companyId;
    const row = await request.tx((tx) => mediaRepository.findById(tx, { companyId }, id));
    if (row === null) throw crossTenant("media", id, companyId);
    return data(toMedia(row));
  });

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
