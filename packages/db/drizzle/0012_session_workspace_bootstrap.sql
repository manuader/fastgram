-- Bootstrap del workspace de una sesión de usuario — `P1-AUTH-002`, PRD §9.1, §9.2.
--
-- ## El mismo problema que `0003`, del otro lado
--
-- Una sesión de `apps/web` trae un **usuario**, no un workspace. Averiguar sobre
-- qué workspace opera es leer `workspace_memberships`, y esa tabla tiene
-- `FORCE ROW LEVEL SECURITY` con una política que compara `company_id` contra
-- `app.current_company()` — o sea, contra lo que se está tratando de averiguar.
-- Con el GUC sin setear la política no deja ver nada.
--
-- Es la trampa 13 de `docs/HANDOFF.md` otra vez: con la conexión de desarrollo
-- (superusuario) el SELECT directo **funciona**; con `fastgram_app` devuelve cero
-- filas y **toda sesión válida responde "sin workspace"**.
--
-- ## Por qué una función y qué devuelve
--
-- `SECURITY DEFINER` por lo mismo que `app.resolve_api_key`: una política que
-- permitiera leer membresías sin GUC abriría la tabla a cualquier consulta que se
-- olvide de setearlo. La superficie es mínima: recibe un `user_id` y devuelve
-- **un** `company_id` o nada. No permite listar membresías, ni ver roles, ni ver
-- las de otro usuario sin conocer su id — y el id de usuario sólo llega acá
-- después de que Better Auth verificó la firma de la sesión.
--
-- ## La regla de elección
--
--  1. Sólo membresías `active` (una `invited` todavía no aceptó; una `removed` ya
--     no es miembro) de workspaces que **no** estén `soft_deleted` — con API key,
--     un workspace borrado es 401 (PRD:1867); con sesión, simplemente no se elige.
--  2. `users.default_workspace_id` si cumple lo anterior.
--  3. Si no, la membresía más vieja: `created_at`, y `id` para desempatar, así
--     dos llamadas seguidas no pueden elegir distinto.
--
-- `search_path` fijo, como en `0003`: sin él una `SECURITY DEFINER` es una vía
-- de escalación.

CREATE OR REPLACE FUNCTION app.resolve_session_workspace(p_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m.company_id
  FROM public.workspace_memberships m
  JOIN public.companies c ON c.id = m.company_id
  JOIN public.users u ON u.id = m.user_id
  WHERE m.user_id = p_user_id
    AND m.status = 'active'
    AND c.status <> 'soft_deleted'
  ORDER BY (m.company_id = u.default_workspace_id) DESC NULLS LAST,
           m.created_at ASC,
           m.id ASC
  LIMIT 1;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.resolve_session_workspace(uuid) IS
  'Bootstrap de sesion: user_id -> el company_id sobre el que opera. SECURITY DEFINER '
  'para saltear el FORCE RLS de workspace_memberships; sin esto, con fastgram_app '
  'toda sesion valida queda sin workspace. Solo membresias active de workspaces no '
  'soft_deleted; prefiere users.default_workspace_id; si no, la mas vieja.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.resolve_session_workspace(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_session_workspace(uuid) TO fastgram_app;
