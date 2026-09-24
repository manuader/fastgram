/**
 * Brand Sources y Company Profile — **EXTENSION · EXT-001** (§9.14, PRD:2358-2374).
 *
 * No existe en Fastlane: es una extensión del clon. Los endpoints están
 * enumerados en el PRD como "propuestos" con la misma convención de envelope,
 * cursor e idempotencia que el resto:
 *
 *   POST   /brand/sources/resolve      barato, no crea nada
 *   POST   /brand/sources              202 + `brandSourceId`, exige Idempotency-Key
 *   GET    /brand/sources[/:id]        listado y polling de estado
 *   POST   /brand/sources/:id/reanalyse
 *   POST   /brand/sources/:id/assist   tier D: bio y captions pegados (añadida)
 *   PATCH  /brand/sources/:id          sólo `isPrimary`
 *   DELETE /brand/sources/:id
 *   GET|PATCH /brand/profile
 *
 * Fuente: DATA-031 (PRD:2183), DATA-032 (PRD:2200), DATA-004 (PRD:2046),
 * AI-016 (PRD:2559).
 */
import { z } from "zod";
import { brandSourceIdSchema, msEpochSchema } from "../primitives/ids.js";

// --- Números del PRD ---------------------------------------------------------

/** §9.14 (PRD:2377) / AI-016 (PRD:2574) — máx. 5 fuentes por workspace. */
export const MAX_BRAND_SOURCES_PER_WORKSPACE = 5;
/** §9.14 (PRD:2378) — re-análisis por fuente y día; configurable por plan, default 3. */
export const BRAND_SOURCE_REANALYSES_PER_DAY_DEFAULT = 3;
/** §9.14 (PRD:2380) / AI-016 (PRD:2574) — ítems analizados por fuente. */
export const BRAND_SOURCE_ITEMS_PER_ANALYSIS_DEFAULT = 24;
/** DATA-031 (PRD:2193) — una fuente pasa a `stale` a los 90 días. */
export const BRAND_SOURCE_STALE_AFTER_DAYS = 90;
/** §9.14 (PRD:2384) — seguimiento de link-in-bio: 1 nivel, 5 destinos. */
export const BRAND_SOURCE_LINK_FOLLOW_DEPTH = 1;
export const BRAND_SOURCE_LINK_FOLLOW_MAX_TARGETS = 5;
/** AI-001 (PRD:2545) — descripción libre de la marca ≤ 4 000 caracteres por respuesta. */
export const BRAND_FREE_TEXT_ANSWER_MAX = 4000;

// --- Enums · DATA-031 --------------------------------------------------------

export const brandSourceTypeSchema = z.enum([
  "website",
  "instagram",
  "tiktok",
  "x",
  "youtube",
  "linkedin",
  "other_url",
  "manual",
]);
export type BrandSourceType = z.infer<typeof brandSourceTypeSchema>;

/** FR-011.4 — orden de adquisición B → C → A → D (PRD:2189). */
export const acquisitionTierSchema = z.enum([
  "A_oauth",
  "B_public_api",
  "C_page_fetch",
  "D_assisted",
]);
export type AcquisitionTier = z.infer<typeof acquisitionTierSchema>;

export const brandSourceStatusSchema = z.enum([
  "pending",
  "analyzing",
  "ready",
  "partial",
  "failed",
  "stale",
]);
export type BrandSourceStatus = z.infer<typeof brandSourceStatusSchema>;

export const brandSourceFailureReasonSchema = z.enum([
  "not_found",
  "private",
  "insufficient_content",
  "rate_limited",
  "provider_unavailable",
  "unsupported_platform",
  "already_registered",
]);
export type BrandSourceFailureReason = z.infer<typeof brandSourceFailureReasonSchema>;

// --- Recurso -----------------------------------------------------------------

export const brandSourceSchema = z
  .object({
    _id: brandSourceIdSchema,
    sourceType: brandSourceTypeSchema,
    handle: z.string().nullable(),
    canonicalUrl: z.string().url().nullable(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().url().nullable(),
    isPrimary: z.boolean(),
    acquisitionTier: acquisitionTierSchema,
    status: brandSourceStatusSchema,
    failureReason: brandSourceFailureReasonSchema.nullable().optional(),
    lastAnalysedAt: msEpochSchema.nullable(),
    analysisCount: z.number().int().nonnegative(),
    createdAt: msEpochSchema,
    updatedAt: msEpochSchema,
  })
  .strict();
export type BrandSource = z.infer<typeof brandSourceSchema>;

/**
 * La única pista de tipo que acepta `/resolve`: el chip `Website`.
 *
 * `FR-011.2` dice que los chips *"prefijan el input y fijan el `sourceType`"*.
 * Para los cinco sociales el prefijo ya lo dice todo —`instagram.com/…` se
 * detecta por el host—, así que una pista no aportaría nada. `Website` es el
 * único chip sin prefijo posible, y la aclaración de `FR-011.1` (2026-09-21)
 * dice que ese chip *"pasa un **hint** que fuerza `website`"* porque, sin él,
 * un host desconocido se detecta `other_url` y la precedencia de fusión de
 * `FR-011.6` los trata distinto.
 *
 * Semántica, que es la de `detectBrandSource` en `core`: **sólo decide
 * `website` frente a `other_url`** para un host que no es de ninguna red
 * social. Nunca convierte una URL de Instagram (ni de ninguna de las cinco) en
 * `website`, y un `@handle` suelto sigue siendo ambiguo (`ERR-B03`).
 */
export const brandSourceResolveHintSchema = z.enum(["website"]);
export type BrandSourceResolveHint = z.infer<typeof brandSourceResolveHintSchema>;

/**
 * `POST /brand/sources/resolve` — "Dado un texto libre, devuelve
 * `{sourceType, handle, canonicalUrl, displayName, avatarUrl, available}` sin
 * crear nada" (PRD:2368).
 *
 * `hint` es **añadido sobre la forma literal** de PRD:2368, y es opcional: sin
 * él la respuesta es exactamente la de antes. Ver
 * {@link brandSourceResolveHintSchema}.
 */
export const resolveBrandSourceRequestSchema = z
  .object({
    input: z.string().min(1),
    hint: brandSourceResolveHintSchema.optional(),
  })
  .strict();
export type ResolveBrandSourceRequest = z.infer<typeof resolveBrandSourceRequestSchema>;

export const resolveBrandSourceResponseSchema = z
  .object({
    sourceType: brandSourceTypeSchema,
    handle: z.string().nullable(),
    canonicalUrl: z.string().url().nullable(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().url().nullable(),
    available: z.boolean(),
    /**
     * **Campo añadido sobre la forma literal del PRD**, y la razón es que sin él
     * `ERR-B12` no se puede implementar.
     *
     * `FR-011.1` dice que un enlace a un post se resuelve al perfil de su autor
     * y que **hay que avisarlo**: *"We'll analyse the whole @{handle} profile,
     * not just that post."* El aviso es de la resolución, no del alta — ocurre
     * mientras el usuario escribe—, así que el único sitio donde cabe es esta
     * respuesta. La lista de campos de PRD:2368 no lo trae, pero tampoco trae
     * ningún otro canal para el aviso, y `ERR-B12` está en §19.5.1 como copy.
     *
     * Es **opcional** a propósito: un cliente que no lo mire sigue leyendo
     * exactamente la forma del PRD.
     */
    resolvedFromPost: z.boolean().optional(),
  })
  .strict();
export type ResolveBrandSourceResponse = z.infer<typeof resolveBrandSourceResponseSchema>;

/** `POST /brand/sources` — crea y encola el análisis; exige `Idempotency-Key`. */
export const createBrandSourceRequestSchema = z
  .object({
    sourceType: brandSourceTypeSchema,
    handle: z.string().min(1).optional(),
    canonicalUrl: z.string().url().optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.handle !== undefined || b.canonicalUrl !== undefined, {
    message: "handle or canonicalUrl is required",
  });
export type CreateBrandSourceRequest = z.infer<typeof createBrandSourceRequestSchema>;

/**
 * `POST /brand/sources/:id/assist` — **tier D asistido** (`P1-BRAND-014`,
 * `FR-011.4` fila D, `FR-011.9`). **Ruta añadida sobre §9.14.**
 *
 * Cuando una fuente social no se pudo leer (sin extractor, privada, límite de
 * la plataforma), el usuario pega su bio y unos captions recientes y la misma
 * síntesis corre sobre eso. Es una ruta sobre la fuente que ya existe, y no un
 * `POST /brand/sources` con `sourceType: manual`, por dos razones: la fuente
 * conserva su plataforma —la precedencia de `FR-011.6` (y el tono invertido)
 * la necesita—, y un `manual` con `handle` vacío chocaría contra la unicidad
 * global de `(sourceType, handle)`.
 *
 * `202` con la fuente en `analyzing` y `acquisitionTier` final `D_assisted`.
 * **No** consume el cupo de re-análisis (`ERR-B11`): no se lee la plataforma.
 * Todo lo pegado es dato, nunca instrucción (§9.14): pasa por la misma
 * contención que una bio leída.
 *
 * Techos: los de la descripción libre de `AI-001` por texto
 * ({@link BRAND_FREE_TEXT_ANSWER_MAX}) y los ítems de un análisis
 * ({@link BRAND_SOURCE_ITEMS_PER_ANALYSIS_DEFAULT}). El PRD no fija otros.
 */
export const assistBrandSourceRequestSchema = z
  .object({
    bio: z.string().max(BRAND_FREE_TEXT_ANSWER_MAX).optional(),
    captions: z
      .array(z.string().max(BRAND_FREE_TEXT_ANSWER_MAX))
      .max(BRAND_SOURCE_ITEMS_PER_ANALYSIS_DEFAULT)
      .optional(),
  })
  .strict()
  .refine(
    (b) => (b.bio ?? "").trim() !== "" || (b.captions ?? []).some((c) => c.trim() !== ""),
    { message: "paste a bio or at least one caption" },
  );
export type AssistBrandSourceRequest = z.infer<typeof assistBrandSourceRequestSchema>;

/** `PATCH /brand/sources/:id` — "Sólo `isPrimary`" (PRD:2372). */
export const updateBrandSourceRequestSchema = z
  .object({ isPrimary: z.boolean() })
  .strict();
export type UpdateBrandSourceRequest = z.infer<typeof updateBrandSourceRequestSchema>;

// --- Company Profile · DATA-004 ---------------------------------------------

/** DATA-004 (PRD:2059) — `fieldMeta` por campo del perfil. */
export const fieldConfidenceSchema = z.enum(["high", "medium", "low"]);
export type FieldConfidence = z.infer<typeof fieldConfidenceSchema>;

/**
 * `sourceId` y `excerptRef` son **nullable**, y ése es justamente el caso que
 * `PATCH /brand/profile` produce.
 *
 * La forma original los exigía, y con eso un campo **editado a mano** no tenía
 * `fieldMeta` posible: una edición manual no sale de ninguna `BrandSource` y no
 * cita ningún extracto, así que no hay `sourceId` ni `excerptRef` que escribir.
 * El efecto no era cosmético: `FR-011.6` dice que un campo con
 * `editedByUser: true` **no se pisa** en la siguiente fusión, y sin poder
 * escribir la marca para un campo que nunca tuvo fuente, la siguiente síntesis
 * borraría lo que el usuario acababa de escribir. Nullable es lo mínimo que
 * cierra eso; la alternativa —inventar un `sourceId`— haría que la fusión
 * creyera que hay evidencia donde no la hay, que es lo que `AI-016` prohíbe.
 */
export const fieldMetaSchema = z
  .object({
    confidence: fieldConfidenceSchema,
    sourceId: brandSourceIdSchema.nullable(),
    excerptRef: z.string().nullable(),
    editedByUser: z.boolean(),
    conflictsWith: z.array(brandSourceIdSchema).optional(),
    /**
     * `P1-BRANDPG-005` / `ERR-B14`: el `excerptRef` de la propuesta que el
     * usuario descartó («Keep mine»). Mientras la propuesta vigente sea ésa, no
     * se vuelve a ofrecer; un re-análisis que proponga otra cosa sí aparece.
     */
    dismissedProposal: z.string().optional(),
  })
  .strict();
export type FieldMeta = z.infer<typeof fieldMetaSchema>;

/** DATA-004 (PRD:2058) — `partial` es EXTENSION. */
export const companyProfileStatusSchema = z.enum([
  "pending",
  "ready",
  "failed",
  "partial",
]);
export type CompanyProfileStatus = z.infer<typeof companyProfileStatusSchema>;

/**
 * Los cinco campos estructurados que produce AI-001 (PRD:2548), más los del
 * cuestionario de onboarding (DATA-004, PRD:2056). El PRD no fija longitudes
 * máximas para los campos del perfil: no se inventan.
 */
export const companyProfileSchema = z
  .object({
    coreIdentity: z.string(),
    productOffering: z.string(),
    uniqueBenefits: z.string(),
    problemSolution: z.string(),
    marketAndCompetition: z.string(),
    toneOfVoice: z.string().optional(),
    targetAudience: z.string().optional(),
    businessModel: z.string().optional(),
    businessCategories: z.array(z.string()).optional(),
    monthlyRevenueBand: z.string().optional(),
    teamSize: z.string().optional(),
    ownerRole: z.string().optional(),
    expectations: z.array(z.string()).optional(),
    brandRevision: z.number().int().nonnegative(),
    status: companyProfileStatusSchema,
    fieldMeta: z.record(fieldMetaSchema),
  })
  .strict();
export type CompanyProfile = z.infer<typeof companyProfileSchema>;

/**
 * `PATCH /brand/profile` — "una edición manual marca `editedByUser: true`"
 * (PRD:2374). El cliente envía sólo los campos de texto; `fieldMeta`,
 * `brandRevision` y `status` los escribe el servidor.
 */
export const updateCompanyProfileRequestSchema = companyProfileSchema
  .omit({ brandRevision: true, status: true, fieldMeta: true })
  .partial()
  .extend({
    /**
     * `P1-BRANDPG-004` (`F-022`): la revisión que el cliente tenía cuando
     * empezó a editar. Si el perfil ya se movió (otra pestaña, un análisis),
     * `409 conflict` con `details.reason = "brand_revision_changed"` en vez de
     * pisar en silencio. Opcional: sin él, la escritura es la de siempre.
     */
    expectedBrandRevision: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).some((k) => k !== "expectedBrandRevision"), {
    message: "empty body is not allowed",
  });
export type UpdateCompanyProfileRequest = z.infer<
  typeof updateCompanyProfileRequestSchema
>;

// --- Propuestas del re-análisis · P1-BRANDPG-005 / ERR-B14 -------------------

/** Los ocho campos que `AI-016` deriva (`BRAND_PROFILE_FIELDS` de core). */
export const brandProfileFieldSchema = z.enum([
  "coreIdentity",
  "productOffering",
  "uniqueBenefits",
  "problemSolution",
  "marketAndCompetition",
  "toneOfVoice",
  "targetAudience",
  "businessCategories",
]);
export type BrandProfileField = z.infer<typeof brandProfileFieldSchema>;

/**
 * Lo que una fuente propone para un campo que la fusión **no escribió**
 * porque el usuario lo había editado (`FR-011.6`) o porque su valor no tiene
 * procedencia conocida. `ERR-B14`: *"This source suggests a different answer —
 * replace?"*. Se calcula en cada lectura desde el último snapshot de cada
 * fuente: no hay columna nueva.
 */
export const brandProfileProposalSchema = z
  .object({
    field: brandProfileFieldSchema,
    value: z.string(),
    currentValue: z.string(),
    confidence: fieldConfidenceSchema,
    sourceId: brandSourceIdSchema,
    sourceType: brandSourceTypeSchema,
    /** El extracto que respalda la propuesta, o `null` si el snapshot ya no lo tiene. */
    excerpt: z.string().nullable(),
    /** `snapshotId#field`: identifica la propuesta para aceptarla o descartarla. */
    excerptRef: z.string(),
    reason: z.enum(["edited_by_user", "unknown_provenance"]),
  })
  .strict();
export type BrandProfileProposal = z.infer<typeof brandProfileProposalSchema>;

/** `GET /brand/profile/proposals`. */
export const brandProfileProposalsSchema = z
  .object({
    brandRevision: z.number().int().nonnegative(),
    proposals: z.array(brandProfileProposalSchema),
  })
  .strict();
export type BrandProfileProposals = z.infer<typeof brandProfileProposalsSchema>;

/**
 * `POST /brand/profile/proposals/{field}` — `accept` escribe el valor propuesto
 * con su procedencia (deja de ser `editedByUser`); `dismiss` conserva el valor
 * del usuario y no vuelve a ofrecer esa propuesta. `excerptRef` tiene que ser
 * el de la propuesta vigente (si cambió, `409`), y `expectedBrandRevision` la
 * revisión que el cliente vio.
 */
export const resolveBrandProfileProposalRequestSchema = z
  .object({
    action: z.enum(["accept", "dismiss"]),
    excerptRef: z.string().min(1).max(200),
    expectedBrandRevision: z.number().int().nonnegative(),
  })
  .strict();
export type ResolveBrandProfileProposalRequest = z.infer<
  typeof resolveBrandProfileProposalRequestSchema
>;

// --- Logo · P1-ONB-003 --------------------------------------------------------

/** Techo del logo decodificado. No es del PRD: es para que viaje en `GET /workspaces`. */
export const BRAND_LOGO_MAX_BYTES = 256 * 1024;

/**
 * `PUT /brand/logo` — el logo como `data:` URL (`image/png`, `image/jpeg` o
 * `image/webp`, base64). La web lo reduce antes de subirlo. Se guarda en
 * `companies.logo_url` y sale en `GET /workspaces` para el selector de marca.
 */
export const updateBrandLogoRequestSchema = z
  .object({
    dataUrl: z
      .string()
      .max(Math.ceil((BRAND_LOGO_MAX_BYTES * 4) / 3) + 64)
      .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export type UpdateBrandLogoRequest = z.infer<typeof updateBrandLogoRequestSchema>;

export const brandLogoSchema = z.object({ logoUrl: z.string().nullable() }).strict();
export type BrandLogo = z.infer<typeof brandLogoSchema>;

// --- Tier D con capturas · P1-BRAND-014 / P1-VISION-002 ------------------------

/** Una captura por pedido: el cuerpo de la API tope en 1 MiB. */
export const BRAND_OCR_IMAGE_MAX_BYTES = 700 * 1024;
/** Cuántas capturas ofrece la pantalla (brief del sprint 7: 1–5). */
export const BRAND_OCR_MAX_IMAGES = 5;

/**
 * `POST /brand/ocr` — el texto de una captura de perfil, para que el usuario lo
 * revise y lo mande por `/assist` como texto pegado. **No persiste nada**: ni
 * la imagen ni el texto.
 */
export const brandOcrRequestSchema = z
  .object({
    contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    /** Base64 sin prefijo `data:`. */
    data: z
      .string()
      .min(4)
      .max(Math.ceil((BRAND_OCR_IMAGE_MAX_BYTES * 4) / 3) + 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export type BrandOcrRequest = z.infer<typeof brandOcrRequestSchema>;

export const brandOcrResultSchema = z
  .object({
    text: z.string(),
    /** Qué lo leyó: `services/vision` (OCR) o el modelo `vision` del registro. */
    engine: z.enum(["ocr", "vision_model"]),
  })
  .strict();
export type BrandOcrResult = z.infer<typeof brandOcrResultSchema>;
