/**
 * Biblioteca **global** de assets — sprint 9 (agente N), `PU-S9-005`,
 * `PU-S9-006`, PRD §2.7 `D-19`.
 *
 * Es el catálogo de la instalación (como las librerías de CapCut o Premiere):
 * clips de pantalla verde, fondos, imágenes y audio que cualquier marca puede
 * usar. No lleva `companyId`; el día que haya multiusuario es la librería
 * común. Cada asset trae un **JSON de metadatos versionado** que lo describe
 * para que un modelo de juicio lo elija leyendo texto
 * (`describeLibraryAsset` en `@fastgram/core`).
 *
 *   GET    /library/assets                       buscar/filtrar
 *   GET    /library/assets/{id}                  detalle
 *   PATCH  /library/assets/{id}                  editar metadatos / ocultar
 *   DELETE /library/assets/{id}                  borrar (soft)
 *   POST   /library/assets/uploads               reservar una subida (+ licencia)
 *   POST   /library/assets/uploads/{upload}/complete   confirmarla → import
 *   POST   /library/assets/{id}/use-in-brand     copiar al Media Bank de la marca
 *   GET    /library/sources                      fuentes externas y si están listas
 *   PUT    /library/sources/{source}/key         guardar la key (Pexels, Pixabay)
 *   DELETE /library/sources/{source}/key
 *   GET    /library/sources/{source}/search      buscar en la fuente
 *   POST   /library/sources/{source}/import      importar resultados elegidos
 *
 * Todas son del dueño (ignoran la marca activa) salvo `use-in-brand`, que
 * escribe en la marca activa.
 *
 * ## La licencia es obligatoria y no hay `unknown` (D-19)
 *
 * Qué entra y por qué, con la doc oficial leída el 2026-09-28:
 *
 * - `cc0`: dominio público dedicado (creativecommons.org/publicdomain/zero/1.0).
 * - `cc-by`: uso comercial y obra derivada, **con atribución**: `attribution`
 *   es obligatoria y se muestra en la UI.
 * - `pexels`: https://www.pexels.com/license/ — uso libre y comercial, sin
 *   atribución obligatoria, se puede modificar. Prohíbe: vender copias sin
 *   alterar, redistribuirlo en otras plataformas de stock, mostrar a personas
 *   identificables de forma ofensiva, sugerir que una persona o marca
 *   respalda un producto, usarlo como marca comercial.
 * - `pixabay`: https://pixabay.com/service/license-summary/ — uso comercial sin
 *   atribución y modificable. Prohíbe: vender o distribuir el contenido tal
 *   cual («standalone»), usar marcas/logos reconocibles en productos,
 *   personas reconocibles en contextos inmorales o ilegales, usos engañosos,
 *   usarlo como marca comercial.
 * - `own` / `generated`: lo subió el dueño declarando que es suyo o que lo
 *   generó con IA.
 *
 * **Fuera**, con su razón en {@link LIBRARY_EXCLUDED_LICENSES}: CC BY-SA (el
 * share-alike sobre una pieza compuesta obligaría a licenciar el reel entero
 * igual: discutible, y la opción conservadora es no entrar), las NC/ND
 * (prohíben uso comercial u obra derivada) y el dominio público «marcado»
 * de Commons sin CC0 (la razón varía por archivo y por país; no es una
 * licencia verificable por máquina).
 */
import { z } from "zod";

// --- Esquema de metadatos (versionado) ----------------------------------------

/** Subir esto obliga a una migración de los JSON guardados: ver la cabecera. */
export const LIBRARY_METADATA_SCHEMA_VERSION = 1 as const;

export const LIBRARY_ASSET_KINDS = [
  "green_screen_video",
  "background_video",
  "background_image",
  "image",
  "audio",
] as const;
export const libraryAssetKindSchema = z.enum(LIBRARY_ASSET_KINDS);
export type LibraryAssetKind = z.infer<typeof libraryAssetKindSchema>;

/**
 * Para qué sirve el asset dentro de un meme o un reel. Enum cerrado (lo lee un
 * modelo de juicio: un texto libre no se puede filtrar) con `other`.
 */
export const LIBRARY_MEME_TYPES = [
  /** Alguien reacciona: facepalm, aplauso lento, ojos en blanco. */
  "reaction",
  /** Remate: el golpe final del chiste. */
  "punchline",
  /** Pasaje entre dos partes: whoosh, explosión, barrido. */
  "transition",
  /** «Cuando el cliente pide cambios…»: la situación es el chiste. */
  "when_x_happens",
  /** Efecto que se superpone: flecha, señal, explosión, confeti. */
  "overlay_effect",
  /** Fondo sobre el que va otra cosa. */
  "background",
  /** Plano de apoyo que ilustra lo que se dice. */
  "b_roll",
  "sound_effect",
  "music",
  "other",
] as const;
export const libraryMemeTypeSchema = z.enum(LIBRARY_MEME_TYPES);
export type LibraryMemeType = z.infer<typeof libraryMemeTypeSchema>;

export const LIBRARY_EMOTIONS = [
  "joy",
  "laughter",
  "surprise",
  "shock",
  "excitement",
  "pride",
  "love",
  "calm",
  "neutral",
  "boredom",
  "confusion",
  "embarrassment",
  "sarcasm",
  "frustration",
  "anger",
  "sadness",
  "fear",
  "disgust",
] as const;
export const libraryEmotionSchema = z.enum(LIBRARY_EMOTIONS);
export type LibraryEmotion = z.infer<typeof libraryEmotionSchema>;

/** `scene` = fondo o paisaje sin sujeto; `none` = audio. */
export const LIBRARY_FRAMINGS = [
  "full_body",
  "half_body",
  "face",
  "object",
  "scene",
  "none",
] as const;
export const libraryFramingSchema = z.enum(LIBRARY_FRAMINGS);
export type LibraryFraming = z.infer<typeof libraryFramingSchema>;

export const LIBRARY_CHROMA_TYPES = ["green", "blue", "alpha", "none"] as const;
export const libraryChromaTypeSchema = z.enum(LIBRARY_CHROMA_TYPES);
export type LibraryChromaType = z.infer<typeof libraryChromaTypeSchema>;

export const LIBRARY_ENERGY_LEVELS = ["low", "medium", "high"] as const;
export const libraryEnergySchema = z.enum(LIBRARY_ENERGY_LEVELS);
export type LibraryEnergy = z.infer<typeof libraryEnergySchema>;

export const LIBRARY_ASPECT_RATIOS = ["9:16", "16:9", "1:1", "4:5", "other"] as const;
export const libraryAspectRatioSchema = z.enum(LIBRARY_ASPECT_RATIOS);
export type LibraryAspectRatio = z.infer<typeof libraryAspectRatioSchema>;

export const LIBRARY_LICENSE_TYPES = [
  "cc0",
  "cc-by",
  "pexels",
  "pixabay",
  "own",
  "generated",
] as const;
export const libraryLicenseTypeSchema = z.enum(LIBRARY_LICENSE_TYPES);
export type LibraryLicenseType = z.infer<typeof libraryLicenseTypeSchema>;

/** Lo que no entra, con la razón que ve el usuario. Ver la cabecera. */
export const LIBRARY_EXCLUDED_LICENSES: Readonly<Record<string, string>> = {
  "cc-by-sa": "Share-alike would force the whole composed piece under the same license.",
  "cc-by-nc": "Non-commercial licenses don't allow brand content.",
  "cc-by-nd": "No-derivatives licenses don't allow compositing.",
  "public-domain-mark":
    "Public-domain marks vary by file and country; only CC0 is machine-verifiable.",
  unknown: "Assets without a verifiable license can't enter the global library.",
};

/** Las que exigen atribución visible. */
export const LIBRARY_ATTRIBUTION_REQUIRED: readonly LibraryLicenseType[] = ["cc-by"];
/** Las que vienen de un tercero: sin `sourceUrl` y `licenseUrl` no se verifican. */
const THIRD_PARTY: readonly LibraryLicenseType[] = ["cc0", "cc-by", "pexels", "pixabay"];

export const LIBRARY_ATTRIBUTION_MAX = 500;

const isoDate = z.string().datetime({ offset: true });

export const libraryLicenseSchema = z
  .object({
    type: libraryLicenseTypeSchema,
    /** Versión de la licencia CC (`4.0`, `3.0`…). */
    version: z.string().max(10).optional(),
    /** Texto listo para mostrar. Obligatoria para `cc-by`. */
    attribution: z.string().trim().min(1).max(LIBRARY_ATTRIBUTION_MAX).optional(),
    /** La página del archivo en la fuente: también es la clave de dedupe. */
    sourceUrl: z.string().url().optional(),
    author: z.string().trim().min(1).max(200).optional(),
    licenseUrl: z.string().url().optional(),
    /** Cuándo la verificó el código contra la fuente (o la declaró el dueño). */
    verifiedAt: isoDate,
  })
  .strict()
  .superRefine((l, ctx) => {
    if (LIBRARY_ATTRIBUTION_REQUIRED.includes(l.type) && l.attribution === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attribution"],
        message: "attribution is required for CC BY",
      });
    }
    if (THIRD_PARTY.includes(l.type)) {
      for (const field of ["sourceUrl", "licenseUrl"] as const) {
        if (l[field] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is required for a third-party license`,
          });
        }
      }
    }
  });
export type LibraryLicense = z.infer<typeof libraryLicenseSchema>;

export const libraryAspectSchema = z
  .object({
    ratio: libraryAspectRatioSchema,
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
  })
  .strict();
export type LibraryAspect = z.infer<typeof libraryAspectSchema>;

const HEX_COLOR = /^#[0-9A-F]{6}$/i;

export const libraryChromaSchema = z
  .object({
    type: libraryChromaTypeSchema,
    /**
     * **Medida**, nunca propuesta por un modelo: la proporción del borde de
     * los cuadros muestreados que es color de croma (0–1) o, con `alpha`,
     * que es transparente de verdad. `null` = no se midió (audio).
     */
    keyQuality: z.number().min(0).max(1).nullable(),
    keyColor: z.string().regex(HEX_COLOR).nullable(),
  })
  .strict();
export type LibraryChroma = z.infer<typeof libraryChromaSchema>;

export const LIBRARY_DESCRIPTION_MAX = 600;
export const LIBRARY_TAG_MAX = 40;

const shortText = (max: number) => z.string().trim().min(1).max(max);

export const libraryMetadataFieldsSchema = z
  .object({
    schemaVersion: z.literal(LIBRARY_METADATA_SCHEMA_VERSION),
    kind: libraryAssetKindSchema,
    /** Qué pasa en la escena, 1–3 oraciones. Vacía = falta completarla a mano. */
    description: z.string().trim().max(LIBRARY_DESCRIPTION_MAX),
    memeType: libraryMemeTypeSchema,
    emotions: z.array(libraryEmotionSchema).max(6),
    /** Frases cortas: «when the client asks for changes». */
    useCases: z.array(shortText(120)).max(8),
    characters: z.array(shortText(60)).max(6),
    tags: z.array(shortText(LIBRARY_TAG_MAX)).max(20),
    /** BCP 47 corto (`en`, `es`, `pt-BR`) si hay habla; si no, `null`. */
    language: z
      .string()
      .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/)
      .nullable(),
    hasSpeech: z.boolean(),
    durationSec: z.number().nonnegative().nullable(),
    aspect: libraryAspectSchema,
    framing: libraryFramingSchema,
    chroma: libraryChromaSchema,
    /** Obligatoriamente `false`: lo NSFW no entra (D-19). */
    nsfw: z.literal(false, {
      errorMap: () => ({ message: "NSFW assets can't enter the library" }),
    }),
    energy: libraryEnergySchema,
    /** `true` mientras falte algo que no se pudo etiquetar solo. */
    needsReview: z.boolean(),
    license: libraryLicenseSchema,
  })
  .strict();

export const libraryAssetMetadataSchema = libraryMetadataFieldsSchema.superRefine(
  (m, ctx) => {
    if (m.kind === "green_screen_video" && m.chroma.type === "none") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chroma", "type"],
        message: "a green-screen video needs a key (green, blue or alpha)",
      });
    }
    const isVideoOrAudio =
      m.kind === "green_screen_video" ||
      m.kind === "background_video" ||
      m.kind === "audio";
    if (isVideoOrAudio && m.durationSec === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationSec"],
        message: "video and audio need a measured duration",
      });
    }
    if (!m.hasSpeech && m.language !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["language"],
        message: "language only applies when there is speech",
      });
    }
  },
);
export type LibraryAssetMetadata = z.infer<typeof libraryAssetMetadataSchema>;

// --- El asset tal como sale por la API ----------------------------------------

export const LIBRARY_ASSET_STATUSES = [
  "processing",
  "ready",
  "failed",
  "hidden",
] as const;
export const libraryAssetStatusSchema = z.enum(LIBRARY_ASSET_STATUSES);
export type LibraryAssetStatus = z.infer<typeof libraryAssetStatusSchema>;

export const LIBRARY_MEDIA_TYPES = ["video", "image", "audio"] as const;
export const libraryMediaTypeSchema = z.enum(LIBRARY_MEDIA_TYPES);
export type LibraryMediaType = z.infer<typeof libraryMediaTypeSchema>;

export const LIBRARY_SOURCES = ["wikimedia", "pexels", "pixabay"] as const;
export const librarySourceIdSchema = z.enum(LIBRARY_SOURCES);
export type LibrarySourceId = z.infer<typeof librarySourceIdSchema>;

export const libraryProviderSchema = z.enum(["upload", ...LIBRARY_SOURCES]);
export type LibraryProvider = z.infer<typeof libraryProviderSchema>;

/** Motivos estables de un import fallido: nunca el stderr ni el texto del proveedor. */
export const LIBRARY_FAILURE_CODES = [
  "download_failed",
  "too_large",
  "too_long",
  "unsupported_media",
  "normalization_failed",
  "invalid_metadata",
  /** El modelo de visión vio desnudez o violencia gráfica: no entra (D-19). */
  "nsfw_rejected",
  /**
   * La fuente contestó 429 (Wikimedia: `Retry-After` de 10 min, visto el
   * 2026-09-28). Volver a importar el mismo archivo lo reintenta.
   */
  "source_rate_limited",
] as const;
export const libraryFailureCodeSchema = z.enum(LIBRARY_FAILURE_CODES);
export type LibraryFailureCode = z.infer<typeof libraryFailureCodeSchema>;

export const LIBRARY_METADATA_SOURCES = ["auto", "edited"] as const;
export const libraryMetadataSourceSchema = z.enum(LIBRARY_METADATA_SOURCES);

export const libraryAssetSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    kind: libraryAssetKindSchema,
    mediaType: libraryMediaTypeSchema,
    status: libraryAssetStatusSchema,
    /** La dirección del objeto (no firmada, §9.10); `null` mientras procesa. */
    url: z.string().url().nullable(),
    previewUrl: z.string().url().nullable(),
    contentType: z.string().nullable(),
    sizeMb: z.number().nonnegative().nullable(),
    durationSec: z.number().nonnegative().nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    license: libraryLicenseSchema,
    /** `null` mientras procesa o si falló antes de etiquetar. */
    metadata: libraryAssetMetadataSchema.nullable(),
    metadataSource: libraryMetadataSourceSchema,
    provider: libraryProviderSchema,
    externalId: z.string().nullable(),
    failureCode: libraryFailureCodeSchema.nullable(),
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .strict();
export type LibraryAsset = z.infer<typeof libraryAssetSchema>;

export const libraryAssetListSchema = z.array(libraryAssetSchema);

const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
    )
    .pipe(z.array(item).max(20));

export const listLibraryAssetsQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    kind: csv(libraryAssetKindSchema).optional(),
    memeType: csv(libraryMemeTypeSchema).optional(),
    emotion: csv(libraryEmotionSchema).optional(),
    aspect: csv(libraryAspectRatioSchema).optional(),
    license: csv(libraryLicenseTypeSchema).optional(),
    minDuration: z.coerce.number().nonnegative().optional(),
    maxDuration: z.coerce.number().positive().optional(),
    /** Default: `ready` y `processing` (lo oculto y lo fallido, sólo si se pide). */
    status: csv(libraryAssetStatusSchema).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(40),
  })
  .strict();
export type ListLibraryAssetsQuery = z.infer<typeof listLibraryAssetsQuerySchema>;

export const libraryAssetPageSchema = z
  .object({
    data: libraryAssetListSchema,
    pagination: z.object({ cursor: z.string().nullable(), hasMore: z.boolean() }),
  })
  .strict();

/**
 * `PATCH /library/assets/{id}` — lo que el dueño corrige del JSON. Lo medible
 * (duración, aspecto, croma) y la licencia **no** se editan: lo midió el
 * código o lo verificó contra la fuente. Guardar vuelve a validar el JSON
 * entero y pasa `metadataSource` a `edited`.
 */
export const updateLibraryAssetRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    kind: libraryAssetKindSchema.optional(),
    description: z.string().trim().max(LIBRARY_DESCRIPTION_MAX).optional(),
    memeType: libraryMemeTypeSchema.optional(),
    emotions: z.array(libraryEmotionSchema).max(6).optional(),
    useCases: z.array(shortText(120)).max(8).optional(),
    characters: z.array(shortText(60)).max(6).optional(),
    tags: z.array(shortText(LIBRARY_TAG_MAX)).max(20).optional(),
    language: z
      .string()
      .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/)
      .nullable()
      .optional(),
    hasSpeech: z.boolean().optional(),
    framing: libraryFramingSchema.optional(),
    energy: libraryEnergySchema.optional(),
    /** `true` = sale de búsquedas y del decisor; `false` = vuelve. */
    hidden: z.boolean().optional(),
  })
  .strict();
export type UpdateLibraryAssetRequest = z.infer<typeof updateLibraryAssetRequestSchema>;

// --- Subida manual -----------------------------------------------------------

/** Una biblioteca de clips pesa más que el Media Bank (50 MB): la normalización la achica. */
export const LIBRARY_UPLOAD_MAX_MB = 200;

export const LIBRARY_UPLOAD_CONTENT_TYPES: Readonly<Record<string, readonly string[]>> = {
  "video/mp4": [".mp4"],
  "video/quicktime": [".mov"],
  "video/webm": [".webm"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "audio/mpeg": [".mp3"],
  "audio/mp4": [".m4a"],
  "audio/wav": [".wav"],
};
export const libraryUploadContentTypeSchema = z.enum([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
]);

/** La declaración del formulario: el dueño elige el tipo y completa lo que exige. */
export const libraryLicenseDeclarationSchema = z
  .object({
    type: libraryLicenseTypeSchema,
    version: z.string().max(10).optional(),
    attribution: z.string().trim().min(1).max(LIBRARY_ATTRIBUTION_MAX).optional(),
    sourceUrl: z.string().url().optional(),
    author: z.string().trim().min(1).max(200).optional(),
    licenseUrl: z.string().url().optional(),
  })
  .strict();
export type LibraryLicenseDeclaration = z.infer<typeof libraryLicenseDeclarationSchema>;

export const libraryUploadRequestSchema = z
  .object({
    filename: z.string().min(1).max(255),
    contentType: libraryUploadContentTypeSchema,
    sizeBytes: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(),
    /** Pista del tipo; sin ella, el worker decide por lo que mide. */
    kind: libraryAssetKindSchema.optional(),
    license: libraryLicenseDeclarationSchema,
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.sizeBytes > LIBRARY_UPLOAD_MAX_MB * 1024 * 1024) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sizeBytes"],
        message: `file exceeds the ${String(LIBRARY_UPLOAD_MAX_MB)} MB limit`,
      });
    }
    const allowed = LIBRARY_UPLOAD_CONTENT_TYPES[body.contentType] ?? [];
    const lower = body.filename.toLowerCase();
    if (!allowed.some((ext) => lower.endsWith(ext))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["filename"],
        message: "filename extension must match contentType",
      });
    }
  });
export type LibraryUploadRequest = z.infer<typeof libraryUploadRequestSchema>;

export const libraryUploadReservationSchema = z
  .object({
    uploadId: z.string().uuid(),
    uploadUrl: z.string().url(),
    method: z.literal("PUT"),
    headers: z.record(z.string()),
    expiresAt: z.number().int(),
  })
  .strict();
export type LibraryUploadReservation = z.infer<typeof libraryUploadReservationSchema>;

// --- Fuentes externas --------------------------------------------------------

export const librarySourceStatusSchema = z
  .object({
    id: librarySourceIdSchema,
    label: z.string(),
    /** URL de la licencia oficial que se aplicó para aceptar sus archivos. */
    licenseUrl: z.string().url(),
    needsKey: z.boolean(),
    enabled: z.boolean(),
    /** Por qué está deshabilitada: `missing_key`. */
    disabledReason: z.enum(["missing_key"]).nullable(),
    /** Dónde sale la key si viene del entorno (nunca la key). */
    keyFrom: z.enum(["file", "env"]).nullable(),
  })
  .strict();
export type LibrarySourceStatus = z.infer<typeof librarySourceStatusSchema>;
export const librarySourceStatusListSchema = z.array(librarySourceStatusSchema);

export const setLibrarySourceKeyRequestSchema = z
  .object({ apiKey: z.string().trim().min(8).max(200) })
  .strict();

export const librarySearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100),
    page: z.coerce.number().int().min(1).max(50).default(1),
  })
  .strict();

/** Por qué un resultado no se puede importar. */
export const LIBRARY_UNIMPORTABLE_REASONS = [
  "license_not_accepted",
  "license_unverifiable",
  "restricted",
  "too_long",
  "too_large",
  "unsupported_media",
] as const;
export const libraryUnimportableReasonSchema = z.enum(LIBRARY_UNIMPORTABLE_REASONS);
export type LibraryUnimportableReason = z.infer<typeof libraryUnimportableReasonSchema>;

export const librarySearchResultSchema = z
  .object({
    source: librarySourceIdSchema,
    externalId: z.string(),
    title: z.string(),
    pageUrl: z.string().url(),
    previewUrl: z.string().url().nullable(),
    mediaType: libraryMediaTypeSchema,
    durationSec: z.number().nonnegative().nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    sizeMb: z.number().nonnegative().nullable(),
    /** La licencia tal como la declara la fuente, en nuestro vocabulario. */
    licenseLabel: z.string(),
    license: libraryLicenseSchema.nullable(),
    importable: z.boolean(),
    unimportableReason: libraryUnimportableReasonSchema.nullable(),
    /** Si ya está en la biblioteca (dedupe por `sourceUrl`). */
    existingAssetId: z.string().uuid().nullable(),
  })
  .strict();
export type LibrarySearchResult = z.infer<typeof librarySearchResultSchema>;

export const librarySearchPageSchema = z
  .object({
    results: z.array(librarySearchResultSchema),
    nextPage: z.number().int().positive().nullable(),
    /** Lo que la fuente pide mostrar junto a los resultados (Pexels, Pixabay). */
    credit: z.object({ text: z.string(), url: z.string().url() }).strict(),
  })
  .strict();
export type LibrarySearchPage = z.infer<typeof librarySearchPageSchema>;

export const LIBRARY_IMPORT_BATCH_MAX = 20;

export const librarySourceImportRequestSchema = z
  .object({
    externalIds: z.array(z.string().min(1).max(300)).min(1).max(LIBRARY_IMPORT_BATCH_MAX),
    kind: libraryAssetKindSchema.optional(),
  })
  .strict();
export type LibrarySourceImportRequest = z.infer<typeof librarySourceImportRequestSchema>;

export const librarySourceImportOutcomeSchema = z
  .object({
    externalId: z.string(),
    outcome: z.enum(["queued", "duplicate", "rejected"]),
    assetId: z.string().uuid().nullable(),
    reason: z.union([libraryUnimportableReasonSchema, z.literal("not_found")]).nullable(),
  })
  .strict();
export type LibrarySourceImportOutcome = z.infer<typeof librarySourceImportOutcomeSchema>;
export const librarySourceImportResultSchema = z.array(librarySourceImportOutcomeSchema);

// --- Usar en la marca --------------------------------------------------------

/** La categoría del Media Bank con que entra cada tipo (`FR-100`). */
export const LIBRARY_KIND_MEDIA_CATEGORY: Readonly<
  Record<Exclude<LibraryAssetKind, "audio">, string>
> = {
  green_screen_video: "green-screen-video",
  background_video: "background-video",
  background_image: "green-screen-background",
  image: "slideshow-image",
};

export const libraryUseInBrandResultSchema = z
  .object({
    assetId: z.string().uuid(),
    /** Dónde quedó: una fila del Media Bank o una pista de audio de la marca. */
    target: z.enum(["media", "audio"]),
    targetId: z.string().uuid(),
    url: z.string().url(),
  })
  .strict();
export type LibraryUseInBrandResult = z.infer<typeof libraryUseInBrandResultSchema>;

/** El prefijo de storage de la biblioteca (grants del render: `sharedPrefixes`). */
export const LIBRARY_KEY_PREFIX = "library";
