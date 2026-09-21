/**
 * Paginación por cursor — PRD §9.10, P1-DATA-011.
 *
 * El contrato público dice `{"data": [...], "pagination": {"cursor": "…"|null,
 * "hasMore": bool}}` con `limit` 1–100 y default 20. El cursor es **opaco**: es base64
 * y no un offset ni un id visible, para que cambiar la estrategia interna no sea un
 * breaking change.
 *
 * ## Por qué keyset y no OFFSET
 *
 * `OFFSET` se corre solo: si entra una fila mientras el cliente pagina —y en este
 * producto entran todo el tiempo, la cola de discovery se rellena en background— la
 * página 2 repite o se saltea filas. El cursor es `(createdAt, id)` y la condición es
 * una comparación de tuplas, así que:
 *
 *  - con orden **desc** (el del producto: lo más nuevo primero), una fila insertada
 *    después de leer la página 1 tiene `createdAt` mayor, cae *antes* del cursor y
 *    simplemente no aparece. No duplica ni saltea nada de lo ya paginado.
 *  - `id` es el desempate. Sin él, dos filas con el mismo `createdAt` —inserciones en
 *    el mismo lote, que es el caso normal— hacen que el orden no sea total y la
 *    paginación pierda o repita justo en el borde de la página.
 */

import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import { PAGINATION } from "./limits.js";

export interface CursorKey {
  readonly createdAt: Date;
  readonly id: string;
}

export interface PageRequest {
  /** Cursor opaco devuelto por la página anterior. */
  readonly cursor?: string | null;
  /** 1–100. Default 20. */
  readonly limit?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
}

export class InvalidCursorError extends Error {
  override readonly name = "InvalidCursorError";
  constructor(cursor: string) {
    super(`Cursor inválido: ${JSON.stringify(cursor)}`);
  }
}

/** Acota el límite al rango del PRD. Un límite fuera de rango se clampa, no explota. */
export function normalizeLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return PAGINATION.limitDefault;
  const floored = Math.floor(limit);
  if (floored < PAGINATION.limitMin) return PAGINATION.limitMin;
  if (floored > PAGINATION.limitMax) return PAGINATION.limitMax;
  return floored;
}

export function encodeCursor(key: CursorKey): string {
  const payload = `${key.createdAt.toISOString()}|${key.id}`;
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorKey {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new InvalidCursorError(cursor);
  }
  const separator = decoded.indexOf("|");
  if (separator <= 0) throw new InvalidCursorError(cursor);

  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
    throw new InvalidCursorError(cursor);
  }
  return { createdAt, id };
}

export type SortDirection = "asc" | "desc";

/**
 * Condición keyset para seguir después del cursor.
 * Devuelve `undefined` cuando no hay cursor (primera página).
 */
export function cursorCondition(
  createdAtColumn: PgColumn,
  idColumn: PgColumn,
  cursor: string | null | undefined,
  direction: SortDirection = "desc",
): SQL | undefined {
  if (cursor === null || cursor === undefined || cursor === "") return undefined;
  const key = decodeCursor(cursor);
  const tuple = sql`(${createdAtColumn}, ${idColumn}::text)`;
  const bound = sql`(${key.createdAt}::timestamptz, ${key.id}::text)`;
  return direction === "desc" ? sql`${tuple} < ${bound}` : sql`${tuple} > ${bound}`;
}

/** `ORDER BY` que acompaña a `cursorCondition`. Tienen que moverse juntos. */
export function cursorOrderBy(
  createdAtColumn: PgColumn,
  idColumn: PgColumn,
  direction: SortDirection = "desc",
): SQL[] {
  return direction === "desc"
    ? [sql`${createdAtColumn} desc`, sql`${idColumn}::text desc`]
    : [sql`${createdAtColumn} asc`, sql`${idColumn}::text asc`];
}

/**
 * Arma la página a partir de `limit + 1` filas.
 *
 * Pedir una fila de más es cómo se sabe que hay siguiente sin un `COUNT(*)` que
 * escanearía toda la tabla del workspace en cada request.
 */
export function buildPage<T>(
  rows: readonly T[],
  limit: number,
  keyOf: (row: T) => CursorKey,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    cursor: hasMore && last !== undefined ? encodeCursor(keyOf(last)) : null,
    hasMore,
  };
}

/** Cuántas filas pedirle a la base para un `limit` dado. */
export function fetchLimit(limit: number): number {
  return limit + 1;
}
