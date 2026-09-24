/**
 * Puerto ConnectionTokens — `PU-PUB-001`, `PU-PUB-008`, `FR-060`, `NFR-007`.
 *
 * Lo que el worker de publicación necesita de una conexión OAuth: **el access
 * token en claro, vigente, justo antes de publicar**. Descifrar
 * (`TokenCipher`), refrescar si está por vencer (`OAuthClient.refresh`) y
 * marcar la conexión `expired` si el refresh se rechaza es trabajo de la
 * implementación, que vive con el resto del OAuth (`packages/core/src/connections`
 * y `packages/adapters/src/oauth`). Acá sólo está la forma, para que el worker
 * no conozca nada de eso.
 *
 * Errores (`PortError`):
 *  - `unauthorized` — la conexión está `expired` / `revoked`, o el refresh fue
 *    rechazado. Es lo que lleva un `Post` a `AWAITING_RECONNECT` (`FR-060`), no
 *    a `FAILED`.
 *  - `not_found` — la conexión no existe **o es de otra marca** (mismo
 *    resultado: el 404 invisible de §9.2).
 *  - `rate_limited`, `timeout`, `provider_unavailable` — el refresh no pudo
 *    hablar con la plataforma. Transitorios.
 *
 * `NFR-007`: el valor devuelto **nunca** se loguea, se persiste ni se devuelve
 * por la API. Vive lo que dura la publicación.
 */

export interface ConnectionTokenScope {
  /** La marca dueña de la conexión. Una conexión de otra marca es `not_found`. */
  readonly companyId: string;
}

export interface ConnectionTokens {
  /**
   * El access token vigente de la conexión. `scope` es obligatorio: todo acceso
   * a datos lleva `companyId`, y la fila de tokens se carga con él
   * (`ConnectionTokenStore.load(companyId, connectionId)`).
   */
  getAccessToken(connectionId: string, scope: ConnectionTokenScope): Promise<string>;
}
