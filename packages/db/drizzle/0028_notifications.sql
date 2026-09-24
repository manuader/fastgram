-- Notificaciones — `P5-NOTIF-001…004`, PRD §13 (canales, triggers N-09/N-10/
-- N-19/N-22, read/unread §13.3), `P1-OBS-005` (cola atascada / dead-letter),
-- `P3-OAUTH-005`/`011` (vencimiento de conexiones).
--
-- ## Qué agrega
--
-- 1. `notifications` — una fila por aviso, **por marca**, con `read_at`.
--    - `category`: código estable (lista en `core/notifications/categories.ts`).
--      `text` + CHECK y no enum: agregar una categoría no tiene que pelear con
--      `ALTER TYPE … ADD VALUE` dentro de la transacción del migrador.
--    - `dedupe_key`: **la** guarda contra avisar dos veces lo mismo. Los
--      detectores del worker miran ventanas que se solapan (un post fallido se
--      ve en varias vueltas); el `UNIQUE (company_id, dedupe_key)` con
--      `ON CONFLICT DO NOTHING` es lo que lo hace idempotente (trampa 37: un
--      INSERT se protege con una restricción, no con una lectura previa).
--    - `in_app`: si se muestra en la campana. Una categoría apagada para la app
--      y prendida para push se guarda igual (es el outbox del push) pero no se
--      lista.
--    - `push_status` / `push_attempts` / `push_error` / `pushed_at`: el outbox
--      de ntfy y Telegram. `pending` lo toma el despachador del worker;
--      `skipped` = no había canal o la categoría no va por push. El error es un
--      **código estable**, nunca la respuesta del proveedor (puede traer el
--      token en la URL de Telegram).
-- 2. `app.notification_brands()` — marcas vivas con su dueño, su nombre y su
--    zona, para los barridos del worker (sin tenant). Mismo patrón y misma
--    razón que `app.autopilot_brands()` (0017): con `fastgram_app` y FORCE RLS
--    un SELECT directo sobre `companies` devuelve cero filas sin error.
--
-- ## RLS
--
-- Tabla de cliente: misma política que el resto (`0002`). GRANT explícito
-- (trampa 17).

CREATE TABLE "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "category" text NOT NULL,
  "severity" text DEFAULT 'info' NOT NULL,
  "title" text NOT NULL,
  "body" text DEFAULT '' NOT NULL,
  "link" text,
  "dedupe_key" text,
  "in_app" boolean DEFAULT true NOT NULL,
  "read_at" timestamp with time zone,
  "push_status" text DEFAULT 'skipped' NOT NULL,
  "push_attempts" integer DEFAULT 0 NOT NULL,
  "push_error" text,
  "pushed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "notifications_category_check" CHECK ("category" IN (
    'post_published', 'post_failed', 'tiktok_draft_ready',
    'connection_expired', 'connection_expiring', 'autopilot_rejected',
    'campaign_ready', 'daily_summary', 'queue_stuck', 'queue_dead_letter'
  )),
  CONSTRAINT "notifications_severity_check"
    CHECK ("severity" IN ('info', 'success', 'warning', 'error')),
  CONSTRAINT "notifications_push_status_check"
    CHECK ("push_status" IN ('pending', 'sent', 'failed', 'skipped')),
  CONSTRAINT "notifications_push_attempts_check" CHECK ("push_attempts" >= 0),
  CONSTRAINT "notifications_title_len" CHECK (char_length("title") BETWEEN 1 AND 200),
  CONSTRAINT "notifications_body_len" CHECK (char_length("body") <= 2000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_company_dedupe_uq"
  ON "notifications" ("company_id", "dedupe_key")
  WHERE "dedupe_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "notifications_company_created_idx"
  ON "notifications" ("company_id", "created_at");
--> statement-breakpoint
CREATE INDEX "notifications_company_unread_idx"
  ON "notifications" ("company_id", "created_at")
  WHERE "read_at" IS NULL AND "in_app";
--> statement-breakpoint
CREATE INDEX "notifications_push_pending_idx"
  ON "notifications" ("company_id", "created_at")
  WHERE "push_status" = 'pending';
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications" TO "fastgram_app";
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notifications_tenant_isolation" ON "notifications"
  USING ("notifications"."company_id" = "app"."current_company"())
  WITH CHECK ("notifications"."company_id" = "app"."current_company"());
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.notification_brands()
RETURNS TABLE (
  company_id    uuid,
  owner_user_id uuid,
  name          text,
  timezone      text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.id, c.owner_user_id, c.name, c.timezone
  FROM public.companies c
  WHERE c.status <> 'soft_deleted'
  ORDER BY c.created_at, c.id;
$$;
--> statement-breakpoint
COMMENT ON FUNCTION app.notification_brands() IS
  'Barridos de notificaciones del worker (P5-NOTIF, P1-OBS-005): marcas vivas, '
  'su dueno, nombre y zona. SECURITY DEFINER para saltear el FORCE RLS de '
  'companies con fastgram_app. Los datos de cada marca se leen con su scope.';
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.notification_brands() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.notification_brands() TO fastgram_app;
