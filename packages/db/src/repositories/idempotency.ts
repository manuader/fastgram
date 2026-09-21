/**
 * `IdempotencyRecord` (DATA-027 · PRD §9.3).
 *
 * Tiene repositorio propio porque su semántica no es CRUD:
 *
 *  - misma key + mismo `requestHash` ⇒ **replay** de `responseSnapshot`;
 *  - misma key + `requestHash` distinto ⇒ `conflict` (la capa de arriba lo vuelve 409);
 *  - una petición que **falla** libera la key (`released`).
 *
 * La reserva se apoya en la PK `(companyId, key)`: dos peticiones concurrentes con la
 * misma key compiten por insertar la misma fila y el `ON CONFLICT DO NOTHING` decide
 * quién gana. No hay ventana entre "miro si existe" e "inserto", que es donde viven
 * los cobros duplicados.
 */

import { and, eq, sql } from "drizzle-orm";

import type { Executor } from "../client";
import { idempotencyRecords } from "../schema/platform";
import type { TenantScope } from "./base";

export type IdempotencyRow = typeof idempotencyRecords.$inferSelect;

export type ReservationOutcome =
  /** La key es nueva: seguir con el trabajo. */
  | { readonly kind: "reserved" }
  /** Ya completada con el mismo body: devolver `response` sin reejecutar nada. */
  | { readonly kind: "replay"; readonly response: unknown }
  /** Misma key, body distinto ⇒ 409. */
  | { readonly kind: "conflict" }
  /** Misma key, misma petición, todavía corriendo ⇒ 409 o reintento del cliente. */
  | { readonly kind: "in_flight" };

export interface ReserveInput {
  readonly key: string;
  readonly endpoint: string;
  readonly requestHash: string;
}

export const idempotencyRepository = {
  /**
   * Reserva la key o dice por qué no puede. **Se llama dentro de la transacción de
   * negocio**, no antes: IMPL §2.3 exige que la reserva y el descuento de cuota
   * commiteen juntos.
   */
  async reserve(
    exec: Executor,
    scope: TenantScope,
    input: ReserveInput,
  ): Promise<ReservationOutcome> {
    const inserted = await exec
      .insert(idempotencyRecords)
      .values({
        key: input.key,
        companyId: scope.companyId,
        endpoint: input.endpoint,
        requestHash: input.requestHash,
        state: "in_flight",
      })
      .onConflictDoNothing()
      .returning({ key: idempotencyRecords.key });

    if (inserted.length > 0) return { kind: "reserved" };

    const existing = await this.find(exec, scope, input.key);
    if (existing === null) {
      // La fila desapareció entre el INSERT y el SELECT: sólo pasa si otra transacción
      // la liberó. Tratarlo como conflicto es la opción segura — nunca se re-ejecuta
      // un efecto facturable por las dudas.
      return { kind: "conflict" };
    }
    if (existing.requestHash !== input.requestHash) return { kind: "conflict" };
    if (existing.state === "completed") {
      return { kind: "replay", response: existing.responseSnapshot };
    }
    if (existing.state === "released") return { kind: "reserved" };
    return { kind: "in_flight" };
  },

  async find(
    exec: Executor,
    scope: TenantScope,
    key: string,
  ): Promise<IdempotencyRow | null> {
    const rows = await exec
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.companyId, scope.companyId),
          eq(idempotencyRecords.key, key),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Cierra la reserva guardando la respuesta que se va a replayear. */
  async complete(
    exec: Executor,
    scope: TenantScope,
    key: string,
    response: unknown,
  ): Promise<void> {
    await exec
      .update(idempotencyRecords)
      .set({ state: "completed", responseSnapshot: response })
      .where(
        and(
          eq(idempotencyRecords.companyId, scope.companyId),
          eq(idempotencyRecords.key, key),
        ),
      );
  },

  /**
   * *"una petición que falla libera la key"* (§9.3). Se marca `released` en vez de
   * borrar la fila para conservar el rastro de que esa key ya se intentó.
   */
  async release(exec: Executor, scope: TenantScope, key: string): Promise<void> {
    await exec
      .update(idempotencyRecords)
      .set({ state: "released", responseSnapshot: sql`null` })
      .where(
        and(
          eq(idempotencyRecords.companyId, scope.companyId),
          eq(idempotencyRecords.key, key),
        ),
      );
  },
};
