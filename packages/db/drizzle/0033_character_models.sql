-- Biblioteca de modelos — sprint 8 (agente K), `P5-LIBR-001/002`, `P4-JV-004`.
--
-- ## Qué agrega
--
-- 1. `character_models`: los personajes **del dueño**, no de una marca. Un
--    modelo tiene su Soul ID de Higgsfield (`soul_id`, interno: nunca sale por
--    la API), un retrato y fotos en nuestro storage (prefijo
--    `models/{owner_user_id}/`, se guardan las **claves**), notas, y la voz que
--    eligió el dueño (proveedor `fal`, modelo TTS y `voice_id`).
-- 2. `influencers.model_id`: la fila que representa al modelo **dentro** de
--    una marca. Asignar un modelo a una marca crea (o reactiva) esa fila con el
--    mismo `soul_id` y estado `ready`, sin entrenar: galería, Animate,
--    Configuration y Blitz siguen funcionando por marca sin cambios.
--
-- ## Sin RLS, como `onboarding_records`
--
-- El scope es el **dueño** (`owner_user_id`), por encima del tenant, igual que
-- el directorio de marcas (`workspace-directory.ts`): lo sostiene el
-- repositorio (`character-models.ts`), que no tiene ninguna función sin
-- `ownerUserId` en el `WHERE`. Queda en `NON_TENANT_TABLES` con su razón.
--
-- ## `source_influencer_id` sin FK
--
-- Es de dónde se promovió el modelo, en **otra** tabla con RLS y de una marca
-- que puede borrarse. Es historia, no una relación que haya que mantener.

CREATE TABLE IF NOT EXISTS "character_models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "source" text NOT NULL,
  "status" text DEFAULT 'training' NOT NULL,
  "progress" integer DEFAULT 0 NOT NULL,
  "provider" text DEFAULT 'higgsfield' NOT NULL,
  "soul_id" text,
  "portrait_key" text,
  "portrait_url" text,
  "reference_keys" text[] DEFAULT '{}'::text[] NOT NULL,
  "notes" text,
  "age" integer,
  "style" text,
  "voice_provider" text,
  "voice_model" text,
  "voice_id" text,
  "source_influencer_id" uuid,
  "source_company_id" uuid,
  "failure_code" text,
  "failure_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "character_models_source_check"
    CHECK ("source" IN ('photos', 'soul_id', 'influencer')),
  CONSTRAINT "character_models_status_check"
    CHECK ("status" IN ('training', 'ready', 'failed')),
  CONSTRAINT "character_models_progress_check"
    CHECK ("progress" BETWEEN 0 AND 100),
  CONSTRAINT "character_models_age_check"
    CHECK ("age" IS NULL OR "age" BETWEEN 18 AND 60),
  -- Un modelo listo sin personaje no sirve para generar nada.
  CONSTRAINT "character_models_ready_has_soul_check"
    CHECK ("status" <> 'ready' OR "soul_id" IS NOT NULL),
  -- La voz va entera o no va: un modelo TTS sin voz no se puede llamar.
  CONSTRAINT "character_models_voice_shape_check"
    CHECK (
      ("voice_provider" IS NULL AND "voice_model" IS NULL AND "voice_id" IS NULL)
      OR ("voice_provider" = 'fal' AND "voice_model" IS NOT NULL AND "voice_id" IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS "character_models_owner_created_idx"
  ON "character_models" USING btree ("owner_user_id", "created_at");

ALTER TABLE "influencers"
  ADD COLUMN IF NOT EXISTS "model_id" uuid
  REFERENCES "character_models"("id") ON DELETE SET NULL;

-- Una marca tiene, a lo sumo, una fila por modelo: desasignar la desactiva y
-- reasignar la reactiva, no crea otra.
CREATE UNIQUE INDEX IF NOT EXISTS "influencers_company_model_uidx"
  ON "influencers" USING btree ("company_id", "model_id")
  WHERE "model_id" IS NOT NULL;
