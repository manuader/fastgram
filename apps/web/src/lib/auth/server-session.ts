// Sin `import "server-only"`: ese paquete no es una dependencia declarada de
// `apps/web` y esta tarea no puede tocar `package.json`. El guardarraíl real
// aquí es `next/headers`, que ya falla en compilación si alguien importa este
// módulo desde un componente cliente.
import { cookies } from "next/headers";
import {
  DEV_SESSION,
  devSessionAllowed,
  parseSessionCookie,
  SESSION_COOKIE,
} from "./session";
import type { Session } from "./session";

/**
 * Lee la sesión en un Server Component.
 *
 * Usa `cookies()`, que en Next 15 es asíncrono y marca la ruta como dinámica.
 * Es lo correcto: una pantalla de la app **no** se puede prerenderizar en
 * estático sin saber quién la mira.
 */
export async function readSession(): Promise<Session | null> {
  const store = await cookies();
  const session = parseSessionCookie(store.get(SESSION_COOKIE)?.value);
  if (session !== null) return session;
  return devSessionAllowed() ? DEV_SESSION : null;
}
