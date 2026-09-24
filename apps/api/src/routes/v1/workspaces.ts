/**
 * Marcas (workspaces) y modo — `PU-BRAND-001`, `PU-RUN-002` · `D-06`, `D-07`.
 *
 * El contrato es el de `@fastgram/contracts` (`resources/workspaces.ts`), fijado
 * por el coordinador del sprint 1. Lo que no se deduce leyéndolo:
 *
 * ## Fuera del modo personal, `/workspaces` responde 404
 *
 * Las rutas se registran siempre —el OpenAPI describe una sola superficie, y un
 * documento que cambie con una variable de entorno no se puede comparar contra
 * nada—, pero en `standard` contestan como si no existieran. No es cosmético:
 * `POST /workspaces` crea companies en plan `pro` con suscripción `active`, y en
 * `standard` eso sería un plan pago gratis por cada API key. Crear workspaces en
 * `standard` es `P1-TENANT-001` (rama `auth-y-suscripciones`), con billing.
 *
 * `GET /mode` sí contesta en los dos modos: es cómo la web sabe cuál es.
 *
 * ## El scope de estas rutas es el dueño, no la marca
 *
 * Todas operan sobre las marcas del **dueño de la credencial**, y la marca del
 * header `X-Fastgram-Workspace` no cambia el resultado (es del mismo dueño, o la
 * request ni llegó acá: `auth/scope.ts` ya contestó 404). Las consultas cruzan
 * companies, así que corren con `withoutCompany`; el porqué y el agujero que eso
 * deja están en `packages/db/src/repositories/workspace-directory.ts`.
 *
 * ## No se puede borrar la marca de la key
 *
 * Decisión que el contrato no cubre. Una company `soft_deleted` hace que su key
 * responda 401 (PRD:1867), así que borrar la marca a la que pertenece la key de la
 * web **deja la app entera afuera**, sin forma de volver desde la UI. Se responde
 * `409 conflict`, igual que para la última marca.
 *
 * ## Borrar una marca apaga lo que tenía en marcha
 *
 * `P1-TENANT-005` (sprint 7): con el borrado, en la misma transacción, los
 * posts cancelables pasan a `CANCELLED`, los slots planificados se borran, la
 * estrategia vuelve a `manual` y las campañas vivas se cancelan
 * (`packages/db/src/repositories/brand-shutdown.ts`). Lo que ya está del lado
 * de TikTok (`IN_USER_INBOX`, `UPLOADING_TO_TIKTOK`) no se toca.
 */
import { z } from "zod";
import {
  createWorkspaceRequestSchema,
  idempotencyHeaderSchema,
  updateWorkspaceRequestSchema,
  type FastgramMode,
  type Workspace,
} from "@fastgram/contracts";
import {
  shutdownBrandActivity,
  withoutCompany,
  workspaceDirectory,
  type OwnedWorkspace,
} from "@fastgram/db";
import type { FastifyRequest } from "fastify";

import { ownerOrFail } from "../../auth/scope.js";
import { ApiRejection } from "../../http/errors.js";
import { data, idempotencyKeyOf, notFound, withIdempotency } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const workspaceParams = z.object({ id: z.string().min(1) });

/** `DATA-004`: sin fila de perfil es que nadie la analizó todavía. */
function toWorkspace(row: OwnedWorkspace): Workspace {
  return {
    id: row.id,
    name: row.name,
    profileStatus: row.profileStatus ?? "pending",
    logoUrl: row.logoUrl,
    createdAt: row.createdAt.toISOString(),
  };
}

/** La company de la credencial, antes del header. Es la puerta al dueño. */
function homeCompanyOf(request: FastifyRequest): string {
  return request.auth.homeCompanyId ?? request.auth.companyId;
}

export function registerWorkspaceRoutes(app: ZodApp): void {
  const { db, idempotency, clock } = app.deps;
  const mode: FastgramMode = app.deps.mode ?? "standard";

  /** Ver la cabecera: en `standard` estas rutas no existen para el cliente. */
  const requirePersonal = (): void => {
    if (mode !== "personal") throw notFound("route");
  };

  // ── GET /mode ──
  app.get("/mode", async (_request, reply) => reply.status(200).send(data({ mode })));

  // ── GET /workspaces ──
  app.get("/workspaces", async (request, reply) => {
    requirePersonal();
    const rows = await withoutCompany(db, async (tx) => {
      const owner = await ownerOrFail(tx, homeCompanyOf(request));
      return workspaceDirectory.list(tx, owner);
    });
    return reply.status(200).send(data(rows.map(toWorkspace)));
  });

  // ── POST /workspaces ──
  app.post(
    "/workspaces",
    {
      schema: { body: createWorkspaceRequestSchema, headers: idempotencyHeaderSchema },
    },
    async (request, reply) => {
      requirePersonal();
      const body = request.body;
      return withIdempotency(
        idempotency,
        request,
        reply,
        {
          key: idempotencyKeyOf({ ...request.headers }),
          route: "POST /workspaces",
          body,
          successStatus: 201,
        },
        () =>
          withoutCompany(db, async (tx) => {
            if (body.timezone !== undefined && !isIanaTimeZone(body.timezone)) {
              throw new ApiRejection(
                400,
                "bad_request",
                "timezone must be an IANA time zone",
                {
                  field: "timezone",
                },
              );
            }
            const owner = await ownerOrFail(tx, homeCompanyOf(request));
            return toWorkspace(await workspaceDirectory.create(tx, owner, body));
          }),
      );
    },
  );

  // ── PATCH /workspaces/:id ──
  app.patch(
    "/workspaces/:id",
    { schema: { params: workspaceParams, body: updateWorkspaceRequestSchema } },
    async (request, reply) => {
      requirePersonal();
      const { id } = request.params;
      const row = await withoutCompany(db, async (tx) => {
        const owner = await ownerOrFail(tx, homeCompanyOf(request));
        return workspaceDirectory.rename(tx, owner, id, request.body.name);
      });
      if (row === null) throw notFound("workspace");
      return reply.status(200).send(data(toWorkspace(row)));
    },
  );

  // ── DELETE /workspaces/:id ──
  app.delete(
    "/workspaces/:id",
    { schema: { params: workspaceParams } },
    async (request, reply) => {
      requirePersonal();
      const { id } = request.params;
      const home = homeCompanyOf(request);

      const result = await withoutCompany(db, async (tx) => {
        const owner = await ownerOrFail(tx, home);
        // La existencia va primero: una marca ajena tiene que dar el mismo 404
        // que una inexistente, aunque su id coincida con algo.
        //
        // Con la marca de la key, "es la última" gana sobre "es la de la key":
        // las dos son 409, pero el mensaje de la primera es el que el usuario
        // entiende. Y como la marca de la key siempre está viva (acaba de
        // autenticar), la última marca viva **es siempre** la de la key: sin
        // este orden, el 409 de "última" no saldría nunca.
        if (id === home) {
          const alive = await workspaceDirectory.list(tx, owner);
          if (!alive.some((w) => w.id === id)) return { kind: "not_found" as const };
          if (alive.length <= 1) return { kind: "last_workspace" as const };
          return { kind: "home_workspace" as const };
        }
        const deleted = await workspaceDirectory.softDelete(tx, owner, id);
        if (deleted.kind !== "deleted") return deleted;
        // `P1-TENANT-005` (sprint 7): en la misma transacción, apagar lo que la
        // marca tenía en marcha — posts agendados, slots planificados, piloto
        // y campañas. Sin esto, el job de un post `SCHEDULED` publicaba igual
        // en la cuenta de una marca borrada. Ver `brand-shutdown.ts`.
        const shutdown = await shutdownBrandActivity(tx, id, new Date(clock.nowMs()));
        request.log.info(
          { workspaceId: id, ...shutdown },
          "marca borrada: actividad apagada",
        );
        return deleted;
      });

      if (result.kind === "not_found") throw notFound("workspace");
      if (result.kind === "last_workspace") {
        throw new ApiRejection(409, "conflict", "You can't delete your only brand.");
      }
      if (result.kind === "home_workspace") {
        throw new ApiRejection(
          409,
          "conflict",
          "This brand owns the API key in use and can't be deleted.",
        );
      }
      return reply.status(204).send();
    },
  );
}

/** El mismo criterio que `timeZoneSchema` de strategy: lo que `Intl` acepta. */
function isIanaTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
