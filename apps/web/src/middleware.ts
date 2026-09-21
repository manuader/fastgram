/**
 * Guards de navegación · `P1-UI-004`.
 *
 * El middleware es el **único** sitio donde se redirige. Repetir la regla en
 * cada layout es lo que produce bucles: dos copias de la misma regla siempre
 * acaban discrepando en un caso borde.
 *
 * La decisión en sí vive en `lib/auth/route-policy.ts` y es pura.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveGuard } from "./lib/auth/route-policy";
import {
  DEV_SESSION,
  devSessionAllowed,
  parseSessionCookie,
  SESSION_COOKIE,
} from "./lib/auth/session";
import type { Session } from "./lib/auth/session";

function sessionFrom(request: NextRequest): Session | null {
  const session = parseSessionCookie(request.cookies.get(SESSION_COOKIE)?.value);
  if (session !== null) return session;
  return devSessionAllowed() ? DEV_SESSION : null;
}

export function middleware(request: NextRequest): NextResponse {
  const decision = resolveGuard({
    pathname: request.nextUrl.pathname,
    session: sessionFrom(request),
  });
  if (decision === null) return NextResponse.next();
  return NextResponse.redirect(new URL(decision.redirectTo, request.url));
}

export const config = {
  /**
   * Todo menos los assets. `_next/*` y los archivos con extensión se sirven sin
   * pasar por aquí: un redirect sobre un `.css` rompe la página en vez de
   * protegerla.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)"],
};
