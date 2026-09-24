/**
 * Audio · `GET /audio?for=wall-of-text|video-hook` (PRD:2280).
 *
 * Fuente: FR-053 (PRD:1219-1236), DATA-012 (PRD:2099).
 *
 * El catálogo es **global**, compartido por todos los workspaces y curado por
 * tipo de contenido. El Media Bank no acepta subidas de audio (PRD:1232).
 */
import { z } from "zod";
import { audioLibrarySchema } from "../primitives/enums.js";
import { audioIdSchema } from "../primitives/ids.js";
import { cursorQuerySchema } from "../primitives/pagination.js";

/** `for` es obligatorio: los dos catálogos son distintos (FR-053, PRD:1232). */
export const listAudioQuerySchema = cursorQuerySchema
  .extend({ for: audioLibrarySchema })
  .strict();
export type ListAudioQuery = z.infer<typeof listAudioQuerySchema>;

export const audioTrackSchema = z
  .object({
    audioId: audioIdSchema,
    url: z.string().url(),
    description: z.string(),
    sizeMb: z.number().nonnegative(),
    durationSec: z.number().nonnegative().optional(),
    library: audioLibrarySchema,
  })
  .strict();
export type AudioTrack = z.infer<typeof audioTrackSchema>;

// --- Biblioteca de audio de la marca (sprint 7, migración `0025`) ------------
//
// El catálogo de arriba es global y sigue vacío. Lo que de verdad llega al
// video es la biblioteca **de la marca**: lo que el dueño sube o importa por
// link (`PU-MEME-001`). Un workspace = una marca (D-06), así que "de la marca"
// es "del workspace": cruce → 404 como cualquier recurso.

/**
 * Prefijo del bucket donde vive el audio de una marca, sin barra final.
 *
 * Es **el** dato que comparten tres lugares: la API (subida presignada), el
 * worker (import por link) y la autorización del build
 * (`apps/worker/src/content/media-authorization.ts`), que lo firma como
 * librería para el rol `audio` del render. Si uno lo escribiera a mano, el
 * síntoma sería un `audio_fuera_de_libreria` con las dos URLs pareciendo
 * correctas.
 */
export const brandAudioKeyPrefix = (companyId: string): string => `audio/${companyId}`;

/**
 * Tope de una subida de audio. El PRD no lo fija (el Media Bank no aceptaba
 * audio): 20 MB son ~20 min de MP3 a 128 kbps o ~2 min de WAV 16-bit estéreo,
 * sobrado para la música de un short de 60 s. Decisión de esta tanda.
 */
export const BRAND_AUDIO_MAX_MB = 20;

/** Tipos aceptados y sus extensiones. La extensión tiene que coincidir (§9.8). */
export const BRAND_AUDIO_CONTENT_TYPES: Readonly<Record<string, readonly string[]>> = {
  "audio/mpeg": [".mp3"],
  "audio/mp4": [".m4a"],
  "audio/x-m4a": [".m4a"],
  "audio/aac": [".aac"],
  "audio/wav": [".wav"],
  "audio/x-wav": [".wav"],
};

export const brandAudioContentTypeSchema = z.enum([
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
]);
export type BrandAudioContentType = z.infer<typeof brandAudioContentTypeSchema>;

export const BRAND_AUDIO_TITLE_MAX = 200;
const titleSchema = z.string().trim().min(1).max(BRAND_AUDIO_TITLE_MAX);

/** `POST /brand-audio/upload-url` — reserva de subida (paso 1 de §9.8). */
export const brandAudioUploadRequestSchema = z
  .object({
    filename: z.string().min(1).max(255),
    contentType: brandAudioContentTypeSchema,
    sizeBytes: z.number().int().positive(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.sizeBytes > BRAND_AUDIO_MAX_MB * 1024 * 1024) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sizeBytes"],
        message: `file exceeds the ${BRAND_AUDIO_MAX_MB} MB limit`,
      });
    }
    const allowed = BRAND_AUDIO_CONTENT_TYPES[body.contentType] ?? [];
    const lower = body.filename.toLowerCase();
    if (!allowed.some((ext) => lower.endsWith(ext))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["filename"],
        message: "filename extension must match contentType",
      });
    }
  });
export type BrandAudioUploadRequest = z.infer<typeof brandAudioUploadRequestSchema>;

/** `POST /brand-audio` — finalizar la subida (paso 3 de §9.8). */
export const finalizeBrandAudioRequestSchema = z
  .object({
    uploadId: z.string().uuid(),
    /** Sin título, el nombre del archivo sin extensión. */
    title: titleSchema.optional(),
  })
  .strict();
export type FinalizeBrandAudioRequest = z.infer<typeof finalizeBrandAudioRequestSchema>;

/** `PATCH /brand-audio/:id` — renombrar o sacar del sorteo de Blitz. */
export const updateBrandAudioRequestSchema = z
  .object({
    title: titleSchema.optional(),
    autoUse: z.boolean().optional(),
  })
  .strict()
  .refine((p) => p.title !== undefined || p.autoUse !== undefined, {
    message: "change the title or autoUse",
  });
export type UpdateBrandAudioRequest = z.infer<typeof updateBrandAudioRequestSchema>;

/** `GET /brand-audio?q=` — más nuevas primero; `q` busca en el título. */
export const listBrandAudioQuerySchema = cursorQuerySchema
  .extend({ q: z.string().trim().max(BRAND_AUDIO_TITLE_MAX).optional() })
  .strict();
export type ListBrandAudioQuery = z.infer<typeof listBrandAudioQuerySchema>;

export const brandAudioOriginSchema = z.enum(["upload", "import"]);
export type BrandAudioOrigin = z.infer<typeof brandAudioOriginSchema>;

export const brandAudioTrackSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    /** La que va al payload de build (`audio.url`) y la que usa el preview. */
    url: z.string().url(),
    origin: brandAudioOriginSchema,
    contentType: z.string(),
    sizeMb: z.number().nonnegative(),
    durationSec: z.number().nonnegative().optional(),
    sourceUrl: z.string().optional(),
    /** Si Blitz/refill la puede elegir sola para una pieza nueva de video. */
    autoUse: z.boolean(),
    createdAt: z.number().int(),
  })
  .strict();
export type BrandAudioTrack = z.infer<typeof brandAudioTrackSchema>;
