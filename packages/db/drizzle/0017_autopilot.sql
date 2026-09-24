-- Piloto automático — `PU-AUTO-001`, `PU-AUTO-002`, `PU-AUTO-003` ·
-- `docs/PLAN-USO-PERSONAL.md` §2 pasos 3–5 · PRD §2.7 `D-08`, §25.3 `JV-3`.
--
-- ## Qué agrega
--
-- 1. `autopilot_decisions` — una fila por sugerencia que el piloto juzgó:
--    `approved` (se aceptó y se agendó), `rejected` (se descartó, con motivo) o
--    `held` (el juicio no respondió: queda en la cola para revisión manual).
--    Guarda las **respuestas crudas** del juicio en `details`, así que cambiar
--    un umbral se recalcula sobre lo guardado sin reinferir (§9.15.3 regla 2).
--    Es de donde sale el resumen diario (`GET /autopilot/digest`).
-- 2. `autopilot_runs` — una fila por marca con la última corrida: cuándo, qué
--    pasó y los contadores. Es el "estado por marca" del pedido.
-- 3. `app.autopilot_brands()` — la lista de marcas vivas con su dueño y su
--    autonomía, para el barrido del cron.
--
-- ## Una decisión por sugerencia
--
-- `UNIQUE (suggestion_id)`: el piloto nunca juzga dos veces la misma pieza.
-- Es la guarda de dos corridas solapadas (trampa 37: un INSERT se protege con
-- una restricción, no con una lectura previa), y es también lo que hace que
-- una pieza `held` no la vuelva a tomar el piloto: se queda para el humano.
--
-- ## `app.autopilot_brands()` y por qué SECURITY DEFINER
--
-- El barrido pregunta **por encima** del tenant ("¿qué marcas hay?"), igual que
-- `app.resolve_api_key` (`0003`). `companies` y `brand_strategies` tienen
-- `FORCE ROW LEVEL SECURITY`: con `fastgram_app` una consulta directa devuelve
-- cero filas y el piloto no correría nunca, sin fallar (en desarrollo anda
-- porque la conexión es superusuaria: la clase de la trampa 16). Devuelve lo
-- mínimo —ids y la autonomía—; los datos de cada marca se leen después con su
-- scope.
--
-- ## RLS
--
-- Las dos tablas son de cliente y van bajo la misma política que el resto
-- (`0002_tenancy_rls.sql`). Los GRANT se repiten explícitos (trampa 17).

CREATE TABLE "autopilot_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "suggestion_id" uuid NOT NULL REFERENCES "suggestions"("id") ON DELETE cascade,
  "decision" text NOT NULL,
  "reason" text,
  "content_id" uuid REFERENCES "contents"("id") ON DELETE set null,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "autopilot_decisions_decision_check"
    CHECK ("decision" IN ('approved', 'rejected', 'held'))
);

CREATE UNIQUE INDEX "autopilot_decisions_suggestion_uq"
  ON "autopilot_decisions" ("suggestion_id");
CREATE INDEX "autopilot_decisions_company_created_idx"
  ON "autopilot_decisions" ("company_id", "created_at");

CREATE TABLE "autopilot_runs" (
  "company_id" uuid PRIMARY KEY NOT NULL
    REFERENCES "companies"("id") ON DELETE cascade,
  "last_run_at" timestamp with time zone NOT NULL,
  "outcome" text NOT NULL,
  "queue_target" integer NOT NULL,
  "queued" integer NOT NULL,
  "approved" integer NOT NULL,
  "rejected" integer NOT NULL,
  "held" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "autopilot_runs_counts_check"
    CHECK ("queue_target" >= 0 AND "queued" >= 0 AND "approved" >= 0
           AND "rejected" >= 0 AND "held" >= 0)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON "autopilot_decisions" TO "fastgram_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "autopilot_runs" TO "fastgram_app";

ALTER TABLE "autopilot_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "autopilot_decisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "autopilot_decisions_tenant_isolation" ON "autopilot_decisions"
  USING ("autopilot_decisions"."company_id" = "app"."current_company"())
  WITH CHECK ("autopilot_decisions"."company_id" = "app"."current_company"());

ALTER TABLE "autopilot_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "autopilot_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "autopilot_runs_tenant_isolation" ON "autopilot_runs"
  USING ("autopilot_runs"."company_id" = "app"."current_company"())
  WITH CHECK ("autopilot_runs"."company_id" = "app"."current_company"());

CREATE OR REPLACE FUNCTION app.autopilot_brands()
RETURNS TABLE (
  company_id    uuid,
  owner_user_id uuid,
  autonomy      text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.id, c.owner_user_id, s.autonomy::text
  FROM public.companies c
  LEFT JOIN public.brand_strategies s ON s.company_id = c.id
  WHERE c.status <> 'soft_deleted'
  ORDER BY c.created_at, c.id;
$$;

COMMENT ON FUNCTION app.autopilot_brands() IS
  'Barrido del piloto automatico (PU-AUTO-001): marcas vivas, su dueno y la '
  'autonomia de su estrategia (NULL = nunca guardo una). Sin scope de companyId '
  'porque la pregunta es sobre todas; SECURITY DEFINER para saltear el FORCE RLS '
  'de companies y brand_strategies con fastgram_app. Devuelve solo ids.';

REVOKE ALL ON FUNCTION app.autopilot_brands() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.autopilot_brands() TO fastgram_app;
