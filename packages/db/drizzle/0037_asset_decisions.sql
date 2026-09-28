-- 0037_asset_decisions — el decisor de assets (sprint 9, agente O).
-- `PU-S9-007` (Laya como motor de juicio) y `PU-S9-008` (decisor), PRD §2.7
-- D-18, §9.15.3 (reglas 2 y 3: pesos en código, respuestas crudas persistidas).
--
-- ## Dos cambios
--
-- 1. `judgment_adapter` suma `laya`. `judgment_records` (`DATA-033`) guarda qué
--    adaptador respondió, y el experimento de §25.4 compara adaptadores sobre el
--    mismo estado: registrar a Laya como `jev` (habla el mismo protocolo)
--    mezclaría dos modelos distintos bajo un nombre. Jev de TypeSafe sigue siendo
--    `jev`.
--
--    `ALTER TYPE … ADD VALUE` va dentro de la transacción del migrador (Postgres
--    ≥ 12 lo permite) y el valor **no se usa** en esta migración: no se puede
--    hasta que la transacción commitee (ver `0013_media_origin_brand_kit.sql`).
--    `IF NOT EXISTS` la hace reejecutable.
--
-- 2. `asset_decisions`: una fila por decisión (no por llamada, eso es
--    `judgment_records`). Guarda lo necesario para **recalcular** la decisión con
--    otros pesos sin volver a inferir (§9.15.3.2): los candidatos, lo que el
--    filtro en código sacó, las respuestas crudas por candidato y dimensión, los
--    pesos y su versión, la versión de las preguntas, el elegido, el motivo, el
--    adaptador/modelo y la latencia total.
--
-- ## Lo que no guarda, a propósito
--
-- Ni el estado del juicio ni la descripción de los candidatos: son texto de
-- terceros (títulos de YouTube, etiquetas de un modelo de visión). Misma línea de
-- retención que `judgment_records` (`stateHash`, nunca el estado). Los ids
-- alcanzan para volver al asset.
--
-- `idea` sí: la escribió el dueño (el prompt o el título del ángulo), y sin ella
-- las preferencias (agente Q, D-22) no pueden saber qué se estaba buscando.
--
-- ## RLS
--
-- Por marca, con la política estándar (`company_id = app.current_company()`), y
-- en `COMPANY_SCOPED_TABLES` para que `rls.int.test.ts` la verifique.

ALTER TYPE "judgment_adapter" ADD VALUE IF NOT EXISTS 'laya';
--> statement-breakpoint
CREATE TABLE "asset_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "subject_type" text NOT NULL,
  "subject_id" text,
  "role" text NOT NULL,
  "format" text NOT NULL,
  "idea" text,
  "candidates" jsonb NOT NULL,
  "excluded" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "scored" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "weights" jsonb NOT NULL,
  "weights_version" text NOT NULL,
  "questions_version" text NOT NULL,
  "chosen_id" text,
  "mode" text NOT NULL,
  "reason" text NOT NULL,
  "adapter" text,
  "model" text,
  "latency_ms" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "asset_decisions_mode_check"
    CHECK ("mode" IN ('judged', 'fallback', 'all_unsafe', 'empty')),
  CONSTRAINT "asset_decisions_latency_check" CHECK ("latency_ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX "asset_decisions_company_created_idx"
  ON "asset_decisions" ("company_id", "created_at");
--> statement-breakpoint
CREATE INDEX "asset_decisions_subject_idx"
  ON "asset_decisions" ("company_id", "subject_type", "subject_id");
--> statement-breakpoint
-- Trampa 17: GRANT explícito aunque el DEFAULT PRIVILEGES de 0002 lo cubra.
GRANT SELECT, INSERT, UPDATE, DELETE ON "asset_decisions" TO "fastgram_app";
--> statement-breakpoint
ALTER TABLE "asset_decisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "asset_decisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "asset_decisions_tenant_isolation" ON "asset_decisions"
  USING ("asset_decisions"."company_id" = "app"."current_company"())
  WITH CHECK ("asset_decisions"."company_id" = "app"."current_company"());
