-- 0041_reel_planner — el planificador semanal de reels (sprint 9, agente U).
-- `PU-S9-014`, PRD §2.7 D-20 (reels con HyperFrames), D-22 (preferencias).
--
-- ## Dos tablas
--
-- `reel_plans`: una fila por marca y **semana ISO local** (`week_start` = el
-- lunes, en la zona de la marca). `UNIQUE (company_id, week_start)` es la
-- idempotencia del plan: el cron y el botón «Plan now» convergen en la misma
-- fila. `quota` es lo que pedía la estrategia al planificar (tope nuestro: 14,
-- dos por día); `notes` los avisos con código estable (sin modelo `text`, sin
-- subtítulos, fuente reemplazada…).
--
-- `reel_plan_items`: un reel planificado. Guarda lo que decidió el
-- planificador para poder mostrarlo y volver a él sin reinferir: ángulo (y su
-- título al planificar: el ángulo se puede borrar), idea, gancho, copy,
-- animaciones, lo que eligió el decisor por rol, el `ReelSpec` armado y el
-- póster. `status`: planned → suggested → accepted/discarded → built, o
-- failed con `failure_reason`. `suggestion_id` / `content_id` enlazan con la
-- cola de Blitz y la Library; `set null` porque borrar una pieza no borra la
-- historia del plan.
--
-- El `ReelSpec` va en `spec` y **también** en el `build_plan` de la sugerencia
-- cuando entra a la cola: la sugerencia se construye sola (como las demás) y
-- el plan conserva lo planificado aunque la sugerencia se descarte.
--
-- ## RLS
--
-- Por marca, con la política estándar, y en `COMPANY_SCOPED_TABLES`.

CREATE TABLE "reel_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "week_start" text NOT NULL,
  "timezone" text NOT NULL,
  "quota" integer NOT NULL,
  "notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reel_plans_week_format" CHECK ("week_start" ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT "reel_plans_quota_range" CHECK ("quota" between 0 and 14)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reel_plans_company_week_uq"
  ON "reel_plans" ("company_id", "week_start");
--> statement-breakpoint
CREATE TABLE "reel_plan_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "plan_id" uuid NOT NULL REFERENCES "reel_plans"("id") ON DELETE cascade,
  "ord" integer NOT NULL,
  "day" text NOT NULL,
  "status" text DEFAULT 'planned' NOT NULL,
  "template" text NOT NULL,
  "angle_id" uuid REFERENCES "content_angles"("id") ON DELETE set null,
  "angle_title" text,
  "idea" text,
  "hook" text,
  "copy" jsonb,
  "motion" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "assets" jsonb,
  "spec" jsonb,
  "duration_sec" real,
  "poster_key" text,
  "explored" boolean DEFAULT false NOT NULL,
  "suggestion_id" uuid REFERENCES "suggestions"("id") ON DELETE set null,
  "content_id" uuid REFERENCES "contents"("id") ON DELETE set null,
  "failure_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reel_plan_items_status" CHECK (
    "status" in ('planned', 'suggested', 'accepted', 'discarded', 'built', 'failed')
  ),
  CONSTRAINT "reel_plan_items_template" CHECK (
    "template" in ('hook-reaction-punchline', 'list-beats', 'before-after')
  ),
  CONSTRAINT "reel_plan_items_day_format" CHECK ("day" ~ '^\d{4}-\d{2}-\d{2}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reel_plan_items_plan_ord_uq" ON "reel_plan_items" ("plan_id", "ord");
--> statement-breakpoint
CREATE INDEX "reel_plan_items_company_day_idx" ON "reel_plan_items" ("company_id", "day");
--> statement-breakpoint
CREATE INDEX "reel_plan_items_suggestion_idx" ON "reel_plan_items" ("suggestion_id")
  WHERE "suggestion_id" is not null;
--> statement-breakpoint
CREATE INDEX "reel_plan_items_content_idx" ON "reel_plan_items" ("content_id")
  WHERE "content_id" is not null;
--> statement-breakpoint
-- Trampa 17: GRANT explícito aunque el DEFAULT PRIVILEGES de 0002 lo cubra.
GRANT SELECT, INSERT, UPDATE, DELETE ON "reel_plans" TO "fastgram_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "reel_plan_items" TO "fastgram_app";
--> statement-breakpoint
ALTER TABLE "reel_plans" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reel_plans" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "reel_plans_tenant_isolation" ON "reel_plans"
  USING ("reel_plans"."company_id" = "app"."current_company"())
  WITH CHECK ("reel_plans"."company_id" = "app"."current_company"());
--> statement-breakpoint
ALTER TABLE "reel_plan_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reel_plan_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "reel_plan_items_tenant_isolation" ON "reel_plan_items"
  USING ("reel_plan_items"."company_id" = "app"."current_company"())
  WITH CHECK ("reel_plan_items"."company_id" = "app"."current_company"());
