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
