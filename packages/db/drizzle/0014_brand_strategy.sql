-- Estrategia de publicación por marca y slots planificados.
-- `PU-BRAND-002`, `PU-CAL-001`, `PU-CAL-002` · `docs/PLAN-USO-PERSONAL.md`
-- §2 (pasos 2 y 5) y §5 · PRD §2.7 `D-07`, `D-08`.
--
-- ## Qué agrega
--
-- 1. `brand_strategies` — una fila por marca: redes activas con piezas por día
--    y tope anti-bot, ventanas horarias por día de la semana, idioma, mix de
--    formatos, autonomía (`manual|autopilot`), jitter y separación mínima entre
--    marcas. **Sin fila = estrategia por defecto** (la arma `apps/api`). La
--    zona horaria no se duplica: es `companies.timezone`.
-- 2. `planned_slots` — contenido + red + hora, **sin cuenta**.
-- 3. Un índice por expresión sobre `posts` para el rango del calendario.
--
-- ## Por qué un slot y no un post
--
-- `posts` exige exactamente una cuenta (`posts_account_exclusive`) y en este
-- sprint no hay OAuth. Relajar ese CHECK rompería `FR-060`: el worker de
-- publicación supone que todo post `SCHEDULED` tiene a quién publicar, y un
-- post sin cuenta llegaría a la hora y fallaría. El slot es lo que hay
-- **antes** de que exista un post: el calendario lo muestra, se puede mover, y
-- cuando la marca tenga la conexión se convierte en un post por el flujo de
-- `POST /content/:id/schedule` (queda `status = converted` con `post_id`).
-- Si la marca ya tiene la conexión, el auto-slot crea el post directo.
--
-- ## `strategy_network` es un enum nuevo, a propósito
--
-- `social_platform` y `post_platform` no tienen `x`, `threads` ni `facebook`
-- (`D-09`). Ampliarlos es del sprint 3, con los adaptadores que publican ahí;
-- hacerlo acá dejaría valores que ningún código sabe manejar en tablas que el
-- worker lee.
--
-- ## RLS
--
-- Las dos tablas son de cliente y van bajo la misma política que el resto
-- (`0002_tenancy_rls.sql`). Los `GRANT` los cubre el `ALTER DEFAULT
-- PRIVILEGES` de `0002` (tablas creadas después, en `public`), pero se repiten
-- explícitos: un grant que depende de un default que nadie mira es la trampa
-- 17 del HANDOFF al revés.
--
-- ## El índice de `posts`
--
-- El calendario pide `[from, to)` sobre la **fecha efectiva** del post:
-- `coalesce(posted_at, scheduled_at_utc)` (un post del carril lento de TikTok
-- sale hasta 72 h después de su hora, y se dibuja donde salió). Sin índice por
-- esa expresión, el rango es un barrido de todos los posts de la marca. No se
-- declara en el schema de Drizzle: las migraciones de este paquete se escriben
-- a mano desde `0004` y drizzle-kit no las regenera.

CREATE TYPE "strategy_network" AS ENUM (
  'instagram', 'tiktok', 'x', 'threads', 'facebook', 'youtube', 'linkedin'
);
CREATE TYPE "brand_autonomy" AS ENUM ('manual', 'autopilot');
CREATE TYPE "planned_slot_status" AS ENUM ('planned', 'converted');

CREATE TABLE "brand_strategies" (
  "company_id" uuid PRIMARY KEY NOT NULL
    REFERENCES "companies"("id") ON DELETE cascade,
  "networks" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "windows" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "format_mix" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "language" text NOT NULL,
  "autonomy" "brand_autonomy" DEFAULT 'manual' NOT NULL,
  "jitter_minutes" integer NOT NULL,
  "brand_gap_minutes" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "brand_strategies_jitter_range" CHECK ("jitter_minutes" between 0 and 60),
  CONSTRAINT "brand_strategies_gap_range" CHECK ("brand_gap_minutes" between 0 and 240)
);

CREATE TABLE "planned_slots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "content_id" uuid NOT NULL REFERENCES "contents"("id") ON DELETE cascade,
  "network" "strategy_network" NOT NULL,
  "scheduled_at_utc" timestamp with time zone NOT NULL,
  "status" "planned_slot_status" DEFAULT 'planned' NOT NULL,
  "post_id" uuid REFERENCES "posts"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "planned_slots_company_scheduled_idx"
  ON "planned_slots" ("company_id", "scheduled_at_utc");
CREATE INDEX "planned_slots_company_created_idx"
  ON "planned_slots" ("company_id", "created_at");
-- Una pieza no se planifica dos veces en la misma red. Es la guarda de la
-- carrera de dos auto-slots simultáneos sobre el mismo contenido (trampa 37:
-- un INSERT se protege con una restricción, no con una lectura previa).
CREATE UNIQUE INDEX "planned_slots_content_network_planned_uq"
  ON "planned_slots" ("content_id", "network") WHERE "status" = 'planned';

CREATE INDEX "posts_company_effective_at_idx"
  ON "posts" ("company_id", (coalesce("posted_at", "scheduled_at_utc")));

GRANT SELECT, INSERT, UPDATE, DELETE ON "brand_strategies" TO "fastgram_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "planned_slots" TO "fastgram_app";

ALTER TABLE "brand_strategies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand_strategies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "brand_strategies_tenant_isolation" ON "brand_strategies"
  USING ("brand_strategies"."company_id" = "app"."current_company"())
  WITH CHECK ("brand_strategies"."company_id" = "app"."current_company"());

ALTER TABLE "planned_slots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "planned_slots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "planned_slots_tenant_isolation" ON "planned_slots"
  USING ("planned_slots"."company_id" = "app"."current_company"())
  WITH CHECK ("planned_slots"."company_id" = "app"."current_company"());
