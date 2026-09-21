/**
 * Influencers — `GET /influencers`, `GET /influencers/:id`.
 *
 * Fuente: PRD §9.3, FR-080, DATA-013.
 *
 * ## Qué falta acá y por qué
 *
 * `POST /influencers` y `POST /influencers/base-image/upload-url` no están
 * implementados: escriben, y `@fastgram/db` no expone escritura.
 *
 * `POST /influencers` es además el endpoint más caro de la API (250 créditos, pipeline
 * de 15-20 min), así que quien lo implemente necesita tres cosas que hoy no existen:
 * un método de repositorio que **reserve créditos dentro de la misma transacción** que
 * crea la fila (§9.4: *"reservas atómicas de cuota antes de trabajo costoso"*), el
 * `Idempotency-Key` obligatorio de §9.3 —que ya está cableado y listo en
 * `support/idempotency-store.ts`— y el cap de 50 activos de `HARD_CAPS`.
 *
 * `core` ya tiene `reserveCredits` y `releaseCredits`; lo que falta es el repositorio.
 */
import { z } from "zod";
import { cursorQuerySchema } from "@fastgram/contracts";
import { influencerRepository } from "@fastgram/db";

import { toInfluencer } from "../../support/serializers.js";
import { crossTenant, data, page } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const influencerParams = z.object({ id: z.string().min(1) });

export function registerInfluencerRoutes(app: ZodApp): void {
  // ── GET /influencers ──
  app.get(
    "/influencers",
    { schema: { querystring: cursorQuerySchema } },
    async (request) => {
      const q = request.query;
      const result = await request.tx((tx) =>
        influencerRepository.list(
          tx,
          { companyId: request.auth.companyId },
          { limit: q.limit, ...(q.cursor === undefined ? {} : { cursor: q.cursor }) },
        ),
      );
      return page(result, toInfluencer);
    },
  );

  // ── GET /influencers/:id ──
  app.get(
    "/influencers/:id",
    { schema: { params: influencerParams } },
    async (request) => {
      const { id } = request.params;
      const companyId = request.auth.companyId;
      const row = await request.tx((tx) =>
        influencerRepository.findById(tx, { companyId }, id),
      );
      if (row === null) throw crossTenant("influencer", id, companyId);
      // `soulId`, `baseCharacterCmlId` e `internalRefs` no salen: DATA-013 los marca
      // "nunca expuestos" y `toInfluencer` simplemente no los mapea.
      return data(toInfluencer(row));
    },
  );
}
