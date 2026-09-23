/**
 * El lado navegador de entrar y salir · F-001…F-003, PRD §15.1–15.3.
 *
 * Habla **sólo** con los route handlers de esta app (`/api/fastgram/auth/*`,
 * `lib/auth/bff.ts`), nunca con `apps/api`: el token de sesión no pasa por
 * este código — lo pone el servidor en una cookie `httpOnly`. Lo único que
 * vuelve es el usuario y a dónde ir.
 *
 * No usa `lib/api/client.ts` porque ése está atado a la base
 * `/api/fastgram/v1` y a validar `{data}`; acá hay `202`/`204` sin cuerpo y
 * un `Retry-After` que hay que leer del header. Los errores sí son el mismo
 * `ApiRequestError`, con el mismo sobre de §9.3.
 */
import { errorEnvelopeSchema } from "@fastgram/contracts";
import { z } from "zod";
import { ApiRequestError } from "../api/errors";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "../api/csrf";
import type { CopyKey, MessageVars } from "../i18n/t";

export const AUTH_BASE = "/api/fastgram/auth";

const signedInSchema = z.object({
  data: z.object({
    user: z.object({ id: z.string(), email: z.string(), emailVerified: z.boolean() }),
    next: z.string().startsWith("/"),
  }),
});
export type SignedIn = z.infer<typeof signedInSchema>["data"];

async function post(path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    // Los handlers rechazan con `403` todo `POST` sin este header (`lib/api/csrf.ts`).
    [CSRF_HEADER]: CSRF_HEADER_VALUE,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
  let response: Response;
  try {
    response = await fetch(`${AUTH_BASE}${path}`, {
      method: "POST",
      headers,
      credentials: "same-origin",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    throw new ApiRequestError({
      code: "network_error",
      status: 0,
      serverMessage: cause instanceof Error ? cause.message : undefined,
    });
  }
  if (!response.ok) throw await failureOf(response);
  return response;
}

/**
 * `Retry-After` en segundos (la forma que usa `apps/api`). La forma de fecha
 * HTTP también es válida en el estándar; se acepta por si acaso.
 */
export function retryAfterSeconds(
  header: string | null,
  now: number = Date.now(),
): number | null {
  if (header === null || header.trim() === "") return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

async function failureOf(response: Response): Promise<ApiRequestError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = errorEnvelopeSchema.safeParse(body);
  const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
  if (!parsed.success) {
    return new ApiRequestError({
      code: "invalid_response",
      status: response.status,
      serverMessage: `Unrecognised error envelope (HTTP ${String(response.status)})`,
    });
  }
  const error = ApiRequestError.fromEnvelope(parsed.data.error, response.status);
  if (retryAfter === null) return error;
  return new ApiRequestError({
    code: error.code,
    status: error.status,
    serverMessage: error.serverMessage,
    details: { ...error.details, retryAfterSeconds: retryAfter },
  });
}

async function signedIn(response: Response): Promise<SignedIn> {
  const parsed = signedInSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    throw new ApiRequestError({
      code: "invalid_response",
      status: response.status,
      serverMessage: "Sign-in response was not understood",
    });
  }
  return parsed.data.data;
}

export async function signIn(input: {
  email: string;
  password: string;
  returnTo?: string | undefined;
}): Promise<SignedIn> {
  return signedIn(await post("/login", input));
}

export async function signUp(input: {
  email: string;
  password: string;
  fullName: string;
  returnTo?: string | undefined;
}): Promise<SignedIn> {
  return signedIn(await post("/signup", input));
}

export async function signOut(): Promise<void> {
  await post("/logout");
}

export async function requestPasswordReset(email: string): Promise<void> {
  await post("/password-reset", { email });
}

export async function completePasswordReset(input: {
  token: string;
  newPassword: string;
}): Promise<void> {
  await post("/password-reset/complete", input);
}

// ---------------------------------------------------------------------------
// Qué lee el usuario
// ---------------------------------------------------------------------------

export type AuthForm = "login" | "signup" | "forgot" | "reset";

export interface AuthErrorPresentation {
  readonly key: CopyKey;
  readonly vars?: MessageVars;
  /** `409` en el signup: la salida es ir al login, no reintentar. */
  readonly action?: "login" | "requestNewLink";
}

/**
 * De un fallo a un mensaje, **según la pantalla**: el mismo `401` en el login
 * es "no coinciden"; el mismo `400` en el reset es "el enlace no vale".
 */
export function presentAuthError(error: unknown, form: AuthForm): AuthErrorPresentation {
  if (!(error instanceof ApiRequestError)) return { key: "common.somethingWentWrong" };
  switch (error.code) {
    case "unauthorized":
      return form === "login"
        ? { key: "auth.error.invalidCredentials" }
        : { key: "error.accessDenied.title" };
    case "conflict":
      return form === "signup"
        ? { key: "auth.error.emailTaken", action: "login" }
        : { key: "error.conflict.title" };
    case "bad_request":
      return form === "reset"
        ? { key: "auth.reset.invalidLink", action: "requestNewLink" }
        : { key: "error.badRequest.title" };
    case "rate_limited": {
      const seconds = error.details?.["retryAfterSeconds"];
      return typeof seconds === "number" && seconds > 0
        ? { key: "auth.error.rateLimitedFor", vars: { seconds } }
        : { key: "auth.error.rateLimited" };
    }
    case "service_unavailable":
      return { key: "error.serviceUnavailable.title" };
    case "network_error":
      return { key: "error.network.title" };
    default:
      return { key: "common.somethingWentWrong" };
  }
}
