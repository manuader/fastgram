/**
 * `Identity` en memoria — PRD §9.1, §15, IMPL ADR-008.
 *
 * **Esto no es Better Auth.** ADR-008 elige Better Auth self-hosted y ese
 * adaptador todavía no existe: el paquete no está declarado en
 * `packages/adapters` (ver el reporte de la tarea). Lo que hay acá es la
 * tercera implementación, la de tests — el mismo papel que `MemoryStorage`
 * cumple para `Storage`.
 *
 * Justifica su existencia por dos cosas concretas:
 *
 * 1. **Correr la suite de contrato de `Identity` sin proveedor.** Los nueve
 *    casos estaban escritos y nunca se habían ejecutado. Que corran contra
 *    algo hace que el día que aparezca el adaptador de Better Auth, la suite
 *    ya esté probada y el único sospechoso sea el adaptador nuevo.
 *
 * 2. **Tests de casos de uso.** El middleware de scope de `P1-API-007` empieza
 *    en `verifySessionToken`. Testearlo no debería necesitar un servidor de
 *    identidad, pero sí necesita que `unauthorized` se comporte igual que en
 *    producción — que es lo que la suite compartida garantiza.
 *
 * **Lo que deliberadamente NO hace:** criptografía. Los tokens son opacos y
 * arbitrarios, las contraseñas no existen y `completeAuthorization` no habla
 * OAuth con nadie. Un test que dependa de validar una firma real tiene que
 * correr contra el proveedor.
 *
 * **Va con `systemClock`, no con un reloj congelado**, por la misma razón que
 * `MemoryStorage`: `IdentityPrincipal.expiresAt` lo compara el contrato contra
 * la hora de pared (`checkFuture`), porque una sesión vence contra el reloj
 * del navegador del usuario y no contra uno inyectado.
 */

import { randomUUID } from "node:crypto";
import {
  PortError,
  type AuthorizationResult,
  type AuthorizationUrl,
  type AuthorizationUrlRequest,
  type Clock,
  type CompleteAuthorizationRequest,
  type Identity,
  type IdentityPrincipal,
  type IdentityUser,
  type IdentityUserId,
} from "@fastgram/ports";
import { systemClock } from "../clock/index.js";

const SOURCE = "Identity/memory";

/** Una hora. No hay número normativo en el PRD; es el default del adaptador. */
const DEFAULT_SESSION_TTL_SECONDS = 3600;

export interface MemoryIdentitySeedUser {
  readonly userId: IdentityUserId;
  readonly email: string;
  readonly emailVerified?: boolean;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  /** Token de sesión ya emitido, para no tener que hacer el flujo en cada test. */
  readonly sessionToken?: string;
}

export interface MemoryIdentityOptions {
  readonly users?: readonly MemoryIdentitySeedUser[];
  readonly clock?: Clock;
  readonly sessionTtlSeconds?: number;
  /** Base de la URL de autorización simulada. */
  readonly authorizationBaseUrl?: string;
}

interface StoredSession {
  readonly sessionId: string;
  readonly userId: IdentityUserId;
  readonly expiresAt: Date;
}

export class MemoryIdentity implements Identity {
  readonly #users = new Map<IdentityUserId, IdentityUser>();
  readonly #sessionsByToken = new Map<string, StoredSession>();
  /** `code` → usuario, para que `completeAuthorization` tenga qué validar. */
  readonly #codes = new Map<string, { userId: IdentityUserId; state: string }>();
  readonly #seenUsers = new Set<IdentityUserId>();
  readonly #clock: Clock;
  readonly #ttlSeconds: number;
  readonly #authorizationBaseUrl: string;

  constructor(options: MemoryIdentityOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#ttlSeconds = options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    this.#authorizationBaseUrl =
      options.authorizationBaseUrl ?? "https://identity.invalid/authorize";

    for (const seed of options.users ?? []) {
      this.#users.set(seed.userId, {
        userId: seed.userId,
        email: seed.email,
        emailVerified: seed.emailVerified ?? true,
        createdAt: this.#clock.now(),
        ...(seed.displayName === undefined ? {} : { displayName: seed.displayName }),
        ...(seed.avatarUrl === undefined ? {} : { avatarUrl: seed.avatarUrl }),
      });
      this.#seenUsers.add(seed.userId);
      if (seed.sessionToken !== undefined) {
        this.issueSession(seed.userId, seed.sessionToken);
      }
    }
  }

  /** Sólo para tests: emite una sesión sin pasar por el flujo de SSO. */
  // `token: string` explícito: sin la anotación, el default de `randomUUID()`
  // infiere el tipo plantilla `${string}-${string}-…` y un token sembrado por
  // un test —que es un string cualquiera— deja de compilar.
  issueSession(userId: IdentityUserId, token: string = randomUUID()): string {
    this.#sessionsByToken.set(token, {
      sessionId: `ses_${randomUUID()}`,
      userId,
      expiresAt: new Date(this.#clock.nowMs() + this.#ttlSeconds * 1000),
    });
    return token;
  }

  /** Sólo para tests: prepara el `code` que devolvería el proveedor. */
  issueAuthorizationCode(userId: IdentityUserId, state: string): string {
    const code = `code_${randomUUID()}`;
    this.#codes.set(code, { userId, state });
    return code;
  }

  async verifySessionToken(sessionToken: string): Promise<IdentityPrincipal> {
    // Token vacío incluido: el contrato es explícito en que no puede colarse
    // como `bad_request`, y menos como éxito.
    const session =
      sessionToken.length === 0 ? undefined : this.#sessionsByToken.get(sessionToken);
    if (session === undefined) {
      throw unauthorized();
    }
    if (session.expiresAt.getTime() <= this.#clock.nowMs()) {
      this.#sessionsByToken.delete(sessionToken);
      throw unauthorized();
    }
    const user = this.#users.get(session.userId);
    if (user === undefined) {
      // La sesión sobrevivió al borrado del usuario. Es `unauthorized` y no
      // `not_found`: §9.1 pide que el borrado deje la cuenta irrecuperable, y
      // un `not_found` acá confirmaría que esa cuenta existió.
      throw unauthorized();
    }

    return {
      userId: user.userId,
      email: user.email,
      emailVerified: user.emailVerified,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
    };
  }

  async getUser(userId: IdentityUserId): Promise<IdentityUser | null> {
    // `null`, no excepción: `NFR-006` — consultar por alguien ajeno no revela
    // existencia.
    return this.#users.get(userId) ?? null;
  }

  async createAuthorizationUrl(
    request: AuthorizationUrlRequest,
  ): Promise<AuthorizationUrl> {
    if (request.state.length === 0) {
      // Sin `state` la vuelta no se puede validar: es CSRF servido.
      throw new PortError("bad_request", "state is required", { source: SOURCE });
    }
    if (!isAbsoluteUrl(request.redirectUri)) {
      throw new PortError("bad_request", "redirectUri must be an absolute URL", {
        source: SOURCE,
      });
    }

    const url = new URL(this.#authorizationBaseUrl);
    url.searchParams.set("provider", request.provider);
    url.searchParams.set("redirect_uri", request.redirectUri);
    url.searchParams.set("state", request.state);

    return {
      url: url.toString(),
      expiresAt: new Date(this.#clock.nowMs() + 600_000),
    };
  }

  async completeAuthorization(
    request: CompleteAuthorizationRequest,
  ): Promise<AuthorizationResult> {
    const issued = this.#codes.get(request.code);
    if (issued === undefined) {
      throw unauthorized();
    }
    // El `state` se valida contra el que se emitió, no contra el que vino.
    if (issued.state !== request.state) {
      throw new PortError("bad_request", "state does not match", { source: SOURCE });
    }
    this.#codes.delete(request.code);

    const user = this.#users.get(issued.userId);
    if (user === undefined) throw unauthorized();

    const isNewUser = !this.#seenUsers.has(user.userId);
    this.#seenUsers.add(user.userId);

    const sessionToken = this.issueSession(user.userId);
    const session = this.#sessionsByToken.get(sessionToken);
    if (session === undefined) throw unauthorized();

    return {
      principal: {
        userId: user.userId,
        email: user.email,
        emailVerified: user.emailVerified,
        sessionId: session.sessionId,
        expiresAt: session.expiresAt,
      },
      sessionToken,
      isNewUser,
    };
  }

  async requestPasswordReset(_email: string): Promise<void> {
    // No lanza nunca, ni siquiera con un email inexistente: lanzar convertiría
    // este endpoint en un oráculo de qué cuentas existen.
  }

  async revokeSession(sessionId: string): Promise<void> {
    for (const [token, session] of this.#sessionsByToken) {
      if (session.sessionId === sessionId) {
        this.#sessionsByToken.delete(token);
      }
    }
    // Idempotente: una sesión ya cerrada no es error.
  }

  async deleteUser(userId: IdentityUserId): Promise<void> {
    /**
     * Orden a propósito: **primero las sesiones, después el usuario.**
     *
     * Es el caso que §9.1 quiere evitar y que en el original falla a la vista
     * (`Clerk could not mint a fresh Convex token for account deletion`). Si
     * se borrara el usuario primero y fallara antes de las sesiones, quedarían
     * tokens vivos apuntando a una cuenta que ya no está: el usuario no puede
     * entrar y tampoco puede irse. Al revés, un fallo a mitad deja una cuenta
     * sin sesiones — recuperable volviendo a entrar.
     */
    for (const [token, session] of this.#sessionsByToken) {
      if (session.userId === userId) this.#sessionsByToken.delete(token);
    }
    for (const [code, issued] of this.#codes) {
      if (issued.userId === userId) this.#codes.delete(code);
    }
    this.#users.delete(userId);
    // `#seenUsers` **no** se limpia: si vuelve a darse de alta con el mismo id
    // no es un usuario nuevo, y `isNewUser` dispara el onboarding de `FR-010`.
  }

  /** Sólo para tests. */
  get userCount(): number {
    return this.#users.size;
  }
}

function unauthorized(): PortError {
  // §15.2: `We couldn't verify your session.` El mensaje es el mismo para
  // token inválido, vencido y de usuario borrado — distinguirlos le diría a
  // quien sondea cuál de las tres cosas pasó.
  return new PortError("unauthorized", "We couldn't verify your session", {
    source: SOURCE,
  });
}

function isAbsoluteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
