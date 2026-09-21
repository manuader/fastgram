/**
 * Subida en tres fases · §9.8 (PRD:2338) y NFR-013 (PRD:2963).
 *
 *   reserva (`POST …/upload-url`) → PUT directo al storage → finalización
 *
 * El PRD fija la forma exacta de la respuesta de reserva:
 *   `{uploadId, uploadUrl, method:"PUT", headers, expiresAt}`
 *
 * Errores de la reserva: `409 conflict` (objeto no alcanzable, finalización en
 * curso, reserva previa fallida), `410 gone` (expirada), `404` (ajena).
 */
import { z } from "zod";
import {
  imageContentTypeSchema,
  uploadContentTypeSchema,
  videoContentTypeSchema,
} from "./enums.js";
import { msEpochSchema, uploadIdSchema } from "./ids.js";

/** NFR-013 (PRD:2963) — imágenes 10 MB. */
export const UPLOAD_IMAGE_MAX_MB = 10;
/** NFR-013 (PRD:2963) — videos 50 MB. */
export const UPLOAD_VIDEO_MAX_MB = 50;
/** NFR-013 (PRD:2963) / FR-080 (PRD:1515) — base image de influencer 10 MB. */
export const UPLOAD_INFLUENCER_BASE_IMAGE_MAX_MB = 10;

/**
 * El PRD dice "MB" sin decir si son 10^6 o 2^20. Se toma el mebibyte (2^20),
 * que es la lectura habitual en límites de subida. Si el número real fuera
 * decimal, el cambio es esta constante y nada más.
 */
export const BYTES_PER_MB = 1024 * 1024;

export const mbToBytes = (mb: number): number => mb * BYTES_PER_MB;

/**
 * §9.8 (PRD:2339) — "La extensión del filename debe coincidir con el content type".
 * El mapa es la única fuente de esa coherencia en el contrato.
 */
export const CONTENT_TYPE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "video/mp4": [".mp4"],
  "video/quicktime": [".mov"],
};

export const filenameMatchesContentType = (
  filename: string,
  contentType: string,
): boolean => {
  const allowed = CONTENT_TYPE_EXTENSIONS[contentType];
  if (allowed === undefined) return false;
  const lower = filename.toLowerCase();
  return allowed.some((ext) => lower.endsWith(ext));
};

/**
 * Cuerpo genérico de una reserva. Los endpoints concretos lo estrechan al tipo
 * de contenido y al tamaño que permiten (imagen, video, base image).
 */
const reservationBase = {
  filename: z.string().min(1),
  sizeBytes: z.number().int().positive(),
};

/** Fábrica: reserva restringida a un conjunto de content types y a un techo en MB. */
export const uploadReservationRequest = <T extends z.ZodTypeAny>(
  contentType: T,
  maxMb: number,
) =>
  z
    .object({ ...reservationBase, contentType })
    .strict()
    .superRefine((body, ctx) => {
      if (body.sizeBytes > mbToBytes(maxMb)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sizeBytes"],
          message: `file exceeds the ${maxMb} MB limit`,
        });
      }
      if (!filenameMatchesContentType(body.filename, String(body.contentType))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["filename"],
          message: "filename extension must match contentType",
        });
      }
    });

export const imageUploadReservationRequestSchema = uploadReservationRequest(
  imageContentTypeSchema,
  UPLOAD_IMAGE_MAX_MB,
);
export type ImageUploadReservationRequest = z.infer<
  typeof imageUploadReservationRequestSchema
>;

export const videoUploadReservationRequestSchema = uploadReservationRequest(
  videoContentTypeSchema,
  UPLOAD_VIDEO_MAX_MB,
);
export type VideoUploadReservationRequest = z.infer<
  typeof videoUploadReservationRequestSchema
>;

/**
 * Media Bank: acepta imagen **o** video, y cada uno con su propio techo
 * (FR-100, PRD:1631). Por eso no se puede expresar con un solo `maxMb`.
 */
export const mediaUploadReservationRequestSchema = z
  .object({ ...reservationBase, contentType: uploadContentTypeSchema })
  .strict()
  .superRefine((body, ctx) => {
    const maxMb = body.contentType.startsWith("image/")
      ? UPLOAD_IMAGE_MAX_MB
      : UPLOAD_VIDEO_MAX_MB;
    if (body.sizeBytes > mbToBytes(maxMb)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sizeBytes"],
        message: `file exceeds the ${maxMb} MB limit`,
      });
    }
    if (!filenameMatchesContentType(body.filename, body.contentType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["filename"],
        message: "filename extension must match contentType",
      });
    }
  });
export type MediaUploadReservationRequest = z.infer<
  typeof mediaUploadReservationRequestSchema
>;

/** §9.8 (PRD:2338) — forma literal de la respuesta de reserva. */
export const uploadReservationSchema = z
  .object({
    uploadId: uploadIdSchema,
    uploadUrl: z.string().url(),
    method: z.literal("PUT"),
    headers: z.record(z.string()),
    expiresAt: msEpochSchema,
  })
  .strict();
export type UploadReservation = z.infer<typeof uploadReservationSchema>;
