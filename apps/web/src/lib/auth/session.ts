/**
 * Sesión del usuario en la shell · PRD §15.1–15.2, F-001…F-003.
 *
 * ## Qué es una sesión, desde que hay identidad real
 *
 * La web es un **BFF**. El navegador guarda en `fg_session` un token **opaco**
 * que emitió `apps/api` (Better Auth) al hacer login o signup; la cookie es
 * `httpOnly`, así que ningún script de la página lo lee. Una sesión existe
 * cuando **hay cookie y `GET /api/v1/auth/session` la valida** — no cuando la
 * cookie "parece" una sesión. La cookie es el portador; la verdad es la API.
 *
 * Esto reemplaza dos cosas que ya no existen, a propósito:
 *
 * 1. **El JSON sin firmar en la cookie.** Antes `parseSessionCookie` aceptaba
 *    cualquier `{userId, companyId, …}`: cualquiera que alcanzara el puerto se
 *    fabricaba la sesión que quisiera.
 * 2. **La sesión de desarrollo por defecto** (`DEV_SESSION`). Sin cookie,
 *    fuera de producción, la shell entraba como `dev-user`. Se quitó sin
 *    reemplazo: con signup real, un modo "entro sin cuenta" es sólo una
 *    segunda puerta que alguien olvida cerrar. Para mirar la app en local se
 *    crea una cuenta contra `apps/api` como en producción.
 *
 * ## Tres resultados, no dos
 *
 * Verificar puede terminar en "sí", en "no" o en **"no sé"** (la API no
 * respondió, 5xx, cuerpo ilegible). "No sé" no es "no hay sesión": tratarlo así
 * borraría la cookie de todo el mundo cada vez que la API parpadea. Es el caso
 * del copy literal de §15.2 — `We couldn't verify your session…`.
 *
 * Este módulo **no** importa `next/headers`: lo usa el middleware.
 */
import { z } from "zod";
import { readUpstreamConfig } from "../api/upstream";

/**
 * Nombre de la cookie. El valor es el token opaco de `apps/api`.
 *
 * Se conserva el nombre de la costura anterior a propósito: una cookie vieja
 * con JSON adentro llega a la API como token, la API contesta 401 y el
 * middleware la borra. Sin migración y sin caso especial.
 */
export const SESSION_COOKIE = "fg_session";

/**
 * Header con el que el token viaja a `apps/api`. **Nunca** se loguea: quien
 * lee un log con él puede hacerse pasar por el usuario hasta que expire.
 */
export const SESSION_HEADER = "X-Fastgram-Session";

export interface Session {
  readonly userId: string;
  readonly email: string;
  /** `null` mientras el usuario no tiene workspace → `/onboarding`. */
  readonly companyId: string | null;
  /**
   * FR-010: hasta que el onboarding no cierra, la app entera redirige allí.
   *
   * **Derivado**, no leído: `GET /auth/session` sólo publica `companyId`, así
   * que hoy "terminó el onboarding" = "tiene workspace". Un usuario con
   * workspace a medio configurar entra a la app. Cuando la API publique el
   * estado del onboarding, se lee de ahí y sólo cambia `sessionFromApi`.
   */
  readonly onboardingComplete: boolean;
  /** PRD:329 — `Admin` sólo para staff. La API no lo publica: siempre `false`. */
  readonly isStaff: boolean;
}

/** Cuerpo de `GET /api/v1/auth/session` (contrato de la API, 200). */
export const apiSessionSchema = z.object({
  data: z.object({
    user: z.object({
      id: z.string().min(1),
      email: z.string(),
      emailVerified: z.boolean(),
    }),
    companyId: z.string().min(1).nullable(),
  }),
});

export function sessionFromApi(body: z.infer<typeof apiSessionSchema>): Session {
  const { user, companyId } = body.data;
  return {
    userId: user.id,
    email: user.email,
    companyId,
    onboardingComplete: companyId !== null,
    isStaff: false,
  };
}

export type SessionState =
  /** No hay cookie. */
  | { readonly kind: "anonymous" }
  /** Hay cookie y la API la aceptó. */
  | { readonly kind: "authenticated"; readonly session: Session }
  /** Hay cookie y la API dijo 401: está vencida, revocada o es basura. */
  | { readonly kind: "rejected" }
  /** Hay cookie y no se pudo saber (red, 5xx, cuerpo ilegible). §15.2. */
  | { readonly kind: "unverifiable" };

/**
 * Techo de la verificación. Corre en **cada navegación** (middleware) y en el
 * primer render que la pida: más corto que el `UPSTREAM_TIMEOUT_MS` del proxy
 * porque acá una espera larga es una pantalla en blanco antes de todo. El PRD
 * no fija el número; 5 s es "la API está mal", no "la API está lenta".
 */
export const SESSION_VERIFY_TIMEOUT_MS = 5_000;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Pregunta a la API si el token vale. Nunca lanza.
 *
 * `fetchImpl` se inyecta para los tests; en la app es el `fetch` global.
 */
export async function verifySessionToken(
  token: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<SessionState> {
  if (token === undefined || token === "") return { kind: "anonymous" };

  const upstream = readUpstreamConfig(env);
  if (!upstream.ok) {
    console.error(
      `[auth] ${upstream.missing} no está configurada: no se puede verificar la sesión.`,
    );
    return { kind: "unverifiable" };
  }

  let response: Response;
  try {
    response = await fetchImpl(`${upstream.config.base}/auth/session`, {
      method: "GET",
      headers: { Accept: "application/json", [SESSION_HEADER]: token },
      cache: "no-store",
      signal: AbortSignal.timeout(SESSION_VERIFY_TIMEOUT_MS),
    });
  } catch {
    // El error de `fetch` no se imprime: puede llevar la URL interna, y la
    // `cause` de undici a veces arrastra los headers del request.
    console.error("[auth] la verificación de sesión no obtuvo respuesta de la API");
    return { kind: "unverifiable" };
  }

  if (response.status === 401) return { kind: "rejected" };
  if (response.status !== 200) {
    console.error(
      `[auth] la verificación de sesión devolvió HTTP ${String(response.status)}`,
    );
    return { kind: "unverifiable" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "unverifiable" };
  }
  const parsed = apiSessionSchema.safeParse(body);
  if (!parsed.success) {
    console.error(
      "[auth] la verificación de sesión devolvió un cuerpo fuera de contrato",
    );
    return { kind: "unverifiable" };
  }
  return { kind: "authenticated", session: sessionFromApi(parsed.data) };
}

// ---------------------------------------------------------------------------
// La cookie
// ---------------------------------------------------------------------------

export interface SessionCookieOptions {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: "lax";
  readonly path: "/";
  readonly expires: Date;
}

/**
 * Flags de la cookie de sesión.
 *
 * · `httpOnly` — el token no existe para el JavaScript de la página: un XSS no
 *   se lo puede llevar.
 * · `secure` en producción (o si el origen público es `https`). En `next dev`
 *   por `http://localhost` una cookie `Secure` la tira Safari, y el login no
 *   funcionaría.
 * · `SameSite=Lax` — viaja en la navegación de primer nivel (el enlace de un
 *   email a la app sigue logueado) y no en `POST`/`fetch` cross-site. No es la
 *   defensa CSRF: ésa es `lib/api/csrf.ts`, que se exige igual.
 * · `expires` = el `expiresAt` que da la API. La cookie no sobrevive a la
 *   sesión que representa.
 */
export function sessionCookieOptions(
  expiresAt: Date,
  env: Readonly<Record<string, string | undefined>>,
): SessionCookieOptions {
  const appOrigin = env["FASTGRAM_APP_ORIGIN"]?.trim() ?? "";
  return {
    httpOnly: true,
    secure: env["NODE_ENV"] === "production" || appOrigin.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  };
}

/** Las mismas flags, vencidas: así se borra (el navegador exige que coincidan `path` y `secure`). */
export function clearedSessionCookieOptions(
  env: Readonly<Record<string, string | undefined>>,
): SessionCookieOptions {
  return sessionCookieOptions(new Date(0), env);
}
