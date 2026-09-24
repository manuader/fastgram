-- Automations (campañas multi-semana) — PRD `MOD-015` / `FR-150`, `DATA-021`,
-- `DATA-022`, `P3-AUTO-001…013`.
--
-- ## Por qué hace falta migración
--
-- Las dos tablas nacieron en `0000` con los campos de `DATA-021`/`DATA-022` y
-- nadie las usó. Para las dos máquinas de estados y el camino post-launch
-- faltan cosas que el PRD no lista y el código no puede deducir:
--
-- 1. En `automations`:
--    - `updated_at`: la campaña cambia de estado y se renombra (`DATA-021`
--      sólo da `createdAt`); el listado muestra "actualizada hace".
--    - `posting_times`: los horarios fijos del wizard (`HH:MM` locales).
--      `NULL` = los de la estrategia de la marca.
--    - `generation_quota`: el tope de generaciones de la campaña (el PRD
--      nombra `generationQuotaUsed` pero no el tope; va 2 por slot).
--    - `failure_code`: por qué la campaña quedó `FAILED` (código estable).
--    - `launched_at`, `cancelled_at`, `completed_at`: para el detalle y para
--      que el barrido de build sepa desde cuándo mira.
-- 2. En `automation_slots`:
--    - `slot_index`: posición en la grilla (día × turno). Único por campaña:
--      es la guarda contra una doble generación de la grilla.
--    - `error_code`: el motivo **nuestro** de un fallo que no está en el enum
--      del PRD (`no_media`, `invalid_state`, `build_failed`…). `failure_reason`
--      sigue siendo el del PRD.
--    - `dedup_fingerprint`: la huella del texto normalizado (dedup
--      `P3-AUTO-007`; ver `packages/core/src/automations/dedup.ts` para por qué
--      es léxico y no pgvector).
--    - `generation_attempts` y `generating_since`: cuántas copias costó el
--      slot y desde cuándo está `GENERATING` (un worker muerto lo deja ahí;
--      pasado un tope vuelve a `PENDING_GEN`).
-- 3. En `planned_slots` (`0014`): `automation_slot_id` y `connection_id`. El
--    launch reserva los slots de la campaña como slots planificados, y el
--    barrido de publicación los convierte en posts con **la conexión y las
--    captions que eligió la campaña** (sin estas columnas usaría "la única
--    conexión activa de la red" y un caption vacío).
-- 4. Índices para lo que se consulta: los posts y los slots planificados de
--    un slot de campaña.
--
-- ## RLS
--
-- Sin tablas nuevas: las columnas heredan las políticas de `0002` y `0014`.

ALTER TABLE "automations" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "posting_times" text[];
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "generation_quota" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "failure_code" text;
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "launched_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "cancelled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "completed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_generation_quota_used_nonnegative"
  CHECK ("generation_quota_used" >= 0);
--> statement-breakpoint
CREATE INDEX "automations_company_status_idx" ON "automations" ("company_id", "status");
--> statement-breakpoint
ALTER TABLE "automation_slots" ADD COLUMN "slot_index" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "automation_slots" ADD COLUMN "error_code" text;
--> statement-breakpoint
ALTER TABLE "automation_slots" ADD COLUMN "dedup_fingerprint" text;
--> statement-breakpoint
ALTER TABLE "automation_slots" ADD COLUMN "generation_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "automation_slots" ADD COLUMN "generating_since" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_slots_automation_index_uq"
  ON "automation_slots" ("automation_id", "slot_index");
--> statement-breakpoint
CREATE INDEX "automation_slots_company_fingerprint_idx"
  ON "automation_slots" ("company_id", "dedup_fingerprint")
  WHERE "dedup_fingerprint" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "planned_slots" ADD COLUMN "automation_slot_id" uuid
  REFERENCES "automation_slots"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "planned_slots" ADD COLUMN "connection_id" uuid
  REFERENCES "connections"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "planned_slots_automation_slot_idx"
  ON "planned_slots" ("automation_slot_id")
  WHERE "automation_slot_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "posts_automation_slot_idx"
  ON "posts" ("automation_slot_id")
  WHERE "automation_slot_id" IS NOT NULL;
