/**
 * Repositorio de `companies` — `DATA-002`.
 *
 * ## Por qué no sale de `createCompanyScopedRepository`
 *
 * Porque la tabla no tiene columna `companyId`: **es** la compañía, su PK es
 * el `companyId`. La fábrica genérica pide una columna para el `WHERE` del
 * scope y acá esa columna es la clave primaria. Es la misma razón de forma que
 * en `audio_tracks`, pero la conclusión es la contraria: `audio_tracks` no
 * tiene tenant, y esto **es** el tenant.
 *
 * Así que el scope sigue en la firma y sigue siendo obligatorio — sólo que acá
 * filtra por `id`. `load(exec, { companyId })` no puede leer otro workspace, y
 * no hay ningún `findById(id)` suelto que lo permita.
 *
 * ## Por qué hacía falta
 *
 * Tres agentes que escribían rutas distintas —contenido, media/influencers y
 * posts— reportaron el mismo bloqueo por separado: sin poder leer `planId`,
 * `billingAnchorDay`, `apiOverageEnabled` y `entitlements`, **no se puede
 * cablear ninguna cuota ni ningún entitlement**. El motor de cuotas de
 * `packages/core` está escrito y testeado desde hace rato; lo que no había era
 * de dónde sacar el plan.
 *
 * Y el hueco tenía un filo: `POST /posts/:id/schedule` con
 * `postingMode: "direct"` **pasa hoy sin comprobar el entitlement de TikTok**,
 * porque no había forma de leerlo.
 *
 * ## Qué NO hay acá
 *
 * Escritura. Crear un workspace es `P1-TENANT-001` y arrastra el límite por
 * usuario, la membresía del dueño y el estado inicial; cambiar el plan es
 * `P3` y pasa por el puerto `Payments`. Un `update` genérico acá dejaría a
 * cualquiera moverse de plan con un `PATCH`, que es exactamente el tipo de
 * escritura que tiene que costar una decisión y no un método.
 */

import { eq } from "drizzle-orm";

import type { Executor } from "../client";
import { companies } from "../schema/index";
import type { TenantScope } from "./base";

export type CompanyRow = typeof companies.$inferSelect;

/**
 * Lo que necesita la capa de cuotas y entitlements, sin el resto de la fila.
 *
 * Es una proyección explícita y no la fila entera porque lo que se devuelve
 * termina viajando por el sistema: `websiteUrl`, `logoUrl` y `ownerUserId` no
 * tienen nada que hacer en una decisión de cuota, y tenerlos a mano invita a
 * usarlos donde no corresponde.
 */
export interface CompanyBilling {
  readonly companyId: string;
  readonly planId: string;
  readonly status: string;
  readonly subscriptionStatus: string;
  /** PRD §16.2: el reset de saves es en este día, no el 1 de cada mes. */
  readonly billingAnchorDay: number;
  readonly timezone: string;
  readonly apiOverageEnabled: boolean;
  readonly entitlements: readonly string[];
}

export const companyRepository = {
  table: companies,

  /** La fila entera. `null` si el workspace no existe. */
  async load(exec: Executor, scope: TenantScope): Promise<CompanyRow | null> {
    const rows = await exec
      .select()
      .from(companies)
      .where(eq(companies.id, scope.companyId))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Sólo lo que hace falta para decidir cuota y permisos. */
  async billing(exec: Executor, scope: TenantScope): Promise<CompanyBilling | null> {
    const rows = await exec
      .select({
        companyId: companies.id,
        planId: companies.planId,
        status: companies.status,
        subscriptionStatus: companies.subscriptionStatus,
        billingAnchorDay: companies.billingAnchorDay,
        timezone: companies.timezone,
        apiOverageEnabled: companies.apiOverageEnabled,
        entitlements: companies.entitlements,
      })
      .from(companies)
      .where(eq(companies.id, scope.companyId))
      .limit(1);

    const row = rows[0];
    return row === undefined ? null : row;
  },

  /**
   * Si el workspace tiene un entitlement.
   *
   * La lista es abierta (`KNOWN_ENTITLEMENTS` en el schema la documenta sin
   * cerrarla), así que esto toma un string. Un workspace que no existe
   * devuelve `false` y no lanza: para quien pregunta, "no lo tiene" y "no
   * existe" llevan a la misma respuesta, y distinguirlos desde acá invitaría
   * a un 403 donde el PRD pide 404.
   */
  async hasEntitlement(
    exec: Executor,
    scope: TenantScope,
    entitlement: string,
  ): Promise<boolean> {
    const row = await this.billing(exec, scope);
    return row?.entitlements.includes(entitlement) ?? false;
  },
};
