/**
 * `OAuthStateLedger` en memoria del proceso de la API — `PU-PUB-002`.
 *
 * Alcanza para uso personal: un solo proceso de API emite y consume los
 * `state`. Un reinicio en medio de un login lo invalida (el usuario vuelve a
 * tocar «Connect»), que es el lado seguro. Si algún día hay más de una
 * instancia de la API, esto pasa a una tabla.
 *
 * Las entradas vencidas se barren al escribir: sin eso, un botón que se toca
 * y nunca vuelve dejaría la entrada para siempre.
 */
import type { OAuthPendingAuthorization, OAuthStateLedger } from "@fastgram/ports";

/** Tope de sanidad: nadie tiene mil logins a medio hacer. */
const MAX_PENDING = 1_000;

export class MemoryOAuthStateLedger implements OAuthStateLedger {
  readonly #entries = new Map<string, OAuthPendingAuthorization>();

  put(nonce: string, entry: OAuthPendingAuthorization): Promise<void> {
    const now = Date.now();
    for (const [k, v] of this.#entries) {
      if (v.expiresAt.getTime() <= now) this.#entries.delete(k);
    }
    if (this.#entries.size >= MAX_PENDING) {
      const oldest = this.#entries.keys().next();
      if (oldest.done !== true) this.#entries.delete(oldest.value);
    }
    this.#entries.set(nonce, entry);
    return Promise.resolve();
  }

  take(nonce: string, now: Date): Promise<OAuthPendingAuthorization | null> {
    const entry = this.#entries.get(nonce);
    this.#entries.delete(nonce);
    if (entry === undefined || entry.expiresAt.getTime() <= now.getTime()) {
      return Promise.resolve(null);
    }
    return Promise.resolve(entry);
  }

  get size(): number {
    return this.#entries.size;
  }
}
