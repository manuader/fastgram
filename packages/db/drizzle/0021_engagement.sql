-- Engagement (Reddit): leads con scoring JV-2, respuestas con tono JV-5 y
-- ban meter calculado en código.
-- `P4-ENGAGE-001…012` · PRD `FR-140`, `MOD-014` (F-190…F-201), §25.3 `JV-2`,
-- `JV-5`, `DP-002`, `DP-003`, `DATA-024`, `DATA-025`.
--
-- ## Qué agrega
--
-- 1. Columnas en `leads` (DATA-024 da los campos de la UI; éstas son las que
--    el motor necesita):
--    - `source`: `discovery` (el job) o `manual` (el usuario pegó un post: el
--      modo que funciona **sin** la API de Reddit, que hoy exige aprobación
--      previa — Responsible Builder Policy).
--    - `permalink`, `post_created_at`, `num_comments`, `matched_keywords`: el
--      snapshot del post al descubrirlo.
--    - `context_comments`, `subreddit_rules`: lo que el juicio y el borrador
--      necesitan (¿ya lo respondieron?, ¿el subreddit permite mencionar un
--      producto?) sin volver a pedírselo a Reddit. Sin autores.
--    - `score_answers` (jsonb): las respuestas **crudas** del juicio JV-2.
--      Es lo que hace a los pesos y umbrales «recalculables sin reinferir»
--      (`P4-ENGAGE-005`, §9.15.3 regla 3). `score_version` es la versión de
--      las preguntas: otra pregunta es otra inferencia.
--    - `lead_score`, `lead_tier`: la composición **en código** sobre esas
--      respuestas. Se guardan para ordenar y filtrar en SQL; si cambian los
--      pesos, se recalculan desde `score_answers`.
--    - `score_status`: `pending` (sin juzgar), `scored`, `failed` (el juicio
--      falló), `no_judgment` (no hay modelo para `judgment`). Un lead sin
--      juzgar se muestra con esa marca; uno juzgado como `hidden`/`vetoed`,
--      no se muestra.
--    - `reply_status` y compañía: el borrador lo genera el worker (el LLM no
--      vive en la API) y la web lo espera por polling.
--    - `last_synced_at`, `our_comments`, `replies_to_us`, `new_activity`: el
--      seguimiento del hilo (F-198/F-199).
--    - `UNIQUE (company_id, reddit_post_id)`: **el** dedupe. Incluye los
--      borrados (soft delete): un lead descartado (F-201) no vuelve a
--      aparecer en el próximo descubrimiento.
-- 2. `engagement_settings` — por marca: subreddits, palabras clave, tono,
--    reglas propias, links permitidos (default **no**), y el estado del
--    último descubrimiento (incluida la pausa por límite de tasa).
-- 3. `reddit_accounts` — una cuenta por marca, tokens **cifrados** con el
--    `TokenCipher` local (NFR-007). No reusa `connections`: Reddit no es una
--    red de publicación y ahí la vería el barrido de publicación.
-- 4. `engagement_replies` — cada respuesta enviada (`api` o `manual`) con su
--    etiqueta de tono (`value_add` / `subtle_mention` / `direct_promo`) y las
--    respuestas crudas del juicio. **El modelo etiqueta; el ratio y el nivel
--    del medidor los cuenta el código** (DP-003, `P4-ENGAGE-010`).
-- 5. Columnas en `ban_risk_assessments` para lo que el medidor contó
--    (muestra, conteos, ventana), así la UI explica el nivel sin recalcular.
-- 6. `app.engagement_brands()` — la lista de marcas con Engagement
--    configurado, para los crons (sin tenant). Devuelve **sólo ids** y dos
--    booleanos: mismo patrón y misma razón que `app.autopilot_brands()`
--    (0017) — con `fastgram_app` y FORCE RLS, un SELECT directo devolvería
--    cero filas sin error.
--
-- ## El `when` del journal
--
-- Va entre la 0020 y la 0022 (que ya existía al escribir ésta, de otro agente
-- en paralelo): `journal.test.ts` exige `when` creciente en el orden de `idx`.
-- Una base que ya hubiera aplicado la 0022 se saltearía ésta (trampa 52):
-- las bases de desarrollo que la tengan tienen que re-crearse o aplicar esta
-- migración a mano.

ALTER TABLE "leads" ADD COLUMN "source" text DEFAULT 'discovery' NOT NULL;
ALTER TABLE "leads" ADD COLUMN "permalink" text;
ALTER TABLE "leads" ADD COLUMN "post_created_at" timestamp with time zone;
ALTER TABLE "leads" ADD COLUMN "num_comments" integer DEFAULT 0 NOT NULL;
ALTER TABLE "leads" ADD COLUMN "matched_keywords" text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE "leads" ADD COLUMN "context_comments" text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE "leads" ADD COLUMN "subreddit_rules" text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE "leads" ADD COLUMN "score_status" text DEFAULT 'pending' NOT NULL;
ALTER TABLE "leads" ADD COLUMN "score_answers" jsonb;
ALTER TABLE "leads" ADD COLUMN "score_version" text;
ALTER TABLE "leads" ADD COLUMN "lead_score" numeric(10, 4);
ALTER TABLE "leads" ADD COLUMN "lead_tier" text;
ALTER TABLE "leads" ADD COLUMN "scored_at" timestamp with time zone;
ALTER TABLE "leads" ADD COLUMN "reply_status" text DEFAULT 'none' NOT NULL;
ALTER TABLE "leads" ADD COLUMN "reply_error" text;
ALTER TABLE "leads" ADD COLUMN "reply_generated_at" timestamp with time zone;
ALTER TABLE "leads" ADD COLUMN "last_synced_at" timestamp with time zone;
ALTER TABLE "leads" ADD COLUMN "our_comments" integer DEFAULT 0 NOT NULL;
ALTER TABLE "leads" ADD COLUMN "replies_to_us" integer DEFAULT 0 NOT NULL;
ALTER TABLE "leads" ADD COLUMN "new_activity" boolean DEFAULT false NOT NULL;

ALTER TABLE "leads" ADD CONSTRAINT "leads_source_check"
  CHECK ("source" IN ('discovery', 'manual'));
ALTER TABLE "leads" ADD CONSTRAINT "leads_score_status_check"
  CHECK ("score_status" IN ('pending', 'scored', 'failed', 'no_judgment'));
ALTER TABLE "leads" ADD CONSTRAINT "leads_tier_check"
  CHECK ("lead_tier" IS NULL OR "lead_tier" IN ('top', 'general', 'hidden', 'vetoed'));
ALTER TABLE "leads" ADD CONSTRAINT "leads_reply_status_check"
  CHECK ("reply_status" IN ('none', 'generating', 'ready', 'failed'));

CREATE UNIQUE INDEX "leads_company_post_uq" ON "leads" ("company_id", "reddit_post_id");

ALTER TABLE "ban_risk_assessments" ADD COLUMN "sample_size" integer DEFAULT 0 NOT NULL;
ALTER TABLE "ban_risk_assessments" ADD COLUMN "counts" jsonb
  DEFAULT '{"valueAdd":0,"subtle":0,"direct":0,"unlabeled":0}'::jsonb NOT NULL;
ALTER TABLE "ban_risk_assessments" ADD COLUMN "window_days" integer DEFAULT 30 NOT NULL;
ALTER TABLE "ban_risk_assessments" ADD COLUMN "small_sample" boolean DEFAULT true NOT NULL;

CREATE TABLE "engagement_settings" (
  "company_id" uuid PRIMARY KEY NOT NULL
    REFERENCES "companies"("id") ON DELETE cascade,
  "subreddits" text[] DEFAULT '{}'::text[] NOT NULL,
  "keywords" text[] DEFAULT '{}'::text[] NOT NULL,
  "reply_tone" text DEFAULT 'casual' NOT NULL,
  "custom_rules" text DEFAULT '' NOT NULL,
  "allow_links" boolean DEFAULT false NOT NULL,
  "discovery_enabled" boolean DEFAULT true NOT NULL,
  "last_discovery_at" timestamp with time zone,
  "last_discovery_outcome" text,
  "discovery_paused_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "engagement_settings_tone_check"
    CHECK ("reply_tone" IN ('casual', 'professional', 'friendly_expert'))
);

CREATE TABLE "reddit_accounts" (
  "company_id" uuid PRIMARY KEY NOT NULL
    REFERENCES "companies"("id") ON DELETE cascade,
  "reddit_user_id" text NOT NULL,
  "username" text NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "token_expiry" timestamp with time zone,
  "scopes" text[] DEFAULT '{}'::text[] NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "status_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reddit_accounts_status_check"
    CHECK ("status" IN ('active', 'expired', 'revoked'))
);

CREATE TABLE "engagement_replies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "lead_id" uuid NOT NULL REFERENCES "leads"("id") ON DELETE cascade,
  "text" text NOT NULL,
  "channel" text NOT NULL,
  "reddit_comment_name" text,
  "permalink" text,
  "sent_at" timestamp with time zone NOT NULL,
  "tone" text,
  "tone_answers" jsonb,
  "tone_version" text,
  "classified_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "engagement_replies_channel_check" CHECK ("channel" IN ('api', 'manual')),
  CONSTRAINT "engagement_replies_tone_check"
    CHECK ("tone" IS NULL OR "tone" IN ('value_add', 'subtle_mention', 'direct_promo'))
);

CREATE INDEX "engagement_replies_company_sent_idx"
  ON "engagement_replies" ("company_id", "sent_at");
CREATE INDEX "engagement_replies_lead_idx"
  ON "engagement_replies" ("company_id", "lead_id");

GRANT SELECT, INSERT, UPDATE, DELETE ON "engagement_settings" TO "fastgram_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "reddit_accounts" TO "fastgram_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "engagement_replies" TO "fastgram_app";

ALTER TABLE "engagement_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "engagement_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "engagement_settings_tenant_isolation" ON "engagement_settings"
  USING ("engagement_settings"."company_id" = "app"."current_company"())
  WITH CHECK ("engagement_settings"."company_id" = "app"."current_company"());

ALTER TABLE "reddit_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reddit_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "reddit_accounts_tenant_isolation" ON "reddit_accounts"
  USING ("reddit_accounts"."company_id" = "app"."current_company"())
  WITH CHECK ("reddit_accounts"."company_id" = "app"."current_company"());

ALTER TABLE "engagement_replies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "engagement_replies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "engagement_replies_tenant_isolation" ON "engagement_replies"
  USING ("engagement_replies"."company_id" = "app"."current_company"())
  WITH CHECK ("engagement_replies"."company_id" = "app"."current_company"());

CREATE OR REPLACE FUNCTION app.engagement_brands()
RETURNS TABLE (
  company_id          uuid,
  discovery_enabled   boolean,
  has_reddit_account  boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.id,
         s.discovery_enabled,
         EXISTS (
           SELECT 1 FROM public.reddit_accounts a
           WHERE a.company_id = c.id AND a.status = 'active'
         )
  FROM public.companies c
  JOIN public.engagement_settings s ON s.company_id = c.id
  WHERE c.status <> 'soft_deleted'
  ORDER BY c.created_at, c.id;
$$;

COMMENT ON FUNCTION app.engagement_brands() IS
  'Crons de Engagement (P4-ENGAGE-003/011): marcas vivas con Engagement '
  'configurado, si el descubrimiento esta prendido y si tienen una cuenta de '
  'Reddit activa. SECURITY DEFINER para saltear el FORCE RLS con fastgram_app. '
  'Devuelve solo ids y booleanos.';

REVOKE ALL ON FUNCTION app.engagement_brands() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.engagement_brands() TO fastgram_app;
