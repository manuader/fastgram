-- Preferencias aprendidas desde Blitz — sprint 9 (agente Q), `PU-S9-011`, `D-22`.
--
-- ## Qué agrega
--
-- 1. `preference_signals` (RLS por marca): cada decisión del dueño en Blitz
--    (aceptar, descartar, editar antes/después de aceptar) con los rasgos de
--    la pieza (vocabulario cerrado de `@fastgram/core`, `preferences/`). Es la
--    fuente de verdad: los pesos se recalculan desde acá.
--    Idempotente por (marca, sugerencia, tipo, aspecto): reintentar no cuenta
--    dos veces y editar dos veces el mismo aspecto deja la última edición.
-- 2. `preference_weights` (RLS por marca, 1:1 con la company): los pesos
--    materializados y la configuración de la marca (on/off, exploración y
--    vida media; `NULL` = hereda la del dueño).
-- 3. `owner_preferences` (del dueño, **sin RLS**): la configuración por
--    defecto y lo que cada marca aporta al nivel del dueño (`brand_stats`).
--
-- ## Por qué el nivel del dueño no necesita cruzar tenants
--
-- El dueño agrega todas sus marcas, pero leer las señales de otras marcas
-- desde una transacción con `app.current_company` puesto no se puede (RLS), y
-- `withoutCompany` sólo ve filas con la conexión de desarrollo (el agujero de
-- `workspace-directory.ts`). En vez de eso, **cada marca escribe su propio
-- aporte** en `owner_preferences.brand_stats[company_id]` desde su propia
-- transacción, con `brand_stats || jsonb_build_object(...)`: una sola
-- sentencia, sin leer-modificar-escribir, así dos marcas a la vez no se pisan.
-- La tabla no tiene RLS (como `character_models`, 0033): el scope es
-- `owner_user_id` y lo sostiene el repositorio (`repositories/preferences.ts`).
--
-- ## Sin FK a `suggestions` ni a `contents`
--
-- Es historia de aprendizaje: borrar una sugerencia o una pieza vieja no tiene
-- que borrar lo que el dueño enseñó con ella (mismo criterio que
-- `character_models.source_influencer_id`).

CREATE TABLE IF NOT EXISTS "preference_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "suggestion_id" uuid NOT NULL,
  "content_id" uuid,
  "kind" text NOT NULL,
  "aspect" text DEFAULT '' NOT NULL,
  "features" text[] DEFAULT '{}'::text[] NOT NULL,
  "removed" text[] DEFAULT '{}'::text[] NOT NULL,
  "added" text[] DEFAULT '{}'::text[] NOT NULL,
  "weight" real NOT NULL,
  "vocabulary_version" integer NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "preference_signals_kind_check"
    CHECK ("kind" IN ('accept', 'discard', 'edit_before_accept', 'edit_after_accept')),
  CONSTRAINT "preference_signals_aspect_check"
    CHECK ("aspect" IN ('', 'text', 'background', 'clip', 'music', 'style')),
  -- Aceptar/descartar es sobre la pieza entera; una edición, sobre un aspecto.
  CONSTRAINT "preference_signals_edit_has_aspect_check"
    CHECK (("kind" IN ('accept', 'discard')) = ("aspect" = '')),
  CONSTRAINT "preference_signals_weight_check"
    CHECK ("weight" > 0 AND "weight" <= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "preference_signals_decision_uq"
  ON "preference_signals" USING btree ("company_id", "suggestion_id", "kind", "aspect");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "preference_signals_company_occurred_idx"
  ON "preference_signals" USING btree ("company_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "preference_signals_company_content_idx"
  ON "preference_signals" USING btree ("company_id", "content_id")
  WHERE "content_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "preference_signals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "preference_signals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "preference_signals_tenant_isolation" ON "preference_signals"
  USING ("preference_signals"."company_id" = "app"."current_company"())
  WITH CHECK ("preference_signals"."company_id" = "app"."current_company"());
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "preference_weights" (
  "company_id" uuid PRIMARY KEY NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT true NOT NULL,
  "exploration" real,
  "half_life_days" real,
  "stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "signal_count" integer DEFAULT 0 NOT NULL,
  "computed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "preference_weights_exploration_check"
    CHECK ("exploration" IS NULL OR "exploration" BETWEEN 0 AND 0.5),
  CONSTRAINT "preference_weights_half_life_check"
    CHECK ("half_life_days" IS NULL OR "half_life_days" BETWEEN 1 AND 365)
);
--> statement-breakpoint
ALTER TABLE "preference_weights" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "preference_weights" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "preference_weights_tenant_isolation" ON "preference_weights"
  USING ("preference_weights"."company_id" = "app"."current_company"())
  WITH CHECK ("preference_weights"."company_id" = "app"."current_company"());
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "owner_preferences" (
  "owner_user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "exploration" real DEFAULT 0.15 NOT NULL,
  "half_life_days" real DEFAULT 30 NOT NULL,
  "reset_at" timestamp with time zone,
  "brand_stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "owner_preferences_exploration_check"
    CHECK ("exploration" BETWEEN 0 AND 0.5),
  CONSTRAINT "owner_preferences_half_life_check"
    CHECK ("half_life_days" BETWEEN 1 AND 365)
);
