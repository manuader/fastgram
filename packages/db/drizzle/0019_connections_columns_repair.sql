-- Reparación de la 0015 (2026-09-24).
--
-- La 0015 se escribió en varias pasadas mientras otros agentes ya levantaban la
-- app: una base que la aplicó en una versión intermedia quedó con las columnas
-- viejas de `connections`, y Drizzle no vuelve a correr una migración ya
-- registrada. Se vio en la base de desarrollo del dueño (un 500
-- `42703 errorMissingColumn` al agregar una fuente social) y antes en
-- `fastgram_worker`. Todo es `IF NOT EXISTS`: en una base sana no cambia nada.
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "display_name" text;
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "avatar_url" text;
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "refresh_token_expiry" timestamp with time zone;
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "token_issued_at" timestamp with time zone;
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "status_reason" text;
CREATE UNIQUE INDEX IF NOT EXISTS "connections_company_account_uq"
  ON "connections" ("company_id", "platform", "platform_user_id");
