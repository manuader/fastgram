/**
 * Media Bank — `DATA-010` Media, `DATA-011` MediaSet, `DATA-012` AudioTrack.
 */

import { sql } from "drizzle-orm";
import { index, integer, pgTable, real, text, uuid } from "drizzle-orm/pg-core";

import { createdAtOnly, softDelete, tsColumn, timestamps } from "./_shared";
import { companyRef } from "./identity";
import { influencers } from "./influencers";
import {
  audioLibraryEnum,
  mediaOriginEnum,
  mediaSetKindEnum,
  mediaStatusEnum,
  mediaTypeEnum,
} from "./enums";

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
    ...softDelete(),
    ...timestamps(),
  },
  (t) => [
    index("media_company_created_idx").on(t.companyId, t.createdAt),
    index("media_company_live_created_idx")
      .on(t.companyId, t.createdAt)
      .where(sql`${t.deletedAt} is null`),
    index("media_company_uploaded_idx").on(t.companyId, t.uploadedAt),
  ],
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
