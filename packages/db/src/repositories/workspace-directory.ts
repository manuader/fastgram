/**
 * Directorio de marcas de un dueño — `PU-BRAND-001` (modo personal, `D-07`).
 *
 * ## Por qué esto no es un repositorio por `companyId`
 *
 * Porque la pregunta es **por encima** del tenant: *"¿qué marcas tiene el dueño
 * de esta key?"* y *"¿esta otra marca es del mismo dueño?"*. Ninguna de las dos
 * se contesta desde adentro de un workspace, y RLS está hecho justamente para
 * que desde adentro de un workspace no se vea ningún otro.
 *
 * Así que el scope acá es el **dueño** ({@link OwnerScope}), y es igual de
 * obligatorio que el `TenantScope` en el resto del paquete: no hay ninguna
 * función que liste o toque una company sin `ownerUserId` en el `WHERE`. Un id
 * de otro dueño devuelve `null`, igual que un cruce de tenant.
 *
 * ## Qué conexión necesita, y el agujero que eso deja
 *
 * `companies`, `workspace_memberships` y `company_profiles` tienen `FORCE ROW
 * LEVEL SECURITY` con política por `app.current_company()`. Estas consultas
 * cruzan companies, así que **tienen que correr con `withoutCompany` y sin
 * `SET LOCAL ROLE`**, o sea con el rol de la cadena de conexión. En desarrollo
 * y en el modo personal (la Mac, o un VPS con el `docker compose` del repo) ese
 * rol es `fastgram`, superusuario, y funciona.
 *
 * Con una conexión `fastgram_app` (NOSUPERUSER) devolverían **cero filas**. Es
 * el mismo agujero que `app.resolve_api_key` (migración `0003`) cerró para las
 * keys. No se cierra acá porque el modo personal no lo necesita y una migración
 * `SECURITY DEFINER` es una decisión aparte; lo que sí se hace es que **no sea
 * silencioso**: {@link workspaceDirectory.ownerOf} devuelve `null` si RLS
 * escondió la fila, y `apps/api` convierte eso en un error ruidoso, porque la
 * company de la key existe siempre (la acaba de resolver el bootstrap).
 */
import { and, asc, eq, ne } from "drizzle-orm";

import type { Executor } from "../client.js";
import { companies, companyProfiles, workspaceMemberships } from "../schema/index.js";

/** El dueño cuyas marcas se consultan. Obligatorio en toda firma de este módulo. */
export interface OwnerScope {
  readonly ownerUserId: string;
}

export interface OwnedWorkspace {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  /** `null` si la company no tiene fila en `company_profiles` (datos viejos). */
  readonly profileStatus: "pending" | "ready" | "failed" | "partial" | null;
  readonly createdAt: Date;
}

export interface OwnerDefaults {
  readonly ownerUserId: string;
  readonly timezone: string;
  readonly billingAnchorDay: number;
}

export type DeleteWorkspaceResult =
  | { readonly kind: "deleted" }
  | { readonly kind: "not_found" }
  /** Era la última marca activa del dueño. */
  | { readonly kind: "last_workspace" };

const selection = {
  id: companies.id,
  name: companies.name,
  status: companies.status,
  profileStatus: companyProfiles.status,
  createdAt: companies.createdAt,
};

export const workspaceDirectory = {
  /**
   * El dueño de una company, y los defaults que una marca nueva hereda de ella.
   *
   * Es la entrada al scope de dueño: el `companyId` sale del bootstrap de la
   * key, no del cliente. `null` = la fila no se ve, que con una company recién
   * autenticada sólo puede ser RLS (ver cabecera).
   */
  async ownerOf(exec: Executor, companyId: string): Promise<OwnerDefaults | null> {
    const rows = await exec
      .select({
        ownerUserId: companies.ownerUserId,
        timezone: companies.timezone,
        billingAnchorDay: companies.billingAnchorDay,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Las marcas vivas del dueño, de la más vieja a la más nueva. */
  async list(exec: Executor, scope: OwnerScope): Promise<OwnedWorkspace[]> {
    return exec
      .select(selection)
      .from(companies)
      .leftJoin(companyProfiles, eq(companyProfiles.companyId, companies.id))
      .where(
        and(
          eq(companies.ownerUserId, scope.ownerUserId),
          ne(companies.status, "soft_deleted"),
        ),
      )
      .orderBy(asc(companies.createdAt), asc(companies.id));
  },

  /** Una marca viva del dueño. `null` si no existe, es de otro o está borrada. */
  async find(
    exec: Executor,
    scope: OwnerScope,
    companyId: string,
  ): Promise<OwnedWorkspace | null> {
    const rows = await exec
      .select(selection)
      .from(companies)
      .leftJoin(companyProfiles, eq(companyProfiles.companyId, companies.id))
      .where(
        and(
          eq(companies.id, companyId),
          eq(companies.ownerUserId, scope.ownerUserId),
          ne(companies.status, "soft_deleted"),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Crea una marca: la company, la membresía de dueño y el perfil en `pending`.
   *
   * Plan `pro` y suscripción `active` porque en modo personal no hay billing
   * (`D-06`) y `pro` es el único plan sin tope de saves (`PLANS.pro`). El perfil
   * se crea ya para que `profileStatus` diga `pending` —"todavía no se
   * analizó"— en vez de que el cliente tenga que interpretar una ausencia.
   */
  async create(
    exec: Executor,
    owner: OwnerDefaults,
    input: { readonly name: string; readonly timezone?: string | undefined },
  ): Promise<OwnedWorkspace> {
    const [company] = await exec
      .insert(companies)
      .values({
        name: input.name,
        ownerUserId: owner.ownerUserId,
        status: "active",
        planId: "pro",
        subscriptionStatus: "active",
        billingAnchorDay: owner.billingAnchorDay,
        timezone: input.timezone ?? owner.timezone,
      })
      .returning({ id: companies.id });
    if (company === undefined)
      throw new Error("El INSERT de companies no devolvió fila.");

    await exec.insert(workspaceMemberships).values({
      companyId: company.id,
      userId: owner.ownerUserId,
      role: "owner",
      status: "active",
    });
    await exec
      .insert(companyProfiles)
      .values({ companyId: company.id, status: "pending" });

    const created = await this.find(exec, owner, company.id);
    if (created === null) throw new Error("La marca recién creada no se pudo releer.");
    return created;
  },

  /** Renombra una marca viva del dueño. `null` si no es suya o no existe. */
  async rename(
    exec: Executor,
    scope: OwnerScope,
    companyId: string,
    name: string,
  ): Promise<OwnedWorkspace | null> {
    const updated = await exec
      .update(companies)
      .set({ name, updatedAt: new Date() })
      .where(
        and(
          eq(companies.id, companyId),
          eq(companies.ownerUserId, scope.ownerUserId),
          ne(companies.status, "soft_deleted"),
        ),
      )
      .returning({ id: companies.id });
    if (updated[0] === undefined) return null;
    return this.find(exec, scope, companyId);
  },

  /**
   * Soft delete, salvo que sea la última marca viva.
   *
   * **Bloquea las marcas vivas del dueño antes de contar.** Sin el `FOR
   * UPDATE`, dos borrados simultáneos de las dos últimas marcas leen "quedan 2"
   * y borran las dos. Con el lock, el segundo espera, relee con una sola viva y
   * devuelve `last_workspace`.
   */
  async softDelete(
    exec: Executor,
    scope: OwnerScope,
    companyId: string,
  ): Promise<DeleteWorkspaceResult> {
    const alive = await exec
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          eq(companies.ownerUserId, scope.ownerUserId),
          ne(companies.status, "soft_deleted"),
        ),
      )
      .for("update");

    if (!alive.some((row) => row.id === companyId)) return { kind: "not_found" };
    if (alive.length <= 1) return { kind: "last_workspace" };

    await exec
      .update(companies)
      .set({ status: "soft_deleted", updatedAt: new Date() })
      .where(
        and(eq(companies.id, companyId), eq(companies.ownerUserId, scope.ownerUserId)),
      );
    return { kind: "deleted" };
  },
};
