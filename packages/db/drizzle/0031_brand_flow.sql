-- 0031_brand_flow — flujo de marca y audio extraído (sprint 7, segunda tanda, agente H).
--
-- `P1-ONB-005` (sub-pasos del análisis), `P1-ONB-007` (oferta post-análisis,
-- `D-04`, `FR-011.5.1`) y "Extract from a video" de la biblioteca de audio.
--
-- ## Qué agrega
--
-- 1. `brand_sources.analysis_phase`: la fase **real** en la que está el handler
--    de `brand-source-analysis` (`apps/worker/src/brand/analysis-handler.ts`).
--    La escribe el worker al entrar a cada etapa, siempre con
--    `WHERE status = 'analyzing'`, y la limpia (`NULL`) al completar o fallar.
--    `NULL` con `analyzing` = reclamada pero sin empezar (o `/reanalyse`
--    todavía sin worker). No hay porcentajes: son etapas que el código recorre.
-- 2. `company_profiles.post_analysis_offer_dismissed_at`: el usuario descartó
--    la tarjeta "conectá tus cuentas e importá tus posts" de `/brand`. Por
--    marca, en la base y no en el navegador: la misma marca se abre desde la
--    Mac y desde el VPS.
-- 3. `brand_audio_tracks.origin` += `extracted`: la pista sacada con FFmpeg de
--    un video del Media Bank (cola `audio-extract`). El estado del trabajo vive
--    en un JSON del storage, como el de `media-import` (sin tabla nueva).

ALTER TABLE "brand_sources" ADD COLUMN "analysis_phase" text;
--> statement-breakpoint
ALTER TABLE "brand_sources" ADD CONSTRAINT "brand_sources_analysis_phase_check"
  CHECK ("analysis_phase" IS NULL
         OR "analysis_phase" IN ('collecting', 'reading_links', 'synthesizing', 'verifying'));
--> statement-breakpoint
ALTER TABLE "company_profiles" ADD COLUMN "post_analysis_offer_dismissed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "brand_audio_tracks" DROP CONSTRAINT "brand_audio_tracks_origin_check";
--> statement-breakpoint
ALTER TABLE "brand_audio_tracks" ADD CONSTRAINT "brand_audio_tracks_origin_check"
  CHECK ("origin" IN ('upload', 'import', 'extracted'));
