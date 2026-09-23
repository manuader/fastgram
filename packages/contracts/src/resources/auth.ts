/**
 * Autenticación de usuario — `F-001`…`F-003`, PRD §15.1–15.3, §9.1, ADR-008.
 *
 * ## Interno: no es parte de la API pública v1
 *
 * §9.3 enumera la superficie v1 (server-to-server, API key) y **ninguna ruta de
 * auth** está ahí. Estas seis existen para un solo cliente: el servidor de
 * `apps/web`, que hace de BFF. El flujo:
 *
 *   navegador ──cookie httpOnly de la web──▶ apps/web ──`X-Fastgram-Session`──▶ apps/api
 *
 * La API emite el `sessionToken` **sólo** en el cuerpo de signup/login, se lo
 * entrega al servidor web, y éste lo guarda en su propia cookie. La API nunca
 * lee cookies. En el OpenAPI van marcadas `x-internal` y con `security: []`: no
 * exigen API key, y un SDK público no debería generarlas.
 *
 * ## Lo que el PRD no da y se decidió acá
 *
 *  - **Longitudes de contraseña.** El PRD no fija política (§15 delega en el
 *    proveedor). 8–128 es el default de Better Auth 1.7.5, que es lo que valida
 *    el adaptador; se repite acá para que el formulario pueda validar antes de
 *    viajar. Si cambia la política del adaptador, cambia esto.
 *  - **`fullName` ≥ 2** sale de DATA-001 (`users_full_name_min_len`). El máximo
 *    de 200 es una cota de sanidad, no un número del PRD.
 *  - **Email ≤ 254**: el máximo práctico de RFC 5321 para una dirección.
 */
import { z } from "zod";

// --- Números -----------------------------------------------------------------

/** Default de Better Auth 1.7.5 (`minPasswordLength`). No es un número del PRD. */
export const PASSWORD_MIN_LENGTH = 8;
/** Default de Better Auth 1.7.5 (`maxPasswordLength`). No es un número del PRD. */
export const PASSWORD_MAX_LENGTH = 128;
/** DATA-001 — `users_full_name_min_len`. */
export const FULL_NAME_MIN_LENGTH = 2;
/** Cota de sanidad, no del PRD. */
export const FULL_NAME_MAX_LENGTH = 200;
/** RFC 5321: el máximo práctico de una dirección. */
export const EMAIL_MAX_LENGTH = 254;

/** El header por el que el BFF reenvía la sesión. La API no lee cookies. */
export const SESSION_HEADER = "X-Fastgram-Session";

/**
 * §15.2 (PRD:2820), literal. Es el mensaje de **todo** 401 de sesión: token
 * basura, vencido, revocado o de un usuario borrado se ven igual.
 */
export const SESSION_UNAUTHORIZED_MESSAGE =
  "We couldn't verify your session. Try again, or sign in again if this continues.";

// --- Piezas ------------------------------------------------------------------

const emailSchema = z.string().trim().min(3).max(EMAIL_MAX_LENGTH).email();
const newPasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

/** El usuario tal como lo ve el BFF. Campo por campo: nada del proveedor. */
export const authUserSchema = z
  .object({
    id: z.string().min(1),
    email: z.string().min(1),
    emailVerified: z.boolean(),
  })
  .strict();
export type AuthUser = z.infer<typeof authUserSchema>;

// --- Requests ----------------------------------------------------------------

/** `POST /auth/signup` — F-001, §15.1. */
export const signUpRequestSchema = z
  .object({
    email: emailSchema,
    password: newPasswordSchema,
    fullName: z.string().trim().min(FULL_NAME_MIN_LENGTH).max(FULL_NAME_MAX_LENGTH),
  })
  .strict();
export type SignUpRequest = z.infer<typeof signUpRequestSchema>;

/**
 * `POST /auth/login` — F-002, §15.2.
 *
 * La contraseña **no** lleva el mínimo de la política: una contraseña de 3
 * caracteres es una credencial incorrecta (401 neutro), no un pedido mal formado
 * (400). Con el mínimo acá, el 400 le diría a quien prueba algo sobre la política
 * y el 401 dejaría de ser la única respuesta a "no entrás".
 */
export const loginRequestSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  })
  .strict();
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** `POST /auth/password-reset` — §15.3. Responde 202 exista o no la cuenta. */
export const passwordResetRequestSchema = z.object({ email: emailSchema }).strict();
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

/** `POST /auth/password-reset/complete` — §15.3. */
export const passwordResetCompleteRequestSchema = z
  .object({
    token: z.string().min(1).max(512),
    newPassword: newPasswordSchema,
  })
  .strict();
export type PasswordResetCompleteRequest = z.infer<
  typeof passwordResetCompleteRequestSchema
>;

// --- Responses ---------------------------------------------------------------

/**
 * Lo que devuelven signup y login. `sessionToken` es una credencial bearer: el
 * BFF la guarda en una cookie httpOnly y **nunca** se la da al navegador en
 * claro. `expiresAt` en ISO 8601.
 */
export const authSessionSchema = z
  .object({
    sessionToken: z.string().min(1),
    expiresAt: z.string().datetime(),
    user: authUserSchema,
  })
  .strict();
export type AuthSession = z.infer<typeof authSessionSchema>;

/**
 * `GET /auth/session`. `companyId: null` = sesión válida sin ningún workspace
 * activo: el BFF lo manda al onboarding. Las rutas de negocio, con esa misma
 * sesión, responden `403 forbidden`.
 */
export const sessionInfoSchema = z
  .object({
    user: authUserSchema,
    companyId: z.string().min(1).nullable(),
  })
  .strict();
export type SessionInfo = z.infer<typeof sessionInfoSchema>;
