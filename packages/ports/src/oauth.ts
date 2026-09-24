/**
 * Puertos del OAuth de plataforma — `PU-PUB-001` (`= P3-OAUTH-007`),
 * `PU-PUB-002` (`= P3-OAUTH-003`) y los OAuth de TikTok y X
 * (`P3-OAUTH-002`), `docs/PLAN-USO-PERSONAL.md` §5, `D-09`…`D-11`.
 *
 * Tres piezas, separadas porque cambian por razones distintas:
 *
 * - {@link OAuthClient}: habla con **una** plataforma (armar la URL de
 *   autorización, cambiar el `code`, refrescar). Los endpoints, con su cita,
 *   viven en `packages/adapters/src/oauth/`.
 * - {@link TokenCipher}: cifra los tokens antes de que toquen la base
 *   (`NFR-007`: *"cifrados, nunca expuestos"*).
 * - {@link OAuthStateLedger} y {@link ConnectionTokenStore}: dónde se guarda
 *   lo que el flujo necesita recordar (el `state` de un solo uso y el
 *   `code_verifier` de PKCE; los tokens cifrados de una conexión).
 *
 * `NFR-007`: **ningún** método de estos puertos se expone hacia la API. Lo que
 * sale es siempre una vista sin tokens (`packages/core/src/connections`).
 */

/**
 * Las redes que se conectan por OAuth en uso personal (`D-09`, en orden).
 * YouTube y LinkedIn quedan para después; están en `social_platform` desde
 * antes, pero no tienen cliente.
 */
export const OAUTH_PLATFORMS = [
  "instagram",
  "tiktok",
  "x",
  "threads",
  "facebook",
] as const;
export type OAuthPlatform = (typeof OAUTH_PLATFORMS)[number];

export function isOAuthPlatform(value: string): value is OAuthPlatform {
  return (OAUTH_PLATFORMS as readonly string[]).includes(value);
}

/** Client id / secret de la app de desarrollador de una plataforma. */
export interface OAuthAppCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Tokens **en claro**. Sólo viven en memoria, entre el adaptador y el cifrado. */
export interface OAuthTokenSet {
  readonly accessToken: string;
  /** Ausente si la plataforma no da refresh token (Meta refresca con el propio access token). */
  readonly refreshToken?: string;
  /** `null` = la plataforma dice que no vence (token de Página de Facebook). */
  readonly expiresAt: Date | null;
  readonly refreshExpiresAt?: Date | null;
  /** Lo que la plataforma dice que se concedió, si lo dice. */
  readonly scopes?: readonly string[];
}

/** La cuenta del otro lado, tal como la devuelve la API de la plataforma. */
export interface OAuthAccountIdentity {
  /** Id estable en la plataforma (IG user id, open_id de TikTok, id de Página…). */
  readonly platformUserId: string;
  /** Handle sin `@`. Si la plataforma no lo da, el nombre visible. */
  readonly username: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
}

/** Una cuenta con sus tokens. Facebook devuelve una por Página; el resto, una. */
export interface OAuthGrantedAccount {
  readonly identity: OAuthAccountIdentity;
  readonly tokens: OAuthTokenSet;
}

export interface OAuthAuthorizeRequest {
  readonly credentials: Pick<OAuthAppCredentials, "clientId">;
  readonly redirectUri: string;
  readonly state: string;
  readonly scopes: readonly string[];
  /** S256 de `code_verifier`. Presente sólo donde la plataforma usa PKCE (X). */
  readonly codeChallenge?: string;
}

export interface OAuthCodeExchangeRequest {
  readonly credentials: OAuthAppCredentials;
  readonly redirectUri: string;
  readonly code: string;
  readonly codeVerifier?: string;
}

export interface OAuthRefreshRequest {
  readonly credentials: OAuthAppCredentials;
  /** El access token vigente (Meta refresca con él). */
  readonly accessToken: string;
  readonly refreshToken?: string;
}

/**
 * El cliente OAuth de una plataforma.
 *
 * Errores (`PortError`): `unauthorized` (code vencido o ya usado, refresh
 * rechazado, credenciales de la app inválidas), `bad_request` (redirect URI
 * que no coincide, scope no habilitado en la app), `rate_limited`, `timeout`,
 * `provider_unavailable` y `provider_contract_violation` (respondió algo que
 * no es lo documentado). El `cause` puede llevar el cuerpo del proveedor:
 * **nunca** se loguea entero ni sale por la API.
 */
export interface OAuthClient {
  readonly platform: OAuthPlatform;
  /** Si la plataforma exige PKCE en el flujo web. */
  readonly usesPkce: boolean;
  /** Si el refresh necesita `refreshToken` (TikTok, X) o el access token (Meta). */
  readonly refreshWith: "refresh_token" | "access_token" | "none";
  authorizeUrl(request: OAuthAuthorizeRequest): string;
  /** Cambia el `code` y lee la identidad de la(s) cuenta(s). */
  exchangeCode(
    request: OAuthCodeExchangeRequest,
  ): Promise<readonly OAuthGrantedAccount[]>;
  refresh(request: OAuthRefreshRequest): Promise<OAuthTokenSet>;
}

/**
 * Cifrado simétrico de tokens. El texto cifrado es opaco y autocontenido
 * (lleva su versión, su IV y su tag). `decrypt` de algo alterado o cifrado con
 * otra clave es `PortError("provider_contract_violation")`, nunca basura.
 */
export interface TokenCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

/**
 * MAC de la instalación, para firmar el `state`. Se deriva de la misma clave
 * local que el cifrado, con otra etiqueta: nunca la misma clave para dos usos.
 */
export interface StateSigner {
  /** base64url del HMAC-SHA256 de `data`. */
  sign(data: string): Promise<string>;
}

/** Lo que se recuerda de un `state` emitido. */
export interface OAuthPendingAuthorization {
  readonly companyId: string;
  readonly platform: OAuthPlatform;
  readonly codeVerifier?: string;
  readonly expiresAt: Date;
}

/**
 * El registro de `state` emitidos: `take` lo devuelve **una sola vez**. Un
 * segundo `take` del mismo nonce (un callback repetido, un replay) es `null`.
 */
export interface OAuthStateLedger {
  put(nonce: string, entry: OAuthPendingAuthorization): Promise<void>;
  take(nonce: string, now: Date): Promise<OAuthPendingAuthorization | null>;
}

/* ------------------------------------------------------------------------ *
 * Tokens de una conexión guardada
 * ------------------------------------------------------------------------ */

/** Lo que `resolveAccessToken` necesita de una fila de `connections`. */
export interface StoredConnectionTokens {
  readonly id: string;
  readonly companyId: string;
  readonly platform: string;
  readonly status: "active" | "expired" | "paused" | "revoked";
  /** Ciphertext. */
  readonly accessToken: string | null;
  /** Ciphertext. */
  readonly refreshToken: string | null;
  readonly tokenExpiry: Date | null;
  readonly refreshTokenExpiry: Date | null;
  /** Cuándo se emitió el access token vigente (Meta no refresca antes de 24 h). */
  readonly tokenIssuedAt: Date | null;
}

export interface ConnectionTokenUpdate {
  /** Ciphertext. */
  readonly accessToken: string;
  /** Ciphertext. `undefined` = no cambia. */
  readonly refreshToken?: string | null;
  readonly tokenExpiry: Date | null;
  readonly refreshTokenExpiry?: Date | null;
  readonly tokenIssuedAt: Date;
}

/**
 * La fila de tokens, con scope de marca. `load` de otra marca es `null` (el
 * 404 de §9.2 lo pone la capa de arriba).
 *
 * `load` bloquea la fila (`FOR UPDATE`) si corre dentro de una transacción:
 * X rota el refresh token en cada uso, y dos refrescos en paralelo harían que
 * el segundo usara uno ya invalidado y marcara `expired` una conexión sana.
 */
export interface ConnectionTokenStore {
  load(companyId: string, connectionId: string): Promise<StoredConnectionTokens | null>;
  saveTokens(
    companyId: string,
    connectionId: string,
    update: ConnectionTokenUpdate,
  ): Promise<void>;
  markExpired(companyId: string, connectionId: string, reason: string): Promise<void>;
}
