/**
 * Alta del primer workspace de un usuario — `P1-TENANT-001`, `DATA-002`,
 * `DATA-003`, PRD §15.4 y la decisión de PRD §2.4 (2026-09-23).
 *
 * Es la **única escritura** sobre `companies` de este paquete (la cabecera de
 * `company.ts` explica por qué no hay un `create` genérico ahí). Qué valores
 * lleva el workspace lo decide `planFirstWorkspace` de `@fastgram/core`; acá
 * sólo se escribe, y se escribe **todo o nada** en una transacción: la company,
 * la membresía `owner` `active` y `users.default_workspace_id`.
 *
 * ## RLS: sin función privilegiada, con el mecanismo de siempre
 *
 * El problema parece el de `0003`/`0012` —no hay `companyId` todavía— y no lo
 * es. Aquéllas **leen** algo cuyo `companyId` no se conoce; esto **escribe** un
 * workspace cuyo `companyId` lo elige quien escribe. Así que el id se genera
 * antes de abrir la transacción y se abre con `withCompany(db, idNuevo)`: el GUC
 * apunta al workspace que se está creando, y las políticas de `companies` y
 * `workspace_memberships` (`WITH CHECK id = app.current_company()`) se cumplen
 * **por construcción**, sin abrir ninguna. Una fila con otro `company_id` que
 * se colara en esta transacción la rechazaría RLS.
 *
 * Lo único que cruza workspaces es la pregunta *"¿ya tiene uno?"*, y para eso
 * ya existe `app.resolve_session_workspace` (`0012`, `SECURITY DEFINER`): es
 * **la misma regla** que decide el `companyId` de la sesión, así que "tiene
 * workspace" acá y "la sesión resuelve un workspace" en la API no pueden
 * divergir. `users` no tiene RLS (identidad global, ver `0002`).
 *
 * No hace falta una migración nueva. Se evaluó una función `SECURITY DEFINER`
 * que hiciera todo en SQL y se descartó: sería una segunda vía de escritura en
 * `companies` que saltea RLS, para resolver algo que RLS ya permite.
 *
 * ## La carrera (trampa 37 de `docs/HANDOFF.md`)
 *
 * *"¿Ya tiene uno?"* seguido de `INSERT` no es una guarda: dos pedidos
 * simultáneos leen "no", y los dos insertan. No hay índice único que lo cierre
 * —un usuario **podrá** tener varios workspaces cuando existan los
 * adicionales—, así que lo cierra un lock que los dos pedidos disputan: la fila
 * del usuario, `FOR NO KEY UPDATE`, **antes** de preguntar. El segundo espera
 * al commit del primero y, en READ COMMITTED, su siguiente sentencia ya ve la
 * membresía nueva.
 *
 * `NO KEY UPDATE` y no `UPDATE`: el `INSERT` de una sesión de Better Auth toma
 * `KEY SHARE` sobre la fila del usuario (FK de `auth_sessions`), y `FOR UPDATE`
 * lo bloquearía. Dos `NO KEY UPDATE` sí se excluyen entre sí, que es lo único
 * que hace falta.
 *
 * `test/first-workspace.int.test.ts` lo pone rojo quitando el lock: una
 * transacción ajena retiene la fila del usuario hasta que los dos pedidos están
 * **esperando un lock** (`pg_stat_activity`), así que el solapamiento se fuerza
 * en vez de confiarlo al azar (trampas 22 y 34).
 */
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Database } from "../client.js";
import { companies, users, workspaceMemberships } from "../schema/index.js";
import { withCompany, type WithCompanyOptions } from "../tenancy.js";
import type { CompanyRow } from "./company.js";

/** El índice parcial de `DATA-002`: `websiteUrl` único global cuando existe. */
export const COMPANY_WEBSITE_UNIQUE_CONSTRAINT = "companies_website_url_uq";

/**
 * Lo que se escribe. Es la forma de `FirstWorkspacePlan` de `@fastgram/core`
 * repetida **estructuralmente**: `db` no depende de `core` (IMPL §2.2, decisión
 * 8 de `docs/HANDOFF.md`), y quien llama a los dos es `apps/api`.
 */
export interface NewFirstWorkspace {
  readonly ownerUserId: string;
  readonly name: string;
  readonly websiteUrl: string | null;
  readonly planId: string;
  readonly subscriptionStatus: (typeof companies.$inferInsert)["subscriptionStatus"] &
    string;
  readonly status: (typeof companies.$inferInsert)["status"] & string;
  readonly billingAnchorDay: number;
  readonly ownerMembership: {
    readonly role: (typeof workspaceMemberships.$inferInsert)["role"];
    readonly status: (typeof workspaceMemberships.$inferInsert)["status"] & string;
  };
  readonly setAsDefaultWorkspace: boolean;
}

export type CreateFirstWorkspaceResult =
  | { readonly kind: "created"; readonly company: CompanyRow }
  /** Ya es miembro activo de un workspace vivo: el que su sesión resuelve. */
  | { readonly kind: "already_has_workspace"; readonly companyId: string }
  /** `DATA-002`: la web ya es de otro workspace (o de uno propio borrado). */
  | { readonly kind: "website_taken" }
  /** El id no es de ningún usuario. Con un id verificado, sólo si lo borraron. */
  | { readonly kind: "owner_not_found" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createFirstWorkspace(
  db: Database,
  input: NewFirstWorkspace,
  options: WithCompanyOptions = {},
): Promise<CreateFirstWorkspaceResult> {
  // Un id que no es uuid no es de ningún usuario, y a Postgres le llegaría
  // como `22P02` —un 500— en vez de como "no existe".
  if (!UUID_RE.test(input.ownerUserId)) return { kind: "owner_not_found" };

  const companyId = randomUUID();

  try {
    return await withCompany(
      db,
      companyId,
      async (tx): Promise<CreateFirstWorkspaceResult> => {
        // 1. El lock que serializa dos altas del mismo usuario. Ver la cabecera.
        const owner = (await tx.execute(
          sql`select ${users.timezone} as timezone from ${users}
              where ${users.id} = ${input.ownerUserId}
              for no key update`,
        )) as unknown as { timezone: string }[];
        const ownerRow = owner[0];
        if (ownerRow === undefined) return { kind: "owner_not_found" };

        // 2. ¿Ya tiene uno? La misma regla que la sesión (`0012`).
        const existing = (await tx.execute(
          sql`select app.resolve_session_workspace(${input.ownerUserId}::uuid) as company_id`,
        )) as unknown as { company_id: string | null }[];
        const existingId = existing[0]?.company_id ?? null;
        if (existingId !== null) {
          return { kind: "already_has_workspace", companyId: existingId };
        }

        // 3. La company. `timezone` es la del dueño (`DATA-001` la exige); el
        //    PRD no dice con qué zona nace un workspace.
        const [company] = await tx
          .insert(companies)
          .values({
            id: companyId,
            name: input.name,
            websiteUrl: input.websiteUrl,
            ownerUserId: input.ownerUserId,
            status: input.status,
            planId: input.planId,
            subscriptionStatus: input.subscriptionStatus,
            billingAnchorDay: input.billingAnchorDay,
            timezone: ownerRow.timezone,
          })
          .returning();
        if (company === undefined) {
          throw new Error("El INSERT de companies no devolvió la fila.");
        }

        // 4. La membresía del dueño (`DATA-003`). `invitedBy` queda en null: nadie
        //    lo invitó.
        await tx.insert(workspaceMemberships).values({
          companyId,
          userId: input.ownerUserId,
          role: input.ownerMembership.role,
          status: input.ownerMembership.status,
        });

        // 5. El default. Es lo que `app.resolve_session_workspace` prefiere, y lo
        //    que hace que `GET /auth/session` devuelva este `companyId`.
        if (input.setAsDefaultWorkspace) {
          await tx.execute(
            sql`update ${users}
                set default_workspace_id = ${companyId}, updated_at = now()
                where ${users.id} = ${input.ownerUserId}`,
          );
        }

        return { kind: "created", company };
      },
      options,
    );
  } catch (error) {
    // El 23505 aborta la transacción: se reconoce afuera, ya revertida.
    if (isUniqueViolation(error, COMPANY_WEBSITE_UNIQUE_CONSTRAINT)) {
      return { kind: "website_taken" };
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const shape = error as { code?: unknown; constraint_name?: unknown };
  return shape.code === "23505" && shape.constraint_name === constraint;
}
