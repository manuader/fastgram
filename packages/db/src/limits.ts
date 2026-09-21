/**
 * Los números del PRD, en un solo lugar.
 *
 * IMPL §4 (Testing): *"toda regla de negocio con un número en el PRD lleva un test que
 * fija ese número"*. Este archivo es el sujeto de `test/limits.test.ts`; el test existe
 * para que cambiar una de estas constantes sea un acto deliberado y no un efecto
 * colateral.
 *
 * **Regla:** acá sólo entran números que el PRD dice explícitamente, con la cita de
 * dónde salen. Si algo no está en el PRD, no está acá — se marca como pendiente.
 */

/** DATA-005 · PRD §1.6 · §16.2 */
export const CONTENT_ANGLE_LIMITS = {
  /** *"Cap: 100 por workspace"*. */
  maxPerWorkspace: 100,
  /** *"máx. 10 ángulos por influencer"*. */
  maxPerInfluencer: 10,
  /** `title` (≤200) */
  titleMaxChars: 200,
  /** `description` (≤2000) */
  descriptionMaxChars: 2000,
  /** `targetAudience` (≤500) */
  targetAudienceMaxChars: 500,
} as const;

/** DATA-008 · FR-070 */
export const CONTENT_LIMITS = {
  /** *"copy extraíble actual, normalizada, ≤ 2 000 caracteres"*. */
  generatedTextMaxChars: 2000,
  /** FR-070: *"Máximo 20 slides por slideshow"*. */
  maxSlidesPerSlideshow: 20,
} as const;

/** DATA-009 */
export const CONTENT_TEXT_BOX = {
  /** `text` (≤5000) */
  textMaxChars: 5000,
  /** `position{x,y}` (0–100) */
  positionMin: 0,
  positionMax: 100,
  /** `widthPercent` (25–100) */
  widthPercentMin: 25,
  widthPercentMax: 100,
  /** `font{… size 8–72}` */
  fontSizeMin: 8,
  fontSizeMax: 72,
  /** `stroke{width 0–8, color}` */
  strokeWidthMin: 0,
  strokeWidthMax: 8,
  /** `background{… opacity 0–1 …}` */
  backgroundOpacityMin: 0,
  backgroundOpacityMax: 1,
} as const;

/** DATA-013 · FR-090 */
export const INFLUENCER_LIMITS = {
  /** *"Cap: 50 activos/workspace"*. */
  maxActivePerWorkspace: 50,
  /** Slider de edad: *"rango 18–60"*. */
  ageMin: 18,
  ageMax: 60,
  /** `progress` (0–100) */
  progressMin: 0,
  progressMax: 100,
} as const;

/** DATA-006 */
export const BLITZ_PREFERENCES_LIMITS = {
  /** Los cuatro pesos de formato *"suman 100"*. */
  formatWeightsSum: 100,
  percentageMin: 0,
  percentageMax: 100,
} as const;

/** DATA-021 */
export const AUTOMATION_LIMITS = {
  /** `name` (≤100) */
  nameMaxChars: 100,
  /** `perAccountPerDay` (1–3) */
  perAccountPerDayMin: 1,
  perAccountPerDayMax: 3,
  /** `durationWeeks` (1–4) */
  durationWeeksMin: 1,
  durationWeeksMax: 4,
} as const;

/** DATA-031 · §9.14 */
export const BRAND_SOURCE_LIMITS = {
  /** *"Máx. 5 fuentes por workspace"*. */
  maxPerWorkspace: 5,
  /** *"Máx. N re-análisis por fuente y día (configurable por plan; default 3)"*. */
  defaultReanalysesPerDay: 3,
  /** *"Límite de ítems analizados por fuente: 24 por defecto"*. */
  defaultItemsAnalysedPerSource: 24,
  /** *"`stale` a los 90 días"*. */
  staleAfterDays: 90,
} as const;

/** PRD §9.10 — paginación por cursor. */
export const PAGINATION = {
  /** *"`limit` 1–100, default 20"*. */
  limitMin: 1,
  limitMax: 100,
  limitDefault: 20,
} as const;

/** NFR-012 — *"Máx. 100 ids por llamada en cancel, delete y analytics de posts"*. */
export const BATCH_LIMITS = {
  maxIdsPerCall: 100,
} as const;

/**
 * FR-060 — límites de copy por plataforma. Los cuatro números son CONFIRMED en la UI
 * (`Caption 0/2200`, `Title 0/90`, `Description 0/4000`).
 *
 * PENDIENTE: el PRD no fija el límite de caption de YouTube, LinkedIn ni Reddit.
 * No se inventa ninguno.
 */
export const PLATFORM_COPY_LIMITS = {
  instagramCaptionMaxChars: 2200,
  tiktokTitleMaxChars: 90,
  tiktokDescriptionMaxChars: 4000,
} as const;

/** PRD §9.8 — uploads. Los tipos MIME permitidos también son literales del PRD. */
export const UPLOAD_LIMITS = {
  imageMaxBytes: 10 * 1024 * 1024,
  videoMaxBytes: 50 * 1024 * 1024,
  influencerBaseImageMaxBytes: 10 * 1024 * 1024,
  imageContentTypes: ["image/jpeg", "image/png", "image/webp"],
  videoContentTypes: ["video/mp4", "video/quicktime"],
} as const;
