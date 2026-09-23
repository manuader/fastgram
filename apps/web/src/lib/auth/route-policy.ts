/**
 * Guards de las rutas del PRD §3.1 · `P1-UI-004`.
 *
 * Es una función pura —entra `{pathname, session}`, sale un destino o `null`—
 * y no un puñado de `redirect()` repartidos por los layouts. Tres razones:
 *
 *   1. Se testea sin montar Next.
 *   2. El middleware y el layout de servidor aplican **la misma** regla; si cada
 *      uno tuviera la suya, el primer bug sería un bucle de redirecciones.
 *   3. Las reglas se leen juntas, que es como hay que revisarlas.
 */
import { ROUTES } from "../nav/routes";
import type { Session, SessionState } from "./session";

/**
 * Rutas accesibles **sin** sesión. Todo lo que no esté aquí exige una.
 *
 * `/status` está dentro a propósito: una página de estado que exige login no
 * sirve para nada el día que el login es justo lo que está caído (F-255).
 */
const PUBLIC_PREFIXES: readonly string[] = [
  ROUTES.login,
  ROUTES.signup,
  ROUTES.forgotPassword,
  ROUTES.resetPassword,
  ROUTES.ssoCallback,
  ROUTES.status,
  "/auth/", // callbacks OAuth por plataforma (PRD:287-291)
  "/partner/checkout/", // retorno de checkout de partner (PRD:292-293)
];

/**
 * Rutas que un usuario **con** sesión puede ver aunque no haya terminado el
 * onboarding. Sin esta lista, `/logout` quedaría atrapado detrás del wizard y
 * un usuario a medio alta no podría ni salir.
 */
const ONBOARDING_EXEMPT_PREFIXES: readonly string[] = [
  ROUTES.onboarding,
  ROUTES.logout,
  ROUTES.forgotPassword,
  ROUTES.resetPassword,
  ROUTES.upgrade,
  ROUTES.status,
  "/auth/",
  "/partner/checkout/",
];

function matches(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) =>
      pathname === prefix ||
      pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
  );
}

export function isPublicRoute(pathname: string): boolean {
  return matches(pathname, PUBLIC_PREFIXES);
}

export interface GuardInput {
  pathname: string;
  session: Session | null;
}

/** El destino al que hay que mandar al usuario, o `null` si puede quedarse. */
export type GuardDecision = { readonly redirectTo: string } | null;

/**
 * El parámetro con el que `/login` sabe adónde volver. Es el nombre que usa
 * Clerk (`redirect_url`), para no tener que renombrarlo cuando entre.
 */
export const RETURN_TO_PARAM = "redirect_url";

/**
 * Prefijo de los route handlers de esta app (hoy, el puente con la API).
 *
 * Quedan **fuera** de la guard: quien los llama es un `fetch`, no una
 * navegación. Un 307 hacia `/login` le devolvería el HTML del login con status
 * 200 y el cliente lo leería como "el servidor mandó algo que no entiendo"
 * (`invalid_response`) en vez de "no estás autenticado". El handler responde
 * su propio `401` con el sobre de §9.3, que es lo que el cliente sabe traducir.
 */
export const API_ROUTE_PREFIX = "/api/";

export function resolveGuard({ pathname, session }: GuardInput): GuardDecision {
  if (pathname.startsWith(API_ROUTE_PREFIX)) return null;

  // `/` es sólo un desvío: a la app si hay sesión, al login si no (PRD:216).
  if (pathname === ROUTES.root) {
    return { redirectTo: session === null ? ROUTES.login : ROUTES.home };
  }

  if (session === null) {
    if (isPublicRoute(pathname)) return null;
    const returnTo = encodeURIComponent(pathname);
    return { redirectTo: `${ROUTES.login}?${RETURN_TO_PARAM}=${returnTo}` };
  }

  // Con sesión, el login y el signup ya no tienen sentido.
  if (matches(pathname, [ROUTES.login, ROUTES.signup])) {
    return { redirectTo: ROUTES.home };
  }

  // FR-010: el onboarding es una puerta, no una sugerencia.
  if (!session.onboardingComplete) {
    if (matches(pathname, ONBOARDING_EXEMPT_PREFIXES)) return null;
    return { redirectTo: ROUTES.onboarding };
  }

  // Y al revés: terminado el alta, volver al wizard no lleva a ningún lado.
  if (pathname === ROUTES.onboarding) {
    return { redirectTo: ROUTES.home };
  }

  return null;
}

// ---------------------------------------------------------------------------
// La sesión verificada contra la API · P1-AUTH-002
// ---------------------------------------------------------------------------

/**
 * `/login?reason=session_unverified` pinta el copy literal de §15.2. Es la
 * única forma de que la pantalla sepa **por qué** llegó el usuario: el
 * middleware no puede renderizar nada, sólo redirigir.
 */
export const REASON_PARAM = "reason";
export const SESSION_UNVERIFIED_REASON = "session_unverified";

export interface NavigationDecision {
  /** `null` = puede quedarse. */
  readonly redirectTo: string | null;
  /** La API rechazó el token: la cookie es basura y se borra en la misma respuesta. */
  readonly clearSessionCookie: boolean;
}

/**
 * La decisión del middleware, sobre el **estado** de la sesión y no sólo
 * sobre "hay o no hay".
 *
 * · `rejected` (401 de la API) se comporta como sin sesión **y** borra la
 *   cookie: si no, cada navegación volvería a preguntar por un token muerto.
 * · `unverifiable` (la API no contestó) **no** borra nada y **no** manda al
 *   login como si no hubiera sesión: lleva al login con el motivo, que pinta
 *   §15.2 (`Try again, or sign in again…`). Las rutas públicas y `/logout`
 *   siguen accesibles — salir no puede depender de que la API esté arriba.
 */
export function resolveNavigation(
  pathname: string,
  state: SessionState,
): NavigationDecision {
  if (pathname.startsWith(API_ROUTE_PREFIX)) {
    return { redirectTo: null, clearSessionCookie: false };
  }
  switch (state.kind) {
    case "authenticated":
      return {
        redirectTo:
          resolveGuard({ pathname, session: state.session })?.redirectTo ?? null,
        clearSessionCookie: false,
      };
    case "anonymous":
      return {
        redirectTo: resolveGuard({ pathname, session: null })?.redirectTo ?? null,
        clearSessionCookie: false,
      };
    case "rejected":
      return {
        redirectTo: resolveGuard({ pathname, session: null })?.redirectTo ?? null,
        clearSessionCookie: true,
      };
    case "unverifiable": {
      if (isPublicRoute(pathname) || matches(pathname, [ROUTES.logout])) {
        return { redirectTo: null, clearSessionCookie: false };
      }
      const params = new URLSearchParams({ [REASON_PARAM]: SESSION_UNVERIFIED_REASON });
      if (pathname !== ROUTES.root) params.set(RETURN_TO_PARAM, pathname);
      return {
        redirectTo: `${ROUTES.login}?${params.toString()}`,
        clearSessionCookie: false,
      };
    }
  }
}

/**
 * El destino tras el login, saneado. Sólo rutas **relativas de esta app**:
 * `redirect_url=https://evil.test` o `//evil.test` (que el navegador lee como
 * otro host) convertirían el login en un redirector abierto — el usuario pone
 * su contraseña en nuestra página y termina en la de otro.
 */
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//")) return null;
  // Una barra invertida o un control (tab, salto) hacen que el parser de URL
  // del navegador lea otra cosa: `/\evil.test` y `/\t/evil.test` son hosts.
  for (const char of raw) {
    if (char === "\\" || char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) {
      return null;
    }
  }
  // Volver al login o al signup tras entrar es un bucle con un paso de más.
  if (matches(raw.split("?")[0] ?? "", [ROUTES.login, ROUTES.signup, ROUTES.logout])) {
    return null;
  }
  return raw;
}
