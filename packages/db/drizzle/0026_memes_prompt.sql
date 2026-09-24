-- 0026_memes_prompt — sprint 7: memes desde un prompt y selección inteligente
-- (`JV-6`, `P4-JV-003`). Sólo `blitz_prompt_requests`.
--
-- ## Por qué hace falta migración
--
-- «Crear desde prompt» ahora puede **buscar e importar** un meme de pantalla
-- verde cuando el Media Bank no tiene uno para el tema. Eso tarda (una búsqueda
-- de `yt-dlp` y una bajada) y cruza reintentos del job, así que el pedido
-- necesita recordar tres cosas que no se deducen de nada:
--
-- 1. `phase`: en qué anda un pedido `running` (`searching_meme` o NULL). Es lo
--    que la web muestra («Searching for a meme…») en vez de un «generando»
--    mudo de un minuto.
-- 2. `meme_searches`: cuántas búsquedas lleva el pedido. El dueño pidió nunca
--    más de 1–2 por pedido, y un reintento del job (pg-boss) sin este contador
--    volvería a buscar desde cero. El CHECK lo hace cumplir la base.
-- 3. `auto_media_id`: el clip que ya se importó. Un reintento lo retoma (espera
--    a que la normalización lo deje `ready`) en vez de bajar otro.
--    `ON DELETE SET NULL`: si el dueño borra el clip, el pedido no se rompe.
--
-- ## RLS
--
-- Columnas nuevas en una tabla que ya tiene `ENABLE` + `FORCE` + política por
-- `company_id` (`0012`): no cambia nada. Los GRANT de la tabla cubren las
-- columnas nuevas.

ALTER TABLE "blitz_prompt_requests" ADD COLUMN "phase" text;
--> statement-breakpoint
ALTER TABLE "blitz_prompt_requests"
  ADD COLUMN "meme_searches" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "blitz_prompt_requests"
  ADD COLUMN "auto_media_id" uuid REFERENCES "media"("media_id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "blitz_prompt_requests"
  ADD CONSTRAINT "blitz_prompt_requests_phase"
  CHECK ("phase" IS NULL OR "phase" IN ('searching_meme'));
--> statement-breakpoint
ALTER TABLE "blitz_prompt_requests"
  ADD CONSTRAINT "blitz_prompt_requests_meme_searches_range"
  CHECK ("meme_searches" BETWEEN 0 AND 2);
