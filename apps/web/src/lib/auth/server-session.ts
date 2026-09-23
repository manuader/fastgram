// Sin `import "server-only"`: ese paquete no es una dependencia declarada de
// `apps/web` y esta tarea no puede tocar `package.json`. El guardarraíl real
// aquí es `next/headers`, que ya falla en compilación si alguien importa este
// módulo desde un componente cliente.
import { cookies } from "next/headers";
import { cache } from "react";
import { SESSION_COOKIE, verifySessionToken } from "./session";
import type { Session, SessionState } from "./session";

/**
 * El estado de la sesión en un Server Component.
 *
 * **Cacheado por request, no por proceso.** `cache()` de React memoiza durante
 * *un* render de servidor: el layout y la página que piden la sesión en la
 * misma navegación hacen **una** llamada a `GET /auth/session`, y la siguiente
 * navegación vuelve a preguntar. Un cache de módulo (un `Map` global) serviría
 * la sesión de un usuario a otro y seguiría aceptando un token revocado.
 *
 * Fuera de un render (route handlers, tests) `cache()` no memoiza: cada
 * llamada verifica. Es lo seguro, y los route handlers no la usan (el proxy
 * reenvía el token y deja que la API lo valide en la misma llamada).
 */
export const readSessionState = cache(async (): Promise<SessionState> => {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value, process.env);
});

/** Atajo para quien sólo necesita "hay sesión válida o no". */
export async function readSession(): Promise<Session | null> {
  const state = await readSessionState();
  return state.kind === "authenticated" ? state.session : null;
}
