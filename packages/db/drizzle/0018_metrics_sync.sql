-- Métricas de vuelta y auto-tune del content mix.
-- `PU-AUTO-004` (`= P3-METRIC-001`), `P3-ANALYT-001/002` · PRD `FR-120`,
-- `NFR-016`, §9.5 #10 · `docs/PLAN-USO-PERSONAL.md` §2 paso 7.
--
-- ## Qué agrega
--
-- 1. Cuatro columnas en `posts` para el sync:
--    - `shares`: la cuarta métrica. `NOT NULL DEFAULT 0` como sus hermanas del
--      PRD (`views`, `likes`, `comments`) para que ningún lector tenga que
--      tratar a una distinta.
--    - `metrics_synced_at`: **`NULL` = pre-sync** (`NFR-016`). El PRD dice que
--      `postedAt` distingue un cero real de uno pre-sync, y no alcanza: un post
--      publicado hace tres días que el sync nunca alcanzó (conexión sin permiso
--      de insights) tiene `postedAt` y ceros que no son datos. Con esta columna
--      la regla es exacta.
--    - `metrics_missing text[]`: las métricas que la red **no dio** en el
--      último sync. Sus columnas quedan en 0 por el `NOT NULL`; esto dice que
--      ese 0 no es un dato. Se prefirió a volver nullable `views`/`likes`/
--      `comments`, que ya leen la API (`POST /analytics/posts`) y la web.
--    - `metrics_error_code`: el último motivo por el que el sync no trajo nada
--      para el post, como código estable. `NULL` = sin error.
-- 2. `content_mix_autotune` — el flag «Auto-tune content mix» por marca, y la
--    última corrida. **Sin fila = apagado.** No va en `brand_strategies`: esa
--    fila se escribe entera con `PUT /strategy` (y la escribe otro código); un
--    flag que cambia sólo por su toggle y una marca de «última corrida» que
--    escribe el worker no tienen por qué pisarse con ella.
-- 3. `format_mix_adjustments` — cada cambio aplicado a los pesos de formato
--    (`blitz_preferences`): quién, cuándo, de qué a qué y con qué evidencia.
-- 4. `app.metrics_sync_brands(since)` — la lista de marcas con trabajo para el
--    cron de `metrics-sync`.
--
-- ## Por qué una función SECURITY DEFINER, y de qué tamaño es la excepción
--
-- El job corre cada hora **sin tenant** y tiene que saber a qué marcas
-- entrar. `posts` y `content_mix_autotune` tienen `FORCE ROW LEVEL SECURITY`;
-- con `fastgram_app` y sin GUC, un `SELECT DISTINCT company_id` devolvería
-- **cero filas sin error** y el sync no correría nunca, en silencio (el mismo
-- modo de falla que `0009` documenta para el barrido de staleness).
--
-- La función devuelve **sólo ids de marca**: ni un dato de ningún post. Todo
-- lo demás (qué posts, con qué token, qué escribir) se hace después marca por
-- marca con `withCompany`, bajo RLS.
--
-- ## El índice parcial
--
-- El scan del cron es «posts `POSTED` de los últimos 30 días» por marca; sin
-- índice, cada hora sería un barrido de todos los posts de la tabla.

ALTER TABLE "posts" ADD COLUMN "shares" integer DEFAULT 0 NOT NULL;
ALTER TABLE "posts" ADD COLUMN "metrics_synced_at" timestamp with time zone;
ALTER TABLE "posts" ADD COLUMN "metrics_missing" text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE "posts" ADD COLUMN "metrics_error_code" text;

CREATE INDEX "posts_company_posted_sync_idx"
  ON "posts" ("company_id", "posted_at")
  WHERE "status" = 'POSTED';

CREATE TABLE "content_mix_autotune" (
  "company_id" uuid PRIMARY KEY NOT NULL
    REFERENCES "companies"("id") ON DELETE cascade,
  "enabled" boolean DEFAULT false NOT NULL,
  "last_run_at" timestamp with time zone,
  "last_outcome" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "format_mix_adjustments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "actor" text NOT NULL,
  "from_weights" jsonb NOT NULL,
  "to_weights" jsonb NOT NULL,
  "stats" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- `text` + CHECK y no un enum: el día que el usuario también quede
  -- registrado al cambiar el mix a mano, se amplía el CHECK sin `ALTER TYPE`.
  CONSTRAINT "format_mix_adjustments_actor_check" CHECK ("actor" IN ('autotune'))
);

CREATE INDEX "format_mix_adjustments_company_created_idx"
  ON "format_mix_adjustments" ("company_id", "created_at");

GRANT SELECT, INSERT, UPDATE, DELETE ON "content_mix_autotune" TO "fastgram_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "format_mix_adjustments" TO "fastgram_app";

ALTER TABLE "content_mix_autotune" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "content_mix_autotune" FORCE ROW LEVEL SECURITY;
CREATE POLICY "content_mix_autotune_tenant_isolation" ON "content_mix_autotune"
  USING ("content_mix_autotune"."company_id" = "app"."current_company"())
  WITH CHECK ("content_mix_autotune"."company_id" = "app"."current_company"());

ALTER TABLE "format_mix_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "format_mix_adjustments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "format_mix_adjustments_tenant_isolation" ON "format_mix_adjustments"
  USING ("format_mix_adjustments"."company_id" = "app"."current_company"())
  WITH CHECK ("format_mix_adjustments"."company_id" = "app"."current_company"());

CREATE OR REPLACE FUNCTION app.metrics_sync_brands(p_since timestamptz)
RETURNS TABLE (company_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- Obligatorio en SECURITY DEFINER: sin esto, quien llama puede anteponer un
-- esquema propio y hacer que `posts` resuelva a otra tabla.
SET search_path = public, pg_temp
AS $$
  SELECT p.company_id
    FROM posts p
   WHERE p.status = 'POSTED'
     AND p.posted_at >= p_since
     AND p.external_post_id IS NOT NULL
  UNION
  SELECT a.company_id
    FROM content_mix_autotune a
   WHERE a.enabled
$$;

COMMENT ON FUNCTION app.metrics_sync_brands(timestamptz) IS
  'Marcas con trabajo para el cron de metrics-sync (PU-AUTO-004): posts POSTED '
  'desde p_since con id en la plataforma, o auto-tune del mix prendido. '
  'SECURITY DEFINER para saltear el FORCE RLS de posts sin GUC. Devuelve solo '
  'ids de marca; los datos se leen despues marca por marca bajo RLS.';

REVOKE ALL ON FUNCTION app.metrics_sync_brands(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.metrics_sync_brands(timestamptz) TO fastgram_app;
