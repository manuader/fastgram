/**
 * `Identity` sobre Better Auth self-hosted — `P1-AUTH-001`, IMPL ADR-008, PRD §9.1, §15.
 *
 * ## Cómo está montado
 *
 * Better Auth (1.7.5) sobre un `Pool` de `pg` —Kysely por dentro—, llamado
 * **sólo server-side** (`auth.api.*` y `auth.$context`). Su `handler` HTTP no se
 * expone: las rutas de `/signup`, `/login`, `/auth/sso-callback` las monta
 * `apps/api` sobre este adaptador. Así el formato de la cookie, los códigos de
 * error y los endpoints son nuestros, y cambiar de proveedor (lo que ADR-008
 * quiere poder hacer) no cambia la superficie HTTP.
 *
 * El modelo `user` de Better Auth **es** la tabla `users` (DATA-001), mapeada con
 * `modelName`/`fields`; sesiones, cuentas y verificaciones viven en `auth_*`
 * (`packages/db/drizzle/0011_better_auth_identity.sql`). Por eso
 * `IdentityUserId === users.id`: no hay tabla de correspondencia que sincronizar.
 *
 * ## El token de sesión
 *
 * Lo que devuelve `sessionToken` es el valor de la cookie de Better Auth: el
 * token de la fila `auth_sessions` **firmado con el secreto** (HMAC). La fila
 * guarda el token en claro; sin el secreto, leerla no alcanza para forjar un
 * valor que `verifySessionToken` acepte. Para verificar se le pasa a
 * `getSession` como cookie, que es el único camino de Better Auth que valida la
 * firma, el vencimiento y extiende la sesión (`updateAge`).
 *
 * `cookieCache` queda apagado a propósito: con él, `getSession` confía en una
 * cookie de datos firmada y **no mira la base**, así que `revokeSession` no
 * tendría efecto hasta que venciera el cache.
 *
 * ## SSO (`P1-AUTH-003`)
 *
 * El puerto lo exige, pero el PRD no nombra ningún proveedor concreto (§15.1:
 * «Email/password + SSO»). Sin proveedor que configurar, `createAuthorizationUrl`
 * y `completeAuthorization` fallan con `bad_request` estable
 * ({@link SSO_NOT_CONFIGURED_MESSAGE}). Además hay una diferencia de forma que
 * `P1-AUTH-003` tiene que resolver: el puerto hace que **quien llama** genere el
 * `state`, y el flujo de Better Auth (`signInSocial`) genera y guarda el suyo.
 *
 * ## NFR-007
 *
 * Nada de lo que devuelve este adaptador trae tokens del proveedor: principal y
 * usuario se arman campo por campo, nunca con spread del objeto de Better Auth.
 * `auth_accounts` guarda los tokens de SSO (cuando exista) cifrados
 * (`encryptOAuthTokens`).
 */

import {
  PortError,
  type AuthorizationResult,
  type AuthorizationUrl,
  type AuthorizationUrlRequest,
  type CompleteAuthorizationRequest,
  type Identity,
  type IdentityPrincipal,
  type IdentityUser,
  type IdentityUserId,
  type PortErrorCode,
} from "@fastgram/ports";
import { betterAuth } from "better-auth";
import type { Pool } from "pg";

const SOURCE = "Identity/better-auth";

/** §15.2, literal. El mismo para token basura, vencido, revocado o de usuario borrado. */
const SESSION_UNAUTHORIZED_MESSAGE = "We couldn't verify your session";

export const SSO_NOT_CONFIGURED_MESSAGE =
  "Single sign-on is not configured for this deployment";

/** El default público de Better Auth cuando no hay secreto. Nunca se acepta. */
const BETTER_AUTH_PLACEHOLDER_SECRET = "better-auth-secret-123456789";
/** Better Auth advierte por debajo de 32; acá es error. */
const MIN_SECRET_LENGTH = 32;
/** DATA-001: `users_full_name_min_len`. */
const MIN_FULL_NAME_LENGTH = 2;

/** Lo que el adaptador le entrega al callback de envío de email. Sin URL a propósito. */
export interface IdentityEmailMessage {
  readonly email: string;
  /**
   * Credencial de un solo uso. La URL la arma quien envía, apuntando a la ruta
   * de `apps/web`/`apps/api` que corresponda: el handler de Better Auth no está
   * montado, así que la URL que él generaría no existe.
   */
  readonly token: string;
}

export type IdentityEmailSender = (message: IdentityEmailMessage) => Promise<void>;

export interface BetterAuthIdentityConfig {
  /** Pool de `pg` contra la base de `packages/db`. Lo cierra quien lo creó. */
  readonly pool: Pool;
  /** `BETTER_AUTH_SECRET`. Requerido, ≥ 32 caracteres, sin default. */
  readonly secret: string;
  /** `BETTER_AUTH_URL`: origen público de la API. Requerido, absoluto, sin default. */
  readonly baseUrl: string;
  /**
   * §15.3: la recuperación la hace el proveedor, pero el envío del email no:
   * no hay adaptador de email en el repo. Requerido porque `requestPasswordReset`
   * es parte del puerto; sin él, Better Auth rechaza el pedido.
   */
  readonly sendPasswordResetEmail: IdentityEmailSender;
  /**
   * Opcional. Sin él no se envía verificación al alta y `emailVerified` queda en
   * `false` hasta que algo llame a {@link BetterAuthIdentity.verifyEmail}.
   */
  readonly sendVerificationEmail?: IdentityEmailSender;
  /**
   * Políticas. El PRD no da números (§9.1, §15, F-001…F-003): lo omitido usa el
   * default de Better Auth 1.7.5 — 8/128 caracteres, sesión de 7 días que se
   * extiende si se usa después de 1 día, token de reset de 1 hora.
   */
  readonly minPasswordLength?: number;
  readonly maxPasswordLength?: number;
  readonly sessionExpiresInSeconds?: number;
  readonly sessionUpdateAgeSeconds?: number;
  readonly resetPasswordTokenExpiresInSeconds?: number;
  /** Nivel del logger interno de Better Auth. Default `warn`. */
  readonly logLevel?: "debug" | "info" | "warn" | "error";
}

export interface PasswordSignUpRequest {
  readonly email: string;
  readonly password: string;
  /** `users.full_name`: ≥ 2 caracteres (DATA-001). */
  readonly fullName: string;
  /** IANA. Default `UTC`; el PRD dice que se sincroniza sola después. */
  readonly timezone?: string;
}

export interface PasswordSignInRequest {
  readonly email: string;
  readonly password: string;
}

export interface CompletePasswordResetRequest {
  readonly token: string;
  readonly newPassword: string;
}

function buildAuth(config: BetterAuthIdentityConfig) {
  const sendVerification = config.sendVerificationEmail;
  return betterAuth({
    appName: "FastGram",
    baseURL: config.baseUrl,
    secret: config.secret,
    database: config.pool,
    // No hay handler montado, pero se deja explícito: el rate limit de auth lo
    // hace `apps/api` (NFR-009), no un contador en memoria por proceso.
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    logger: { level: config.logLevel ?? "warn" },
    advanced: {
      database: { generateId: "uuid" },
    },
    emailAndPassword: {
      enabled: true,
      // `false` es el default; explícito porque con `true` el alta duplicada
      // devuelve éxito falso (anti-enumeración) y el puerto promete `conflict`.
      requireEmailVerification: false,
      ...(config.minPasswordLength === undefined
        ? {}
        : { minPasswordLength: config.minPasswordLength }),
      ...(config.maxPasswordLength === undefined
        ? {}
        : { maxPasswordLength: config.maxPasswordLength }),
      ...(config.resetPasswordTokenExpiresInSeconds === undefined
        ? {}
        : { resetPasswordTokenExpiresIn: config.resetPasswordTokenExpiresInSeconds }),
      // Default de Better Auth: `false`. Una contraseña reseteada tiene que
      // cerrar las sesiones abiertas con la vieja.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        await config.sendPasswordResetEmail({ email: user.email, token });
      },
    },
    ...(sendVerification === undefined
      ? {}
      : {
          emailVerification: {
            sendOnSignUp: true,
            sendVerificationEmail: async ({
              user,
              token,
            }: {
              user: { email: string };
              token: string;
            }) => {
              await sendVerification({ email: user.email, token });
            },
          },
        }),
    user: {
      modelName: "users",
      fields: {
        name: "full_name",
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      additionalFields: {
        timezone: {
          type: "string",
          required: false,
          defaultValue: "UTC",
          input: true,
          fieldName: "timezone",
        },
      },
    },
    session: {
      modelName: "auth_sessions",
      fields: {
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        userId: "user_id",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      ...(config.sessionExpiresInSeconds === undefined
        ? {}
        : { expiresIn: config.sessionExpiresInSeconds }),
      ...(config.sessionUpdateAgeSeconds === undefined
        ? {}
        : { updateAge: config.sessionUpdateAgeSeconds }),
      cookieCache: { enabled: false },
    },
    account: {
      modelName: "auth_accounts",
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      encryptOAuthTokens: true,
    },
    verification: {
      modelName: "auth_verifications",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
  });
}

type BuiltAuth = ReturnType<typeof buildAuth>;

export class BetterAuthIdentity implements Identity {
  readonly #auth: BuiltAuth;

  constructor(config: BetterAuthIdentityConfig) {
    assertConfig(config);
    this.#auth = buildAuth(config);
  }

  async verifySessionToken(sessionToken: string): Promise<IdentityPrincipal> {
    // Vacío o con caracteres que no pueden venir de nuestra cookie: el valor va
    // dentro de un header `cookie`, y un `;` permitiría inyectar otra cookie.
    if (!isCookieSafe(sessionToken)) throw sessionUnauthorized();

    const result = await this.#call(async () => {
      const cookieName = await this.#sessionCookieName();
      return this.#auth.api.getSession({
        headers: new Headers({ cookie: `${cookieName}=${sessionToken}` }),
        query: { disableCookieCache: true },
      });
    }, SESSION_UNAUTHORIZED_MESSAGE);

    if (result === null) throw sessionUnauthorized();
    return toPrincipal(result.user, result.session);
  }

  async getUser(userId: IdentityUserId): Promise<IdentityUser | null> {
    // Un id que no es uuid no existe — y a Postgres le llegaría como error de
    // sintaxis (`22P02`), que no es «no existe». `NFR-006`: `null`, sin más.
    if (!isUuid(userId)) return null;
    const user = await this.#call(async () => {
      const ctx = await this.#auth.$context;
      return ctx.internalAdapter.findUserById(userId);
    });
    return user === null ? null : toIdentityUser(user);
  }

  async createAuthorizationUrl(
    request: AuthorizationUrlRequest,
  ): Promise<AuthorizationUrl> {
    if (request.state.length === 0) {
      throw new PortError("bad_request", "state is required", { source: SOURCE });
    }
    if (!isAbsoluteUrl(request.redirectUri)) {
      throw new PortError("bad_request", "redirectUri must be an absolute URL", {
        source: SOURCE,
      });
    }
    throw new PortError("bad_request", SSO_NOT_CONFIGURED_MESSAGE, { source: SOURCE });
  }

  async completeAuthorization(
    _request: CompleteAuthorizationRequest,
  ): Promise<AuthorizationResult> {
    // Sin proveedor configurado ningún `code` puede ser válido. `bad_request` y
    // no `unauthorized`: el problema es del despliegue, no de quien vuelve.
    throw new PortError("bad_request", SSO_NOT_CONFIGURED_MESSAGE, { source: SOURCE });
  }

  async requestPasswordReset(email: string): Promise<void> {
    // Better Auth responde igual exista o no la cuenta. Queda una diferencia de
    // tiempo: con cuenta, espera al callback de envío (ver el reporte).
    await this.#call(() => this.#auth.api.requestPasswordReset({ body: { email } }));
  }

  async revokeSession(sessionId: string): Promise<void> {
    if (!isUuid(sessionId)) return; // no puede existir: idempotente.
    await this.#call(async () => {
      const ctx = await this.#auth.$context;
      await ctx.adapter.deleteMany({
        model: "session",
        where: [{ field: "id", value: sessionId }],
      });
    });
  }

  async deleteUser(userId: IdentityUserId): Promise<void> {
    if (!isUuid(userId)) return; // no puede existir: idempotente.
    /**
     * Una sola sentencia sobre `users`: las FK `ON DELETE CASCADE` de `0011` se
     * llevan sesiones y credenciales **en la misma sentencia**. No hay orden que
     * elegir ni estado intermedio: o se borra todo, o nada.
     *
     * No se usa `internalAdapter.deleteUser` a propósito: borra sesiones,
     * cuentas y usuario en **tres** sentencias sin transacción. Si la última
     * fallara —`companies.owner_user_id` es `ON DELETE RESTRICT`— quedaría una
     * cuenta sin credenciales y con la fila viva: el usuario no puede entrar y
     * tampoco irse. Es exactamente el fallo de §9.1.
     *
     * Los tokens de reset (`auth_verifications.value = userId`) se borran en la
     * misma transacción; los demás tipos de verificación no guardan el userId y
     * vencen solos.
     */
    await this.#call(async () => {
      const ctx = await this.#auth.$context;
      const run = async (
        adapter: Pick<typeof ctx.adapter, "deleteMany" | "delete">,
      ): Promise<void> => {
        await adapter.deleteMany({
          model: "verification",
          where: [{ field: "value", value: userId }],
        });
        await adapter.delete({ model: "user", where: [{ field: "id", value: userId }] });
      };
      const transaction = ctx.adapter.transaction;
      if (typeof transaction === "function") {
        await transaction((trx) => run(trx));
      } else {
        await run(ctx.adapter);
      }
    });
  }

  // ── Fuera del puerto: email/password (`P1-AUTH-002`, `P1-AUTH-005`) ─────────
  //
  // El puerto no modela alta ni login con contraseña (sólo SSO). Estos métodos
  // son de este adaptador; `apps/api` los usa detrás de sus rutas. Ver el
  // reporte de `P1-AUTH-001`: si se quiere que sobrevivan a un cambio de
  // proveedor, el puerto tiene que crecer.

  async signUpWithPassword(request: PasswordSignUpRequest): Promise<AuthorizationResult> {
    const fullName = request.fullName.trim();
    if (fullName.length < MIN_FULL_NAME_LENGTH) {
      throw new PortError("bad_request", "Full name must have at least 2 characters", {
        source: SOURCE,
      });
    }
    const timezone = request.timezone ?? "UTC";
    if (!isIanaTimezone(timezone)) {
      throw new PortError("bad_request", "Unknown timezone", { source: SOURCE });
    }

    const { headers, response } = await this.#call(
      () =>
        this.#auth.api.signUpEmail({
          body: {
            email: request.email,
            password: request.password,
            name: fullName,
            timezone,
          },
          returnHeaders: true,
        }),
      "We couldn't create your account",
      () => this.#emailTaken(request.email),
    );
    if (response.token === null) {
      // `autoSignIn` está en su default (`true`): sin sesión, Better Auth cambió
      // de comportamiento bajo nuestros pies.
      throw new PortError(
        "provider_contract_violation",
        "Sign up did not open a session",
        {
          source: SOURCE,
        },
      );
    }
    return this.#resultFromHeaders(headers, true);
  }

  async signInWithPassword(request: PasswordSignInRequest): Promise<AuthorizationResult> {
    const { headers } = await this.#call(
      () =>
        this.#auth.api.signInEmail({
          body: { email: request.email, password: request.password },
          returnHeaders: true,
        }),
      "Invalid email or password",
    );
    return this.#resultFromHeaders(headers, false);
  }

  /** §15.3: consume el token que llegó por email. Cierra las sesiones abiertas. */
  async completePasswordReset(request: CompletePasswordResetRequest): Promise<void> {
    await this.#call(
      () =>
        this.#auth.api.resetPassword({
          body: { token: request.token, newPassword: request.newPassword },
        }),
      "This reset link is invalid or has expired",
    );
  }

  /** Consume el token de verificación de email. */
  async verifyEmail(token: string): Promise<void> {
    await this.#call(
      () => this.#auth.api.verifyEmail({ query: { token } }),
      "This verification link is invalid or has expired",
    );
  }

  // ── Internos ────────────────────────────────────────────────────────────────

  async #sessionCookieName(): Promise<string> {
    const ctx = await this.#auth.$context;
    return ctx.authCookies.sessionToken.name;
  }

  async #resultFromHeaders(
    headers: Headers,
    isNewUser: boolean,
  ): Promise<AuthorizationResult> {
    const cookieName = await this.#sessionCookieName();
    const sessionToken = readSetCookie(headers, cookieName);
    if (sessionToken === null) {
      throw new PortError(
        "provider_contract_violation",
        "The identity provider did not issue a session",
        { source: SOURCE },
      );
    }
    // Se verifica en vez de armar el principal con lo que devolvió el alta: es
    // la misma ruta que usará cada petición, y si no acepta el token recién
    // emitido, mejor saberlo acá.
    const principal = await this.verifySessionToken(sessionToken);
    return { principal, sessionToken, isNewUser };
  }

  async #emailTaken(email: string): Promise<boolean> {
    const ctx = await this.#auth.$context;
    const found = await ctx.internalAdapter.findUserByEmail(email.toLowerCase());
    return found !== null;
  }

  /**
   * Toda llamada a Better Auth pasa por acá: ningún error crudo sale del
   * adaptador. `unauthorizedMessage` es el texto público cuando el proveedor
   * responde 401; `isConflict` desambigua un alta fallida (ver `mapError`).
   */
  async #call<T>(
    body: () => Promise<T>,
    unauthorizedMessage = SESSION_UNAUTHORIZED_MESSAGE,
    isConflict?: () => Promise<boolean>,
  ): Promise<T> {
    try {
      return await body();
    } catch (error) {
      throw await mapError(error, unauthorizedMessage, isConflict);
    }
  }
}

// ── Traducción de errores ─────────────────────────────────────────────────────

/** Códigos de `BASE_ERROR_CODES` de Better Auth 1.7.5 que tienen traducción propia. */
const CODE_BY_PROVIDER_CODE: Readonly<Record<string, PortErrorCode>> = {
  USER_ALREADY_EXISTS: "conflict",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "conflict",
  INVALID_EMAIL_OR_PASSWORD: "unauthorized",
  INVALID_TOKEN: "unauthorized",
  TOKEN_EXPIRED: "unauthorized",
  SESSION_EXPIRED: "unauthorized",
  FAILED_TO_GET_SESSION: "unauthorized",
  INVALID_EMAIL: "bad_request",
  INVALID_PASSWORD: "bad_request",
  PASSWORD_TOO_SHORT: "bad_request",
  PASSWORD_TOO_LONG: "bad_request",
  VALIDATION_ERROR: "bad_request",
  RESET_PASSWORD_DISABLED: "provider_unavailable",
  SCHEMA_MISMATCH: "provider_unavailable",
};

const PUBLIC_MESSAGE: Readonly<Record<PortErrorCode, string>> = {
  not_found: "Not found",
  forbidden: "Forbidden",
  unauthorized: SESSION_UNAUTHORIZED_MESSAGE,
  bad_request: "The request is not valid",
  conflict: "An account with this email already exists",
  rate_limited: "Too many attempts. Try again later",
  provider_unavailable: "Authentication is temporarily unavailable",
  timeout: "Authentication timed out",
  quota_exceeded: "Quota exceeded",
  provider_contract_violation: "Authentication returned an unexpected response",
};

async function mapError(
  error: unknown,
  unauthorizedMessage: string,
  isConflict: (() => Promise<boolean>) | undefined,
): Promise<PortError> {
  if (error instanceof PortError) return error;

  const code = await classify(error, isConflict);
  const message = code === "unauthorized" ? unauthorizedMessage : PUBLIC_MESSAGE[code];
  const retryAfterSeconds = code === "rate_limited" ? retryAfterOf(error) : undefined;
  return new PortError(code, message, {
    source: SOURCE,
    cause: error,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
}

async function classify(
  error: unknown,
  isConflict: (() => Promise<boolean>) | undefined,
): Promise<PortErrorCode> {
  const providerCode = stringField(error, "code");
  const body = objectField(error, "body");
  const bodyCode = body === undefined ? undefined : stringField(body, "code");
  const statusCode = numberField(error, "statusCode");

  if (statusCode !== undefined) {
    // `FAILED_TO_CREATE_USER` tapa cualquier error del INSERT. El único que
    // importa distinguir es la carrera de dos altas con el mismo email: las dos
    // pasan el chequeo previo y una choca con `users_email_uq`. Eso es
    // `conflict`, no un fallo del proveedor (trampa 37).
    if (bodyCode === "FAILED_TO_CREATE_USER") {
      if (isConflict !== undefined && (await isConflict().catch(() => false))) {
        return "conflict";
      }
      return "provider_unavailable";
    }
    const mapped = bodyCode === undefined ? undefined : CODE_BY_PROVIDER_CODE[bodyCode];
    if (mapped !== undefined) return mapped;
    return codeFromStatus(statusCode);
  }

  if (providerCode !== undefined) {
    const mapped = CODE_BY_PROVIDER_CODE[providerCode];
    if (mapped !== undefined) return mapped;
    const pg = codeFromPostgres(providerCode);
    if (pg !== undefined) return pg;
  }
  return "provider_unavailable";
}

function codeFromStatus(status: number): PortErrorCode {
  if (status === 400 || status === 422) return "bad_request";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 504) return "timeout";
  return "provider_unavailable";
}

/** SQLSTATE → código. Sólo los que tienen un significado para el puerto. */
function codeFromPostgres(sqlState: string): PortErrorCode | undefined {
  if (!/^[0-9A-Z]{5}$/.test(sqlState)) return undefined;
  // 23503: `companies.owner_user_id` es RESTRICT — el usuario todavía es dueño
  // de un workspace. Borrar los datos del workspace es de `core` (puerto).
  if (sqlState === "23503" || sqlState === "23505") return "conflict";
  if (sqlState === "57014") return "timeout";
  return "provider_unavailable";
}

function retryAfterOf(error: unknown): number | undefined {
  const headers = objectField(error, "headers");
  if (headers instanceof Headers) {
    const value = Number(headers.get("retry-after"));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : undefined;
}

function objectField(value: unknown, key: string): object | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "object" && field !== null ? field : undefined;
}

// ── Formas de salida (NFR-007: campo por campo, nunca spread) ─────────────────

interface ProviderUser {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
  readonly image?: string | null | undefined;
  readonly createdAt: Date;
}

interface ProviderSession {
  readonly id: string;
  readonly expiresAt: Date;
}

function toPrincipal(user: ProviderUser, session: ProviderSession): IdentityPrincipal {
  const expiresAt = toDate(session.expiresAt);
  if (
    typeof user.id !== "string" ||
    user.id.length === 0 ||
    typeof user.email !== "string" ||
    user.email.length === 0 ||
    typeof session.id !== "string" ||
    session.id.length === 0 ||
    expiresAt === null
  ) {
    throw new PortError(
      "provider_contract_violation",
      "The identity provider returned a session without the minimum claims",
      { source: SOURCE },
    );
  }
  return {
    userId: user.id,
    email: user.email,
    emailVerified: user.emailVerified === true,
    sessionId: session.id,
    expiresAt,
  };
}

function toIdentityUser(user: ProviderUser): IdentityUser {
  const createdAt = toDate(user.createdAt);
  if (createdAt === null) {
    throw new PortError(
      "provider_contract_violation",
      "The identity provider returned a user without createdAt",
      { source: SOURCE },
    );
  }
  return {
    userId: user.id,
    email: user.email,
    emailVerified: user.emailVerified === true,
    displayName: user.name,
    ...(typeof user.image === "string" && user.image.length > 0
      ? { avatarUrl: user.image }
      : {}),
    createdAt,
  };
}

function toDate(value: unknown): Date | null {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

// ── Utilidades ────────────────────────────────────────────────────────────────

function sessionUnauthorized(): PortError {
  return new PortError("unauthorized", SESSION_UNAUTHORIZED_MESSAGE, { source: SOURCE });
}

function assertConfig(config: BetterAuthIdentityConfig): void {
  // Los mensajes nombran la variable, nunca el valor.
  if (
    typeof config.secret !== "string" ||
    config.secret.length < MIN_SECRET_LENGTH ||
    config.secret === BETTER_AUTH_PLACEHOLDER_SECRET
  ) {
    throw new Error(
      `BetterAuthIdentity: secret (BETTER_AUTH_SECRET) is required and must have at least ${String(MIN_SECRET_LENGTH)} characters`,
    );
  }
  if (!isAbsoluteUrl(config.baseUrl)) {
    throw new Error(
      "BetterAuthIdentity: baseUrl (BETTER_AUTH_URL) is required and must be an absolute http(s) URL",
    );
  }
  if (typeof config.sendPasswordResetEmail !== "function") {
    throw new Error("BetterAuthIdentity: sendPasswordResetEmail is required");
  }
}

/** Lo que puede salir de `Set-Cookie` de Better Auth: token, `.`, firma url-encoded. */
function isCookieSafe(value: string): boolean {
  return value.length > 0 && value.length <= 512 && /^[A-Za-z0-9._~%-]+$/.test(value);
}

function readSetCookie(headers: Headers, name: string): string | null {
  for (const line of headers.getSetCookie()) {
    if (!line.startsWith(`${name}=`)) continue;
    const value = line.slice(name.length + 1).split(";", 1)[0] ?? "";
    return value.length > 0 ? value : null;
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isAbsoluteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
