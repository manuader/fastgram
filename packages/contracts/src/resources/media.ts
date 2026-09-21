/**
 * Media Bank · `POST /media/upload-url`, `POST /media`, `GET /media`,
 * `GET /media/:id`, `PATCH /media/:id`, `DELETE /media/:id` (PRD:2278).
 *
 * Fuente: FR-100 (PRD:1609-1637), DATA-010 (PRD:2093), §9.8 (PRD:2338).
 *
 * El recurso público **no** lleva `storageKey` ni `companyId`: NFR-007
 * (PRD:2957) prohíbe devolver storage keys e ids internos. DATA-010 los tiene
 * porque describe la fila, no la respuesta.
 */
import { z } from "zod";
import {
  imageMediaCategorySchema,
  mediaCategorySchema,
  mediaOriginSchema,
  mediaStatusSchema,
  mediaTypeSchema,
  videoMediaCategorySchema,
} from "../primitives/enums.js";
import { mediaIdSchema, msEpochSchema, uploadIdSchema } from "../primitives/ids.js";
import { cursorQuerySchema } from "../primitives/pagination.js";

/** FR-100 (PRD:1621) — "`0 selected (need 5 more)`" fija el mínimo de un set. */
export const MEDIA_SET_MIN_ASSETS = 5;

/**
 * Las categorías son válidas **por tipo** (F-129, PRD:601). Un `image` con
 * `hook-video` es `400 bad_request`, no un aviso.
 */
const categoriesForType = (
  mediaType: z.infer<typeof mediaTypeSchema>,
  categories: readonly string[],
): boolean => {
  const allowed =
    mediaType === "image"
      ? imageMediaCategorySchema.options
      : videoMediaCategorySchema.options;
  return categories.every((c) => (allowed as readonly string[]).includes(c));
};

export const mediaSchema = z
  .object({
    mediaId: mediaIdSchema,
    mediaType: mediaTypeSchema,
    filename: z.string().min(1),
    r2Url: z.string().url(),
    status: mediaStatusSchema,
    sizeMb: z.number().nonnegative(),
    videoDurationSec: z.number().nonnegative().optional(),
    categories: z.array(mediaCategorySchema),
    origin: mediaOriginSchema,
    uploadedAt: msEpochSchema,
    deletedAt: msEpochSchema.optional(),
  })
  .strict()
  .refine((m) => categoriesForType(m.mediaType, m.categories), {
    path: ["categories"],
    message: "categories must be valid for the media type",
  });
export type Media = z.infer<typeof mediaSchema>;

/**
 * Finalización de la subida · §9.8 (PRD:2338). El PRD nombra el paso
 * ("finalización (`POST /media`)") pero no enumera su body más allá de que
 * identifica la reserva. Se contrata sólo `uploadId`; las categorías se fijan
 * después con `PATCH /media/:id`, que sí está especificado.
 */
export const finalizeMediaRequestSchema = z.object({ uploadId: uploadIdSchema }).strict();
export type FinalizeMediaRequest = z.infer<typeof finalizeMediaRequestSchema>;

/**
 * `PATCH /media/:id` — "Cambiar categorías es un **reemplazo total**. Lista
 * vacía = el asset sale de todos los pools automáticos de Blitz" (PRD:1634).
 * Por eso el array puede estar vacío y no hay operación de "añadir".
 */
export const updateMediaRequestSchema = z
  .object({ categories: z.array(mediaCategorySchema) })
  .strict();
export type UpdateMediaRequest = z.infer<typeof updateMediaRequestSchema>;

/** Variante estrecha: categorías válidas para imágenes. */
export const updateImageMediaRequestSchema = z
  .object({ categories: z.array(imageMediaCategorySchema) })
  .strict();
export type UpdateImageMediaRequest = z.infer<typeof updateImageMediaRequestSchema>;

/** Variante estrecha: categorías válidas para videos. */
export const updateVideoMediaRequestSchema = z
  .object({ categories: z.array(videoMediaCategorySchema) })
  .strict();
export type UpdateVideoMediaRequest = z.infer<typeof updateVideoMediaRequestSchema>;

/**
 * `GET /media`. §12 (PRD:2722) fija `type` = `image|video` y la paginación por
 * cursor (§9.10, PRD:2345). Los filtros de categoría e influencer existen en la
 * UI pero el PRD no nombra sus parámetros de query: quedan fuera del contrato.
 */
export const listMediaQuerySchema = cursorQuerySchema
  .extend({ type: mediaTypeSchema.optional() })
  .strict();
export type ListMediaQuery = z.infer<typeof listMediaQuerySchema>;
