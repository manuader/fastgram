-- Bootstrap de autenticación por API key — PRD §9.1, `FR-180`.
--
-- ## El problema que resuelve
--
-- Resolver una API key es **el único acceso a datos del sistema que no puede
-- llevar scope de `companyId`**, porque el `companyId` es justamente lo que está
-- intentando averiguar. Es el arranque: todavía no hay tenant.
--
-- Eso choca de frente con la defensa del §2.4 de IMPLEMENTATION-PLAN. `api_keys`
-- tiene `FORCE ROW LEVEL SECURITY`, y su política compara `company_id` contra
-- `app.current_company()`. Con el GUC sin setear, esa función devuelve NULL y la
-- política no deja pasar nada.
--
-- La consecuencia es del tipo peor: **en desarrollo funciona y en producción no**.
-- En desarrollo la conexión suele ser superusuario, que saltea RLS, así que la
-- consulta devuelve la fila y todo anda. En producción, con `fastgram_app`
-- (NOSUPERUSER, NOBYPASSRLS), devolvería **cero filas** y **toda la API
-- respondería 401**. No un endpoint: todos.
--
-- ## Por qué SECURITY DEFINER y no una política más permisiva
--
-- La alternativa —una política que permita leer `api_keys` cuando no hay
-- `app.current_company`— abriría la tabla entera a cualquier consulta que
-- simplemente no setee el GUC. Sería cambiar un fallo ruidoso por uno silencioso.
--
-- Esta función corre con los privilegios de su dueño, así que saltea RLS, pero
-- **sólo hace esto**: recibe un hash y devuelve lo mínimo para autenticar. No
-- devuelve el hash, ni la etiqueta, ni permite listar. Quien conoce el hash ya
-- tiene la clave; no hay nada que filtrar que el llamador no tuviera.
--
-- ## Por qué NO filtra revocadas ni vencidas acá
--
-- Sería más corto y perdería información. El PRD distingue ocho causas de 401
-- (`FR-180`), y aunque el **cuerpo de la respuesta es idéntico para todas** —a
-- propósito, para no decirle a quien sondea si el token existe— el **log** sí
-- tiene que distinguirlas: "clave revocada hace dos días" y "token que nunca
-- existió" piden respuestas operativas distintas. Filtrar acá las colapsaría a
-- `no_match`.
--
-- Por eso devuelve `revoked_at`, `expires_at` y el estado del workspace, y es la
-- aplicación la que decide. De paso resuelve el JOIN con `companies` —que
-- también tiene RLS— en la misma ida, en vez de dos consultas.
--
-- `search_path` fijo es obligatorio en una función `SECURITY DEFINER`: sin eso,
-- alguien que pueda crear objetos en un esquema del `search_path` del llamador
-- puede secuestrar la resolución de nombres y ejecutar código con los
-- privilegios del dueño. Es el modo clásico de convertirla en escalación.

CREATE OR REPLACE FUNCTION app.resolve_api_key(p_hash text)
RETURNS TABLE (
  api_key_id     uuid,
  company_id     uuid,
  kind           text,
  revoked_at     timestamptz,
  expires_at     timestamptz,
  company_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT k.id, k.company_id, k.kind::text, k.revoked_at, k.expires_at, c.status::text
  FROM public.api_keys k
  JOIN public.companies c ON c.id = k.company_id
  WHERE k.hash = p_hash
  LIMIT 1;
$$;

COMMENT ON FUNCTION app.resolve_api_key(text) IS
  'Bootstrap de autenticacion: hash -> datos minimos para autenticar. Es el unico '
  'acceso sin scope de companyId del sistema, porque el companyId es lo que '
  'resuelve. SECURITY DEFINER para saltear el FORCE RLS de api_keys; sin esto, en '
  'produccion con fastgram_app toda la API responde 401. No filtra revocadas ni '
  'vencidas a proposito: la app necesita distinguir las causas para el log.';

-- Nadie más que la aplicación necesita ejecutarla.
REVOKE ALL ON FUNCTION app.resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_api_key(text) TO fastgram_app;
