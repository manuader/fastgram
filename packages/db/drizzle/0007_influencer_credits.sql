-- El cargo de 250 créditos de AI Studio, con columnas propias — `P1-DATA-016`,
-- `FR-080`, PRD §9.4 y §16.2.
--
-- ## El agujero que cierra, con el mecanismo exacto
--
-- `POST /influencers` **ya cobra** `AI_STUDIO_COST.influencer` (250). El registro
-- del cargo —a qué período, cuánto, y si ya se devolvió— se anotaba en
-- `internal_refs.aiStudioCharge`, un `jsonb`, marcado como interino desde el día
-- que se escribió.
--
-- El riesgo no era teórico. `influencerRepository.update(…, { internalRefs: … })`
-- **reemplaza el jsonb entero**: no lo mergea. El día que el handler de
-- `influencer-pipeline` escribiera `soulId` ahí, el registro del cargo
-- desaparecía — sin error, sin log, sin un test en rojo. Y un cargo sin registro
-- es un cargo que no se devuelve nunca: exactamente el agujero que los content
-- saves tuvieron hasta que `0005` les dio columnas.
--
-- ## Por qué tres columnas y no una
--
--  - **`credits_period`**, porque `billing_anchor_day` puede cambiar entre el
--    cobro y el reembolso. Derivar el período de `created_at` en el momento de
--    devolver daría **otro ledger**, y el cliente vería el crédito volver a un
--    ciclo que ya cerró.
--  - **`credits_charged`**, porque `AI_STUDIO_COST` es un número del PRD y puede
--    moverse. Un reembolso que lo releyera de la tabla de tarifas devolvería la
--    tarifa de hoy por un cargo de ayer.
--  - **`credits_refunded_at`**, porque el handler de la cola **puede
--    reintentarse** (lo dice el puerto `Queue`, y el catálogo le da
--    `maxAttempts` > 1). Dos reembolsos sobre un cargo son 250 créditos
--    regalados, otra vez en silencio.
--
-- No hay columna `operation`: en esta tabla la operación siempre es `influencer`,
-- y el monto ya está guardado, así que el reembolso no necesita volver a mirar la
-- tarifa. Tampoco hay `credits_charged_at`: el cobro y el INSERT de la fila
-- ocurren en la **misma transacción** (ADR-005), así que `created_at` ya es ese
-- instante y una segunda copia sólo podría desincronizarse.
--
-- ## Nullable a propósito
--
-- Igual que en `0005`: una fila sin cargo no se cobró, y `NULL` dice eso. Un
-- default marcaría filas viejas como cobradas y el primer fallo de pipeline les
-- regalaría 250 créditos que nadie descontó.

ALTER TABLE "influencers"
  ADD COLUMN "credits_period"      text,
  ADD COLUMN "credits_charged"     integer,
  ADD COLUMN "credits_refunded_at" timestamptz;

COMMENT ON COLUMN "influencers"."credits_period" IS
  'A que periodo de facturacion (quota_ledgers.period) se cobraron los creditos de '
  'AI Studio. Se guarda en vez de derivarlo de created_at porque derivarlo depende '
  'de billing_anchor_day, que puede cambiar entre el cobro y el reembolso: ahi los '
  'creditos volverian a otro ledger. NULL = esta fila no se cobro.';

COMMENT ON COLUMN "influencers"."credits_charged" IS
  'Cuantos creditos se reservaron (AI_STUDIO_COST.influencer = 250 hoy). Se guarda '
  'el monto y no la operacion porque la tarifa del PRD puede moverse y el reembolso '
  'tiene que devolver lo que se cobro, no lo que costaria hoy.';

COMMENT ON COLUMN "influencers"."credits_refunded_at" IS
  'Guarda contra el doble reembolso: el handler de influencer-pipeline puede '
  'reintentarse y dos reembolsos sobre un cargo regalan 250 creditos.';

-- ──────────────────────────────────────────────────────────────────────────────
-- Migrar lo que ya está en `internal_refs`, y por qué sí
-- ──────────────────────────────────────────────────────────────────────────────
--
-- En las bases de desarrollo de hoy esto no mueve nada: `fastgram` tiene 3
-- influencers y ninguno con la clave (se crearon antes del cableado del cobro),
-- y `fastgram_worker` tiene 0. En producción tampoco hay filas todavía.
--
-- Se hace igual, y el criterio es la asimetría del error:
--
--  - Si no hay nada que mover, el UPDATE toca **cero filas** y no cuesta nada.
--  - Si hubiera filas, no moverlas pierde el dato para siempre: el jsonb es la
--    única copia, y un cargo sin registro es 250 créditos que el cliente no
--    recupera.
--
-- Un no-op barato contra una pérdida irreversible no es una decisión difícil.
-- «No hay filas en producción» es cierto **hoy**; esta migración se escribe una
-- sola vez y se aplica cuando se aplique.
--
-- **Lo que este backfill NO cierra, dicho para que no sorprenda:** `apps/api`
-- sigue escribiendo el jsonb hasta que su ruta pase a las columnas nuevas (está
-- descrito en el reporte de `P1-DATA-016`). Entre esta migración y ese cambio,
-- las filas nuevas siguen llegando al jsonb y este UPDATE ya pasó. El backfill
-- cubre el pasado; el único que cierra la ventana es el cambio de la ruta.
--
-- **La clave del jsonb NO se borra.** Es la única copia del dato en el instante
-- en que esto corre, y una migración que mueve *y* borra no deja de dónde volver
-- si el mapeo estuviera mal. Dejarla es inofensivo: hoy **nadie la lee** (sólo
-- `POST /influencers` la escribe), y en cuanto la ruta cambie deja de crecer.

-- >>> backfill (este bloque lo ejecuta también `influencer-credits.int.test.ts`,
-- leyéndolo de este archivo en vez de copiarlo; no lo renombres sin mirar allá)
UPDATE "influencers"
   SET "credits_period"  = "internal_refs"->'aiStudioCharge'->>'period',
       "credits_charged" = ("internal_refs"->'aiStudioCharge'->>'charged')::integer,
       -- `refundedAtMs` es ms epoch (así lo serializaba el jsonb). Hoy siempre
       -- viene `null` —nadie reembolsa todavía— pero mapearlo cuesta una línea y
       -- no mapearlo sería reabrir el doble reembolso en la fila migrada.
       "credits_refunded_at" = CASE
         WHEN "internal_refs"->'aiStudioCharge'->>'refundedAtMs' IS NULL THEN NULL
         ELSE to_timestamp(
           (("internal_refs"->'aiStudioCharge'->>'refundedAtMs')::bigint) / 1000.0
         )
       END
 -- `jsonb_exists(x, k)` y no `x ? k`: son la misma función, pero el `?` es el
 -- placeholder de parámetros de varios drivers y ya ha desaparecido en el camino
 -- más de una vez. La forma con nombre no tiene cómo confundirse.
 WHERE jsonb_exists("internal_refs", 'aiStudioCharge')
   AND "credits_charged" IS NULL
   -- Sólo las filas cuyo registro está completo. Las incompletas las levanta el
   -- guard de abajo, que falla ruidosamente en vez de dejarlas pasar.
   AND "internal_refs"->'aiStudioCharge'->>'period' IS NOT NULL
   AND ("internal_refs"->'aiStudioCharge'->>'charged') ~ '^[1-9][0-9]*$';

-- El guard. Sin esto, una fila con la clave pero con forma inesperada quedaría
-- atrás **en silencio**, que es la forma exacta en que este proyecto viene
-- perdiendo cargos. Es la última oportunidad de moverla: fallar acá deja la
-- transacción sin confirmar y el problema a la vista.
DO $$
DECLARE
  v_huerfanas integer;
BEGIN
  SELECT count(*) INTO v_huerfanas
    FROM public.influencers
   WHERE jsonb_exists(internal_refs, 'aiStudioCharge')
     AND credits_charged IS NULL;

  IF v_huerfanas > 0 THEN
    RAISE EXCEPTION
      'Hay % influencers con internal_refs->aiStudioCharge que no se pudieron migrar '
      '(period o charged ausentes o con forma inesperada). Revisalas con: select id, '
      'internal_refs->''aiStudioCharge'' from influencers where '
      'jsonb_exists(internal_refs, ''aiStudioCharge'') and credits_charged is null;',
      v_huerfanas;
  END IF;
END
$$;
-- <<< backfill

-- ──────────────────────────────────────────────────────────────────────────────
-- Los CHECK, DESPUÉS del backfill y no antes
-- ──────────────────────────────────────────────────────────────────────────────
--
-- El orden es deliberado: un `ADD CONSTRAINT` valida las filas existentes, así
-- que poniéndolos al final **validan también lo que acaba de migrarse**. Al
-- revés, una fila migrada con forma imposible entraría antes de que hubiera
-- quien la rechazara.

-- Un cobro tiene período y monto, o no tiene ninguno de los dos: saber cuánto se
-- cobró sin saber a qué ledger devolverlo no alcanza para reembolsar.
ALTER TABLE "influencers"
  ADD CONSTRAINT "influencers_credits_period_with_charged"
  CHECK (("credits_period" IS NULL) = ("credits_charged" IS NULL));

-- No se puede reembolsar lo que no se cobró.
ALTER TABLE "influencers"
  ADD CONSTRAINT "influencers_refund_requires_charge"
  CHECK ("credits_refunded_at" IS NULL OR "credits_charged" IS NOT NULL);

-- Un cargo de 0 no es un cargo; uno negativo le **quita** créditos al cliente
-- cuando se "devuelve".
ALTER TABLE "influencers"
  ADD CONSTRAINT "influencers_credits_charged_positive"
  CHECK ("credits_charged" IS NULL OR "credits_charged" > 0);
