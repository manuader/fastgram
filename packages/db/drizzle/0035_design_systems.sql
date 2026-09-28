-- 0035_design_systems — design system por marca (sprint 9, agente M).
-- `PU-S9-001…004`: importar un export de Claude Design (zip) o derivar uno
-- mínimo del análisis de marca, y usarlo en Blitz (paleta, cajas de texto,
-- voz en la copy).
--
-- ## Una fila por versión, una sola activa
--
-- Cada import (o derivado) es una fila nueva con `version` = siguiente de la
-- marca. Mientras el worker procesa un zip, la fila está `importing` e
-- **inactiva**: la marca sigue usando el design system anterior. Al terminar
-- bien, en la misma transacción se desactiva el anterior y se activa éste
-- (`brand_design_systems_one_active_uq` lo garantiza aunque dos imports
-- terminen a la vez: el segundo choca y reintenta). Un import fallido queda
-- `failed` con su código, visible en la pantalla, y no toca al activo.
--
-- ## Por qué jsonb y no tablas por token
--
-- Los tokens, el resumen de estilo, las fuentes subidas y los generados
-- pendientes se leen y escriben siempre juntos y nunca se consultan por
-- partes desde SQL. La forma la valida `core/design-system/document.ts`.
--
-- ## Los archivos
--
-- Los assets (logos, imágenes, motivos rasterizados) van al Media Bank de la
-- marca (`media`, `origin = 'brand_kit'`, tag `design-system`): así la
-- pantalla del Media Bank los muestra y Blitz los elige. Las fuentes van al
-- storage bajo `fonts/{company_id}/…` y se listan en `fonts`.

CREATE TABLE IF NOT EXISTS "brand_design_systems" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "status" text DEFAULT 'importing' NOT NULL,
  "source" text NOT NULL,
  "active" boolean DEFAULT false NOT NULL,
  "version" integer NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "tokens" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "style" jsonb,
  "assets" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "fonts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "pending_assets" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "warnings" text[] DEFAULT '{}'::text[] NOT NULL,
  "zip_key" text,
  "zip_bytes" integer,
  "failure_code" text,
  "failure_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "brand_design_systems_status_check"
    CHECK ("status" IN ('importing', 'ready', 'failed')),
  CONSTRAINT "brand_design_systems_source_check"
    CHECK ("source" IN ('zip', 'derived')),
  CONSTRAINT "brand_design_systems_version_check" CHECK ("version" >= 1),
  -- Sólo se activa lo que terminó bien.
  CONSTRAINT "brand_design_systems_active_ready_check"
    CHECK (NOT "active" OR "status" = 'ready')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_design_systems_company_created_idx"
  ON "brand_design_systems" ("company_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brand_design_systems_one_active_uq"
  ON "brand_design_systems" ("company_id")
  WHERE "active";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brand_design_systems_company_version_uq"
  ON "brand_design_systems" ("company_id", "version");
--> statement-breakpoint
-- Trampa 17: GRANT explícito aunque el DEFAULT PRIVILEGES de 0002 lo cubra.
GRANT SELECT, INSERT, UPDATE, DELETE ON "brand_design_systems" TO "fastgram_app";
--> statement-breakpoint
ALTER TABLE "brand_design_systems" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "brand_design_systems" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "brand_design_systems_tenant_isolation" ON "brand_design_systems"
  USING ("brand_design_systems"."company_id" = "app"."current_company"())
  WITH CHECK ("brand_design_systems"."company_id" = "app"."current_company"());
