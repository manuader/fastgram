-- «Crear desde prompt» en Blitz — `EXT-009`, `PU-BLITZ-003`.
--
-- ## Qué agrega
--
-- 1. `blitz_prompt_requests`: un pedido del usuario («hacé un meme sobre los
--    lunes»), con el formato forzado opcional, la cantidad (1–5) y **en qué
--    quedó**. El job corre en el worker y puede fallar por algo que el usuario
--    tiene que ver y arreglar —no hay LLM, no hay media para el formato que
--    forzó—, así que el estado tiene que vivir en algún lado que la API pueda
--    leer con el scope del workspace. pg-boss no sirve para eso: sus tablas no
--    tienen RLS y un job completado se archiva.
-- 2. `suggestions.prompt_request_id`: qué pedido produjo cada sugerencia. Es
--    lo que las pone **primeras** en la cola (el `QUEUE_ORDER` de `db`) y lo
--    que dibuja el chip «From your prompt» en el deck.
--
-- ## Por qué las sugerencias no se guardan como array en el pedido
--
-- Serían dos verdades: el array y el `prompt_request_id` de cada fila. La
-- lista sale de `suggestions` filtrando por el pedido.
--
-- ## Por qué `status` es texto con CHECK y no un enum
--
-- Un `ALTER TYPE … ADD VALUE` no corre dentro de una transacción en las
-- versiones viejas de Postgres, y el migrador de drizzle envuelve cada archivo
-- en una. Con un CHECK, sumar un estado es reemplazar la restricción.
--
-- ## RLS
--
-- Mismo patrón que `0002_tenancy_rls.sql`: `ENABLE` + `FORCE` + política por
-- `company_id`. `test/rls.int.test.ts` recorre `COMPANY_SCOPED_TABLES` y falla
-- si esta tabla queda sin política. Los grants al rol de aplicación los da el
-- `ALTER DEFAULT PRIVILEGES` de `0002`.

CREATE TABLE "blitz_prompt_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "prompt" text NOT NULL,
  "content_type" "suggestion_content_type",
  "count" integer NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "failure_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "blitz_prompt_requests_prompt_length"
    CHECK (char_length("prompt") between 3 and 500),
  CONSTRAINT "blitz_prompt_requests_count_range" CHECK ("count" between 1 and 5),
  CONSTRAINT "blitz_prompt_requests_status"
    CHECK ("status" in ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "blitz_prompt_requests_company_created_idx"
  ON "blitz_prompt_requests" USING btree ("company_id", "created_at");
--> statement-breakpoint
ALTER TABLE "blitz_prompt_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "blitz_prompt_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "blitz_prompt_requests_tenant_isolation" ON "blitz_prompt_requests"
  USING ("blitz_prompt_requests"."company_id" = "app"."current_company"())
  WITH CHECK ("blitz_prompt_requests"."company_id" = "app"."current_company"());
--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "prompt_request_id" uuid
  REFERENCES "blitz_prompt_requests"("id") ON DELETE set null;
--> statement-breakpoint
COMMENT ON TABLE "blitz_prompt_requests" IS
  'Pedidos de crear desde prompt (EXT-009, PU-BLITZ-003). No esta en el PRD como '
  'entidad. failure_reason es un codigo estable de core (PROMPT_FAILURE_REASONS).';
--> statement-breakpoint
COMMENT ON COLUMN "suggestions"."prompt_request_id" IS
  'El pedido de crear desde prompt que la produjo, o NULL si salio del refill. '
  'Las que lo tienen van primeras en la cola. No esta en DATA-007.';
