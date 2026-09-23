-- Purga del material crudo de `brand_source_snapshots` — PRD §9.5 #20,
-- §9.14 «Retención y borrado», `DATA-032`, `P1-BRAND-021`.
--
-- `DATA-032`: «`rawRetentionExpiresAt` fuerza la purga del material crudo; los
-- `derivedFields` sobreviven porque ya son datos del cliente». El schema
-- guardaba la fecha y el índice parcial para escanearla, y nadie la aplicaba:
-- sin handler para `snapshot-purge`, `apps/worker/src/main.ts` ni siquiera
-- programaba el cron. Una obligación de retención que no se ejecuta es peor que
-- no tenerla escrita, porque el documento dice que se cumple.
--
-- ## Qué es «material crudo», columna por columna
--
--  - `profile_signals` — **crudo.** Nombre, bio, categoría, links y contadores
--    del perfil leído. Es copia del perfil ajeno. Pasa a `NULL` (la columna ya
--    es nullable).
--  - `content_items` — **crudo.** Captions, hashtags, transcripciones, OCR y
--    engagement de los posts leídos. Pasa a `'[]'`: la columna es `NOT NULL
--    DEFAULT '[]'`, y el arreglo vacío es exactamente lo que ya significa «sin
--    ítems». No hace falta tocar el `NOT NULL`.
--  - `derived_fields` — **sobrevive**, lo dice `DATA-032` con todas las letras.
--    Incluye los `excerpt` de cada campo: son parte del mapa que el PRD manda
--    conservar, y además los necesita la trazabilidad por campo de
--    `CompanyProfile.fieldMeta` (`excerptRef`). Purgarlos sería contradecir la
--    frase literal del PRD.
--  - `conflicts` — **sobrevive, y es la decisión discutible.** El PRD no lo
--    nombra ni como crudo ni como derivado. `FR-011.6` dice que el conflicto
--    entre fuentes «se guarda en el snapshot … para que aparezca en la
--    revisión»: es un producto de la fusión, no una lectura del perfil ajeno.
--    Ante la duda se elige lo que **no destruye** datos: borrar algo que el PRD
--    no manda borrar es irreversible; no borrarlo se corrige con otra migración.
--  - `tier`, `captured_at`, ids — metadatos propios, sobreviven.
--
-- ## Qué marca «ya purgado»
--
-- `raw_retention_expires_at` pasa a `NULL`. Con eso:
--   - el barrido es idempotente: la segunda pasada no vuelve a ver la fila;
--   - la fila sale del índice parcial `brand_source_snapshots_raw_retention_idx`
--     (`WHERE raw_retention_expires_at IS NOT NULL`), así que el escaneo
--     nocturno no crece con el historial de filas ya purgadas.
-- El costo: después de purgar no queda registro de **cuándo** venció. Se
-- acepta porque el PRD no pide auditoría de la purga; si `OQ-16` la exige
-- («mecanismo de borrado»), hace falta una columna propia, no reciclar ésta.
--
-- ## Por qué SECURITY DEFINER
--
-- El mismo caso que `0006` y `0009`: `brand_source_snapshots` tiene `FORCE ROW
-- LEVEL SECURITY` (`0002`) con la política sobre `app.current_company()`. Un
-- barrido corre sin GUC, así que con `fastgram_app` un `UPDATE` pelado afecta
-- **cero filas sin error**. Como superusuario —desarrollo— parece andar.
--
-- La excepción al aislamiento queda acotada así: no recibe `company_id`, no
-- devuelve datos de cliente (sólo un contador), y sólo **vacía** tres columnas
-- en filas cuya fecha de retención ya venció. No puede escribir ningún valor
-- que elija el llamador.
--
-- ## El borde
--
-- `<=`: una fecha de expiración es el instante en que el material deja de
-- poder guardarse. En `p_now = raw_retention_expires_at` ya venció.

CREATE OR REPLACE FUNCTION app.purge_expired_snapshot_raw(p_now timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
-- Obligatorio en una función SECURITY DEFINER: sin esto, quien la llama puede
-- anteponer un esquema propio y hacer que `brand_source_snapshots` resuelva a
-- otra tabla.
SET search_path = public, pg_temp
AS $$
DECLARE
  v_purgadas integer;
BEGIN
  -- Un `NULL` haría que la comparación nunca sea verdadera: cero filas, sin
  -- error, todas las noches. Mejor que falle y se reintente.
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'p_now no puede ser NULL';
  END IF;

  UPDATE brand_source_snapshots
     SET profile_signals          = NULL,
         content_items            = '[]'::jsonb,
         raw_retention_expires_at = NULL
   WHERE raw_retention_expires_at IS NOT NULL
     AND raw_retention_expires_at <= p_now;

  GET DIAGNOSTICS v_purgadas = ROW_COUNT;
  RETURN v_purgadas;
END
$$;

COMMENT ON FUNCTION app.purge_expired_snapshot_raw(timestamptz) IS
  'Barrido del job snapshot-purge (PRD 9.5 #20, 9.14, DATA-032): vacia '
  'profile_signals y content_items de los snapshots con raw_retention_expires_at '
  'vencido, y pone la fecha en NULL para no reprocesarlos. derived_fields y '
  'conflicts sobreviven. SECURITY DEFINER para saltear el FORCE RLS; sin esto, '
  'con fastgram_app afectaria cero filas sin error. No recibe company_id y solo '
  'devuelve un contador.';

REVOKE ALL ON FUNCTION app.purge_expired_snapshot_raw(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_snapshot_raw(timestamptz) TO fastgram_app;
