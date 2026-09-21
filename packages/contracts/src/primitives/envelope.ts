/**
 * Sobres de éxito de la API v1 · PRD:2256-2251 (§9.3).
 *
 *   Éxito:    {"data": ...}
 *   Paginado: {"data": [...], "pagination": {"cursor": "…"|null, "hasMore": bool}}
 *
 * Son fábricas y no schemas fijos porque el tipo de `data` cambia por endpoint;
 * Zod conserva el tipo inferido a través del genérico.
 */
import { z } from "zod";

export const dataEnvelope = <T extends z.ZodTypeAny>(data: T) => z.object({ data });

/** Cursor **opaco**: el cliente no lo interpreta (PRD:2345). `null` = no hay más. */
export const paginationSchema = z.object({
  cursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const paginatedEnvelope = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ data: z.array(item), pagination: paginationSchema });
