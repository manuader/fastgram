/**
 * Contenido — `DATA-008` Content, `DATA-009` ContentTextBox.
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { softDelete, timestamps } from "./_shared.js";
import { companyRef } from "./identity.js";
import { contentStatusEnum, contentTypeEnum } from "./enums.js";
import { CONTENT_TEXT_BOX, CONTENT_LIMITS } from "../limits.js";

/**
 * DATA-008 — `Content`.
 *
 * `buildPayload` y `studioState` están marcados en el PRD como **nunca** devueltos por
 * la API. Acá se guardan igual; el filtro es de la capa de contrato. Se deja anotado
 * para que nadie los agregue a un `select *` de respuesta.
 */
export const contents = pgTable(
  "contents",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    type: contentTypeEnum().notNull(),
    status: contentStatusEnum().notNull().default("BUILDING"),
    /** URLs. Múltiples para slideshow (una por slide), una para video. */
    files: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    thumbnailUrl: text(),
    /** *"copy extraíble actual, normalizada, ≤ 2 000 caracteres"*. */
    generatedText: varchar({ length: CONTENT_LIMITS.generatedTextMaxChars }),
    /** Permalink público de la fuente remixada. */
    remixSourceUrl: text(),
    /** Concurrencia optimista (PRD §9.4). Arranca en 1 y sube con cada edición. */
    revision: integer().notNull().default(1),
    /** NUNCA se devuelve por API. */
    buildPayload: jsonb(),
    /** NUNCA se devuelve por API. */
    studioState: jsonb(),
    /** Resultado de la última edición. */
    lastEdit: jsonb(),
    ...softDelete(),
    ...timestamps(),
  },
  (t) => [
    index("contents_company_created_idx").on(t.companyId, t.createdAt),
    /** Listados vivos: el soft-delete se excluye por defecto (P1-DATA-012). */
    index("contents_company_live_created_idx")
      .on(t.companyId, t.createdAt)
      .where(sql`${t.deletedAt} is null`),
    check("contents_revision_positive", sql`${t.revision} >= 1`),
    /**
     * FR-070: *"Máximo 20 slides por slideshow"*. `files` tiene una entrada por slide.
     * El cap se fija acá además de en el dominio porque es barato y no depende de que
     * la ruta de escritura sea la esperada.
     */
    check(
      "contents_files_max_slides",
      sql`cardinality(${t.files}) <= ${sql.raw(String(CONTENT_LIMITS.maxSlidesPerSlideshow))}`,
    ),
  ],
);

/**
 * DATA-009 — `ContentTextBox`.
 *
 * NO ESTÁ EN EL PRD: `contentId` y `companyId`.
 * El PRD describe el text box como parte del estado del Studio, sin decir de qué
 * contenido cuelga. Como tabla necesita el padre (`contentId`) y, por IMPL §2.4, el
 * `companyId` para que RLS lo cubra sin un JOIN.
 *
 * El `id` **no** es un uuid: el PRD lo describe como *"estable, p. ej.
 * `slide-0-text-0`"*. Es estable dentro de un contenido, así que la PK es compuesta.
 *
 * `position`, `font`, `stroke` y `background` se guardan como JSONB con la forma
 * anidada exacta del PRD (son objetos en el contrato), con los rangos numéricos como
 * CHECK sobre el JSON. Aplanarlos habría cambiado nombres de campo del contrato.
 */
export const contentTextBoxes = pgTable(
  "content_text_boxes",
  {
    /** Estable dentro del contenido. Ej: `slide-0-text-0`. */
    id: text().notNull(),
    contentId: uuid()
      .notNull()
      .references(() => contents.id, { onDelete: "cascade" }),
    companyId: companyRef(),
    slideIndex: integer(),
    text: varchar({ length: CONTENT_TEXT_BOX.textMaxChars }).notNull(),
    /** `{x, y}` en 0–100. */
    position: jsonb().notNull(),
    widthPercent: integer().notNull(),
    /** `{family, weight, size}` — `size` en 8–72. */
    font: jsonb().notNull(),
    /** `#RRGGBB`. */
    color: text().notNull(),
    /** `{width, color}` — `width` en 0–8. */
    stroke: jsonb().notNull(),
    /** `{color, opacity, style}` o `null`. */
    background: jsonb(),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.contentId, t.id] }),
    index("content_text_boxes_company_created_idx").on(t.companyId, t.createdAt),
    check(
      "content_text_boxes_position_range",
      sql`(${t.position}->>'x')::numeric between 0 and 100
          and (${t.position}->>'y')::numeric between 0 and 100`,
    ),
    check(
      "content_text_boxes_width_percent_range",
      sql`${t.widthPercent} between ${sql.raw(String(CONTENT_TEXT_BOX.widthPercentMin))} and ${sql.raw(String(CONTENT_TEXT_BOX.widthPercentMax))}`,
    ),
    check(
      "content_text_boxes_font_size_range",
      sql`(${t.font}->>'size')::numeric between ${sql.raw(String(CONTENT_TEXT_BOX.fontSizeMin))} and ${sql.raw(String(CONTENT_TEXT_BOX.fontSizeMax))}`,
    ),
    check(
      "content_text_boxes_stroke_width_range",
      sql`(${t.stroke}->>'width')::numeric between ${sql.raw(String(CONTENT_TEXT_BOX.strokeWidthMin))} and ${sql.raw(String(CONTENT_TEXT_BOX.strokeWidthMax))}`,
    ),
    check(
      "content_text_boxes_background_shape",
      sql`${t.background} is null
          or ((${t.background}->>'opacity')::numeric between 0 and 1
              and ${t.background}->>'style' in ('pill', 'full-width'))`,
    ),
    check("content_text_boxes_color_hex", sql`${t.color} ~ '^#[0-9A-Fa-f]{6}$'`),
  ],
);
