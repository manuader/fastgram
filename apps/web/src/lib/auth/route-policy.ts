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
import type { Session } from "./session";

/**
 * Rutas accesibles **sin** sesión. Todo lo que no esté aquí exige una.
 *
 * `/status` está dentro a propósito: una página de estado que exige login no
 * sirve para nada el día que el login es justo lo que está caído (F-255).
 */
const PUBLIC_PREFIXES: readonly string[] = [
  ROUTES.login,
  ROUTES.signup,
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
