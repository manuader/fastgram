/**
 * Estrategia por marca, slots planificados y el rango del calendario —
 * `PU-BRAND-002`, `PU-CAL-001`, `PU-CAL-002`. Tablas de `0014_brand_strategy.sql`.
 *
 * Todo con `TenantScope`, como el resto del paquete. La única función que
 * mira más allá de una marca es {@link calendarLocks.lockOwner}, y no lee
 * datos: toma un lock por dueño.
 */
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type { Executor } from "../client.js";
import { companies, plannedSlots, posts, brandStrategies } from "../schema/index.js";
import { createCompanyScopedRepository, type TenantScope } from "./base.js";

export type BrandStrategyRow = typeof brandStrategies.$inferSelect;
export type BrandStrategyValues = Omit<
  typeof brandStrategies.$inferInsert,
  "companyId" | "createdAt" | "updatedAt"
>;
export type PlannedSlotRow = typeof plannedSlots.$inferSelect;
export type PostRowForCalendar = typeof posts.$inferSelect;

export const brandStrategyRepository = {
  /** `null` = la marca nunca guardó una estrategia: se usa la por defecto. */
  async find(exec: Executor, scope: TenantScope): Promise<BrandStrategyRow | null> {
    const rows = await exec
      .select()
      .from(brandStrategies)
      .where(eq(brandStrategies.companyId, scope.companyId))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Escribe la estrategia entera (`PUT`). */
  async save(
    exec: Executor,
    scope: TenantScope,
    values: BrandStrategyValues,
  ): Promise<BrandStrategyRow> {
    const rows = await exec
      .insert(brandStrategies)
      .values({ ...values, companyId: scope.companyId })
      .onConflictDoUpdate({
        target: brandStrategies.companyId,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    const row = rows[0];
    if (row === undefined)
      throw new Error("El upsert de la estrategia no devolvió fila.");
    return row;
  },

  /**
   * La zona horaria de la marca. Vive en `companies.timezone` (ver el schema:
   * no se duplica en la estrategia). `null` si la company no se ve.
   */
  async timezone(exec: Executor, scope: TenantScope): Promise<string | null> {
    const rows = await exec
      .select({ timezone: companies.timezone })
      .from(companies)
      .where(eq(companies.id, scope.companyId))
      .limit(1);
    return rows[0]?.timezone ?? null;
  },

  async setTimezone(
    exec: Executor,
    scope: TenantScope,
    timezone: string,
  ): Promise<boolean> {
    const rows = await exec
      .update(companies)
      .set({ timezone, updatedAt: new Date() })
      .where(eq(companies.id, scope.companyId))
      .returning({ id: companies.id });
    return rows.length > 0;
  },
};

const plannedSlotBase = createCompanyScopedRepository({
  table: plannedSlots,
  id: plannedSlots.id,
  companyId: plannedSlots.companyId,
  createdAt: plannedSlots.createdAt,
});

export interface RangeRequest {
  readonly fromMs: number;
  readonly toMs: number;
  readonly limit: number;
}

export const plannedSlotRepository = {
  ...plannedSlotBase,

  /** Los slots **planificados** con hora en `[from, to)`, en orden de hora. */
  async listInRange(
    exec: Executor,
    scope: TenantScope,
    range: RangeRequest,
  ): Promise<PlannedSlotRow[]> {
    return exec
      .select()
      .from(plannedSlots)
      .where(
        and(
          eq(plannedSlots.companyId, scope.companyId),
          eq(plannedSlots.status, "planned"),
          gte(plannedSlots.scheduledAtUtc, new Date(range.fromMs)),
          lt(plannedSlots.scheduledAtUtc, new Date(range.toMs)),
        ),
      )
      .orderBy(asc(plannedSlots.scheduledAtUtc), asc(plannedSlots.id))
      .limit(range.limit);
  },

  /** Las redes en las que esta pieza ya tiene un slot planificado. */
  async plannedNetworksOf(
    exec: Executor,
    scope: TenantScope,
    contentId: string,
  ): Promise<string[]> {
    const rows = await exec
      .select({ network: plannedSlots.network })
      .from(plannedSlots)
      .where(
        and(
          eq(plannedSlots.companyId, scope.companyId),
          eq(plannedSlots.contentId, contentId),
          eq(plannedSlots.status, "planned"),
        ),
      );
    return rows.map((row) => row.network);
  },

  /**
   * `planned → converted`, con el post que lo reemplaza. Un `UPDATE … WHERE
   * status = 'planned'` y no leer-y-escribir: dos conversiones simultáneas no
   * pueden cerrar el mismo slot dos veces (trampa 37). `null` = ya no estaba
   * planificado, o no es de esta marca.
   */
  async markConverted(
    exec: Executor,
    scope: TenantScope,
    slotId: string,
    postId: string,
  ): Promise<PlannedSlotRow | null> {
    const rows = await exec
      .update(plannedSlots)
      .set({ status: "converted", postId, updatedAt: new Date() })
      .where(
        and(
          eq(plannedSlots.companyId, scope.companyId),
          eq(plannedSlots.id, slotId),
          eq(plannedSlots.status, "planned"),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },
};

/** Estados que no ocupan lugar en el calendario de nadie. */
export const CALENDAR_IDLE_POST_STATUSES = ["CANCELLED", "FAILED", "DELETED"] as const;

/**
 * Un instante como texto ISO, para comparar contra una **expresión** en `sql`
 * crudo. Un `Date` pelado no sirve ahí: `drizzle()` pone serializadores
 * identidad en el cliente (trampa 18) y la conversión la hace la columna, que en
 * una expresión no está. El `::timestamptz` va del lado de la consulta.
 */
function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** La fecha efectiva de un post: la de salida si salió, la programada si no. */
const effectiveAt = sql<Date>`coalesce(${posts.postedAt}, ${posts.scheduledAtUtc})`;

export interface PostRangeRequest extends RangeRequest {
  /** Keyset: seguir después de este (fecha efectiva, id). */
  readonly after?: { readonly atMs: number; readonly id: string };
  readonly statuses?: readonly (typeof posts.$inferSelect)["status"][];
  readonly excludeStatuses?: readonly (typeof posts.$inferSelect)["status"][];
}

export const postCalendar = {
  /**
   * Posts con fecha efectiva en `[from, to)`, ascendente por (fecha, id).
   * Entra por el índice `posts_company_effective_at_idx` de `0014`.
   */
  async listInRange(
    exec: Executor,
    scope: TenantScope,
    range: PostRangeRequest,
  ): Promise<PostRowForCalendar[]> {
    const conditions: (SQL | undefined)[] = [
      eq(posts.companyId, scope.companyId),
      sql`${effectiveAt} >= ${isoOf(range.fromMs)}::timestamptz`,
      sql`${effectiveAt} < ${isoOf(range.toMs)}::timestamptz`,
    ];
    if (range.statuses !== undefined && range.statuses.length > 0) {
      conditions.push(inArray(posts.status, [...range.statuses]));
    }
    if (range.excludeStatuses !== undefined && range.excludeStatuses.length > 0) {
      conditions.push(notInArray(posts.status, [...range.excludeStatuses]));
    }
    if (range.after !== undefined) {
      const at = isoOf(range.after.atMs);
      conditions.push(
        or(
          sql`${effectiveAt} > ${at}::timestamptz`,
          and(sql`${effectiveAt} = ${at}::timestamptz`, gt(posts.id, range.after.id)),
        ),
      );
    }
    return exec
      .select()
      .from(posts)
      .where(and(...conditions))
      .orderBy(sql`${effectiveAt} asc`, asc(posts.id))
      .limit(range.limit);
  },

  /** Las plataformas en las que esta pieza ya tiene un post vivo. */
  async livePlatformsOf(
    exec: Executor,
    scope: TenantScope,
    contentId: string,
  ): Promise<string[]> {
    const rows = await exec
      .select({ platform: posts.platform })
      .from(posts)
      .where(
        and(
          eq(posts.companyId, scope.companyId),
          eq(posts.contentId, contentId),
          notInArray(posts.status, [...CALENDAR_IDLE_POST_STATUSES]),
        ),
      );
    return rows.map((row) => row.platform);
  },
};

export const calendarLocks = {
  /**
   * Serializa los auto-slot de **un dueño**, entre todas sus marcas.
   *
   * El auto-slot lee lo ocupado en todas las marcas y después escribe en una.
   * Dos auto-slot simultáneos (dos marcas, o dos piezas de la misma) verían la
   * misma ventana libre y la tomarían los dos. Con este lock el segundo espera
   * a que el primero confirme, y **después** lee: ve lo que el otro escribió.
   *
   * Es `pg_advisory_xact_lock`: se suelta solo al cerrar la transacción y no
   * necesita privilegios, así que funciona con `fastgram_app`. La clave es el
   * dueño, no la marca: la separación entre marcas cruza marcas.
   */
  async lockOwner(exec: Executor, ownerUserId: string): Promise<void> {
    await exec.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`fastgram:calendar:${ownerUserId}`}, 0))`,
    );
  },
};
