-- Influencers: video del personaje y «Regenerate = persona nueva» — sprint 7
-- (agente G), `P4-INFL-006`, `P4-INFL-010`, `FR-082`, `F-093`, `F-099`.
--
-- ## Qué agrega
--
-- 1. `influencer_generations` deja de ser sólo de imágenes:
--    - `kind` (`image` | `video`). Default `image`: las filas que ya existen
--      son todas pedidos de SOUL V2.
--    - `duration_seconds`: sólo video (lo que se pidió; el proveedor entrega
--      eso).
--    - `source_media_id`: la imagen del Media Bank que se anima («Animate
--      this image»). Sin FK a `media` a propósito: una imagen borrada del
--      Media Bank no borra el historial del pedido.
--    - `source_image_url`: la URL **pública del proveedor** a la que se subió
--      esa imagen (Higgsfield `files/generate-upload-url`). La guarda la API
--      al encolar: el worker envía con ésa y no vuelve a subir la foto en
--      cada reentrega. No es nuestra media ni se sirve: es la entrada del
--      pedido, como el prompt.
--    Un video es siempre de a uno (`count = 1`), y lleva duración y fuente.
-- 2. `influencers.regenerated_from_id`: de qué personaje salió uno
--    regenerado. `F-093`/`FR-080` (2): regenerar crea un personaje **nuevo**;
--    el viejo se conserva. `ON DELETE SET NULL`: borrar el viejo no borra el
--    nuevo.
--
-- Sin RLS nueva: son columnas de tablas que ya la tienen (`0002`, `0020`).

ALTER TABLE "influencer_generations"
  ADD COLUMN "kind" text DEFAULT 'image' NOT NULL;
ALTER TABLE "influencer_generations" ADD COLUMN "duration_seconds" integer;
ALTER TABLE "influencer_generations" ADD COLUMN "source_media_id" uuid;
ALTER TABLE "influencer_generations" ADD COLUMN "source_image_url" text;

ALTER TABLE "influencer_generations"
  ADD CONSTRAINT "influencer_generations_kind_check"
  CHECK ("kind" IN ('image', 'video'));
-- Un video: uno solo, con duración y con la imagen que anima.
ALTER TABLE "influencer_generations"
  ADD CONSTRAINT "influencer_generations_video_shape_check"
  CHECK (
    "kind" <> 'video'
    OR ("count" = 1 AND "duration_seconds" > 0 AND "source_media_id" IS NOT NULL
        AND "source_image_url" IS NOT NULL)
  );

ALTER TABLE "influencers"
  ADD COLUMN "regenerated_from_id" uuid
  REFERENCES "influencers"("id") ON DELETE SET NULL;
