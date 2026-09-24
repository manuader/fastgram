-- Inspiration como tablero de referencias propio — PRD `MOD-004` / `FR-040`
-- adaptado, `F-041`, `OQ-13`, `D-12`, `D-15` (Inspiration va al final).
--
-- ## Por qué hace falta migración
--
-- `trending_items` (DATA-023) nació **global**: el PRD la dibuja como el
-- catálogo de Fastlane, que son datos licenciados o scrapeados de terceros.
-- `OQ-13` y PRD §2.5 dicen que el clon **no** replica ese catálogo. Lo que sí
-- tiene sentido para uso personal es que el dueño guarde sus propias
-- referencias pegando un link (D-12: asume los derechos). Una referencia así
-- es **de una marca**: tiene que llevar `company_id`, y un id ajeno tiene que
-- dar 404 como cualquier cruce de tenant. Sin columna no hay scope, y un scope
-- en objetos del storage (lo que hizo el import por link) no se puede buscar
-- ni filtrar con una consulta.
--
-- ## Qué agrega
--
-- 1. En `trending_items`:
--    - `company_id` (nullable) y `origin` (`catalog` | `owner`), atados por un
--      CHECK: una fila del catálogo no tiene marca y una del dueño sí.
--    - Lo que se lee **sin login** de la página: `title`, `author`,
--      `caption`, `hashtags`, `format`, `comments`, `duration_seconds`.
--    - El estado de la lectura (`ingest_state`, `ingest_error`: el worker la
--      hace con `yt-dlp --dump-single-json`) y, si se guardó el clip, el
--      `import_id`/`media_id` del import por link (`PU-MEME-001`).
--    - `views` y `likes` pasan a **nullable**: una referencia cuyo sitio no da
--      likes no tiene "0 likes". El catálogo sigue con su default 0.
--    - `platform` y `permalink` pasan a nullable para un clip **subido** (no
--      tiene link público). El CHECK exige los dos en el catálogo.
-- 2. En `blitz_prompt_requests`: `source_trending_item_id`, la referencia de
--    un «Remix this». Al cerrar el pedido, sus sugerencias heredan
--    `source_trending_item_id` y `remix_source_url` (el "Remixed From" del
--    deck, F-056).
--
-- ## RLS
--
-- Hasta acá `trending_items` no tenía política (global, `0002`). Ahora las
-- filas del dueño son de una marca: `ENABLE` + `FORCE` + una política que deja
-- ver el catálogo (`company_id IS NULL`) y **sólo** las referencias propias.
-- Sin GUC, `app.current_company()` es NULL y se ve sólo el catálogo: falla
-- cerrado para lo del dueño y no cambia nada para lo global. La tabla sigue en
-- `NON_TENANT_TABLES` (tiene filas globales), con la razón actualizada.

ALTER TABLE "trending_items"
  ADD COLUMN "company_id" uuid REFERENCES "companies"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "trending_items" ADD COLUMN "origin" text DEFAULT 'catalog' NOT NULL;
--> statement-breakpoint
ALTER TABLE "trending_items" ADD COLUMN "title" text;
--> statement-breakpoint
ALTER TABLE "trending_items" ADD COLUMN "author" text;
--> statement-breakpoint
ALTER TABLE "trending_items" ADD COLUMN "caption" text;
--> statement-breakpoint
ALTER TABLE "trending_items"
  ADD COLUMN "hashtags" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "trending_items" ADD COLUMN "format" text;
--> statement-breakpoint
ALTER TABLE "trending_items" ADD COLUMN "comments" integer;
--> statement-breakpoint
ALTER TABLE "trending_items" ADD COLUMN "duration_seconds" integer;
--> statement-breakpoint
ALTER TABLE "trending_items" ADD COLUMN "ingest_state" text DEFAULT 'ready' NOT NULL;
--> statement-breakpoint
ALTER TABLE "trending_items" ADD COLUMN "ingest_error" text;
--> statement-breakpoint
ALTER TABLE "trending_items" ADD COLUMN "import_id" uuid;
--> statement-breakpoint
ALTER TABLE "trending_items" ADD COLUMN "media_id" uuid;
--> statement-breakpoint
ALTER TABLE "trending_items" ALTER COLUMN "views" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "trending_items" ALTER COLUMN "likes" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "trending_items" ALTER COLUMN "platform" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "trending_items" ALTER COLUMN "permalink" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "trending_items" ADD CONSTRAINT "trending_items_origin"
  CHECK ("origin" in ('catalog', 'owner'));
--> statement-breakpoint
ALTER TABLE "trending_items" ADD CONSTRAINT "trending_items_origin_company"
  CHECK (("origin" = 'owner') = ("company_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "trending_items" ADD CONSTRAINT "trending_items_catalog_source"
  CHECK ("origin" = 'owner' OR ("platform" IS NOT NULL AND "permalink" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "trending_items" ADD CONSTRAINT "trending_items_owner_source"
  CHECK ("origin" = 'catalog' OR "permalink" IS NOT NULL OR "media_id" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "trending_items" ADD CONSTRAINT "trending_items_format"
  CHECK ("format" IS NULL OR "format" in ('video', 'slideshow', 'image', 'text'));
--> statement-breakpoint
ALTER TABLE "trending_items" ADD CONSTRAINT "trending_items_ingest_state"
  CHECK ("ingest_state" in ('pending', 'ready', 'failed'));
--> statement-breakpoint
CREATE INDEX "trending_items_company_created_idx"
  ON "trending_items" USING btree ("company_id", "created_at");
--> statement-breakpoint
ALTER TABLE "trending_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "trending_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "trending_items_catalog_or_own" ON "trending_items"
  USING ("trending_items"."company_id" IS NULL
         OR "trending_items"."company_id" = "app"."current_company"())
  WITH CHECK ("trending_items"."company_id" IS NULL
              OR "trending_items"."company_id" = "app"."current_company"());
--> statement-breakpoint
ALTER TABLE "blitz_prompt_requests" ADD COLUMN "source_trending_item_id" uuid
  REFERENCES "trending_items"("id") ON DELETE set null;
--> statement-breakpoint
-- Trampa 17: los GRANT se repiten explícitos aunque el DEFAULT PRIVILEGES de
-- `0002` ya los cubra (la tabla existía antes; no cambia de dueño).
GRANT SELECT, INSERT, UPDATE, DELETE ON "trending_items" TO "fastgram_app";
--> statement-breakpoint
COMMENT ON COLUMN "trending_items"."origin" IS
  'catalog = fila global (DATA-023, sin marca); owner = referencia que guardo el '
  'dueno con un link o un clip (Inspiration de uso personal, OQ-13).';
--> statement-breakpoint
COMMENT ON COLUMN "blitz_prompt_requests"."source_trending_item_id" IS
  'La referencia de un Remix this. Sus sugerencias heredan remix_source_url y '
  'source_trending_item_id al cerrar el pedido (F-056).';
