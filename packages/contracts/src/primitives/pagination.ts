/**
 * Paginación por cursor · PRD:2345 (§9.10) y PRD:2730 (§12).
 *
 *   "cursor opaco con `limit` (1–100, default 20) y `hasMore`"
 *
 * Los dos números —el techo 100 y el default 20— están fijados por un test.
 */
import { z } from "zod";

/** PRD:2345 — `limit` mínimo. */
export const PAGINATION_LIMIT_MIN = 1;
/** PRD:2345 — `limit` máximo. */
export const PAGINATION_LIMIT_MAX = 100;
/** PRD:2345 — `limit` por defecto cuando el cliente no lo envía. */
export const PAGINATION_LIMIT_DEFAULT = 20;

export const cursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(PAGINATION_LIMIT_MIN)
    .max(PAGINATION_LIMIT_MAX)
    .default(PAGINATION_LIMIT_DEFAULT),
});
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

/**
 * Paginación **numerada** — §9.10 (PRD:2345): *"Paginación por página numerada
 * en la UI de pickers (`Page X of Y`)"*.
 *
 * Existe una sola ruta con esta forma, `GET /blitz/angles/page` (§9.3), y su
 * query vivía escrita a mano dentro de `apps/api/src/routes/v1/angles.ts` con
 * una nota que decía que debería estar acá. El coste de que no estuviera no fue
 * la duplicación: fue que **la ruta no aparecía en el documento OpenAPI**, y
 * nadie lo notó hasta que un test comparó los paths documentados contra los
 * registrados. Un endpoint cuyo schema no está en el contrato es un endpoint
 * que el contrato no puede describir.
 *
 * Reusa el rango y el default del cursor a propósito: §9.10 fija `limit` 1–100
 * con default 20 para la paginación, sin distinguir por forma.
 */
export const numberedPageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(PAGINATION_LIMIT_MIN)
    .max(PAGINATION_LIMIT_MAX)
    .default(PAGINATION_LIMIT_DEFAULT),
});
export type NumberedPageQuery = z.infer<typeof numberedPageQuerySchema>;

/**
 * El bloque `pagination` de la respuesta numerada.
 *
 * **`cursor` no está, y es deliberado.** Incluirlo en `null` lo haría parecer un
 * cursor que el cliente puede guardar y reenviar, y esta ruta no acepta
 * ninguno: un campo que siempre es `null` no es información, es una invitación
 * a un bug del lado del cliente. `hasMore` sí está, y significa lo mismo que en
 * el envelope de cursor.
 *
 * `totalItems` y `totalPages` son lo que §9.10 pide poder mostrar (`Page X of
 * Y`); el `COUNT(*)` va igual para calcular `Y`, así que `totalItems` no cuesta
 * nada extra.
 */
export const numberedPaginationSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(PAGINATION_LIMIT_MIN).max(PAGINATION_LIMIT_MAX),
  totalItems: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type NumberedPagination = z.infer<typeof numberedPaginationSchema>;
