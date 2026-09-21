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

import { PAGINATION } from "./limits";

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
  // La fecha va como texto ISO con cast explícito, no como `Date`. Dentro de un
  // constructor de fila Postgres describe el parámetro como desconocido y el driver
  // no sabe serializar un `Date`: falla con "must be of type string or Buffer".
  const bound = sql`(${key.createdAt.toISOString()}::timestamptz, ${key.id}::text)`;
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

/**
 * ## Paginación por página numerada
 *
 * PRD §9.10 pide las dos: *"Paginación por **cursor opaco** … Paginación por **página
 * numerada** en la UI de pickers (`Page X of Y`)"*, y está marcada CONFIRMED. No es una
 * alternativa al cursor: es para las listas donde el usuario ve los números y puede
 * saltar a la página 7.
 *
 * Lo que cuesta es el `Y`: no hay forma de saber cuántas páginas hay sin un `COUNT(*)`
 * sobre el conjunto filtrado, en cada request. Ésa es exactamente la razón por la que
 * el resto de la API pagina por cursor — y por la que esto no debe usarse para listados
 * grandes ni de scroll infinito.
 */

export interface OffsetPageRequest {
  /** Número de página **base 1**: `Page X of Y` empieza en 1, no en 0. */
  readonly page?: number;
  /** 1–100. Default 20, igual que el cursor. */
  readonly limit?: number;
}

export interface OffsetPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  /** El `Y` de `Page X of Y`. */
  readonly totalPages: number;
  readonly hasMore: boolean;
}

/** Acota la página a un entero ≥ 1. Una página inválida es la primera, no un error. */
export function normalizePage(page?: number): number {
  if (page === undefined || !Number.isFinite(page)) return 1;
  const floored = Math.floor(page);
  return floored < 1 ? 1 : floored;
}

export function offsetOf(page: number, limit: number): number {
  return (page - 1) * limit;
}

export function buildOffsetPage<T>(
  rows: readonly T[],
  page: number,
  pageSize: number,
  totalItems: number,
): OffsetPage<T> {
  // Con cero resultados la UI muestra "Page 1 of 1" y una lista vacía; "Page 1 of 0"
  // no es una posición que exista. Por eso el piso es 1 y no 0.
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  return {
    items: rows,
    page,
    pageSize,
    totalItems,
    totalPages,
    hasMore: page < totalPages,
  };
}
