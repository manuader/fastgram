-- `Content.saveBucket` y `Content.saveRefundedAt` — `FR-050`, PRD §16.2.
--
-- ## Por qué la columna es necesaria y no un detalle
--
-- `FR-050` exige **reembolsar el content save cuando el build falla**, y §16.2
-- describe tres orígenes con precios distintos: el cupo incluido del plan, el
-- saldo comprado y el overage facturable. Reembolsar "un save" sin saber de
-- cuál de los tres salió no es reembolsar: le devuelve al cliente un crédito
-- incluido por algo que pagó como overage, o al revés.
--
-- El dominio ya modela esto (`SaveBucket` en `core/quota/content-saves.ts`, y
-- `refundSave` devuelve **al bucket del que salió**), y `Content` ya lo declara
-- en su tipo. Lo que faltaba era dónde guardarlo: sin columna, el motor de
-- cuotas no se podía cablear a ninguna ruta, y por eso hoy `POST /content` no
-- cobra nada.
--
-- ## Y `saveRefundedAt`
--
-- Es la guarda contra el doble reembolso. Un build que falla, se reintenta y
-- vuelve a fallar dispararía dos reembolsos por un solo cargo — un save
-- gratis. Con la marca, el segundo es un no-op; sin ella, hace falta recordar
-- comprobarlo en cada camino que reembolsa, y son varios.
--
-- ## Nullable a propósito
--
-- Las filas que ya existen se crearon antes de que hubiera cobro, así que no
-- salieron de ningún bucket. Poner un default las marcaría como si hubieran
-- consumido cupo incluido, y el primer fallo de build les regalaría un save
-- que nadie descontó. `NULL` dice lo que es: esta pieza no se cobró.

CREATE TYPE "save_bucket" AS ENUM ('included', 'purchased', 'overage');

ALTER TABLE "contents"
  ADD COLUMN "save_bucket" "save_bucket",
  ADD COLUMN "save_period" text,
  ADD COLUMN "save_refunded_at" timestamptz;

COMMENT ON COLUMN "contents"."save_bucket" IS
  'De que bucket salio el content save (FR-050). NULL = la pieza no se cobro. '
  'Se necesita para reembolsar al bucket correcto: incluido, comprado y overage '
  'tienen precios distintos.';

COMMENT ON COLUMN "contents"."save_period" IS
  'A que periodo de facturacion se cobro. Se guarda en vez de derivarlo de '
  'created_at porque derivarlo depende de billing_anchor_day, que puede cambiar '
  'entre el cobro y el reembolso: ahi el save volveria al ledger equivocado.';

COMMENT ON COLUMN "contents"."save_refunded_at" IS
  'Guarda contra el doble reembolso: un build que falla dos veces reembolsaria '
  'dos veces un solo cargo.';

-- No se puede reembolsar lo que no se cobró. El CHECK lo hace imposible en vez
-- de depender de que todos los caminos que reembolsan se acuerden.
-- Un cobro tiene las dos cosas o ninguna: saber de que bucket salio sin saber a
-- que periodo devolverlo no alcanza para reembolsar.
ALTER TABLE "contents"
  ADD CONSTRAINT "contents_save_bucket_with_period"
  CHECK (("save_bucket" IS NULL) = ("save_period" IS NULL));

ALTER TABLE "contents"
  ADD CONSTRAINT "contents_refund_requires_bucket"
  CHECK ("save_refunded_at" IS NULL OR "save_bucket" IS NOT NULL);
