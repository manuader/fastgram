/**
 * Analytics · `POST /analytics/posts` (PRD:2278).
 *
 * Fuente: F-176 (PRD:640), ERR-F02 (PRD:3210), NFR-012 (PRD:2962),
 * NFR-016 (PRD:2970).
 */
import { z } from "zod";
import { msEpochSchema, postIdSchema } from "../primitives/ids";
import { BATCH_POST_IDS_MAX, batchPostIdsSchema } from "./posts";

export { BATCH_POST_IDS_MAX };

/** Mismo lote que cancel/delete: dedup y luego cap de 100 (NFR-012, PRD:2962). */
export const postAnalyticsRequestSchema = z.object({ postIds: batchPostIdsSchema }).strict();
export type PostAnalyticsRequest = z.infer<typeof postAnalyticsRequestSchema>;

/**
 * F-176 (PRD:640) — métricas por post.
 *
 * NFR-016 (PRD:2970): las métricas reflejan la **última sincronización**. Un
 * post recién publicado puede devolver ceros; `postedAt` es lo que distingue un
 * cero real de un pre-sync, y por eso no es opcional por comodidad.
 */
export const postAnalyticsItemSchema = z
  .object({
    _id: postIdSchema,
    views: z.number().int().nonnegative(),
    likes: z.number().int().nonnegative(),
    comments: z.number().int().nonnegative(),
    postUrl: z.string().url().optional(),
    postedAt: msEpochSchema.optional(),
  })
  .strict();
export type PostAnalyticsItem = z.infer<typeof postAnalyticsItemSchema>;

/**
 * ERR-F02 (PRD:3210) — éxito parcial: un id desconocido vuelve como
 * `{"_id":"…","notFound":true}`. Los ids **malformados** son otra cosa: fallan
 * toda la request con `invalidIds`, y eso no es una fila de la respuesta.
 */
export const postAnalyticsNotFoundSchema = z
  .object({ _id: postIdSchema, notFound: z.literal(true) })
  .strict();
export type PostAnalyticsNotFound = z.infer<typeof postAnalyticsNotFoundSchema>;

export const postAnalyticsResultSchema = z.union([
  postAnalyticsItemSchema,
  postAnalyticsNotFoundSchema,
]);
export type PostAnalyticsResult = z.infer<typeof postAnalyticsResultSchema>;

/** ERR-F02 (PRD:3210) — `details.invalidIds` del error que aborta el lote entero. */
export const invalidIdsDetailsSchema = z.object({ invalidIds: z.array(z.string()) }).strict();
export type InvalidIdsDetails = z.infer<typeof invalidIdsDetailsSchema>;
