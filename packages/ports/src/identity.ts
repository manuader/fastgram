/**
 * Puerto Identity — IMPL ADR-008, PRD §9.1, §15, `INT-007`, `NFR-007`.
 *
 * Qué lo obliga: ADR-008 lo dice con todas las letras. Fastlane usa Clerk; el
 * clon elige Better Auth self-hosted porque «este producto tiene un plan gratis
 * que existe justamente para acumular usuarios que no pagan» y el modelo por
 * usuario activo mensual castiga eso. Y cierra: «**Puerto `Identity` para poder
 * volver atrás si la operación resulta más cara que la licencia**». Es una
 * decisión pendiente documentada, que es la barra de IMPL §7.
 *
 * §9.1 agrega el requisito que sobrevive a cualquier proveedor: «el requisito
 * es soportar email/password + SSO + sesiones + **borrado de cuenta
 * verificado**». Ese último punto está en el PRD porque en el original falla de
 * forma visible (`Clerk could not mint a fresh Convex token for account
 * deletion`): es un caso donde el acoplamiento al proveedor se filtró al
 * usuario. De ahí {@link Identity.deleteUser}.
 *
 * **Dónde NO llega este puerto**, que es la mitad de su valor:
 *  - Las API keys `fsln_live_*` de §9.1 («identidad máquina») **no** pasan por
 *    acá. Se generan, hashean y revocan en el propio sistema (`P1-API-005`,
 *    `DATA-...`): son nuestras, no del proveedor de identidad, y delegarlas
 *    ataría al proveedor algo que el PRD especifica al detalle.
 *  - La membresía de workspace (`Company`, `WorkspaceMembership`) es dominio.
 *    El proveedor dice **quién** es el usuario; a qué workspace pertenece y con
 *    qué permisos lo dice `core`. Mezclarlo haría que cambiar de proveedor
 *    tocara la autorización, que es justo lo que §2.4 quiere en un solo lugar.
 *  - El OAuth **de plataforma** (TikTok, Instagram, …) no es identidad: es
 *    `SocialPublisher` / `SocialReader`. §10 regla 7 exige que sean permisos
 *    separables.
 *
 * Errores (`PortError`):
 *  - `unauthorized` — token inválido, vencido o de otra audiencia. §15.2:
 *    `We couldn't verify your session.`
 *  - `not_found` — usuario inexistente.
 *  - `conflict` — el email ya existe en otro método de alta.
 *  - `provider_unavailable`, `timeout`, `rate_limited`.
 *  - `bad_request` — `redirectUri` no registrada, `state` ausente.
 *  - `provider_contract_violation` — el proveedor devolvió un token sin las
 *    claims mínimas de {@link IdentityPrincipal}.
 *
 * `NFR-007`: ningún método devuelve tokens del proveedor hacia arriba.
 * {@link IdentityPrincipal} es lo mínimo para autorizar y nada más.
 */

/** Id del usuario **en el proveedor**. Estable y opaco. */
export type IdentityUserId = string;

/**
 * Lo que queda después de verificar una sesión. Deliberadamente corto: es lo
 * único que `core` necesita para resolver `companyId`, y todo campo de más
 * sería una dependencia más que romper al cambiar de proveedor.
 */
export interface IdentityPrincipal {
  readonly userId: IdentityUserId;
  readonly email: string;
  readonly emailVerified: boolean;
  /** Id de la sesión, para poder revocarla e invalidar caches. */
  readonly sessionId: string;
  readonly expiresAt: Date;
}

export interface IdentityUser {
  readonly userId: IdentityUserId;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly createdAt: Date;
}

/** §15.1: email/password + SSO. El proveedor expone su catálogo. */
export interface AuthorizationUrlRequest {
  /** `google`, `github`, … o `password` donde el proveedor lo modela así. */
  readonly provider: string;
  /** Debe estar registrada en el proveedor. §15.2: `/auth/sso-callback`. */
  readonly redirectUri: string;
  /** Anti-CSRF. Quien llama lo genera con `Rng` y lo valida al volver. */
  readonly state: string;
}

export interface AuthorizationUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface CompleteAuthorizationRequest {
  readonly code: string;
  readonly state: string;
  readonly redirectUri: string;
}

export interface AuthorizationResult {
  readonly principal: IdentityPrincipal;
  /**
   * Token de sesión a poner en la cookie. Es una credencial: no se loguea, no
   * se persiste en claro, no vuelve por la API (`NFR-007`).
   */
  readonly sessionToken: string;
  /** `true` la primera vez. Dispara el onboarding de `FR-010`. */
  readonly isNewUser: boolean;
}

export interface Identity {
  /**
   * Valida el token de sesión en cada petición. Es el primer eslabón del
   * middleware de scope de `P1-API-007`; el `companyId` lo resuelve `core`.
   */
  verifySessionToken(sessionToken: string): Promise<IdentityPrincipal>;

  /** `null` si no existe. Consultar por alguien ajeno no revela existencia. */
  getUser(userId: IdentityUserId): Promise<IdentityUser | null>;

  /** §15.1 y §15.2: arranque del flujo de alta y de login con SSO. */
  createAuthorizationUrl(request: AuthorizationUrlRequest): Promise<AuthorizationUrl>;

  /** Vuelta de `/auth/sso-callback`. Valida `state` contra el original. */
  completeAuthorization(
    request: CompleteAuthorizationRequest,
  ): Promise<AuthorizationResult>;

  /** §15.3: delegado al proveedor; el clon no tiene UI propia de recuperación. */
  requestPasswordReset(email: string): Promise<void>;

  /** Cierra **esa** sesión. Idempotente: una sesión ya cerrada no es error. */
  revokeSession(sessionId: string): Promise<void>;

  /**
   * §9.1: borrado de cuenta **verificado**. Debe ser idempotente y no puede
   * dejar la cuenta a medio borrar: es el caso que falla a la vista en el
   * original. Borrar los datos del workspace es responsabilidad de `core`;
   * esto borra la identidad.
   */
  deleteUser(userId: IdentityUserId): Promise<void>;
}
