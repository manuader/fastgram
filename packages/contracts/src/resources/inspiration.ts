/**
 * Inspiration como tablero de referencias propio — `FR-040` adaptado,
 * `F-041`, `F-042`, `OQ-13` (el clon no replica el catálogo de terceros de
 * Fastlane), `D-12` (el dueño importa por link y asume los derechos).
 *
 * | Operación                   | Ruta                                      |
 * |-----------------------------|-------------------------------------------|
 * | guardar (link o clip)       | `POST /inspiration`                       |
 * | tablero (búsqueda, filtros) | `GET /inspiration`                        |
 * | etiquetas en uso            | `GET /inspiration/tags`                   |
 * | una                         | `GET /inspiration/{itemId}`               |
 * | etiquetas de una            | `PATCH /inspiration/{itemId}`             |
 * | borrar                      | `DELETE /inspiration/{itemId}`            |
 * | «Remix this»                | `POST /inspiration/{itemId}/remix`        |
 *
 * El remix responde lo mismo que `POST /blitz/generate` (`202 {requestId}`) y
 * se consulta en `GET /blitz/generate/{requestId}`: **es** ese pipeline, con la
 * referencia como contexto.
 *
 * Nada de esto está en el PRD como contrato (FR-040 describe una librería
 * global de solo lectura). Las formas son decisiones de esta tarea.
 */
import { z } from "zod";

import { blitzContentTypeSchema } from "../primitives/enums.js";
import { mediaIdSchema, msEpochSchema } from "../primitives/ids.js";
import { numberedPageQuerySchema } from "../primitives/pagination.js";
import {
  BLITZ_PROMPT_MAX_CHARS,
  BLITZ_PROMPT_MAX_COUNT,
  BLITZ_PROMPT_MIN_CHARS,
} from "./blitz.js";

export const INSPIRATION_FORMATS = ["video", "slideshow", "image", "text"] as const;
export const inspirationFormatSchema = z.enum(INSPIRATION_FORMATS);
export type InspirationFormat = z.infer<typeof inspirationFormatSchema>;

export const INSPIRATION_PLATFORMS = ["tiktok", "instagram", "youtube", "x"] as const;
export const inspirationPlatformSchema = z.enum(INSPIRATION_PLATFORMS);
export type InspirationPlatform = z.infer<typeof inspirationPlatformSchema>;

/** En qué quedó la lectura sin login (`yt-dlp`) de la página. */
export const INSPIRATION_INGEST_STATES = ["pending", "ready", "failed"] as const;
export const inspirationIngestStateSchema = z.enum(INSPIRATION_INGEST_STATES);

/** Etiquetas del dueño: cortas, hasta 10. */
export const INSPIRATION_MAX_TAGS = 10;
export const INSPIRATION_TAG_MAX_CHARS = 30;

const tagSchema = z.string().trim().min(1).max(INSPIRATION_TAG_MAX_CHARS);

export const inspirationItemSchema = z
  .object({
    id: z.string().min(1),
    platform: inspirationPlatformSchema.nullable(),
    /** El link público. `null` para un clip subido. */
    url: z.string().url().nullable(),
    thumbnailUrl: z.string().url().optional(),
    title: z.string().optional(),
    author: z.string().optional(),
    caption: z.string().optional(),
    hashtags: z.array(z.string()),
    /** Las etiquetas del dueño (y las que sumó el modelo de visión). */
    tags: z.array(z.string()),
    format: inspirationFormatSchema.nullable(),
    /** Ausentes = el sitio no las dio. Nunca `0` inventado. */
    views: z.number().int().nonnegative().optional(),
    likes: z.number().int().nonnegative().optional(),
    comments: z.number().int().nonnegative().optional(),
    durationSeconds: z.number().int().nonnegative().optional(),
    slideCount: z.number().int().nonnegative(),
    /** Lo que leyó el modelo de visión en la miniatura (OCR). */
    onScreenText: z.array(z.string()),
    ingestState: inspirationIngestStateSchema,
    /** Un código estable (`unsupported_url`, `download_failed`, …), nunca el stderr. */
    ingestError: z.string().optional(),
    /** El clip en el Media Bank (importado por link o subido). */
    mediaId: mediaIdSchema.optional(),
    /** El import por link del clip: `GET /media/import/{importId}`. */
    importId: z.string().optional(),
    createdAt: msEpochSchema,
  })
  .strict();
export type InspirationItem = z.infer<typeof inspirationItemSchema>;

/**
 * Guardar una referencia: `url` **o** `mediaId` (un clip ya subido al Media
 * Bank), no los dos. `saveClip` baja además el video al Media Bank con el
 * import por link (`PU-MEME-001`). La exclusión se valida en la ruta
 * (`400 bad_request`): el conversor de OpenAPI no describe refinamientos.
 */
export const createInspirationRequestSchema = z
  .object({
    url: z.string().trim().min(1).max(2048).optional(),
    mediaId: z.string().min(1).optional(),
    tags: z.array(tagSchema).max(INSPIRATION_MAX_TAGS).optional(),
    saveClip: z.boolean().optional(),
  })
  .strict();
export type CreateInspirationRequest = z.infer<typeof createInspirationRequestSchema>;

export const updateInspirationRequestSchema = z
  .object({ tags: z.array(tagSchema).max(INSPIRATION_MAX_TAGS) })
  .strict();
export type UpdateInspirationRequest = z.infer<typeof updateInspirationRequestSchema>;

export const listInspirationQuerySchema = numberedPageQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  format: inspirationFormatSchema.optional(),
  tag: z.string().trim().max(INSPIRATION_TAG_MAX_CHARS).optional(),
});
export type ListInspirationQuery = z.infer<typeof listInspirationQuerySchema>;

export const inspirationTagsSchema = z.array(z.string());

/**
 * «Remix this». Todo opcional: sin nota, el tema es el remix; sin formato, el
 * de la referencia (fotos → slideshow, texto → wall of text) o el mix de la
 * marca; sin cantidad, 3.
 */
export const remixInspirationRequestSchema = z
  .object({
    prompt: z
      .string()
      .trim()
      .min(BLITZ_PROMPT_MIN_CHARS)
      .max(BLITZ_PROMPT_MAX_CHARS)
      .optional(),
    contentType: blitzContentTypeSchema.optional(),
    count: z.number().int().min(1).max(BLITZ_PROMPT_MAX_COUNT).optional(),
  })
  .strict();
export type RemixInspirationRequest = z.infer<typeof remixInspirationRequestSchema>;

/** Default de piezas por remix: unas pocas para elegir en el deck. */
export const INSPIRATION_REMIX_DEFAULT_COUNT = 3;
