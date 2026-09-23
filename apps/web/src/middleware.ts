/**
 * Guards de navegación · `P1-UI-004`, `P1-AUTH-002`.
 *
 * El middleware es el **único** sitio donde se redirige. Repetir la regla en
 * cada layout es lo que produce bucles: dos copias de la misma regla siempre
 * acaban discrepando en un caso borde.
 *
 * La decisión vive en `lib/auth/route-policy.ts` y es pura. Lo que hace este
 * archivo es conseguirle el **estado** de la sesión: con cookie, se lo
 * pregunta a la API (`GET /auth/session`). Es una llamada por navegación; los
 * assets y los route handlers (`/api/*`) no pagan ninguna.
 */
import { NextResponse, type NextRequest } from "next/server";
import { API_ROUTE_PREFIX, resolveNavigation } from "./lib/auth/route-policy";
import {
  clearedSessionCookieOptions,
  SESSION_COOKIE,
  verifySessionToken,
} from "./lib/auth/session";

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const pathname = request.nextUrl.pathname;
  // Antes de verificar: un `fetch` del cliente al proxy no paga una segunda
  // ida a la API — el proxy reenvía el token y la API lo valida ahí.
  if (pathname.startsWith(API_ROUTE_PREFIX)) return NextResponse.next();

  const state = await verifySessionToken(
    request.cookies.get(SESSION_COOKIE)?.value,
    process.env,
  );
  const decision = resolveNavigation(pathname, state);

  const response =
    decision.redirectTo === null
      ? NextResponse.next()
      : NextResponse.redirect(new URL(decision.redirectTo, request.url));
  if (decision.clearSessionCookie) {
    response.cookies.set(SESSION_COOKIE, "", clearedSessionCookieOptions(process.env));
  }
  return response;
}

export const config = {
  /**
   * Todo menos los assets. `_next/*` y los archivos con extensión se sirven sin
   * pasar por aquí: un redirect sobre un `.css` rompe la página en vez de
   * protegerla.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)"],
  /**
   * Node, no Edge (estable desde `next@15.5`): la URL de la API se lee de
   * `process.env` **en ejecución**, y en Edge una variable sin `NEXT_PUBLIC_`
   * depende de cómo se despliegue. Es el mismo runtime que los route handlers.
   */
  runtime: "nodejs",
};
