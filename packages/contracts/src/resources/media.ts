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
  mediaSetKindSchema,
  mediaStatusSchema,
  mediaTypeSchema,
  videoMediaCategorySchema,
} from "../primitives/enums.js";
import {
  mediaIdSchema,
  mediaSetIdSchema,
  msEpochSchema,
  uploadIdSchema,
} from "../primitives/ids.js";
import { cursorQuerySchema } from "../primitives/pagination.js";

/** FR-100 (PRD:1621) — "`0 selected (need 5 more)`" fija el mínimo de un set. */
export const MEDIA_SET_MIN_ASSETS = 5;

/** `P2-MEDIA-007`: tope de la búsqueda. El PRD no da número: elección nuestra. */
export const MEDIA_SEARCH_MAX_CHARS = 100;
/** Tope de una etiqueta y de etiquetas por asset. Sin número en el PRD. */
export const MEDIA_TAG_MAX_CHARS = 40;
export const MEDIA_TAGS_MAX = 30;

/**
 * Una lista de etiquetas: se guardan en minúsculas y sin repetir. La
 * normalización la hace el schema para que el filtro `tag=` (también en
 * minúsculas) encuentre lo que el usuario escribió con mayúsculas.
 */
export const mediaTagListSchema = z
  .array(z.string().trim().toLowerCase().min(1).max(MEDIA_TAG_MAX_CHARS))
  .max(MEDIA_TAGS_MAX)
  .transform((tags) => [...new Set(tags)]);

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
    /** `0029`: etiquetas buscables (del usuario o automáticas del clip). */
    tags: z.array(z.string()).optional(),
    /**
     * `0029`: qué hizo la normalización con un video. `hdr_kept_original` =
     * el video es HDR y el servicio no puede pasarlo a SDR: se usa el original.
     */
    normalization: z
      .enum(["normalized", "already_normalized", "hdr_kept_original"])
      .optional(),
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
  .object({
    categories: z.array(mediaCategorySchema).optional(),
    /** `0029`: reemplazo total de las etiquetas, como las categorías. */
    tags: mediaTagListSchema.optional(),
  })
  .strict()
  .refine((b) => b.categories !== undefined || b.tags !== undefined, {
    message: "send categories, tags or both",
  });
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
  .extend({
    type: mediaTypeSchema.optional(),
    /**
     * `P2-MEDIA-007` (`0029`): búsqueda por nombre de archivo o etiqueta,
     * sin distinguir mayúsculas. «Search your images» del PRD.
     */
    q: z.string().trim().min(1).max(MEDIA_SEARCH_MAX_CHARS).optional(),
    /** Una categoría de F-129; filtra los assets que la tienen. */
    category: mediaCategorySchema.optional(),
    /** Una etiqueta exacta (en minúsculas), incluidas las automáticas de los clips. */
    tag: z.string().trim().toLowerCase().min(1).max(MEDIA_TAG_MAX_CHARS).optional(),
  })
  .strict();
export type ListMediaQuery = z.infer<typeof listMediaQuerySchema>;

/**
 * `POST /media/brand-kit` — `PU-MEDIA-002`. Encola la generación de fondos de
 * marca (imágenes y loops de video) en `services/render`, sin proveedor. Los
 * fondos entran al Media Bank con `origin: "brand_kit"`, `ready` y ya
 * categorizados: imágenes → `slideshow-image` + `green-screen-background`;
 * videos → `background-video`.
 *
 * Todo opcional. Sin `seed`, la ruta elige una nueva (otro juego de fondos);
 * con la misma `seed` y las mismas cantidades, el trabajo no se repite: es
 * idempotente por marca + semilla. Los topes son los de `core`
 * (`MAX_BRAND_KIT_IMAGES`, `MAX_BRAND_KIT_VIDEOS`): `contracts` no importa
 * `core`, así que están escritos dos veces y el test de la ruta los ata.
 */
export const BRAND_KIT_MAX_IMAGES = 20;
export const BRAND_KIT_MAX_VIDEOS = 6;

export const brandKitRequestSchema = z
  .object({
    /** 1–100 caracteres ASCII imprimibles, sin espacios. */
    seed: z
      .string()
      .regex(/^[\x21-\x7E]{1,100}$/u, "seed must be 1-100 printable ASCII characters")
      .optional(),
    /** Default 8. */
    images: z.number().int().min(0).max(BRAND_KIT_MAX_IMAGES).optional(),
    /** Default 3. Cada uno es un loop de 8 s, 1080×1920. */
    videos: z.number().int().min(0).max(BRAND_KIT_MAX_VIDEOS).optional(),
  })
  .strict();
export type BrandKitRequest = z.infer<typeof brandKitRequestSchema>;

export const brandKitJobSchema = z
  .object({
    seed: z.string().min(1),
    images: z.number().int().nonnegative(),
    videos: z.number().int().nonnegative(),
    /**
     * `false` si ya había un trabajo con esta misma marca, semilla y
     * cantidades: no se encoló otro. Los fondos de esa semilla ya están (o
     * están por estar) en el Media Bank.
     */
    enqueued: z.boolean(),
  })
  .strict();
export type BrandKitJob = z.infer<typeof brandKitJobSchema>;

/* ------------------------------------------------------------------------ *
 * Importar por link — `PU-MEME-001`, `PU-MEME-002`, `PU-MEME-003` (D-12)
 * ------------------------------------------------------------------------ */

/**
 * Motivos estables de un import fallido. Viajan en `error` del estado, **no**
 * como código HTTP: el import es asíncrono y el `POST` ya devolvió `202`. Son
 * los de `MEDIA_IMPORT_FAILURE_CODES` de `@fastgram/ports`, escritos dos veces
 * porque `contracts` no importa `ports`; el test de la ruta los ata.
 */
export const mediaImportFailureCodeSchema = z.enum([
  "unsupported_url",
  "too_long",
  "too_large",
  "download_failed",
]);

/**
 * `POST /media/import`. `categories` sólo para video (las de F-129 de video):
 * pedir `green-screen-video` es pedir el clip como foreground, y es lo que
 * dispara el recorte de fondo si no es verde. Audio no lleva categorías.
 */
export const mediaImportRequestSchema = z
  .object({
    url: z.string().min(1).max(2048),
    kind: z.enum(["video", "audio"]),
    categories: z.array(videoMediaCategorySchema).max(10).optional(),
  })
  .strict();
export type MediaImportRequest = z.infer<typeof mediaImportRequestSchema>;

export const clipTagsSchema = z
  .object({
    emotion: z.string(),
    situation: z.string(),
    people: z.number().int().nonnegative(),
    tags: z.array(z.string()),
  })
  .strict();
export type ClipTagsView = z.infer<typeof clipTagsSchema>;

export const mediaImportBackgroundSchema = z.enum([
  "not_requested",
  "pending",
  "green_screen",
  "removed",
  "needs_background_removal",
  "failed",
]);

/** `GET /media/import/:id` (y el `202` del `POST`). */
export const mediaImportSchema = z
  .object({
    importId: z.string().uuid(),
    kind: z.enum(["video", "audio"]),
    state: z.enum(["queued", "downloading", "imported", "failed"]),
    sourceUrl: z.string(),
    error: mediaImportFailureCodeSchema.optional(),
    mediaId: mediaIdSchema.optional(),
    /** Estado de la fila en el Media Bank (`processing` mientras se normaliza). */
    mediaStatus: mediaStatusSchema.optional(),
    /** El clip con alfa derivado (`PU-MEME-002`). */
    cutoutMediaId: mediaIdSchema.optional(),
    background: mediaImportBackgroundSchema.optional(),
    tagging: z.enum(["pending", "tagged", "skipped", "failed"]).optional(),
    tags: clipTagsSchema.optional(),
    /** Sólo audio: `DATA-010` no tiene tipo audio, así que no hay fila. */
    audioUrl: z.string().url().optional(),
    updatedAt: msEpochSchema,
  })
  .strict();
export type MediaImport = z.infer<typeof mediaImportSchema>;

/** `GET /media/meta?ids=…` — hasta 100 ids separados por coma. */
export const mediaMetaQuerySchema = z
  .object({
    ids: z
      .string()
      .min(1)
      .max(100 * 37),
  })
  .strict();

export const mediaMetaSchema = z
  .object({
    mediaId: mediaIdSchema,
    sourceUrl: z.string().optional(),
    tags: clipTagsSchema.optional(),
    background: mediaImportBackgroundSchema.optional(),
    cutoutMediaId: mediaIdSchema.optional(),
    cutoutOf: mediaIdSchema.optional(),
  })
  .strict();
export type MediaMetaView = z.infer<typeof mediaMetaSchema>;

export const mediaMetaListSchema = z.array(mediaMetaSchema);

/* ------------------------------------------------------------------------ *
 * Media Sets — `DATA-011`, `F-127`, `P2-MEDIA-005/006`
 * ------------------------------------------------------------------------ */

/** Tope de assets por set. El PRD sólo fija el mínimo (5): éste es nuestro. */
export const MEDIA_SET_MAX_ASSETS = 100;
export const MEDIA_SET_NAME_MAX_CHARS = 80;

export const mediaSetSchema = z
  .object({
    id: mediaSetIdSchema,
    name: z.string().min(1),
    kind: mediaSetKindSchema,
    mediaIds: z.array(mediaIdSchema),
    createdAt: msEpochSchema,
  })
  .strict();
export type MediaSet = z.infer<typeof mediaSetSchema>;

/**
 * `POST /media/sets`. Mínimo {@link MEDIA_SET_MIN_ASSETS} (FR-100: *«need 5
 * more»*), ids únicos. Que cada id sea un asset vivo de la marca lo valida
 * la ruta (`400` con los que no).
 */
export const createMediaSetRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(MEDIA_SET_NAME_MAX_CHARS),
    kind: mediaSetKindSchema,
    mediaIds: z
      .array(mediaIdSchema)
      .min(MEDIA_SET_MIN_ASSETS)
      .max(MEDIA_SET_MAX_ASSETS)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "mediaIds must be unique",
      }),
  })
  .strict();
export type CreateMediaSetRequest = z.infer<typeof createMediaSetRequestSchema>;

/* ------------------------------------------------------------------------ *
 * Importar posts propios — `FR-011.5.1`, `P1-ONB-008` (opt-in)
 * ------------------------------------------------------------------------ */

/** Default del brief: los últimos 20 posts. Tope 50 (la base lo sostiene). */
export const OWN_POST_IMPORT_DEFAULT_LIMIT = 20;
export const OWN_POST_IMPORT_MAX_LIMIT = 50;

/**
 * `POST /media/own-posts/import`. Dos caminos:
 * - `connection`: la cuenta conectada de la marca por la API oficial
 *   (Instagram Graph `/{ig-user-id}/media`, YouTube `uploads`).
 * - `profile`: un link de perfil público leído con `yt-dlp` sin login
 *   (TikTok, YouTube), donde funcione.
 */
export const ownPostImportRequestSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("connection"),
      connectionId: z.string().uuid(),
      limit: z.number().int().min(1).max(OWN_POST_IMPORT_MAX_LIMIT).optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("profile"),
      url: z.string().trim().min(1).max(2048),
      limit: z.number().int().min(1).max(OWN_POST_IMPORT_MAX_LIMIT).optional(),
    })
    .strict(),
]);
export type OwnPostImportRequest = z.infer<typeof ownPostImportRequestSchema>;

/** Motivos estables de un import fallido entero (no de un post suelto). */
export const ownPostImportErrorSchema = z.enum([
  "unsupported_platform",
  "unsupported_url",
  "connection_unavailable",
  "listing_failed",
  "nothing_found",
]);

export const ownPostImportSchema = z
  .object({
    id: z.string().uuid(),
    source: z.enum(["connection", "profile"]),
    platform: z.string(),
    state: z.enum(["queued", "running", "done", "failed"]),
    limit: z.number().int().positive(),
    found: z.number().int().nonnegative(),
    imported: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    error: ownPostImportErrorSchema.optional(),
    createdAt: msEpochSchema,
    updatedAt: msEpochSchema,
  })
  .strict();
export type OwnPostImport = z.infer<typeof ownPostImportSchema>;
