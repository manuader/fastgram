/**
 * La base propia de los tests de integración de identidad.
 *
 * `better-auth-identity.int.test.ts` escribe en `users` y `auth_*`. La suite de
 * `apps/api` trunca esas mismas tablas en la base compartida `fastgram`, y
 * `pnpm test:int` corre las dos a la vez (turbo): una le borraba el usuario a
 * la otra en medio de un test (`23503` sobre `auth_sessions_user_id_users_id_fk`,
 * o un alta que «ya existe»). Solas pasaban siempre. Es el mismo arreglo que el
 * de `apps/worker` (`fastgram` → `fastgram_worker`).
 */
const SHARED =
  process.env["DATABASE_URL"] ?? "postgres://fastgram:fastgram@localhost:5432/fastgram";

/** `…/fastgram` → `…/fastgram_adapters`. Respeta el resto de la URL tal cual. */
export function identityDatabaseUrl(shared: string = SHARED): string {
  const url = new URL(shared);
  const nombre = url.pathname.replace(/^\//, "");
  if (nombre === "" || nombre.endsWith("_adapters")) return shared;
  url.pathname = `/${nombre}_adapters`;
  return url.toString();
}
