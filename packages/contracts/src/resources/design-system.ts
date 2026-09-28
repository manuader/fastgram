/**
 * Design system por marca — sprint 9 (agente M), `PU-S9-001…004`.
 *
 *   GET    /design-system                                 activo + último import
 *   POST   /design-system/upload-url                      reservar la subida del zip (§9.8)
 *   POST   /design-system/import                          confirmar la subida → import (202)
 *   POST   /design-system/derive                          derivado del análisis de marca (201)
 *   PATCH  /design-system/{designSystemId}                paleta, licencias, estilo, nombre
 *   POST   /design-system/{designSystemId}/generate       generar assets (202, pendientes)
 *   POST   /design-system/{designSystemId}/pending/{assetRef}/approve  → Media Bank
 *   DELETE /design-system/{designSystemId}/pending/{assetRef}          descartar
 *   GET    /design-system/{designSystemId}/font-files/{fileRef}        bytes para el specimen
 *   DELETE /design-system/{designSystemId}
 *
 * Todo con la marca activa (`X-Fastgram-Workspace`); una fila de otra marca
 * es 404. Fechas en ms, como el resto de la API v1.
 *
 * ## Por qué los bytes de la fuente vienen en base64 por la API
 *
 * El specimen de la pantalla necesita cargar la fuente con `FontFace`. La URL
 * del storage es de otro origen (MinIO en local) y una fuente cross-origin
 * exige CORS que el bucket no da; el proxy de la web (`/api/fastgram/v1`)
 * pasa el cuerpo como texto, así que tampoco puede servir binarios. Un JSON
 * con un `data:` URL cruza el proxy intacto. Las OTF de FOCUS pesan ~25 KB.
 */
import { z } from "zod";

import { hexColorSchema } from "../primitives/enums.js";

/** Tope del zip: el mismo que aplica el worker (`DESIGN_SYSTEM_ZIP_LIMITS`). */
export const DESIGN_SYSTEM_ZIP_MAX_MB = 100;
export const DESIGN_SYSTEM_ZIP_CONTENT_TYPES = [
  "application/zip",
  "application/x-zip-compressed",
] as const;

export const designSystemStatusSchema = z.enum(["importing", "ready", "failed"]);
export const designSystemSourceSchema = z.enum(["zip", "derived"]);

/** Códigos estables de un import fallido. La web los traduce. */
export const designSystemFailureCodeSchema = z.enum([
  "zip_too_large",
  "too_many_entries",
  "unsafe_path",
  "zip_bomb",
  "not_a_zip",
  "empty_design_system",
  "storage_failed",
  "internal_error",
]);

export const designSystemColorSchema = z.object({
  name: z.string(),
  hex: hexColorSchema,
  aliasOf: z.string().nullable(),
});

export const designSystemFontFaceSchema = z.object({
  weight: z.number().int(),
  style: z.enum(["normal", "italic"]),
  /** Para pedir los bytes (`GET …/font-files/{fileRef}`). `null` sin archivo subido. */
  fileRef: z.string().nullable(),
});

export const resolvedFontSchema = z.object({
  kind: z.enum(["brand", "registered"]),
  /** `brand`: id de la familia de la marca; `registered`: una de las 12 del render. */
  family: z.string(),
  displayName: z.string(),
  weight: z.number().int(),
  /** La familia de la marca que se reemplazó, si es un reemplazo. */
  mappedFrom: z.string().nullable(),
  reason: z.string().nullable(),
});

export const designSystemFamilySchema = z.object({
  id: z.string(),
  name: z.string(),
  origin: z.enum(["file", "google", "stack"]),
  category: z.enum(["serif", "sans", "display", "mono", "script"]),
  license: z.enum(["open", "needs_confirmation", "system"]),
  licenseConfirmed: z.boolean(),
  weights: z.array(z.number().int()),
  faces: z.array(designSystemFontFaceSchema),
  /** La familia registrada que la reemplaza cuando no se puede usar. */
  fallback: z.string(),
  fallbackName: z.string(),
  /** ¿Se renderiza con sus propios archivos? */
  usable: z.boolean(),
});

export const designSystemRoleSchema = z.object({
  role: z.string(),
  stack: z.array(z.string()),
  familyId: z.string().nullable(),
});

export const designSystemStyleSchema = z.object({
  voice: z.string().max(400),
  values: z.array(z.string().max(200)).max(8),
  tagline: z.string().max(200).nullable(),
  compositionRules: z.array(z.string().max(200)).max(10),
  dos: z.array(z.string().max(200)).max(8),
  donts: z.array(z.string().max(200)).max(8),
  language: z.string().max(35).nullable(),
  origin: z.enum(["model", "heuristic", "owner"]),
});
export type DesignSystemStyleResource = z.infer<typeof designSystemStyleSchema>;

export const designSystemAssetSchema = z.object({
  mediaId: z.string(),
  kind: z.enum(["logo", "imagery", "motif", "generated"]),
  url: z.string(),
  filename: z.string(),
});

export const designSystemPendingAssetSchema = z.object({
  id: z.string(),
  url: z.string(),
  generator: z.enum(["local", "model"]),
  createdAt: z.number(),
});

export const designSystemSchema = z.object({
  id: z.string().uuid(),
  status: designSystemStatusSchema,
  source: designSystemSourceSchema,
  active: z.boolean(),
  version: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  palette: z.array(designSystemColorSchema),
  semantic: z.object({
    surfaceDark: hexColorSchema.nullable(),
    surfaceLight: hexColorSchema.nullable(),
    textOnDark: hexColorSchema.nullable(),
    textOnLight: hexColorSchema.nullable(),
    accents: z.array(hexColorSchema),
  }),
  families: z.array(designSystemFamilySchema),
  roles: z.array(designSystemRoleSchema),
  /** Lo que usan las cajas de texto nuevas: títulos/hooks y el resto. */
  textDefaults: z.object({
    title: resolvedFontSchema,
    body: resolvedFontSchema,
    color: hexColorSchema.nullable(),
    backgroundColor: hexColorSchema.nullable(),
  }),
  spacing: z.array(z.object({ name: z.string(), px: z.number() })),
  style: designSystemStyleSchema.nullable(),
  assets: z.array(designSystemAssetSchema),
  pendingAssets: z.array(designSystemPendingAssetSchema),
  warnings: z.array(z.string()),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type DesignSystemResource = z.infer<typeof designSystemSchema>;

/** `GET /design-system`: el activo y, si hay uno más nuevo en curso o fallido, ése. */
export const designSystemStateSchema = z.object({
  active: designSystemSchema.nullable(),
  latest: designSystemSchema.nullable(),
});
export type DesignSystemState = z.infer<typeof designSystemStateSchema>;

export const designSystemUploadRequestSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(255)
      .refine((f) => f.toLowerCase().endsWith(".zip"), "the file must be a .zip"),
    contentType: z.enum(DESIGN_SYSTEM_ZIP_CONTENT_TYPES),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(
        DESIGN_SYSTEM_ZIP_MAX_MB * 1024 * 1024,
        `the zip exceeds ${String(DESIGN_SYSTEM_ZIP_MAX_MB)} MB`,
      ),
  })
  .strict();
export type DesignSystemUploadRequest = z.infer<typeof designSystemUploadRequestSchema>;

export const designSystemImportRequestSchema = z
  .object({ uploadId: z.string().uuid() })
  .strict();

export const designSystemUpdateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    /** La paleta completa (reemplaza), con los alias de rol. Entre 2 y 48 colores. */
    palette: z
      .array(
        z
          .object({
            name: z
              .string()
              .regex(/^--[A-Za-z0-9_-]{1,60}$/u)
              .optional(),
            hex: hexColorSchema,
          })
          .strict(),
      )
      .min(2)
      .max(48)
      .optional(),
    /** familyId → «tengo licencia para usar esta fuente». */
    fontLicenses: z.record(z.string().max(64), z.boolean()).optional(),
    /** familyId → familia registrada que la reemplaza. */
    fontFallbacks: z.record(z.string().max(64), z.string().max(32)).optional(),
    style: designSystemStyleSchema.omit({ origin: true }).strict().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, "nothing to update");
export type DesignSystemUpdateRequest = z.infer<typeof designSystemUpdateRequestSchema>;

export const designSystemGenerateRequestSchema = z
  .object({
    localImages: z.number().int().min(0).max(8).default(4),
    modelImages: z.number().int().min(0).max(4).default(0),
  })
  .strict()
  .refine((b) => b.localImages + b.modelImages > 0, "nothing to generate");
export type DesignSystemGenerateRequest = z.input<
  typeof designSystemGenerateRequestSchema
>;

export const designSystemGenerateResponseSchema = z.object({
  requestId: z.string().uuid(),
  localImages: z.number().int(),
  modelImages: z.number().int(),
  /** `false` si se pidieron imágenes de modelo y no hay modelo `image` configurado. */
  imageModelConfigured: z.boolean(),
});

export const designSystemFontFileSchema = z.object({
  fileRef: z.string(),
  contentType: z.string(),
  /** `data:font/otf;base64,…` */
  dataUrl: z.string(),
});

export const designSystemApproveResponseSchema = z.object({ mediaId: z.string() });
