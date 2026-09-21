/**
 * Ledger de cuota — `DATA-029`, PRD §16.2 y §9.4.
 *
 * ## Por qué esto no sale de la fábrica genérica
 *
 * Porque lo que hace falta acá no es leer y escribir: es **leer bloqueando**.
 * §9.4 pide *"reservas atómicas de cuota antes de trabajo costoso"*, y una
 * lectura seguida de una escritura no es atómica. Con el aislamiento por
 * defecto de Postgres —READ COMMITTED— dos peticiones simultáneas del mismo
 * workspace leen el mismo saldo, las dos deciden que hay lugar, y las dos
 * consumen. El cliente obtiene un save gratis y nadie se entera: no hay error,
 * no hay log, sólo una fila con un contador más bajo del que corresponde.
 *
 * Es el mismo patrón que ya mordió en el limitador de tasa, donde 120 de 120
 * peticiones pasaron contra un límite de 60. Ahí se resolvió con
 * compare-and-swap porque el store era genérico; acá hay una base de datos, así
 * que se resuelve con `SELECT … FOR UPDATE`, que es más simple y no reintenta.
 *
 * ## El orden importa: crear y después bloquear
 *
 * Un `SELECT … FOR UPDATE` sobre una fila que no existe no bloquea nada — no
 * hay qué bloquear— así que dos peticiones concurrentes sobre un workspace
 * cuyo período todavía no tiene ledger volverían a correr la misma carrera. Por
 * eso {@link lockPeriod} inserta primero con `ON CONFLICT DO NOTHING` (que sí
 * serializa: el segundo espera al primero) y recién después bloquea.
 */

import { and, eq, sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import { quotaLedgers } from "../schema/index.js";
import type { TenantScope } from "./base.js";

export type QuotaLedgerRow = typeof quotaLedgers.$inferSelect;

/** Lo que se escribe al crear el ledger de un período nuevo. */
export interface NewPeriodDefaults {
  /** Cupo del plan para el período. Sale de `PLANS[plan].contentSaves`. */
  readonly contentSavesIncluded: number;
  /** Saldo comprado que se arrastra del período anterior: **no caduca** (§16.2). */
  readonly contentSavesPurchased?: number;
  readonly aiCredits?: number;
  readonly warmedPostSlots?: number;
}

/**
 * Deja el ledger del período creado y **bloqueado** hasta el fin de la
 * transacción.
 *
 * Quien llame tiene que estar dentro de una transacción: fuera de una, el
 * `FOR UPDATE` se libera al terminar la sentencia y no protege nada. No se
 * puede comprobar desde acá —el `Executor` no distingue— así que queda escrito.
 *
 * Devuelve la fila tal como está, con el cupo ya aplicado si acaba de crearse.
 */
export async function lockPeriod(
  exec: Executor,
  scope: TenantScope,
  period: string,
  defaults: NewPeriodDefaults,
): Promise<QuotaLedgerRow> {
  // Primero crear. `ON CONFLICT DO NOTHING` serializa a los concurrentes: el
  // segundo espera a que el primero confirme y después no inserta nada.
  await exec
    .insert(quotaLedgers)
    .values({
      companyId: scope.companyId,
      period,
      contentSavesIncluded: defaults.contentSavesIncluded,
      contentSavesPurchased: defaults.contentSavesPurchased ?? 0,
      aiCredits: defaults.aiCredits ?? 0,
      warmedPostSlots: defaults.warmedPostSlots ?? 0,
    })
    .onConflictDoNothing();

  // Y ahora sí bloquear. A partir de acá, cualquier otra transacción que
  // quiera este mismo ledger espera.
  const filas = await exec
    .select()
    .from(quotaLedgers)
    .where(
      and(eq(quotaLedgers.companyId, scope.companyId), eq(quotaLedgers.period, period)),
    )
    .for("update")
    .limit(1);

  const fila = filas[0];
  if (fila === undefined) {
    // No debería pasar: acabamos de insertarla en esta misma transacción. Si
    // pasa, es que el scope no coincide con el `app.current_company` del GUC y
    // RLS la está ocultando — que es un bug de cableado, no de datos.
    throw new Error(
      `No se pudo bloquear el ledger de ${period}. Casi siempre es que la ` +
        "transacción no tiene seteado `app.current_company` para este workspace.",
    );
  }
  return fila;
}

/** Lee sin bloquear. Para mostrar saldo, nunca para decidir si alcanza. */
export async function readPeriod(
  exec: Executor,
  scope: TenantScope,
  period: string,
): Promise<QuotaLedgerRow | null> {
  const filas = await exec
    .select()
    .from(quotaLedgers)
    .where(
      and(eq(quotaLedgers.companyId, scope.companyId), eq(quotaLedgers.period, period)),
    )
    .limit(1);
  return filas[0] ?? null;
}

/** Los contadores que una consumición o un reembolso pueden mover. */
export interface LedgerCounters {
  readonly contentSavesUsed: number;
  readonly contentSavesPurchased: number;
  readonly overageUnits: number;
}

/**
 * Escribe los contadores del período.
 *
 * Toma valores absolutos y no incrementos a propósito: el cálculo lo hace el
 * dominio (`consumeSave` / `refundSave` en `packages/core`), que es donde está
 * la regla de qué bucket se toca primero. Un `+1` desde acá duplicaría esa
 * regla en SQL, y las dos copias se separarían.
 *
 * Sólo tiene sentido después de {@link lockPeriod} en la misma transacción.
 */
export async function writeCounters(
  exec: Executor,
  scope: TenantScope,
  period: string,
  counters: LedgerCounters,
): Promise<void> {
  await exec
    .update(quotaLedgers)
    .set({
      contentSavesUsed: counters.contentSavesUsed,
      contentSavesPurchased: counters.contentSavesPurchased,
      overageUnits: counters.overageUnits,
      updatedAt: new Date(),
    })
    .where(
      and(eq(quotaLedgers.companyId, scope.companyId), eq(quotaLedgers.period, period)),
    );
}

/**
 * Los swipes diarios, que tienen su propio reloj (00:00 UTC, no el ancla).
 *
 * Se escribe el contador **y** el instante del próximo reset juntos: si se
 * guardaran por separado, una caída en el medio dejaría un contador reiniciado
 * con la marca vieja, o al revés — swipes gratis o swipes perdidos.
 */
export async function writeDailySwipes(
  exec: Executor,
  scope: TenantScope,
  period: string,
  used: number,
  resetAt: Date,
): Promise<void> {
  await exec
    .update(quotaLedgers)
    .set({ dailySwipesUsed: used, dailySwipeResetAt: resetAt, updatedAt: new Date() })
    .where(
      and(eq(quotaLedgers.companyId, scope.companyId), eq(quotaLedgers.period, period)),
    );
}

/** Créditos de AI Studio. Valor absoluto, por la misma razón que los contadores. */
export async function writeAiCredits(
  exec: Executor,
  scope: TenantScope,
  period: string,
  credits: number,
): Promise<void> {
  await exec
    .update(quotaLedgers)
    .set({ aiCredits: credits, updatedAt: new Date() })
    .where(
      and(eq(quotaLedgers.companyId, scope.companyId), eq(quotaLedgers.period, period)),
    );
}

export const quotaLedgerStore = {
  table: quotaLedgers,
  lockPeriod,
  readPeriod,
  writeCounters,
  writeDailySwipes,
  writeAiCredits,
  /** Para tests y para soporte: cuántos períodos tiene un workspace. */
  async countPeriods(exec: Executor, scope: TenantScope): Promise<number> {
    const filas = await exec
      .select({ value: sql<number>`count(*)::int` })
      .from(quotaLedgers)
      .where(eq(quotaLedgers.companyId, scope.companyId));
    return filas[0]?.value ?? 0;
  },
};
