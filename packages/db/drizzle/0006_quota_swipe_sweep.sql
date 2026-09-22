-- Barrido de swipes diarios vencidos — `P1-QUOTA-013`, PRD §9.5 #17 y §16.2.
--
-- ## Qué problema resuelve, y el que NO resuelve
--
-- El job `quota-reset` del catálogo es **red, no mecanismo**: el reset real se
-- calcula en lectura contra el reloj (`core/quota/reset.ts`), porque si
-- dependiera del cron la cuota de un cliente dependería de que el cron haya
-- corrido. Lo único que queda para el cron es limpiar los contadores de las
-- cuentas que **nadie consultó**, que es exactamente lo que hace esto.
--
-- Barre un solo contador: `daily_swipes_used`, con su `daily_swipe_reset_at`.
-- Es el único del ledger que guarda su propio instante de reset y que por lo
-- tanto puede quedar viejo indefinidamente. Los content saves **no se barren**:
-- su reset *es* la clave del período, así que al cruzar el ancla de facturación
-- aparece una fila nueva y la vieja queda como historia de facturación. Un
-- `UPDATE` sobre la vieja reescribiría una factura cerrada.
--
-- ## Por qué SECURITY DEFINER
--
-- `quota_ledgers` tiene `FORCE ROW LEVEL SECURITY` y su política compara
-- `company_id` contra `app.current_company()`. Un barrido corre sin GUC, así que
-- esa función devuelve NULL, la política no deja pasar nada y un `UPDATE` pelado
-- afectaría **cero filas, sin error**.
--
-- Y el modo de falla sería el de siempre en este repo: en desarrollo la conexión
-- es superusuaria, saltea RLS y el barrido parece andar; en producción, con
-- `fastgram_app` (NOSUPERUSER, NOBYPASSRLS), no hace nada y nadie se entera. Es
-- el mismo caso de `app.resolve_api_key` (migración `0003`) y se resuelve igual.
--
-- La alternativa —una política que permita escribir `quota_ledgers` cuando no
-- hay `app.current_company`— abriría la tabla entera a cualquier consulta que
-- simplemente no setee el GUC. Sería cambiar un fallo ruidoso por uno silencioso.
--
-- ## De qué tamaño es la excepción al aislamiento
--
--  - **No devuelve ni una fila de ningún cliente**: devuelve un entero.
--  - **No recibe `company_id`.** No hay forma de apuntarla a un tenant, ni desde
--    el payload de la cola ni desde la aplicación.
--  - **Escribe tres columnas de una tabla**, y sólo en filas cuyo propio
--    `daily_swipe_reset_at` ya venció.
--  - `GRANT EXECUTE` sólo a `fastgram_app`.
--
-- ## Por qué los dos instantes son parámetros
--
-- `p_now` y `p_next_reset` los calcula la aplicación con `nextDailyResetUtc`
-- (`@fastgram/core`). Calcularlos acá sería una segunda copia de una regla del
-- dominio, y además una copia peligrosa: `date_trunc('day', ts)` sobre
-- `timestamptz` trunca en la zona de la **sesión**, no en UTC, y §16.2 fija los
-- resets a 00:00 UTC. Un servidor con `TimeZone` local movería el reset con el
-- horario de verano, que es justo lo que el puerto `Queue` advierte del cron.
--
-- ## `FOR UPDATE SKIP LOCKED` y el límite
--
-- `SKIP LOCKED` deja pasar de largo las filas que una petición tiene
-- bloqueadas: ese workspace está siendo atendido en este instante y su camino de
-- lectura va a resetear el contador por su cuenta. Esperarla sería hacer que un
-- barrido de mantenimiento bloquee a un usuario.
--
-- Y al revés: si el barrido llega primero, el `UPDATE` de la petición espera y
-- después vuelve a evaluar su `WHERE` (READ COMMITTED), así que no escribe
-- encima de un reset que ya ocurrió. El orden correcto lo sostiene `lockPeriod`,
-- que bloquea **antes** de leer; una petición que leyera sin bloquear se pisaría
-- con este barrido igual que se pisa con otra petición.
--
-- El `p_limit` acota la transacción: el job tiene `timeoutSeconds: 300` y un
-- `UPDATE` sobre toda la tabla en una sola sentencia no tiene por qué entrar ahí
-- el día que haya muchas cuentas. El llamador itera hasta que vuelve menos que
-- el límite.
--
-- NOTA DE PERFORMANCE, deliberada: no hay índice por `daily_swipe_reset_at`.
-- Con una fila por (workspace, período) y una corrida diaria, un seq scan es más
-- barato que mantener el índice en el camino caliente del consumo. El índice
-- parcial `where daily_swipe_reset_at is not null` empieza a valer la pena
-- cuando la tabla pase el orden de 1e6 filas; hacerlo ahora obligaba además a
-- tocar `schema/platform.ts`, que es de otro dueño en esta tanda.

CREATE OR REPLACE FUNCTION app.sweep_expired_daily_swipes(
  p_now         timestamptz,
  p_next_reset  timestamptz,
  p_limit       integer
) RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_barridas integer;
BEGIN
  IF p_now IS NULL OR p_next_reset IS NULL THEN
    RAISE EXCEPTION 'p_now y p_next_reset son obligatorios';
  END IF;

  -- El mismo invariante que `isExpired` afirma del lado del dominio. Un
  -- `p_next_reset` en el pasado dejaría las filas vencidas al salir, y el
  -- barrido siguiente las volvería a tomar para siempre.
  IF p_next_reset <= p_now THEN
    RAISE EXCEPTION 'p_next_reset (%) tiene que ser posterior a p_now (%)',
      p_next_reset, p_now;
  END IF;

  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'p_limit fuera de rango: %', p_limit;
  END IF;

  WITH vencidos AS (
    SELECT l.company_id, l.period
      FROM public.quota_ledgers l
     -- `IS NOT NULL` es la mitad importante: un workspace que nunca hizo un
     -- swipe no tiene instante de reset, y ponerle uno sería inventarle una
     -- cuota diaria que todavía no empezó a correr.
     WHERE l.daily_swipe_reset_at IS NOT NULL
       AND l.daily_swipe_reset_at <= p_now
     ORDER BY l.daily_swipe_reset_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.quota_ledgers l
     SET daily_swipes_used    = 0,
         daily_swipe_reset_at = p_next_reset,
         -- `p_now` y no `now()`: el reloj autoritativo es el del puerto `Clock`,
         -- que es el que los tests fijan.
         updated_at           = p_now
    FROM vencidos v
   WHERE l.company_id = v.company_id
     AND l.period = v.period;

  GET DIAGNOSTICS v_barridas = ROW_COUNT;
  RETURN v_barridas;
END
$$;

COMMENT ON FUNCTION app.sweep_expired_daily_swipes(timestamptz, timestamptz, integer) IS
  'Barrido del job quota-reset (PRD 9.5 #17): pone en cero los daily_swipes_used '
  'ya vencidos de las cuentas que nadie consulto. SECURITY DEFINER para saltear el '
  'FORCE RLS de quota_ledgers; sin esto, con fastgram_app afectaria cero filas sin '
  'error. No recibe company_id y no devuelve datos de cliente: solo un contador. '
  'NO toca los content saves, cuyo reset es la clave del periodo.';

REVOKE ALL ON FUNCTION app.sweep_expired_daily_swipes(timestamptz, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.sweep_expired_daily_swipes(timestamptz, timestamptz, integer) TO fastgram_app;
