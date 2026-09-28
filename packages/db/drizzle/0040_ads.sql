-- Anuncios pagos con la Marketing API de Meta — sprint 9 (agente R),
-- `PU-S9-012`/`013`, `D-21`.
--
-- ## Qué agrega
--
-- 1. `ad_accounts`: la conexión de anuncios de una marca (una por marca),
--    **aparte** de `connections`: pedir permisos de plata no tiene que ser
--    parte de conectar IG para publicar. `access_token` es ciphertext
--    (`TokenCipher`, como `connections`). `status = 'pending'` entre el login
--    y la elección de cuenta publicitaria/Página.
-- 2. `ad_campaigns` / `ad_sets` / `ads`: lo creado en Meta, siempre PAUSED al
--    nacer (`D-21`). Los topes (`daily_cap_minor`, `total_cap_minor`) son
--    unidades mínimas de la moneda de la cuenta; el CHECK repite la regla del
--    dominio (diario > 0, total ≥ diario) porque es barato y no depende de que
--    la ruta de escritura sea la esperada.
-- 3. `ad_experiments`: el A/B de una campaña (sus variantes son los
--    `ad_sets` con `variant_label`). `platform_study_id` si Meta aceptó el
--    `ad_study`; el ganador lo decide nuestra regla (`core/ads/experiment.ts`).
-- 4. `ad_insights_daily`: una fila por anuncio y día; el sync hace upsert por
--    `(company_id, ad_id, date)`.
-- 5. `ad_actions`: auditoría + previews de confirmación. Un preview es una
--    fila `activation_preview` con token de un solo uso, topes y máximo
--    mostrado; la activación la consume (`consumed_at`) en la misma
--    transacción, con `UPDATE … WHERE consumed_at IS NULL` (trampa 37: la
--    guarda de un solo uso es la sentencia, no una lectura previa).
-- 6. `app.ads_sync_brands()`: marcas con cuenta publicitaria activa, para el
--    barrido del worker sin tenant. Mismo patrón y razón que
--    `app.notification_brands()` (0028).
-- 7. Categoría de aviso `ad_spend_cap` (ver abajo).
--
-- ## RLS
--
-- Las seis tablas son de cliente: misma política que el resto (0002) y GRANT
-- explícito (trampa 17).

CREATE TABLE "ad_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "provider" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "access_token" text,
  "token_expires_at" timestamp with time zone,
  "meta_user_id" text,
  "ad_account_id" text,
  "ad_account_name" text,
  "currency" text,
  "timezone_name" text,
  "page_id" text,
  "page_name" text,
  "instagram_user_id" text,
  "instagram_username" text,
  "connected_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ad_accounts_provider_check" CHECK ("provider" IN ('meta', 'fake')),
  CONSTRAINT "ad_accounts_status_check"
    CHECK ("status" IN ('pending', 'active', 'expired', 'revoked')),
  -- Activa = se puede operar: cuenta, moneda y Página elegidas.
  CONSTRAINT "ad_accounts_active_complete_check" CHECK (
    "status" <> 'active'
    OR ("ad_account_id" IS NOT NULL AND "currency" IS NOT NULL AND "page_id" IS NOT NULL)
  ),
  CONSTRAINT "ad_accounts_act_prefix_check"
    CHECK ("ad_account_id" IS NULL OR "ad_account_id" LIKE 'act\_%')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ad_accounts_company_uq" ON "ad_accounts" ("company_id");
--> statement-breakpoint
CREATE TABLE "ad_campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "ad_account_row_id" uuid NOT NULL REFERENCES "ad_accounts"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "objective" text NOT NULL,
  "status" text DEFAULT 'PAUSED' NOT NULL,
  "paused_reason" text DEFAULT 'created',
  "daily_cap_minor" bigint NOT NULL,
  "total_cap_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "is_test" boolean DEFAULT false NOT NULL,
  "start_date" date NOT NULL,
  "end_time" timestamp with time zone,
  "targeting" jsonb NOT NULL,
  "destination_url" text,
  "result_action_type" text,
  "platform_campaign_id" text NOT NULL,
  "paused_at" timestamp with time zone,
  "activated_at" timestamp with time zone,
  "last_synced_at" timestamp with time zone,
  "last_sync_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ad_campaigns_status_check" CHECK ("status" IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
  CONSTRAINT "ad_campaigns_paused_reason_check" CHECK (
    "paused_reason" IS NULL
    OR "paused_reason" IN ('created', 'manual', 'daily_cap', 'total_cap')
  ),
  CONSTRAINT "ad_campaigns_caps_check"
    CHECK ("daily_cap_minor" > 0 AND "total_cap_minor" >= "daily_cap_minor"),
  CONSTRAINT "ad_campaigns_name_len" CHECK (char_length("name") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE INDEX "ad_campaigns_company_created_idx" ON "ad_campaigns" ("company_id", "created_at");
--> statement-breakpoint
CREATE TABLE "ad_sets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "campaign_id" uuid NOT NULL REFERENCES "ad_campaigns"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "variant_label" text,
  "daily_budget_minor" bigint NOT NULL,
  "platform_ad_set_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ad_sets_budget_check" CHECK ("daily_budget_minor" > 0)
);
--> statement-breakpoint
CREATE INDEX "ad_sets_campaign_idx" ON "ad_sets" ("company_id", "campaign_id");
--> statement-breakpoint
CREATE TABLE "ads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "campaign_id" uuid NOT NULL REFERENCES "ad_campaigns"("id") ON DELETE cascade,
  "ad_set_id" uuid NOT NULL REFERENCES "ad_sets"("id") ON DELETE cascade,
  "content_id" uuid REFERENCES "contents"("id") ON DELETE set null,
  "name" text NOT NULL,
  "media_kind" text NOT NULL,
  "message" text NOT NULL,
  "platform_ad_id" text NOT NULL,
  "platform_creative_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ads_media_kind_check" CHECK ("media_kind" IN ('video', 'image'))
);
--> statement-breakpoint
CREATE INDEX "ads_campaign_idx" ON "ads" ("company_id", "campaign_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "ads_platform_uq" ON "ads" ("company_id", "platform_ad_id");
--> statement-breakpoint
CREATE TABLE "ad_experiments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "campaign_id" uuid NOT NULL REFERENCES "ad_campaigns"("id") ON DELETE cascade,
  "metric" text NOT NULL,
  "platform_study_id" text,
  "platform_study_error" text,
  "winner_ad_set_id" uuid REFERENCES "ad_sets"("id") ON DELETE set null,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ad_experiments_metric_check" CHECK ("metric" IN ('ctr', 'cvr'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ad_experiments_campaign_uq" ON "ad_experiments" ("company_id", "campaign_id");
--> statement-breakpoint
CREATE TABLE "ad_insights_daily" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "campaign_id" uuid NOT NULL REFERENCES "ad_campaigns"("id") ON DELETE cascade,
  "ad_id" uuid NOT NULL REFERENCES "ads"("id") ON DELETE cascade,
  "date" date NOT NULL,
  "spend_minor" bigint DEFAULT 0 NOT NULL,
  "impressions" bigint DEFAULT 0 NOT NULL,
  "clicks" bigint DEFAULT 0 NOT NULL,
  "reach" bigint,
  "actions" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "action_values_minor" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ad_insights_daily_nonneg_check"
    CHECK ("spend_minor" >= 0 AND "impressions" >= 0 AND "clicks" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ad_insights_daily_ad_date_uq"
  ON "ad_insights_daily" ("company_id", "ad_id", "date");
--> statement-breakpoint
CREATE INDEX "ad_insights_daily_campaign_date_idx"
  ON "ad_insights_daily" ("company_id", "campaign_id", "date");
--> statement-breakpoint
CREATE TABLE "ad_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "campaign_id" uuid NOT NULL REFERENCES "ad_campaigns"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "actor" text NOT NULL,
  "preview_action" text,
  "confirmation_token" text,
  "preview_id" uuid,
  "daily_cap_minor" bigint,
  "total_cap_minor" bigint,
  "max_spend_minor" bigint,
  "expires_at" timestamp with time zone,
  "consumed_at" timestamp with time zone,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ad_actions_kind_check" CHECK ("kind" IN (
    'create', 'activation_preview', 'activate', 'pause', 'budget_change',
    'cap_pause', 'cap_pause_failed'
  )),
  CONSTRAINT "ad_actions_actor_check" CHECK ("actor" IN ('owner', 'guard')),
  -- Un preview tiene todo lo que se mostró; lo demás no lleva token.
  CONSTRAINT "ad_actions_preview_shape_check" CHECK (
    ("kind" = 'activation_preview') = ("confirmation_token" IS NOT NULL)
    AND (
      "kind" <> 'activation_preview'
      OR (
        "preview_action" IN ('activate', 'budget_increase')
        AND "max_spend_minor" IS NOT NULL
        AND "daily_cap_minor" IS NOT NULL
        AND "total_cap_minor" IS NOT NULL
        AND "expires_at" IS NOT NULL
      )
    )
  )
);
--> statement-breakpoint
CREATE INDEX "ad_actions_campaign_created_idx"
  ON "ad_actions" ("company_id", "campaign_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "ad_actions_token_uq"
  ON "ad_actions" ("confirmation_token") WHERE "confirmation_token" IS NOT NULL;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ad_accounts', 'ad_campaigns', 'ad_sets', 'ads', 'ad_experiments',
    'ad_insights_daily', 'ad_actions'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO fastgram_app', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (%I.company_id = app.current_company()) '
      'WITH CHECK (%I.company_id = app.current_company())',
      t || '_tenant_isolation', t, t, t
    );
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ads_sync_brands()
RETURNS TABLE (
  company_id uuid,
  name       text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.id, c.name
  FROM public.companies c
  JOIN public.ad_accounts a ON a.company_id = c.id
  WHERE c.status <> 'soft_deleted' AND a.status = 'active'
  ORDER BY c.created_at, c.id;
$$;
--> statement-breakpoint
COMMENT ON FUNCTION app.ads_sync_brands() IS
  'Barrido de insights y guardia de topes de anuncios (sprint 9): marcas vivas '
  'con cuenta publicitaria activa. SECURITY DEFINER para saltear el FORCE RLS '
  'de companies con fastgram_app. Los datos de cada marca se leen con su scope.';
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ads_sync_brands() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ads_sync_brands() TO fastgram_app;
--> statement-breakpoint
-- ## Categoría de aviso `ad_spend_cap`
--
-- notifications_category_check += 'ad_spend_cap'
--
-- Se **agrega** al CHECK vigente en vez de reescribirlo con una lista fija:
-- otra migración del mismo sprint puede haber sumado su propia categoría, y
-- una lista escrita acá la borraría. `pg_get_constraintdef` devuelve
-- `CHECK ((category = ANY (ARRAY['a'::text, …])))`; se inserta antes del `]`.
-- La línea de arriba (`+=`) es la que lee `notifications.test.ts` (api).
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  WHERE c.conname = 'notifications_category_check'
    AND c.conrelid = 'public.notifications'::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'notifications_category_check no existe';
  END IF;
  IF position('''ad_spend_cap''' IN def) = 0 THEN
    IF position(']' IN def) = 0 THEN
      RAISE EXCEPTION 'forma inesperada de notifications_category_check: %', def;
    END IF;
    EXECUTE 'ALTER TABLE public.notifications DROP CONSTRAINT notifications_category_check';
    EXECUTE 'ALTER TABLE public.notifications ADD CONSTRAINT notifications_category_check '
      || regexp_replace(def, '\]', ', ''ad_spend_cap''::text]');
  END IF;
END
$$;
