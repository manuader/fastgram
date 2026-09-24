-- Influencers con personaje de Higgsfield (Soul ID) — `PU-LATER-004`,
-- `FR-080`…`FR-082`, `F-094`.
--
-- ## Qué agrega
--
-- 1. En `influencers`:
--    - `reference_media_ids`: las 4–20 fotos del Media Bank con las que se
--      crea el personaje. El pipeline las relee de acá (no del payload) para
--      que una reentrega del job use las mismas.
--    - `provider`: con qué proveedor se creó el personaje (`higgsfield`). El
--      id del personaje en el proveedor ya tenía columna: `soul_id` (`DATA-013`
--      lo lista entre los campos internos).
--    - `failure_code` / `failure_message`: por qué quedó `failed`. `DATA-013`
--      no define un campo de error y el handler lo dejaba sólo en el log (lo
--      dice su cabecera); con un proveedor real, «failed» sin motivo no se
--      puede arreglar desde la UI. El código es estable; el mensaje es una
--      línea apta para mostrar, nunca el cuerpo crudo del proveedor.
--    - `gender`, `age`, `ethnicity` pasan a **nullable**: con fotos de
--      referencia los rasgos son opcionales (el wizard del plan de uso
--      personal). El CHECK de `age` 18–60 sigue valiendo cuando hay edad.
-- 2. `influencer_generations`: una fila por pedido de imágenes del personaje
--    (FR-081). Guarda el `request_id` y la URL de estado **antes** del polling
--    (Higgsfield no acepta clave de idempotencia: una reentrega retoma el
--    polling, no reenvía), el estimado reservado en el tope mensual y los
--    ids de `media` que quedaron en el Media Bank.
--
-- ## RLS
--
-- `influencer_generations` es de cliente: misma política que el resto
-- (`0002_tenancy_rls.sql`) y el GRANT explícito (trampa 17).

ALTER TABLE "influencers" ALTER COLUMN "gender" DROP NOT NULL;
ALTER TABLE "influencers" ALTER COLUMN "age" DROP NOT NULL;
ALTER TABLE "influencers" ALTER COLUMN "ethnicity" DROP NOT NULL;

ALTER TABLE "influencers"
  ADD COLUMN "reference_media_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
ALTER TABLE "influencers" ADD COLUMN "provider" text;
ALTER TABLE "influencers" ADD COLUMN "failure_code" text;
ALTER TABLE "influencers" ADD COLUMN "failure_message" text;

CREATE TABLE "influencer_generations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "influencer_id" uuid NOT NULL REFERENCES "influencers"("id") ON DELETE cascade,
  "status" text DEFAULT 'queued' NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "prompt" text NOT NULL,
  "aspect_ratio" text NOT NULL,
  "count" integer NOT NULL,
  "estimate_usd" double precision NOT NULL,
  "estimate_basis" text NOT NULL,
  "spend_month" text NOT NULL,
  "provider_request_id" text,
  "provider_status_url" text,
  "media_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "error_code" text,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "influencer_generations_status_check"
    CHECK ("status" IN ('queued', 'generating', 'ready', 'failed', 'nsfw')),
  CONSTRAINT "influencer_generations_count_check" CHECK ("count" BETWEEN 1 AND 4),
  CONSTRAINT "influencer_generations_estimate_check" CHECK ("estimate_usd" >= 0),
  -- Un pedido aceptado tiene los dos datos para retomarlo, o ninguno.
  CONSTRAINT "influencer_generations_request_pair_check"
    CHECK (("provider_request_id" IS NULL) = ("provider_status_url" IS NULL))
);

CREATE INDEX "influencer_generations_company_created_idx"
  ON "influencer_generations" ("company_id", "created_at");
CREATE INDEX "influencer_generations_influencer_created_idx"
  ON "influencer_generations" ("influencer_id", "created_at");

GRANT SELECT, INSERT, UPDATE, DELETE ON "influencer_generations" TO "fastgram_app";

ALTER TABLE "influencer_generations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "influencer_generations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "influencer_generations_tenant_isolation" ON "influencer_generations"
  USING ("influencer_generations"."company_id" = "app"."current_company"())
  WITH CHECK ("influencer_generations"."company_id" = "app"."current_company"());
