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

import { createdAtOnly, timestamps } from "./_shared";
import { companyRef } from "./identity";
import { influencers } from "./influencers";
import { trendingItems } from "./discovery";
import {
  genderFilterEnum,
  suggestionContentTypeEnum,
  suggestionStatusEnum,
} from "./enums";
import { BLITZ_PREFERENCES_LIMITS, CONTENT_ANGLE_LIMITS } from "../limits";

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
