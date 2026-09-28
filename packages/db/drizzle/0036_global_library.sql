-- Biblioteca global de assets — sprint 9 (agente N), `PU-S9-005/006`, PRD D-19.
--
-- ## Sin company_id y sin RLS, como `audio_tracks` (DATA-012)
--
-- Es el catálogo de la instalación: lo usan todas las marcas y el día que haya
-- multiusuario es la librería común. `imported_by_company_id` es auditoría
-- (quién la trajo), no scope. Queda en `NON_TENANT_TABLES` con su razón.
--
-- ## La licencia, dos veces
--
-- Entera en `license` (jsonb, validada por `libraryLicenseSchema`) y en
-- columnas indexables: `license_type` (filtro) y `license_source_url`
-- (dedupe: una fila viva por archivo de la fuente). No hay `unknown`: el CHECK
-- lista sólo las licencias aceptadas (D-19); CC BY-SA queda fuera.
--
-- ## Búsqueda
--
-- `search_text` es texto plano que arma el código (título, descripción, tags,
-- casos de uso, personajes). El índice GIN es de expresión con el diccionario
-- `simple` (sin stemming: los tags vienen en inglés y en español).

CREATE TABLE IF NOT EXISTS "library_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "kind" text NOT NULL,
  "media_type" text NOT NULL,
  "status" text DEFAULT 'processing' NOT NULL,
  "provider" text NOT NULL,
  "external_id" text,
  "storage_key" text,
  "url" text,
  "preview_key" text,
  "preview_url" text,
  "content_type" text,
  "size_mb" real,
  "duration_sec" real,
  "width" integer,
  "height" integer,
  "license" jsonb NOT NULL,
  "license_type" text NOT NULL,
  "license_source_url" text,
  "metadata" jsonb,
  "metadata_source" text DEFAULT 'auto' NOT NULL,
  "search_text" text DEFAULT '' NOT NULL,
  "visibility" text DEFAULT 'global' NOT NULL,
  "imported_by_company_id" uuid REFERENCES "companies"("id") ON DELETE SET NULL,
  "failure_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "library_assets_status_check"
    CHECK ("status" IN ('processing', 'ready', 'failed', 'hidden')),
  CONSTRAINT "library_assets_media_type_check"
    CHECK ("media_type" IN ('video', 'image', 'audio')),
  CONSTRAINT "library_assets_license_type_check"
    CHECK ("license_type" IN ('cc0', 'cc-by', 'pexels', 'pixabay', 'own', 'generated')),
  CONSTRAINT "library_assets_metadata_source_check"
    CHECK ("metadata_source" IN ('auto', 'edited')),
  -- Lo que se puede elegir tiene objeto y JSON: el decisor no ve filas a medias.
  CONSTRAINT "library_assets_ready_has_object_check"
    CHECK ("status" NOT IN ('ready', 'hidden')
           OR ("storage_key" IS NOT NULL AND "metadata" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_assets_status_created_idx"
  ON "library_assets" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_assets_kind_idx"
  ON "library_assets" USING btree ("kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_assets_license_type_idx"
  ON "library_assets" USING btree ("license_type");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_assets_source_url_uq"
  ON "library_assets" USING btree ("license_source_url")
  WHERE "license_source_url" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_assets_search_idx"
  ON "library_assets" USING gin (to_tsvector('simple', "search_text"));
--> statement-breakpoint
-- Trampa 17: los GRANT explícitos aunque el DEFAULT PRIVILEGES de `0002` los cubra.
GRANT SELECT, INSERT, UPDATE, DELETE ON "library_assets" TO "fastgram_app";
