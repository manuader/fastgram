/**
 * Blitz — `DATA-005` ContentAngle, `DATA-006` BlitzPreferences, `DATA-007` Suggestion.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { createdAtOnly, timestamps } from "./_shared.js";
import { companyRef } from "./identity.js";
import { influencers } from "./influencers.js";
import { trendingItems } from "./discovery.js";
import { media } from "./media.js";
import {
  genderFilterEnum,
  suggestionContentTypeEnum,
  suggestionStatusEnum,
} from "./enums.js";
import { BLITZ_PREFERENCES_LIMITS, CONTENT_ANGLE_LIMITS } from "../limits.js";

/**
 * DATA-005 — `ContentAngle`.
 *
 * `influencerIds` es un array y no una tabla puente porque el PRD lo modela así
 * (*"N:M vía `influencerIds`"* en el diagrama de relaciones). El cap de 10 ángulos por
 * influencer es del lado del influencer, no del ángulo: se valida en el repositorio.
 */
export const contentAngles = pgTable(
  "content_angles",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    title: varchar({ length: CONTENT_ANGLE_LIMITS.titleMaxChars }).notNull(),
    description: varchar({ length: CONTENT_ANGLE_LIMITS.descriptionMaxChars }),
    targetAudience: varchar({ length: CONTENT_ANGLE_LIMITS.targetAudienceMaxChars }),
    isActive: boolean().notNull().default(true),
    influencerIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    ...timestamps(),
  },
  (t) => [index("content_angles_company_created_idx").on(t.companyId, t.createdAt)],
);

/**
 * DATA-006 — `BlitzPreferences`. 1:1 con company, por eso `companyId` es la PK.
 * *"Sintetiza defaults si no existe fila"* — por eso no hay defaults de negocio acá:
 * inventarlos duplicaría la fuente de verdad, que es el sintetizador en `core`.
 */
export const blitzPreferences = pgTable(
  "blitz_preferences",
  {
    companyId: companyRef().primaryKey(),
    slideshowWeight: integer().notNull(),
    wallOfTextWeight: integer().notNull(),
    greenScreenWeight: integer().notNull(),
    videoHookWeight: integer().notNull(),
    remixPercentage: integer().notNull(),
    ownMediaPercentage: integer().notNull(),
    mentionBusinessPercentage: integer().notNull(),
    influencerChance: integer().notNull(),
    smartTextPositioning: boolean().notNull().default(false),
    /** `man` | `woman` | `null` — el `null` es "sin filtro". */
    genderFilter: genderFilterEnum(),
    /** map ángulo → peso. */
    angleWeights: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** map preset de estilo de texto → peso. */
    textStyleWeights: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps(),
  },
  (t) => [
    /** DATA-006: los cuatro pesos de formato *"suma 100"*. */
    check(
      "blitz_preferences_format_weights_sum",
      sql`${t.slideshowWeight} + ${t.wallOfTextWeight} + ${t.greenScreenWeight} + ${t.videoHookWeight} = ${sql.raw(String(BLITZ_PREFERENCES_LIMITS.formatWeightsSum))}`,
    ),
    /**
     * 0–100 en los campos que el PRD nombra como porcentaje o chance. No es un límite
     * inventado: es la definición de porcentaje.
     */
    check(
      "blitz_preferences_percentage_ranges",
      sql`${t.remixPercentage} between 0 and 100
          and ${t.ownMediaPercentage} between 0 and 100
          and ${t.mentionBusinessPercentage} between 0 and 100
          and ${t.influencerChance} between 0 and 100`,
    ),
    check(
      "blitz_preferences_format_weights_non_negative",
      sql`${t.slideshowWeight} >= 0 and ${t.wallOfTextWeight} >= 0
          and ${t.greenScreenWeight} >= 0 and ${t.videoHookWeight} >= 0`,
    ),
  ],
);

/** Estados de un pedido de «crear desde prompt» (`PU-BLITZ-003`). */
export const BLITZ_PROMPT_STATUS = ["queued", "running", "done", "failed"] as const;
/** `0026`: las fases de un pedido `running` (`PROMPT_PHASES` de `core`). */
export const BLITZ_PROMPT_PHASES = ["searching_meme"] as const;

/**
 * NO ESTÁ EN EL PRD como entidad: un pedido de «crear desde prompt» —
 * `EXT-009`, `PU-BLITZ-003`, migración `0012`.
 *
 * Existe para que la web pueda preguntar **en qué quedó** su pedido: el job
 * corre en el worker y puede fallar por algo que el usuario tiene que ver
 * (sin LLM, sin media para el formato que forzó). Las sugerencias que produjo
 * no se listan acá: son las filas de `suggestions` con `prompt_request_id`
 * apuntando a ésta, una sola fuente de verdad.
 *
 * `failureReason` es un **código estable** (`PROMPT_FAILURE_REASONS` de
 * `core`), nunca un error crudo de proveedor.
 */
export const blitzPromptRequests = pgTable(
  "blitz_prompt_requests",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    /** El tema, tal cual lo escribió el usuario. Dato, nunca instrucción. */
    prompt: text().notNull(),
    /** El formato forzado, o `null` = lo decide el content mix. */
    // Sprint 9 (U): el enum de Postgres admite `reel`, pero un pedido de «crear
    // desde prompt» nunca lo fuerza (`blitzContentTypeSchema` son cuatro):
    // el tipo TS queda en los cuatro para no ensanchar el prompt-handler.
    contentType: suggestionContentTypeEnum().$type<
      "slideshow" | "wall-of-text" | "green-screen" | "video-hook"
    >(),
    count: integer().notNull(),
    status: text({ enum: BLITZ_PROMPT_STATUS }).notNull().default("queued"),
    failureReason: text(),
    /**
     * `0022`: la referencia de un «Remix this» (Inspiration). Al cerrar el
     * pedido, sus sugerencias heredan `sourceTrendingItemId` y
     * `remixSourceUrl` (F-056).
     */
    sourceTrendingItemId: uuid().references(() => trendingItems.id, {
      onDelete: "set null",
    }),
    /**
     * `0026` (sprint 7): en qué anda un pedido `running`. `searching_meme` =
     * buscando e importando un meme porque el Media Bank no tenía uno para el
     * tema. `null` = el camino de siempre.
     */
    phase: text({ enum: BLITZ_PROMPT_PHASES }),
    /** `0026`: búsquedas automáticas hechas, entre reintentos. Tope 2 (CHECK). */
    memeSearches: integer().notNull().default(0),
    /** `0026`: el clip que la búsqueda ya importó; un reintento lo retoma. */
    autoMediaId: uuid().references(() => media.mediaId, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    index("blitz_prompt_requests_company_created_idx").on(t.companyId, t.createdAt),
    check(
      "blitz_prompt_requests_phase",
      sql`${t.phase} is null or ${t.phase} in ('searching_meme')`,
    ),
    check(
      "blitz_prompt_requests_meme_searches_range",
      sql`${t.memeSearches} between 0 and 2`,
    ),
    check(
      "blitz_prompt_requests_prompt_length",
      sql`char_length(${t.prompt}) between 3 and 500`,
    ),
    check("blitz_prompt_requests_count_range", sql`${t.count} between 1 and 5`),
    check(
      "blitz_prompt_requests_status",
      sql`${t.status} in ('queued', 'running', 'done', 'failed')`,
    ),
  ],
);

/**
 * DATA-007 — `Suggestion` (cola de discovery).
 * Objetivo ~5 en cola; el PRD admite que refills concurrentes la excedan
 * transitoriamente, así que **no** hay constraint sobre el tamaño de la cola.
 */
export const suggestions = pgTable(
  "suggestions",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    contentType: suggestionContentTypeEnum().notNull(),
    generatedText: text(),
    /** El racional almacenado que muestra `Why This Content?`. Nunca se regenera. */
    aiExplanation: text(),
    remixSourceUrl: text(),
    sourceTrendingItemId: uuid().references(() => trendingItems.id, {
      onDelete: "set null",
    }),
    influencerId: uuid().references(() => influencers.id, { onDelete: "set null" }),
    angleId: uuid().references(() => contentAngles.id, { onDelete: "set null" }),
    /** El PRD no define una entidad `TextStylePreset`; se guarda el id sin FK. */
    textStylePresetId: text(),
    /**
     * NO ESTÁ EN `DATA-007`: con qué se construye la pieza — la media elegida
     * del Media Bank y los textos (`SuggestionBuildPlan` de `core`). Sin esto,
     * `POST /blitz` creaba la pieza sin `buildPayload` y el build fallaba
     * después de cobrar. `NULL` = sugerencia vieja, que no se construye.
     * Migración `0011`.
     */
    buildPlan: jsonb(),
    /**
     * NO ESTÁ EN `DATA-007`: el pedido de «crear desde prompt» que la produjo
     * (`PU-BLITZ-003`, migración `0012`), o `null` si salió del refill. Las que
     * lo tienen van **primeras** en la cola (`QUEUE_ORDER`).
     */
    promptRequestId: uuid().references(() => blitzPromptRequests.id, {
      onDelete: "set null",
    }),
    status: suggestionStatusEnum().notNull().default("queued"),
    ...createdAtOnly(),
  },
  (t) => [
    index("suggestions_company_created_idx").on(t.companyId, t.createdAt),
    /** La cola se lee por `status = 'queued'`; el índice parcial es el camino caliente. */
    index("suggestions_company_queued_idx")
      .on(t.companyId, t.createdAt)
      .where(sql`${t.status} = 'queued'`),
  ],
);
