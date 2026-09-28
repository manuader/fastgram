/**
 * Biblioteca **global** de assets — sprint 9 (agente N), migración `0036`,
 * `PU-S9-005`, PRD §2.7 `D-19`.
 *
 * Catálogo de la instalación, como `audio_tracks` (`DATA-012`): **sin
 * `companyId` y sin RLS por compañía**. La usan todas las marcas del dueño y
 * el día que haya multiusuario es la librería común. Queda en
 * `NON_TENANT_TABLES` con su razón. `imported_by_company_id` es auditoría
 * (quién la trajo), no scope: ninguna consulta filtra por esa columna.
 *
 * Los objetos viven bajo `library/` (`LIBRARY_KEY_PREFIX` de
 * `@fastgram/contracts`), el prefijo que el render autoriza como
 * `sharedPrefixes` cuando una pieza usa un asset global
 * (`apps/worker/src/library/authorization.ts`).
 *
 * La licencia está dos veces a propósito: entera en `license` (jsonb, lo que
 * sale por la API) y en columnas indexables (`license_type`,
 * `license_source_url`) para filtrar y deduplicar. `metadata` es el JSON
 * versionado (`libraryAssetMetadataSchema`), validado por quien escribe; es
 * `null` mientras el import procesa.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { softDelete, timestamps } from "./_shared.js";
import { companies } from "./identity.js";

export const LIBRARY_ASSET_ROW_STATUSES = [
  "processing",
  "ready",
  "failed",
  "hidden",
] as const;
export type LibraryAssetRowStatus = (typeof LIBRARY_ASSET_ROW_STATUSES)[number];

export const libraryAssets = pgTable(
  "library_assets",
  {
    id: uuid().primaryKey().defaultRandom(),
    title: text().notNull(),
    /** `LIBRARY_ASSET_KINDS` de contracts (texto: el enum es del contrato). */
    kind: text().notNull(),
    mediaType: text().notNull(),
    status: text().$type<LibraryAssetRowStatus>().notNull().default("processing"),
    /** `upload` o la fuente (`wikimedia`, `pexels`, `pixabay`). */
    provider: text().notNull(),
    /** El id del archivo en la fuente (título de Commons, id de Pexels…). */
    externalId: text(),
    /** Clave del objeto final (`library/{id}/…`); `null` mientras procesa. */
    storageKey: text(),
    url: text(),
    previewKey: text(),
    previewUrl: text(),
    contentType: text(),
    sizeMb: real(),
    durationSec: real(),
    width: integer(),
    height: integer(),
    license: jsonb().notNull(),
    licenseType: text().notNull(),
    /** La página del archivo en la fuente. Dedupe: una fila viva por URL. */
    licenseSourceUrl: text(),
    metadata: jsonb(),
    metadataSource: text().notNull().default("auto"),
    /** Texto plano para la búsqueda (título + descripción + tags…). */
    searchText: text().notNull().default(""),
    visibility: text().notNull().default("global"),
    importedByCompanyId: uuid().references(() => companies.id, { onDelete: "set null" }),
    failureCode: text(),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    index("library_assets_status_created_idx").on(t.status, t.createdAt),
    index("library_assets_kind_idx").on(t.kind),
    index("library_assets_license_type_idx").on(t.licenseType),
    uniqueIndex("library_assets_source_url_uq")
      .on(t.licenseSourceUrl)
      .where(sql`${t.licenseSourceUrl} is not null and ${t.deletedAt} is null`),
    check(
      "library_assets_status_check",
      sql`${t.status} in ('processing', 'ready', 'failed', 'hidden')`,
    ),
    check(
      "library_assets_media_type_check",
      sql`${t.mediaType} in ('video', 'image', 'audio')`,
    ),
    check(
      "library_assets_license_type_check",
      sql`${t.licenseType} in ('cc0', 'cc-by', 'pexels', 'pixabay', 'own', 'generated')`,
    ),
    check(
      "library_assets_metadata_source_check",
      sql`${t.metadataSource} in ('auto', 'edited')`,
    ),
    check(
      "library_assets_ready_has_object_check",
      sql`${t.status} not in ('ready', 'hidden') or (${t.storageKey} is not null and ${t.metadata} is not null)`,
    ),
  ],
);
