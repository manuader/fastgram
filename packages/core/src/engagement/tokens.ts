/**
 * El access token vigente de la cuenta de Reddit de una marca — lo usan la
 * API ("Send") y el worker (descubrimiento, seguimiento). Orquestación pura:
 * la fila, el cifrado y el refresco llegan como dependencias (core no importa
 * `db` ni `adapters`).
 *
 * Los tokens de Reddit duran una hora (*"All bearer tokens expire after 1
 * hour"*, wiki OAuth2), así que el refresco es la regla y no la excepción.
 * Quien llama tiene que haber bloqueado la fila (`FOR UPDATE`) si corre en
 * paralelo: el refresh token se usa en cada refresco.
 */
import { isPortError, type TokenCipher } from "@fastgram/ports";

import { redditTokenNeedsRefresh } from "../connections/reddit.js";

export interface StoredRedditTokens {
  readonly status: "active" | "expired" | "revoked" | string;
  /** Ciphertext. */
  readonly accessToken: string | null;
  /** Ciphertext. */
  readonly refreshToken: string | null;
  readonly tokenExpiry: Date | null;
}

export type RedditTokenResult =
  | { readonly ok: true; readonly accessToken: string; readonly refreshed: boolean }
  | {
      readonly ok: false;
      /**
       * - `not_connected`: no hay cuenta, o está `revoked`.
       * - `reconnect_required`: Reddit rechazó el refresh (revocado, app
       *   cambiada) o no hay refresh token. Se marca `expired`.
       * - `unavailable`: Reddit no respondió; reintentar más tarde.
       */
      readonly reason: "not_connected" | "reconnect_required" | "unavailable";
    };

export async function resolveRedditAccessToken(deps: {
  readonly row: StoredRedditTokens | null;
  readonly cipher: TokenCipher;
  readonly now: Date;
  readonly refresh: (refreshToken: string) => Promise<{
    readonly accessToken: string;
    readonly refreshToken: string | null;
    readonly expiresAt: Date | null;
  }>;
  readonly save: (update: {
    readonly accessToken: string;
    readonly refreshToken?: string | null;
    readonly tokenExpiry: Date | null;
  }) => Promise<void>;
  readonly markExpired: (reason: string) => Promise<void>;
}): Promise<RedditTokenResult> {
  const { row } = deps;
  if (row === null || row.status === "revoked" || row.accessToken === null) {
    return { ok: false, reason: "not_connected" };
  }
  if (row.status === "active" && !redditTokenNeedsRefresh(row.tokenExpiry, deps.now)) {
    return {
      ok: true,
      accessToken: await deps.cipher.decrypt(row.accessToken),
      refreshed: false,
    };
  }
  if (row.refreshToken === null) {
    await deps.markExpired("no_refresh_token");
    return { ok: false, reason: "reconnect_required" };
  }
  const refreshPlain = await deps.cipher.decrypt(row.refreshToken);
  try {
    const next = await deps.refresh(refreshPlain);
    await deps.save({
      accessToken: await deps.cipher.encrypt(next.accessToken),
      ...(next.refreshToken !== null && next.refreshToken !== refreshPlain
        ? { refreshToken: await deps.cipher.encrypt(next.refreshToken) }
        : {}),
      tokenExpiry: next.expiresAt,
    });
    return { ok: true, accessToken: next.accessToken, refreshed: true };
  } catch (error) {
    if (
      isPortError(error) &&
      (error.code === "unauthorized" || error.code === "bad_request")
    ) {
      await deps.markExpired(`refresh_${error.code}`);
      return { ok: false, reason: "reconnect_required" };
    }
    return { ok: false, reason: "unavailable" };
  }
}
