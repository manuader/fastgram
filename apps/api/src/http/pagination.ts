/**
 * Paginación por cursor — PRD §9.10 y §9.3.
 *
 * `limit` 1–100, default 20. Cursor **opaco**: el cliente no debe poder
 * construirlo ni deducir de él el total de filas. Se codifica en base64url,
 * que no es seguridad (es reversible) sino una señal de contrato: lo que es
 * opaco no se parsea del otro lado y podemos cambiar su interior sin romper a
 * nadie.
 */
export const PAGINATION = { minLimit: 1, maxLimit: 100, defaultLimit: 20 } as const;

export interface CursorPayload {
  /** Clave de orden. Junto con el id desempata filas del mismo instante. */
  createdAtMs: number;
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as CursorPayload).createdAtMs !== "number" ||
      typeof (parsed as CursorPayload).id !== "string"
    ) {
      return null;
    }
    return parsed as CursorPayload;
  } catch {
    // Un cursor corrupto es entrada inválida del cliente, no un 500.
    return null;
  }
}

export function normaliseLimit(raw: number | undefined): number {
  if (raw === undefined) return PAGINATION.defaultLimit;
  if (!Number.isInteger(raw)) return PAGINATION.defaultLimit;
  return Math.min(PAGINATION.maxLimit, Math.max(PAGINATION.minLimit, raw));
}

/** El envelope paginado del PRD §9.3. */
export interface Paginated<T> {
  data: T[];
  pagination: { cursor: string | null; hasMore: boolean };
}

/**
 * Arma la página a partir de `limit + 1` filas leídas.
 *
 * Leer una de más es lo que permite responder `hasMore` sin un `COUNT(*)`.
 * Con tablas grandes y scope por `companyId`, ese count cuesta más que la
 * consulta que lo acompaña.
 */
export function buildPage<T>(
  rows: T[],
  limit: number,
  toCursor: (row: T) => CursorPayload,
): Paginated<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return {
    data,
    pagination: {
      cursor: hasMore && last !== undefined ? encodeCursor(toCursor(last)) : null,
      hasMore,
    },
  };
}
