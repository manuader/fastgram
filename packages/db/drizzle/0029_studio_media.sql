-- 0029_studio_media — Content Studio y Media Bank (sprint 7, agente F).
--
-- `P2-MEDIA-007` (búsqueda y filtros), `P2-RENDER-013` (HDR→SDR),
-- `P1-ONB-008` / `FR-011.5.1` (importar posts propios).
--
-- ## Qué agrega
--
-- 1. `media_origin` += `imported`. `FR-011.5.1` lo nombra literal: los posts
--    propios entran al Media Bank *«como assets con `origin: "imported"`»*. Se
--    listan junto con `manual_upload` y `brand_kit`.
-- 2. `media.tags`: etiquetas buscables. Las escribe el usuario (`PATCH`) y, para
--    los clips importados por link, las etiquetas automáticas del modelo de
--    visión. Array + índice GIN: el filtro es `tags @> ARRAY[tag]`.
-- 3. `media.source_ref`: de dónde vino un asset importado (`instagram:<id>`,
--    `youtube:<id>`, la URL canónica del post…). Único por marca cuando no es
--    NULL: es la guarda del dedupe del import de posts propios (dos corridas
--    del mismo import no duplican filas; la segunda choca y la saltea).
-- 4. `media.normalization`: qué hizo la normalización con el archivo. La
--    columna existe por `hdr_kept_original`: un video HDR con un FFmpeg sin
--    `zscale` **no se puede** pasar a SDR, y en vez de fallarlo se conserva el
--    original y se marca (antes quedaba `failed` sin explicación).
-- 5. `own_post_imports`: el estado consultable de un import de posts propios
--    (cola `own-post-import`).
--
-- ## Por qué sin usar `imported` acá
--
-- Igual que `0013`: Drizzle corre todas las migraciones en una transacción y
-- el valor nuevo de un enum no se puede nombrar hasta que commitea.

ALTER TYPE "media_origin" ADD VALUE IF NOT EXISTS 'imported';
--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "source_ref" text;
--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "normalization" text;
--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_normalization_check"
  CHECK ("normalization" IS NULL
         OR "normalization" IN ('normalized', 'already_normalized', 'hdr_kept_original'));
--> statement-breakpoint
CREATE UNIQUE INDEX "media_company_source_ref_uq"
  ON "media" ("company_id", "source_ref")
  WHERE "source_ref" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "media_tags_gin_idx" ON "media" USING gin ("tags");
--> statement-breakpoint
CREATE TABLE "own_post_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "source" text NOT NULL,
  "connection_id" uuid,
  "profile_url" text,
  "platform" text NOT NULL,
  "max_items" integer NOT NULL,
  "state" text DEFAULT 'queued' NOT NULL,
  "found" integer DEFAULT 0 NOT NULL,
  "imported" integer DEFAULT 0 NOT NULL,
  "skipped" integer DEFAULT 0 NOT NULL,
  "failed" integer DEFAULT 0 NOT NULL,
  "error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "own_post_imports_source_check" CHECK ("source" IN ('connection', 'profile')),
  CONSTRAINT "own_post_imports_state_check"
    CHECK ("state" IN ('queued', 'running', 'done', 'failed')),
  CONSTRAINT "own_post_imports_source_shape_check"
    CHECK (("source" = 'connection' AND "connection_id" IS NOT NULL)
        OR ("source" = 'profile' AND "profile_url" IS NOT NULL)),
  CONSTRAINT "own_post_imports_max_items_check" CHECK ("max_items" BETWEEN 1 AND 50)
);
--> statement-breakpoint
CREATE INDEX "own_post_imports_company_created_idx"
  ON "own_post_imports" ("company_id", "created_at");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "own_post_imports" TO "fastgram_app";
--> statement-breakpoint
ALTER TABLE "own_post_imports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "own_post_imports" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "own_post_imports_tenant_isolation" ON "own_post_imports"
  USING ("own_post_imports"."company_id" = "app"."current_company"())
  WITH CHECK ("own_post_imports"."company_id" = "app"."current_company"());
