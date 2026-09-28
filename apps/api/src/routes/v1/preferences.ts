/**
 * Preferencias aprendidas desde Blitz — sprint 9 (agente Q), `PU-S9-011`, `D-22`.
 * El contrato está en `@fastgram/contracts` (`resources/preferences.ts`).
 *
 *   GET   /preferences          marca activa (con el dueño como prior)
 *   PATCH /preferences          on/off, exploración, vida media de la marca
 *   POST  /preferences/reset    { scope: "brand" | "owner", confirm: true }
 *   GET   /preferences/owner    nivel del dueño (owner-level, `isOwnerLevelRoute`)
 *   PATCH /preferences/owner    defaults del dueño
 *
 * Las señales las capturan las rutas de decisión (`blitz.ts`, `content.ts`)
 * con `services/preferences.ts`; acá sólo se lee, se configura y se olvida.
 *
 * ## Decisiones que el PRD no cubre
 *
 * - **Reset de la marca** borra sus señales y sus pesos, y saca su aporte del
 *   nivel del dueño. **Reset del dueño** no borra nada de las marcas: marca un
 *   instante desde el que el nivel del dueño vuelve a contar. Los dos piden
 *   `confirm: true` en el cuerpo (sin él, `400`): la confirmación visual la
 *   hace la web, el cuerpo hace que un `curl` distraído no borre nada.
 * - **Cambiar la vida media recalcula en el momento** (es barato: una marca,
 *   hasta 5 000 señales). Cambiar la exploración no: no toca los pesos.
 * - **`/preferences/owner` fuera del modo personal es 404**, como
 *   `/character-models`: el "dueño" existe porque hay una sola persona.
 */
import {
  resetPreferencesRequestSchema,
  updateOwnerPreferenceSettingsRequestSchema,
  updatePreferenceSettingsRequestSchema,
} from "@fastgram/contracts";
import {
  ownerPreferencesStore,
  preferenceSignalStore,
  preferenceWeightsStore,
  withoutCompany,
  workspaceDirectory,
  type OwnerScope,
} from "@fastgram/db";
import type { FastifyRequest } from "fastify";

import { ownerOrFail } from "../../auth/scope.js";
import {
  brandPreferencesView,
  ownerPreferencesView,
  recomputePreferences,
} from "../../services/preferences.js";
import { data, notFound } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

export function registerPreferenceRoutes(app: ZodApp): void {
  const { db, clock } = app.deps;
  const mode = app.deps.mode ?? "standard";

  const requirePersonal = (): void => {
    if (mode !== "personal") throw notFound("route");
  };

  async function ownerOf(request: FastifyRequest): Promise<OwnerScope> {
    requirePersonal();
    const home = request.auth.homeCompanyId ?? request.auth.companyId;
    const owner = await withoutCompany(db, (tx) => ownerOrFail(tx, home));
    return { ownerUserId: owner.ownerUserId };
  }

  // ── GET /preferences ──
  app.get("/preferences", async (request) => {
    const companyId = request.auth.companyId;
    const view = await request.tx((tx) =>
      brandPreferencesView(tx, companyId, clock.nowMs()),
    );
    return data(view);
  });

  // ── PATCH /preferences ──
  app.patch(
    "/preferences",
    { schema: { body: updatePreferenceSettingsRequestSchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const body = request.body;
      const nowMs = clock.nowMs();
      const view = await request.tx(async (tx) => {
        await preferenceWeightsStore.patchSettings(
          tx,
          { companyId },
          {
            enabled: body.enabled,
            exploration: body.exploration,
            halfLifeDays: body.halfLifeDays,
          },
        );
        if (body.halfLifeDays !== undefined) {
          await recomputePreferences(tx, companyId, nowMs);
        }
        return brandPreferencesView(tx, companyId, nowMs);
      });
      return data(view);
    },
  );

  // ── POST /preferences/reset ──
  app.post(
    "/preferences/reset",
    { schema: { body: resetPreferencesRequestSchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const nowMs = clock.nowMs();
      const view = await request.tx(async (tx) => {
        const owner = await workspaceDirectory.ownerOf(tx, companyId);
        if (request.body.scope === "brand") {
          await preferenceSignalStore.deleteAll(tx, { companyId });
          await preferenceWeightsStore.clearStats(tx, { companyId });
          if (owner !== null) {
            await ownerPreferencesStore.removeBrand(
              tx,
              { ownerUserId: owner.ownerUserId },
              companyId,
            );
          }
        } else if (owner !== null) {
          await ownerPreferencesStore.reset(
            tx,
            { ownerUserId: owner.ownerUserId },
            new Date(nowMs),
          );
        }
        return brandPreferencesView(tx, companyId, nowMs);
      });
      request.log.info(
        { scope: request.body.scope },
        "preferencias reseteadas a pedido del dueño",
      );
      return data(view);
    },
  );

  // ── GET /preferences/owner ── (owner-level)
  app.get("/preferences/owner", async (request) => {
    const owner = await ownerOf(request);
    const view = await withoutCompany(db, (tx) =>
      ownerPreferencesView(tx, owner, clock.nowMs()),
    );
    return data(view);
  });

  // ── PATCH /preferences/owner ── (owner-level)
  app.patch(
    "/preferences/owner",
    { schema: { body: updateOwnerPreferenceSettingsRequestSchema } },
    async (request) => {
      const owner = await ownerOf(request);
      const body = request.body;
      const view = await withoutCompany(db, async (tx) => {
        await ownerPreferencesStore.patchSettings(tx, owner, {
          exploration: body.exploration,
          halfLifeDays: body.halfLifeDays,
        });
        return ownerPreferencesView(tx, owner, clock.nowMs());
      });
      return data(view);
    },
  );
}
