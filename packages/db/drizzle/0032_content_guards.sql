-- 0032_content_guards — guardas de contenido e influencer de la pieza (sprint 7,
-- segunda tanda, agente I).
--
-- ## Qué agrega
--
-- `contents.influencer_id`: el personaje con el que se armó la pieza. El dominio
-- ya lo tenía (`Content.influencerId`, `core/content/content.ts`, lo llena el
-- accept de Blitz desde la sugerencia) pero nadie lo persistía: la pieza aceptada
-- perdía al influencer. Lo lee el auto-slot para preferir las cuentas marcadas en
-- la Configuration del personaje (`influencer_configs.publishing_accounts`).
--
-- `ON DELETE SET NULL`, igual que `suggestions.influencer_id`: borrar el
-- personaje no borra ni rompe las piezas que ya se hicieron con él.
--
-- Sin RLS nueva: es una columna de una tabla que ya la tiene.

ALTER TABLE "contents" ADD COLUMN "influencer_id" uuid;
--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_influencer_id_influencers_id_fk"
  FOREIGN KEY ("influencer_id") REFERENCES "public"."influencers"("id") ON DELETE set null ON UPDATE no action;
