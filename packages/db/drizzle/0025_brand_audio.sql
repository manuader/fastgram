-- 0025_brand_audio — la biblioteca de audio de cada marca (sprint 7, agente B).
-- PRD `FR-053` (Select Audio), `FR-070` (el audio sale de "la librería"),
-- `DATA-012` (AudioTrack), D-06…D-17 (uso personal, una marca = un workspace).
--
-- ## Por qué una tabla nueva y no `audio_tracks` con `company_id` nullable
--
-- `audio_tracks` es el catálogo **global** del PRD (DATA-012: *"Global, no por
-- workspace"*), está en `NON_TENANT_TABLES`, su repositorio es el único sin
-- `TenantScope` y `GET /audio?for=` lo lee sin marca. Mezclar filas de marca
-- ahí obliga a una política "global o propia" (como `trending_items`, 0022) y a
-- que cada lectura distinga las dos clases; y el catálogo tiene `library`
-- (wall-of-text / video-hook) obligatorio, que para audio propio no significa
-- nada. Una tabla de marca con la política estándar es el camino sin
-- excepciones: `TENANT_TABLES`, `createCompanyScopedRepository`, cruce → 404.
--
-- ## Columnas que no se deducen
--
-- - `origin`: `upload` (subida presignada) o `import` (link, `PU-MEME-001`).
--   "Extraer audio de un video del Media Bank" no está: necesita una cola nueva
--   en `core/jobs` (fuera del alcance de esta tanda). El CHECK se amplía el día
--   que exista.
-- - `import_id`: el `importId` del import por link. `UNIQUE (company_id,
--   import_id)` hace idempotente el reintento del worker: la segunda vuelta
--   encuentra la fila en vez de duplicarla.
-- - `auto_use`: si Blitz/refill puede elegir esta pista sola. Es el "peso" del
--   sorteo: `false` = peso 0. Todas en `false` = las piezas nuevas salen sin
--   música.
-- - `deleted_at`: soft delete. El objeto **no** se borra del bucket: una pieza
--   que ya la usa se tiene que poder volver a renderizar.

CREATE TABLE "brand_audio_tracks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "title" text NOT NULL,
  "origin" text NOT NULL,
  "storage_key" text NOT NULL,
  "url" text NOT NULL,
  "content_type" text NOT NULL,
  "size_mb" real NOT NULL,
  "duration_sec" real,
  "source_url" text,
  "import_id" uuid,
  "auto_use" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "brand_audio_tracks_origin_check"
    CHECK ("origin" IN ('upload', 'import')),
  CONSTRAINT "brand_audio_tracks_title_check"
    CHECK (char_length("title") BETWEEN 1 AND 200),
  CONSTRAINT "brand_audio_tracks_size_check" CHECK ("size_mb" >= 0)
);
--> statement-breakpoint
CREATE INDEX "brand_audio_tracks_company_created_idx"
  ON "brand_audio_tracks" ("company_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "brand_audio_tracks_company_import_uq"
  ON "brand_audio_tracks" ("company_id", "import_id")
  WHERE "import_id" IS NOT NULL;
--> statement-breakpoint
-- Trampa 17: GRANT explícito aunque el DEFAULT PRIVILEGES de 0002 lo cubra.
GRANT SELECT, INSERT, UPDATE, DELETE ON "brand_audio_tracks" TO "fastgram_app";
--> statement-breakpoint
ALTER TABLE "brand_audio_tracks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "brand_audio_tracks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "brand_audio_tracks_tenant_isolation" ON "brand_audio_tracks"
  USING ("brand_audio_tracks"."company_id" = "app"."current_company"())
  WITH CHECK ("brand_audio_tracks"."company_id" = "app"."current_company"());
