/**
 * Los route handlers de identidad del BFF · `P1-AUTH-002`, PRD §15.1–15.3.
 *
 * `app/api/fastgram/auth/*` son cáscaras de una línea; la lógica está acá para
 * que se lea junta y se pruebe sin montar Next.
 *
 * ## Lo que hace cada uno, y lo que no hace nunca
 *
 * Llaman a `apps/api` **desde el servidor**, sin API key (el contrato de
 * `/api/v1/auth/*` no la pide), y traducen su respuesta para el navegador:
 *
 * · **El `sessionToken` no sale nunca en el cuerpo.** Va a la cookie
 *   `httpOnly` (`sessionCookieOptions`) y el cuerpo lleva el usuario y a dónde
 *   ir. Si el token llegara al JavaScript de la página, la cookie `httpOnly`
 *   no protegería nada.
 * · **Todos son `POST` con la defensa CSRF del proxy** (`rejectCrossSiteWrite`),
 *   también el login: el *login CSRF* mete a la víctima en la cuenta del
 *   atacante.
 * · **Los errores de la API suben con su status y su `code`** (409 `conflict`,
 *   401 `unauthorized`, 429 con `Retry-After`, 503) en el sobre de §9.3. Un
 *   cuerpo que no es ese sobre no se reenvía: se contesta `502`.
 * · **El logout borra la cookie aunque la API falle.** Quedarse "adentro"
 *   porque la API no contestó es peor que dejar una sesión viva del lado del
 *   servidor hasta que expire.
 * · **Nada de esto loguea el token, la contraseña ni el email.**
 */
import { errorEnvelopeSchema } from "@fastgram/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";
import { rejectCrossSiteWrite } from "../api/csrf";
import { errorEnvelope } from "../api/envelope";
import { API_URL_ENV, readUpstreamConfig, UPSTREAM_TIMEOUT_MS } from "../api/upstream";
import { ROUTES } from "../nav/routes";
import { safeReturnTo } from "./route-policy";
import {
  clearedSessionCookieOptions,
  SESSION_COOKIE,
  SESSION_HEADER,
  sessionCookieOptions,
  verifySessionToken,
} from "./session";

type Env = Readonly<Record<string, string | undefined>>;

const LOG = "[auth-bff]";

// ---------------------------------------------------------------------------
// Contrato de la API
// ---------------------------------------------------------------------------

const apiUserSchema = z.object({
  id: z.string().min(1),
  email: z.string(),
  emailVerified: z.boolean(),
});

/** `POST /auth/signup` (201) y `POST /auth/login` (200). */
const issuedSessionSchema = z.object({
  data: z.object({
    sessionToken: z.string().min(1),
    expiresAt: z.string().min(1),
    user: apiUserSchema,
  }),
});

export type AuthUser = z.infer<typeof apiUserSchema>;

/** Lo que el navegador recibe tras entrar. **Sin token.** */
export interface SignedInBody {
  readonly data: {
    readonly user: AuthUser;
    /** Ruta de esta app a la que navegar. `/onboarding` si no hay workspace. */
    readonly next: string;
  };
}

// ---------------------------------------------------------------------------
// Lo que manda el navegador
// ---------------------------------------------------------------------------

/**
 * Los límites de longitud son un techo contra cuerpos absurdos, no la regla
 * de contraseña: ésa la decide la API (Better Auth) y su `400` sube tal cual.
 */
const email = z.string().trim().min(1).max(320);
const password = z.string().min(1).max(1024);
const returnTo = z.string().max(2048).optional();

const loginInput = z.object({ email, password, returnTo });
const signupInput = z.object({
  email,
  password,
  fullName: z.string().trim().min(1).max(200),
  returnTo,
});
const resetInput = z.object({ email });
const resetCompleteInput = z.object({
  token: z.string().min(1).max(1024),
  newPassword: password,
});

// ---------------------------------------------------------------------------
// Piezas
// ---------------------------------------------------------------------------

async function readJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return undefined;
  }
}

function invalidInput(): Response {
  return errorEnvelope(400, "bad_request", "Check the highlighted fields.");
}

function notConfigured(): Response {
  console.error(`${LOG} ${API_URL_ENV} no está configurada.`);
  return errorEnvelope(
    503,
    "service_unavailable",
    "The API is not configured on this server.",
  );
}

function unreachable(what: string): Response {
  // El error de `fetch` no se imprime: su `cause` puede arrastrar el request.
  console.error(`${LOG} la API no respondió (${what})`);
  return errorEnvelope(
    502,
    "service_unavailable",
    "The API did not respond. Try again shortly.",
  );
}

type UpstreamResult =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "not_configured" }
  | { readonly kind: "unreachable" };

async function callApi(
  env: Env,
  path: string,
  init: { readonly body?: unknown; readonly token?: string },
): Promise<UpstreamResult> {
  const upstream = readUpstreamConfig(env);
  if (!upstream.ok) return { kind: "not_configured" };
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined)
    headers["Content-Type"] = "application/json; charset=utf-8";
  if (init.token !== undefined) headers[SESSION_HEADER] = init.token;
  try {
    const response = await fetch(`${upstream.config.base}${path}`, {
      method: "POST",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { kind: "response", response };
  } catch {
    return { kind: "unreachable" };
  }
}

/**
 * Un error de la API, hacia el navegador. Sólo el sobre de §9.3 cruza; con él,
 * `Retry-After` (ERR-R01), que es lo que le dice a la pantalla cuánto esperar.
 */
async function relayError(upstream: Response, what: string): Promise<Response> {
  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    body = undefined;
  }
  const parsed = errorEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    console.error(
      `${LOG} ${what}: HTTP ${String(upstream.status)} con un cuerpo fuera de contrato`,
    );
    return errorEnvelope(
      502,
      "service_unavailable",
      "The API did not respond. Try again shortly.",
    );
  }
  const retryAfter = upstream.headers.get("retry-after");
  const { code, message, details } = parsed.data.error;
  return errorEnvelope(
    upstream.status,
    code,
    message,
    details,
    retryAfter === null ? undefined : { "retry-after": retryAfter },
  );
}

/**
 * A dónde ir tras entrar. `companyId: null` → `/onboarding`, siempre: el
 * `returnTo` de alguien sin workspace lo devolvería al wizard igual, con un
 * redirect de más.
 *
 * Si la verificación no contesta, se va al `returnTo` (o `/home`) y el
 * middleware decide en la próxima navegación — no se falla un login que sí
 * funcionó por no poder saber a qué pantalla mandar.
 */
async function nextAfterSignIn(token: string, rawReturnTo: string | undefined, env: Env) {
  const fallback = safeReturnTo(rawReturnTo) ?? ROUTES.home;
  const state = await verifySessionToken(token, env);
  if (state.kind === "authenticated" && state.session.companyId === null) {
    return ROUTES.onboarding;
  }
  return fallback;
}

/** Login y signup comparten la salida: cookie con el token, cuerpo sin él. */
async function signedIn(
  upstream: Response,
  successStatus: 200 | 201,
  rawReturnTo: string | undefined,
  env: Env,
  what: string,
): Promise<Response> {
  if (upstream.status !== successStatus) return relayError(upstream, what);

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    body = undefined;
  }
  const parsed = issuedSessionSchema.safeParse(body);
  const expiresAt = parsed.success ? new Date(parsed.data.data.expiresAt) : null;
  if (!parsed.success || expiresAt === null || Number.isNaN(expiresAt.getTime())) {
    console.error(`${LOG} ${what}: respuesta de éxito fuera de contrato`);
    return errorEnvelope(
      502,
      "service_unavailable",
      "The API did not respond. Try again shortly.",
    );
  }
  if (expiresAt.getTime() <= Date.now()) {
    // Una cookie ya vencida el navegador la descarta en silencio: el usuario
    // vería "entraste" y la próxima pantalla lo mandaría al login.
    console.error(`${LOG} ${what}: la API emitió una sesión ya vencida`);
    return errorEnvelope(
      502,
      "service_unavailable",
      "The API did not respond. Try again shortly.",
    );
  }

  const { sessionToken, user } = parsed.data.data;
  const next = await nextAfterSignIn(sessionToken, rawReturnTo, env);
  const payload: SignedInBody = { data: { user, next } };
  const response = NextResponse.json(payload, {
    status: successStatus,
    headers: { "cache-control": "no-store" },
  });
  response.cookies.set(
    SESSION_COOKIE,
    sessionToken,
    sessionCookieOptions(expiresAt, env),
  );
  return response;
}

function upstreamFailure(
  result: Exclude<UpstreamResult, { kind: "response" }>,
  what: string,
): Response {
  return result.kind === "not_configured" ? notConfigured() : unreachable(what);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleLogin(
  request: Request,
  env: Env = process.env,
): Promise<Response> {
  const rejected = rejectCrossSiteWrite(request.headers, env, LOG);
  if (rejected !== null) return rejected;
  const input = loginInput.safeParse(await readJson(request));
  if (!input.success) return invalidInput();

  const { email: address, password: secret, returnTo: back } = input.data;
  const result = await callApi(env, "/auth/login", {
    body: { email: address, password: secret },
  });
  if (result.kind !== "response") return upstreamFailure(result, "login");
  return signedIn(result.response, 200, back, env, "login");
}

export async function handleSignup(
  request: Request,
  env: Env = process.env,
): Promise<Response> {
  const rejected = rejectCrossSiteWrite(request.headers, env, LOG);
  if (rejected !== null) return rejected;
  const input = signupInput.safeParse(await readJson(request));
  if (!input.success) return invalidInput();

  const { email: address, password: secret, fullName, returnTo: back } = input.data;
  const result = await callApi(env, "/auth/signup", {
    body: { email: address, password: secret, fullName },
  });
  if (result.kind !== "response") return upstreamFailure(result, "signup");
  return signedIn(result.response, 201, back, env, "signup");
}

/**
 * `204` siempre que pase la guarda CSRF, y siempre con la cookie borrada.
 *
 * La guarda sí se exige: sin ella, cualquier página podría desloguear a
 * cualquiera (*logout CSRF*). Es una molestia, no una brecha — pero no cuesta
 * nada cerrarla.
 */
export async function handleLogout(
  request: Request,
  env: Env = process.env,
): Promise<Response> {
  const rejected = rejectCrossSiteWrite(request.headers, env, LOG);
  if (rejected !== null) return rejected;

  const token = readCookie(request, SESSION_COOKIE);
  if (token !== undefined && token !== "") {
    const result = await callApi(env, "/auth/logout", { token });
    if (result.kind === "unreachable") {
      console.error(`${LOG} logout: la API no respondió; la cookie se borra igual`);
    } else if (result.kind === "response" && result.response.status !== 204) {
      console.error(
        `${LOG} logout: la API devolvió HTTP ${String(result.response.status)}; la cookie se borra igual`,
      );
    }
  }

  const response = new NextResponse(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
  response.cookies.set(SESSION_COOKIE, "", clearedSessionCookieOptions(env));
  return response;
}

/**
 * `202` venga lo que venga de "¿existe ese email?": la API ya contesta neutro,
 * y acá no se agrega ningún detalle que lo delate.
 */
export async function handlePasswordReset(
  request: Request,
  env: Env = process.env,
): Promise<Response> {
  const rejected = rejectCrossSiteWrite(request.headers, env, LOG);
  if (rejected !== null) return rejected;
  const input = resetInput.safeParse(await readJson(request));
  if (!input.success) return invalidInput();

  const result = await callApi(env, "/auth/password-reset", {
    body: { email: input.data.email },
  });
  if (result.kind !== "response") return upstreamFailure(result, "password-reset");
  if (result.response.status !== 202)
    return relayError(result.response, "password-reset");
  return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
}

export async function handlePasswordResetComplete(
  request: Request,
  env: Env = process.env,
): Promise<Response> {
  const rejected = rejectCrossSiteWrite(request.headers, env, LOG);
  if (rejected !== null) return rejected;
  const input = resetCompleteInput.safeParse(await readJson(request));
  if (!input.success) return invalidInput();

  const result = await callApi(env, "/auth/password-reset/complete", {
    body: { token: input.data.token, newPassword: input.data.newPassword },
  });
  if (result.kind !== "response") {
    return upstreamFailure(result, "password-reset/complete");
  }
  if (result.response.status !== 204) {
    return relayError(result.response, "password-reset/complete");
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

/** Lee una cookie de un `Request` estándar (el de los tests no es un `NextRequest`). */
function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}
