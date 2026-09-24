-- Redes de D-09 en conexiones y posts, y lo que el OAuth por marca necesita.
-- `PU-PUB-001`, `PU-PUB-002`, `P3-OAUTH-002` · `docs/PLAN-USO-PERSONAL.md` §5
-- · PRD §2.7 `D-09`, `D-10`.
--
-- ## Qué agrega
--
-- 1. `x`, `threads` y `facebook` a `social_platform` (DATA-016, conexiones) y a
--    `post_platform` (DATA-020, posts). Van al final: `ADD VALUE` no reordena,
--    y el orden del tipo es el de las listas de `schema/enums.ts`.
-- 2. En `connections`: `display_name`, `avatar_url` (la identidad que devolvió
--    la plataforma), `refresh_token_expiry` (TikTok lo da), `token_issued_at`
--    (Instagram y Threads no refrescan un token de menos de 24 h) y
--    `status_reason` (código estable de por qué quedó `expired`/`revoked`).
-- 3. Un índice único `(company_id, platform, platform_user_id)`: reconectar la
--    misma cuenta en la misma marca actualiza la fila en vez de duplicarla. Sin
--    él, cada reconexión sumaría una conexión activa más y `connection_ambiguous`
--    (FR-060) saltaría para siempre.
--
-- ## `ADD VALUE` dentro de la transacción del migrador
--
-- Postgres ≥ 12 lo permite, pero el valor nuevo **no se puede usar** hasta que
-- la transacción confirma. El migrador de Drizzle corre todas las migraciones
-- pendientes en una sola transacción, así que ninguna migración posterior que
-- se aplique en la misma corrida puede usar `'x'`, `'threads'` ni `'facebook'`
-- como literal (un `INSERT`, un `CHECK`, un índice parcial). Si hace falta,
-- va en una migración que se aplique en otra corrida.
--
-- `IF NOT EXISTS`: una base que ya tenga el valor (aplicado a mano) no rompe.
--
-- ## El índice único y las filas existentes
--
-- Hasta este sprint no había OAuth, así que `connections` sólo tiene filas de
-- fixtures o cargadas a mano. Si una base tuviera dos filas de la misma cuenta
-- en la misma marca, este `CREATE UNIQUE INDEX` falla: es a propósito — cuál
-- de las dos conservar (sus posts apuntan a una) no lo decide una migración.

ALTER TYPE "social_platform" ADD VALUE IF NOT EXISTS 'x';
--> statement-breakpoint
ALTER TYPE "social_platform" ADD VALUE IF NOT EXISTS 'threads';
--> statement-breakpoint
ALTER TYPE "social_platform" ADD VALUE IF NOT EXISTS 'facebook';
--> statement-breakpoint
ALTER TYPE "post_platform" ADD VALUE IF NOT EXISTS 'x';
--> statement-breakpoint
ALTER TYPE "post_platform" ADD VALUE IF NOT EXISTS 'threads';
--> statement-breakpoint
ALTER TYPE "post_platform" ADD VALUE IF NOT EXISTS 'facebook';
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "display_name" text;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "avatar_url" text;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "refresh_token_expiry" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "token_issued_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "status_reason" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connections_company_account_uq"
  ON "connections" ("company_id", "platform", "platform_user_id");
