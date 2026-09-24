/**
 * Enums compartidos del contrato v1.
 *
 * Todos los valores están copiados **textualmente** del PRD, en inglés. No se
 * traducen, no se normalizan y no se ordenan "mejor": un enum que no coincide
 * carácter a carácter con el PRD es un contrato roto. Cada bloque cita la línea.
 */
import { z } from "zod";

// --- Contenido ---------------------------------------------------------------

/**
 * Los cuatro formatos base · FR-050 Validation (PRD:1129).
 * Es el enum que acepta `POST /blitz` y el que pondera `BlitzPreferences`.
 */
export const blitzContentTypeSchema = z.enum([
  "slideshow",
  "wall-of-text",
  "green-screen",
  "video-hook",
]);
export type BlitzContentType = z.infer<typeof blitzContentTypeSchema>;

/**
 * `Content.type` · DATA-008 (PRD:2075). Añade `custom`, que es el video propio
 * subido por `POST /content/custom/video` y no un formato generable.
 */
export const contentTypeSchema = z.enum([
  "slideshow",
  "wall-of-text",
  "green-screen",
  "video-hook",
  "custom",
]);
export type ContentType = z.infer<typeof contentTypeSchema>;

/** FR-050 Validation (PRD:1129). Sólo aplica a slideshow. */
export const aspectRatioSchema = z.enum(["1:1", "4:5", "3:4", "9:16"]);
export type AspectRatio = z.infer<typeof aspectRatioSchema>;

/** DATA-008 (PRD:2076). */
export const contentStatusSchema = z.enum(["BUILDING", "CREATED", "FAILED"]);
export type ContentStatus = z.infer<typeof contentStatusSchema>;

// --- Plataformas -------------------------------------------------------------

/**
 * `Connection.platform` · DATA-016 (PRD:2111), más `x`, `threads` y `facebook`
 * de `D-09` (migración `0015_social_platforms.sql`), en el orden del tipo.
 */
export const platformSchema = z.enum([
  "tiktok",
  "instagram",
  "youtube",
  "linkedin",
  "reddit",
  "x",
  "threads",
  "facebook",
]);
export type Platform = z.infer<typeof platformSchema>;

/**
 * `Post.platform` · DATA-020 (PRD:2126): `tiktok | instagram | youtube | reddit`,
 * "+ `linkedin` en automations". Las automations son superficie **sólo MCP**
 * (AI-015, PRD:2706), no REST v1, así que `linkedin` no entra.
 *
 * `x`, `threads` y `facebook` son de `D-09` (migración `0015_social_platforms.sql`
 * los sumó a `post_platform`; los publicadores están en
 * `packages/adapters/src/publishers/{x,threads,facebook}`).
 */
export const postPlatformSchema = z.enum([
  "tiktok",
  "instagram",
  "youtube",
  "reddit",
  "x",
  "threads",
  "facebook",
]);
export type PostPlatform = z.infer<typeof postPlatformSchema>;

/** FR-130 (PRD:1705) — publicación warmed sólo en estas dos. */
export const warmedPlatformSchema = z.enum(["tiktok", "instagram"]);
export type WarmedPlatform = z.infer<typeof warmedPlatformSchema>;

/** DATA-016 (PRD:2111). */
export const connectionStatusSchema = z.enum(["active", "expired", "paused", "revoked"]);
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

/** DATA-020 (PRD:2127). `connectionId` y `warmedAccountId` son excluyentes. */
export const accountTypeSchema = z.enum(["oauth", "warmed"]);
export type AccountType = z.infer<typeof accountTypeSchema>;

// --- Publicación -------------------------------------------------------------

/** FR-060 estados normativos de un Post (PRD:1379). */
export const postStatusSchema = z.enum([
  "BUILDING",
  "CREATED",
  "SCHEDULED",
  "UPLOADING_TO_TIKTOK",
  "IN_USER_INBOX",
  "POSTED",
  "FAILED",
  "DELETED",
  "AWAITING_RECONNECT",
  "CANCELLED",
]);
export type PostStatus = z.infer<typeof postStatusSchema>;

/** F-151 (PRD:619) · INT-001 (PRD:2446). `inbox` es el default. */
export const postingModeSchema = z.enum(["inbox", "direct"]);
export type PostingMode = z.infer<typeof postingModeSchema>;

/** F-152 (PRD:620) · DATA-020 (PRD:2135). Mayúsculas literales de TikTok. */
export const privacyLevelSchema = z.enum([
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
]);
export type PrivacyLevel = z.infer<typeof privacyLevelSchema>;

/** F-158 (PRD:626) · DATA-020 (PRD:2137) — sólo warmed. */
export const instagramSlideshowFormatSchema = z.enum(["carousel", "reel"]);
export type InstagramSlideshowFormat = z.infer<typeof instagramSlideshowFormatSchema>;

/** DATA-020 (PRD:2138). */
export const tiktokSoundModeSchema = z.enum(["audible", "silent"]);
export type TiktokSoundMode = z.infer<typeof tiktokSoundModeSchema>;

/**
 * DATA-020 (PRD:2133) / FR-060 (PRD:1387): "`captionAdjustmentReason`
 * actualmente sólo vale `repeated_mention`".
 */
export const captionAdjustmentReasonSchema = z.enum(["repeated_mention"]);
export type CaptionAdjustmentReason = z.infer<typeof captionAdjustmentReasonSchema>;

// --- Media -------------------------------------------------------------------

/** DATA-010 (PRD:2093). */
export const mediaTypeSchema = z.enum(["image", "video"]);
export type MediaType = z.infer<typeof mediaTypeSchema>;

/** DATA-010 (PRD:2093) — los videos pasan por `processing` (normalización). */
export const mediaStatusSchema = z.enum(["processing", "ready", "failed"]);
export type MediaStatus = z.infer<typeof mediaStatusSchema>;

/**
 * DATA-010 (PRD:2093). `generated`, `demo` e `internal` nunca se listan (PRD:1636).
 * `brand_kit` (`PU-MEDIA-002`, migración `0013`): fondos de marca generados por
 * `services/render`; **sí** se listan, junto con `manual_upload`.
 */
export const mediaOriginSchema = z.enum([
  "manual_upload",
  "generated",
  "demo",
  "internal",
  "brand_kit",
]);
export type MediaOrigin = z.infer<typeof mediaOriginSchema>;

/** F-129 (PRD:601) · FR-100 (PRD:1633) — categorías válidas **por tipo**. */
export const imageMediaCategorySchema = z.enum([
  "slideshow-image",
  "green-screen-background",
]);
export type ImageMediaCategory = z.infer<typeof imageMediaCategorySchema>;

export const videoMediaCategorySchema = z.enum([
  "background-video",
  "hook-video",
  "green-screen-video",
]);
export type VideoMediaCategory = z.infer<typeof videoMediaCategorySchema>;

export const mediaCategorySchema = z.union([
  imageMediaCategorySchema,
  videoMediaCategorySchema,
]);
export type MediaCategory = z.infer<typeof mediaCategorySchema>;

/** DATA-011 (PRD:2096) — mayúsculas literales. */
export const mediaSetKindSchema = z.enum(["SLIDESHOW", "VIDEO", "CURATED"]);
export type MediaSetKind = z.infer<typeof mediaSetKindSchema>;

/** §9.8 (PRD:2339) · FR-100 (PRD:1631) · NFR-013 (PRD:2963). */
export const imageContentTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);
export type ImageContentType = z.infer<typeof imageContentTypeSchema>;

export const videoContentTypeSchema = z.enum(["video/mp4", "video/quicktime"]);
export type VideoContentType = z.infer<typeof videoContentTypeSchema>;

export const uploadContentTypeSchema = z.union([
  imageContentTypeSchema,
  videoContentTypeSchema,
]);
export type UploadContentType = z.infer<typeof uploadContentTypeSchema>;

/** DATA-028 (PRD:2170). */
export const uploadReservationStateSchema = z.enum([
  "reserved",
  "finalizing",
  "committed",
  "failed",
  "expired",
]);
export type UploadReservationState = z.infer<typeof uploadReservationStateSchema>;

// --- Audio -------------------------------------------------------------------

/**
 * `GET /audio?for=wall-of-text|video-hook` · FR-053 (PRD:1232) y §9.3 (PRD:2280).
 * DATA-012 (PRD:2099) lo llama `library`. Dos catálogos curados, globales.
 */
export const audioLibrarySchema = z.enum(["wall-of-text", "video-hook"]);
export type AudioLibrary = z.infer<typeof audioLibrarySchema>;

// --- Influencers -------------------------------------------------------------

/** FR-080 (PRD:1511) · DATA-013 (PRD:2102). */
export const influencerStatusSchema = z.enum([
  "generating_variations",
  "training",
  "ready",
  "failed",
  "inactive",
]);
export type InfluencerStatus = z.infer<typeof influencerStatusSchema>;

// --- Blitz preferences -------------------------------------------------------

/**
 * FR-055 (PRD:1275) — `genderFilter`: `"man" | "woman" | null`.
 * Ojo: la regla 4 de FR-055 (PRD:1285) habla de `male`/`female` al describir el
 * filtrado de la librería. Son dos vocabularios distintos en el PRD; el contrato
 * de la API usa el de la tabla normativa, que es la que mapea a la API.
 */
export const genderFilterSchema = z.enum(["man", "woman"]);
export type GenderFilter = z.infer<typeof genderFilterSchema>;

/** FR-055 (PRD:1279) — presets de estilo de caption. Siete, literales. */
export const textStylePresetSchema = z.enum([
  "tiktok-classic",
  "bold-impact",
  "snapchat",
  "white-box",
  "yellow-pop",
  "clean-karaoke",
  "script-playful",
]);
export type TextStylePreset = z.infer<typeof textStylePresetSchema>;

// --- Tipografía --------------------------------------------------------------

/** FR-051 (PRD:1186) — las doce familias permitidas, en orden del PRD. */
export const fontFamilySchema = z.enum([
  "tiktok",
  "snapchat",
  "montserrat",
  "poppins",
  "inter",
  "oswald",
  "playfair",
  "caveat",
  "anton",
  "bebas",
  "bangers",
  "pacifico",
]);
export type FontFamily = z.infer<typeof fontFamilySchema>;

/**
 * FR-051 (PRD:1186): "Las seis primeras aceptan pesos 300–700 en pasos de 100;
 * `playfair` y `caveat` 400–700; `anton`, `bebas`, `bangers`, `pacifico` sólo 400."
 * Se materializa como tabla para poder validarlo y para que el test lo fije.
 */
export const FONT_WEIGHTS: Readonly<Record<FontFamily, readonly number[]>> = {
  tiktok: [300, 400, 500, 600, 700],
  snapchat: [300, 400, 500, 600, 700],
  montserrat: [300, 400, 500, 600, 700],
  poppins: [300, 400, 500, 600, 700],
  inter: [300, 400, 500, 600, 700],
  oswald: [300, 400, 500, 600, 700],
  playfair: [400, 500, 600, 700],
  caveat: [400, 500, 600, 700],
  anton: [400],
  bebas: [400],
  bangers: [400],
  pacifico: [400],
};

/** FR-051 (PRD:1185) — `background.style`; `null` elimina el fondo. */
export const textBackgroundStyleSchema = z.enum(["pill", "full-width"]);
export type TextBackgroundStyle = z.infer<typeof textBackgroundStyleSchema>;

/** FR-070 (PRD:1453) — `textAlign` del payload de build. */
export const textAlignSchema = z.enum(["left", "center", "right"]);
export type TextAlign = z.infer<typeof textAlignSchema>;

/** FR-051 (PRD:1185) — colores en `#RRGGBB`. */
export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #RRGGBB");
export type HexColor = z.infer<typeof hexColorSchema>;
