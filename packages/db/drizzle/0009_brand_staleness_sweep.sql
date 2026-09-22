-- Barrido de `brand_sources` vencidas — PRD §9.5 #19, `F-026`, `P1-BRAND-021`,
-- `P1-BRANDPG-006`.
--
-- `FR-026` dice que una fuente analizada hace 90 días pasa a `stale` y se le
-- ofrece al usuario refrescarla. El dominio ya sabe decidirlo
-- (`core/brand/brand-source.ts`: `isStale`, `markStaleIfNeeded`, con test de
-- borde «89 no, 90 sí»), pero nadie lo aplicaba: no había handler para la cola
-- `brand-source-staleness-sweep`, y por eso `apps/worker/src/main.ts` ni
-- siquiera la programaba.
--
-- ## Por qué SECURITY DEFINER
--
-- Mismo caso que `app.sweep_expired_daily_swipes` (migración `0006`) y que
-- `app.resolve_api_key` (`0003`), y conviene repetirlo porque es el modo de
-- falla más caro de este repo:
--
-- `brand_sources` tiene `FORCE ROW LEVEL SECURITY` y su política compara
-- `company_id` contra `app.current_company()`. Un barrido corre **sin GUC**
-- —no es de ningún tenant—, así que esa función devuelve NULL, la política no
-- deja pasar nada, y un `UPDATE` pelado afectaría **cero filas, sin error**.
--
-- Y el síntoma sería el de siempre: en desarrollo la conexión es superusuaria,
-- saltea RLS y el barrido parece andar; en producción, con `fastgram_app`
-- (NOSUPERUSER, NOBYPASSRLS), no hace nada y nadie se entera.
--
-- La alternativa —una política que permita escribir `brand_sources` cuando no
-- hay `app.current_company`— abriría la tabla entera a cualquier consulta que
-- simplemente no setee el GUC. Sería cambiar un fallo ruidoso por uno
-- silencioso.
--
-- ## De qué tamaño es la excepción al aislamiento
--
--  - **No devuelve ni una fila de ningún cliente**: devuelve un entero.
--  - **No recibe `company_id`.** No hay forma de apuntarla a un tenant.
--  - **Escribe una columna** (`status`), y sólo en filas que ya cumplen la
--    condición de `isStale`: analizadas, con fecha, y vencidas.
--
-- ## Por qué el umbral es un parámetro y no un literal
--
-- `STALE_AFTER_DAYS = 90` vive en `packages/core` y lo fija un test. Escribirlo
-- también acá serían dos fuentes de verdad para el mismo número, y la de SQL no
-- la mira `pnpm consistency`. El llamador lo pasa.

CREATE OR REPLACE FUNCTION app.sweep_stale_brand_sources(
  p_now        timestamptz,
  p_stale_days integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
-- Obligatorio en una función SECURITY DEFINER: sin esto, quien la llama puede
-- anteponer un esquema propio y hacer que `brand_sources` resuelva a otra tabla.
SET search_path = public, pg_temp
AS $$
DECLARE
  v_barridas integer;
BEGIN
  IF p_stale_days IS NULL OR p_stale_days <= 0 THEN
    RAISE EXCEPTION 'p_stale_days tiene que ser un entero positivo, llego %', p_stale_days;
  END IF;

  UPDATE brand_sources
     SET status     = 'stale',
         updated_at = p_now
   WHERE status IN ('ready', 'partial')
     AND last_analysed_at IS NOT NULL
     -- `<=` y no `<`: el dominio dice «89 no, 90 sí» y tiene test de borde.
     AND last_analysed_at <= p_now - make_interval(days => p_stale_days);

  GET DIAGNOSTICS v_barridas = ROW_COUNT;
  RETURN v_barridas;
END
$$;

COMMENT ON FUNCTION app.sweep_stale_brand_sources(timestamptz, integer) IS
  'Barrido del job brand-source-staleness-sweep (PRD 9.5 #19, F-026): marca stale '
  'las fuentes analizadas hace mas de p_stale_days. SECURITY DEFINER para saltear '
  'el FORCE RLS de brand_sources; sin esto, con fastgram_app afectaria cero filas '
  'sin error. No recibe company_id y no devuelve datos de cliente: solo un contador. '
  'Solo toca filas ready/partial con last_analysed_at vencido.';

REVOKE ALL ON FUNCTION app.sweep_stale_brand_sources(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.sweep_stale_brand_sources(timestamptz, integer) TO fastgram_app;
