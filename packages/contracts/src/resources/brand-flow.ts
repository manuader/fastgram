/**
 * Flujo de marca y audio extraído — sprint 7, segunda tanda (agente H).
 *
 * - `GET /brand/post-analysis-offer` y `POST /brand/post-analysis-offer/dismiss`
 *   (`P1-ONB-007`, `D-04`, `FR-011.5.1`): la tarjeta que, **después** del
 *   análisis, ofrece conectar las cuentas de la marca e importar sus posts.
 * - `POST /audio/library/extract` y `GET /audio/library/extractions/:id`:
 *   sacar el audio de un video del Media Bank a la biblioteca de audio.
 */
import { z } from "zod";
import { mediaIdSchema } from "../primitives/ids.js";
import { BRAND_AUDIO_TITLE_MAX } from "./audio.js";
import { brandSourceTypeSchema } from "./brand.js";

// --- Oferta post-análisis ------------------------------------------------------

export const postAnalysisOfferSchema = z
  .object({
    /** `true` = hay una fuente analizada y la oferta no se descartó. */
    show: z.boolean(),
    dismissed: z.boolean(),
    /** La fuente analizada que nombra la oferta (`Connect @<handle>…`). */
    source: z
      .object({
        sourceType: brandSourceTypeSchema,
        handle: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type PostAnalysisOffer = z.infer<typeof postAnalysisOfferSchema>;

// --- Extraer audio de un video -------------------------------------------------

/**
 * Tope de duración del video del que se saca el audio. **Decisión nuestra**
 * (el PRD no lo fija): una pista para un short dura segundos o un par de
 * minutos; 5 minutos a 128 kb/s son ~5 MB, bajo `BRAND_AUDIO_MAX_MB`. Un
 * video más largo se rechaza (`too_long`), no se recorta en silencio.
 * `packages/core` lo repite (`AUDIO_EXTRACT_MAX_SECONDS`); un test de la API
 * los ata.
 */
export const AUDIO_EXTRACT_MAX_SECONDS = 300;

export const audioExtractRequestSchema = z
  .object({
    mediaId: mediaIdSchema,
    title: z.string().trim().min(1).max(BRAND_AUDIO_TITLE_MAX).optional(),
  })
  .strict();
export type AudioExtractRequest = z.infer<typeof audioExtractRequestSchema>;

export const audioExtractionStateSchema = z.enum([
  "queued",
  "extracting",
  "done",
  "failed",
]);
export type AudioExtractionState = z.infer<typeof audioExtractionStateSchema>;

/** Códigos estables: nunca el stderr de FFmpeg. */
export const audioExtractionErrorSchema = z.enum([
  /** El video ya no está en el Media Bank (o no es un video). */
  "media_not_found",
  /** El video no tiene pista de audio. */
  "no_audio",
  "too_long",
  "too_large",
  /** FFmpeg falló o no está instalado donde corre el worker. */
  "extract_failed",
]);
export type AudioExtractionError = z.infer<typeof audioExtractionErrorSchema>;

export const audioExtractionSchema = z
  .object({
    id: z.string().uuid(),
    mediaId: mediaIdSchema,
    state: audioExtractionStateSchema,
    /** La pista creada (`origin: "extracted"`), cuando `done`. */
    trackId: z.string().uuid().optional(),
    error: audioExtractionErrorSchema.optional(),
    updatedAt: z.number().int(),
  })
  .strict();
export type AudioExtraction = z.infer<typeof audioExtractionSchema>;
