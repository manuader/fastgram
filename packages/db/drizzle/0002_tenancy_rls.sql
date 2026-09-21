-- Row Level Security por `companyId` — P1-DATA-010 · IMPL §2.4 capa 1.
--
-- ## Qué hace y por qué está escrito así
--
-- `app.current_company()` lee el GUC `app.current_company`, que `withCompany()` setea
-- con `set_config(..., true)` *dentro de la transacción*. Si el GUC no está, la función
-- devuelve NULL, la comparación `company_id = NULL` da NULL, y NULL no es TRUE: **sin
-- scope no se ve ni una fila**. Falla cerrado, que es la única forma en que una red de
-- seguridad sirve.
--
-- ### `FORCE ROW LEVEL SECURITY`
-- `ENABLE` solo no alcanza: el **dueño** de la tabla saltea sus propias políticas, y el
-- dueño es justamente el rol con el que corren las migraciones y, si nadie lo corrige,
-- también la aplicación. `FORCE` lo mete adentro de la política.
--
-- ### El rol `fastgram_app`
-- Un **superusuario saltea RLS incondicionalmente**, y ni `FORCE` ni ninguna política
-- lo cambian. Por eso hace falta un rol de aplicación que no sea superusuario: es la
-- diferencia entre tener RLS y creer que se tiene. La aplicación se conecta con él en
-- producción; los tests hacen `SET LOCAL ROLE fastgram_app` porque Testcontainers
-- arranca como superusuario.
--
-- ### Tablas sin política, y por qué
-- - `users` (DATA-001): identidad global, un usuario pertenece a N workspaces.
-- - `audio_tracks` (DATA-012): *"Global, no por workspace"*, literal del PRD.
-- - `trending_items` (DATA-023): global en el diagrama de relaciones del PRD.
-- - `onboarding_records` (DATA-030): existe **antes** de que haya workspace; su scope
--   es `ownerUserId` y lo sostiene el repositorio. Es el único hueco del modelo y está
--   acá escrito para que se vea, no para que se descubra.
--
-- `test/rls.int.test.ts` recorre `COMPANY_SCOPED_TABLES` del schema contra
-- `pg_policies`: agregar una tabla de cliente sin política rompe el test.

CREATE SCHEMA IF NOT EXISTS "app";
--> statement-breakpoint

-- STABLE y no IMMUTABLE: depende de un setting de sesión. Marcarla IMMUTABLE haría que
-- el planner cachee el valor entre transacciones — exactamente el bug que RLS evita.
CREATE OR REPLACE FUNCTION "app"."current_company"() RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('app.current_company', true), '')::uuid
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fastgram_app') THEN
    -- Sin LOGIN ni password: las credenciales las administra el entorno
    -- (P1-INFRA-006), nunca una migración versionada.
    CREATE ROLE "fastgram_app" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA "public" TO "fastgram_app";
--> statement-breakpoint
GRANT USAGE ON SCHEMA "app" TO "fastgram_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "fastgram_app";
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "fastgram_app";
--> statement-breakpoint
-- Para las tablas que cree cualquier migración futura con este mismo dueño.
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "fastgram_app";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT USAGE, SELECT ON SEQUENCES TO "fastgram_app";
--> statement-breakpoint

-- ── Raíz de la tenencia: la política compara `id`, no `company_id` ──────────────
ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "companies_tenant_isolation" ON "companies"
  USING ("companies"."id" = "app"."current_company"())
  WITH CHECK ("companies"."id" = "app"."current_company"());
--> statement-breakpoint

-- ── workspace_memberships ──
ALTER TABLE "workspace_memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workspace_memberships_tenant_isolation" ON "workspace_memberships"
  USING ("workspace_memberships"."company_id" = "app"."current_company"())
  WITH CHECK ("workspace_memberships"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── company_profiles ──
ALTER TABLE "company_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "company_profiles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_profiles_tenant_isolation" ON "company_profiles"
  USING ("company_profiles"."company_id" = "app"."current_company"())
  WITH CHECK ("company_profiles"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── brand_sources ──
ALTER TABLE "brand_sources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "brand_sources" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "brand_sources_tenant_isolation" ON "brand_sources"
  USING ("brand_sources"."company_id" = "app"."current_company"())
  WITH CHECK ("brand_sources"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── brand_source_snapshots ──
ALTER TABLE "brand_source_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "brand_source_snapshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "brand_source_snapshots_tenant_isolation" ON "brand_source_snapshots"
  USING ("brand_source_snapshots"."company_id" = "app"."current_company"())
  WITH CHECK ("brand_source_snapshots"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── content_angles ──
ALTER TABLE "content_angles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "content_angles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "content_angles_tenant_isolation" ON "content_angles"
  USING ("content_angles"."company_id" = "app"."current_company"())
  WITH CHECK ("content_angles"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── blitz_preferences ──
ALTER TABLE "blitz_preferences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "blitz_preferences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "blitz_preferences_tenant_isolation" ON "blitz_preferences"
  USING ("blitz_preferences"."company_id" = "app"."current_company"())
  WITH CHECK ("blitz_preferences"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── suggestions ──
ALTER TABLE "suggestions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "suggestions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "suggestions_tenant_isolation" ON "suggestions"
  USING ("suggestions"."company_id" = "app"."current_company"())
  WITH CHECK ("suggestions"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── contents ──
ALTER TABLE "contents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "contents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "contents_tenant_isolation" ON "contents"
  USING ("contents"."company_id" = "app"."current_company"())
  WITH CHECK ("contents"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── content_text_boxes ──
ALTER TABLE "content_text_boxes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "content_text_boxes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "content_text_boxes_tenant_isolation" ON "content_text_boxes"
  USING ("content_text_boxes"."company_id" = "app"."current_company"())
  WITH CHECK ("content_text_boxes"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── media ──
ALTER TABLE "media" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "media" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "media_tenant_isolation" ON "media"
  USING ("media"."company_id" = "app"."current_company"())
  WITH CHECK ("media"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── media_sets ──
ALTER TABLE "media_sets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "media_sets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "media_sets_tenant_isolation" ON "media_sets"
  USING ("media_sets"."company_id" = "app"."current_company"())
  WITH CHECK ("media_sets"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── influencers ──
ALTER TABLE "influencers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "influencers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "influencers_tenant_isolation" ON "influencers"
  USING ("influencers"."company_id" = "app"."current_company"())
  WITH CHECK ("influencers"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── influencer_assets ──
ALTER TABLE "influencer_assets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "influencer_assets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "influencer_assets_tenant_isolation" ON "influencer_assets"
  USING ("influencer_assets"."company_id" = "app"."current_company"())
  WITH CHECK ("influencer_assets"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── influencer_configs ──
ALTER TABLE "influencer_configs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "influencer_configs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "influencer_configs_tenant_isolation" ON "influencer_configs"
  USING ("influencer_configs"."company_id" = "app"."current_company"())
  WITH CHECK ("influencer_configs"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── connections ──
ALTER TABLE "connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "connections_tenant_isolation" ON "connections"
  USING ("connections"."company_id" = "app"."current_company"())
  WITH CHECK ("connections"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── warmed_accounts ──
ALTER TABLE "warmed_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "warmed_accounts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "warmed_accounts_tenant_isolation" ON "warmed_accounts"
  USING ("warmed_accounts"."company_id" = "app"."current_company"())
  WITH CHECK ("warmed_accounts"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── warmed_slot_balances ──
ALTER TABLE "warmed_slot_balances" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "warmed_slot_balances" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "warmed_slot_balances_tenant_isolation" ON "warmed_slot_balances"
  USING ("warmed_slot_balances"."company_id" = "app"."current_company"())
  WITH CHECK ("warmed_slot_balances"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── replacement_decisions ──
ALTER TABLE "replacement_decisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "replacement_decisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "replacement_decisions_tenant_isolation" ON "replacement_decisions"
  USING ("replacement_decisions"."company_id" = "app"."current_company"())
  WITH CHECK ("replacement_decisions"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── posts ──
ALTER TABLE "posts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "posts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "posts_tenant_isolation" ON "posts"
  USING ("posts"."company_id" = "app"."current_company"())
  WITH CHECK ("posts"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── automations ──
ALTER TABLE "automations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "automations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "automations_tenant_isolation" ON "automations"
  USING ("automations"."company_id" = "app"."current_company"())
  WITH CHECK ("automations"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── automation_slots ──
ALTER TABLE "automation_slots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "automation_slots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "automation_slots_tenant_isolation" ON "automation_slots"
  USING ("automation_slots"."company_id" = "app"."current_company"())
  WITH CHECK ("automation_slots"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── leads ──
ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "leads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "leads_tenant_isolation" ON "leads"
  USING ("leads"."company_id" = "app"."current_company"())
  WITH CHECK ("leads"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── ban_risk_assessments ──
ALTER TABLE "ban_risk_assessments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ban_risk_assessments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ban_risk_assessments_tenant_isolation" ON "ban_risk_assessments"
  USING ("ban_risk_assessments"."company_id" = "app"."current_company"())
  WITH CHECK ("ban_risk_assessments"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── api_keys ──
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "api_keys_tenant_isolation" ON "api_keys"
  USING ("api_keys"."company_id" = "app"."current_company"())
  WITH CHECK ("api_keys"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── idempotency_records ──
ALTER TABLE "idempotency_records" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "idempotency_records" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "idempotency_records_tenant_isolation" ON "idempotency_records"
  USING ("idempotency_records"."company_id" = "app"."current_company"())
  WITH CHECK ("idempotency_records"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── upload_reservations ──
ALTER TABLE "upload_reservations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "upload_reservations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "upload_reservations_tenant_isolation" ON "upload_reservations"
  USING ("upload_reservations"."company_id" = "app"."current_company"())
  WITH CHECK ("upload_reservations"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── quota_ledgers ──
ALTER TABLE "quota_ledgers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "quota_ledgers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "quota_ledgers_tenant_isolation" ON "quota_ledgers"
  USING ("quota_ledgers"."company_id" = "app"."current_company"())
  WITH CHECK ("quota_ledgers"."company_id" = "app"."current_company"());
--> statement-breakpoint

-- ── judgment_records ──
ALTER TABLE "judgment_records" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "judgment_records" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "judgment_records_tenant_isolation" ON "judgment_records"
  USING ("judgment_records"."company_id" = "app"."current_company"())
  WITH CHECK ("judgment_records"."company_id" = "app"."current_company"());
