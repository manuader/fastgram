/**
 * Media Bank — `DATA-010` Media, `DATA-011` MediaSet, `DATA-012` AudioTrack.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAtOnly, softDelete, tsColumn, timestamps } from "./_shared.js";
import { companyRef } from "./identity.js";
import { influencers } from "./influencers.js";
import {
  audioLibraryEnum,
  mediaOriginEnum,
  mediaSetKindEnum,
  mediaStatusEnum,
  mediaTypeEnum,
} from "./enums.js";

/**
 * DATA-010 — `Media`.
 *
 * La PK se llama `mediaId` y no `id` porque así la nombra el PRD y así sale por la API
 * (`GET /media/:id` devuelve `mediaId`). `uploadedAt` es la fecha de negocio del
 * contrato; `createdAt` es la de la fila y es la que usa el cursor.
 */
export const media = pgTable(
  "media",
  {
    mediaId: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    mediaType: mediaTypeEnum().notNull(),
    filename: text().notNull(),
    r2Url: text().notNull(),
    storageKey: text().notNull(),
    status: mediaStatusEnum().notNull().default("processing"),
    sizeMb: real().notNull(),
    videoDurationSec: integer(),
    categories: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    origin: mediaOriginEnum().notNull(),
    uploadedAt: tsColumn().notNull().defaultNow(),
    /** `0029`: etiquetas buscables (del usuario o automáticas del clip). En minúsculas. */
    tags: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** `0029`: origen de un asset importado; único por marca (dedupe del import). */
    sourceRef: text(),
    /** `0029`: qué hizo la normalización. Ver {@link MEDIA_NORMALIZATION_OUTCOMES}. */
    normalization: text().$type<MediaNormalizationOutcome>(),
    ...softDelete(),
    ...timestamps(),
  },
  (t) => [
    index("media_company_created_idx").on(t.companyId, t.createdAt),
    index("media_company_live_created_idx")
      .on(t.companyId, t.createdAt)
      .where(sql`${t.deletedAt} is null`),
    index("media_company_uploaded_idx").on(t.companyId, t.uploadedAt),
    uniqueIndex("media_company_source_ref_uq")
      .on(t.companyId, t.sourceRef)
      .where(sql`${t.sourceRef} is not null`),
    index("media_tags_gin_idx").using("gin", t.tags),
  ],
);

/**
 * `0029` — lo que la normalización hizo con un video. `hdr_kept_original`: el
 * video es HDR y el FFmpeg del servicio no tiene `zscale`; se conserva el
 * original (sin tone mapping) en vez de fallarlo.
 */
export const MEDIA_NORMALIZATION_OUTCOMES = [
  "normalized",
  "already_normalized",
  "hdr_kept_original",
] as const;
export type MediaNormalizationOutcome = (typeof MEDIA_NORMALIZATION_OUTCOMES)[number];

/**
 * `0029` — importación de posts propios al Media Bank (`FR-011.5.1`,
 * `P1-ONB-008`). Una fila por pedido; la cola `own-post-import` la avanza.
 */
export const OWN_POST_IMPORT_STATES = ["queued", "running", "done", "failed"] as const;
export type OwnPostImportState = (typeof OWN_POST_IMPORT_STATES)[number];

export const ownPostImports = pgTable(
  "own_post_imports",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    source: text().$type<"connection" | "profile">().notNull(),
    connectionId: uuid(),
    profileUrl: text(),
    platform: text().notNull(),
    maxItems: integer().notNull(),
    state: text().$type<OwnPostImportState>().notNull().default("queued"),
    found: integer().notNull().default(0),
    imported: integer().notNull().default(0),
    skipped: integer().notNull().default(0),
    failed: integer().notNull().default(0),
    errorCode: text(),
    ...timestamps(),
  },
  (t) => [index("own_post_imports_company_created_idx").on(t.companyId, t.createdAt)],
);

/** DATA-011 — `MediaSet`. */
export const mediaSets = pgTable(
  "media_sets",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    name: text().notNull(),
    kind: mediaSetKindEnum().notNull(),
    influencerId: uuid().references(() => influencers.id, { onDelete: "set null" }),
    mediaIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    ...createdAtOnly(),
  },
  (t) => [index("media_sets_company_created_idx").on(t.companyId, t.createdAt)],
);

/**
 * DATA-012 — `AudioTrack`.
 *
 * **Global, no workspace-scoped**: el PRD es explícito (*"Global, no por workspace"*).
 * Sin `companyId` y, por lo tanto, **sin política RLS por compañía**: es catálogo
 * compartido de sólo lectura. Ver `drizzle/0002_tenancy_rls.sql`.
 */
export const audioTracks = pgTable(
  "audio_tracks",
  {
    audioId: uuid().primaryKey().defaultRandom(),
    url: text().notNull(),
    description: text().notNull(),
    sizeMb: real().notNull(),
    durationSec: integer(),
    library: audioLibraryEnum().notNull(),
    ...timestamps(),
  },
  (t) => [index("audio_tracks_library_created_idx").on(t.library, t.createdAt)],
);

/**
 * La biblioteca de audio **de una marca** (sprint 7, migración `0025`).
 *
 * No es `audio_tracks`: ése es el catálogo global del PRD (DATA-012) y sigue
 * sin `companyId`. Por qué tabla aparte y no una columna nullable allá está en
 * `drizzle/0025_brand_audio.sql`. Esta sí es de tenant: `TENANT_TABLES`, RLS
 * estándar y cruce → 404.
 *
 * El objeto vive bajo `audio/{companyId}/` (`brandAudioKeyPrefix` de
 * `@fastgram/contracts`): es el prefijo que el build autoriza como librería
 * para el rol `audio` del render.
 */
/** `extracted` (`0031`): el audio de un video del Media Bank (cola `audio-extract`). */
export const BRAND_AUDIO_ORIGINS = ["upload", "import", "extracted"] as const;
export type BrandAudioOrigin = (typeof BRAND_AUDIO_ORIGINS)[number];

export const brandAudioTracks = pgTable(
  "brand_audio_tracks",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    title: text().notNull(),
    origin: text().$type<BrandAudioOrigin>().notNull(),
    storageKey: text().notNull(),
    url: text().notNull(),
    contentType: text().notNull(),
    sizeMb: real().notNull(),
    durationSec: real(),
    /** El link de origen de un import (`PU-MEME-001`). */
    sourceUrl: text(),
    /** Idempotencia del import: `UNIQUE (company_id, import_id)`. */
    importId: uuid(),
    /** Si Blitz/refill la puede elegir sola. `false` = peso 0 en el sorteo. */
    autoUse: boolean().notNull().default(true),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    index("brand_audio_tracks_company_created_idx").on(t.companyId, t.createdAt),
    uniqueIndex("brand_audio_tracks_company_import_uq")
      .on(t.companyId, t.importId)
      .where(sql`${t.importId} is not null`),
  ],
);
