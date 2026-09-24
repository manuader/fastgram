/**
 * `PublicMediaUrls` detrás de un túnel de Cloudflare — `PU-RUN-005`, D-17.
 *
 * `pnpm start --tunnel` levanta el proceso de media pública y `cloudflared`,
 * lee la URL `https://…` que imprime el túnel y la exporta como
 * `FASTGRAM_PUBLIC_URL` a la API, el worker y la web. Este adaptador sólo
 * firma: no habla con el túnel ni con S3. Sin `FASTGRAM_PUBLIC_URL`, falla con
 * `public_media_unavailable` — es la forma de decir «no hay túnel».
 *
 * La clave se carga perezosa: construir el adaptador no crea archivos, así que
 * montarlo en un proceso sin túnel no toca `~/.fastgram`.
 */

import {
  DEFAULT_PUBLIC_MEDIA_TTL_SECONDS,
  MAX_PUBLIC_MEDIA_TTL_SECONDS,
  PortError,
  PublicMediaUnavailableError,
  isPublicMediaKey,
  type PublicMediaUrlOptions,
  type PublicMediaUrls,
} from "@fastgram/ports";
import { loadOrCreateSecretKey } from "./secret-key.js";
import { deriveSigningKey, signPublicMediaToken } from "./token.js";

const SOURCE = "PublicMediaUrls/tunnel";

/** Ruta pública. El servidor de `apps/api/src/public-media` sirve ésta y nada más. */
export const PUBLIC_MEDIA_PATH = "/public-media/";

export interface TunnelPublicMediaUrlsConfig {
  /** `FASTGRAM_PUBLIC_URL`. Ausente o vacío ⇒ `public_media_unavailable`. */
  readonly publicBaseUrl: string | undefined;
  /** Bytes de `secret.key`, o una función que los consigue (perezosa). */
  readonly secretKey: Uint8Array | (() => Promise<Uint8Array>);
  /** Para tests. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Normaliza la base: `https`, sin query ni fragmento, sin barra final.
 * `null` si no sirve (y entonces el puerto responde `public_media_unavailable`:
 * una base `http` no la bajan ni Instagram ni TikTok).
 */
export function normalizePublicBaseUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
    return null;
  if (url.search !== "" || url.hash !== "") return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export class TunnelPublicMediaUrls implements PublicMediaUrls {
  readonly #base: string | null;
  readonly #secret: TunnelPublicMediaUrlsConfig["secretKey"];
  readonly #now: () => number;
  #signingKey: Promise<Buffer> | null = null;

  constructor(config: TunnelPublicMediaUrlsConfig) {
    this.#base = normalizePublicBaseUrl(config.publicBaseUrl);
    this.#secret = config.secretKey;
    this.#now = config.now ?? Date.now;
  }

  /** `true` si hay túnel configurado. No comprueba que esté vivo. */
  get available(): boolean {
    return this.#base !== null;
  }

  async forObject(
    objectKey: string,
    options: PublicMediaUrlOptions = {},
  ): Promise<string> {
    if (this.#base === null) throw new PublicMediaUnavailableError();
    const ttl = options.ttlSeconds ?? DEFAULT_PUBLIC_MEDIA_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_PUBLIC_MEDIA_TTL_SECONDS) {
      throw new PortError(
        "bad_request",
        `ttlSeconds must be an integer between 1 and ${MAX_PUBLIC_MEDIA_TTL_SECONDS}`,
        { source: SOURCE },
      );
    }
    if (!isPublicMediaKey(objectKey)) {
      throw new PortError("bad_request", "This object cannot be published by URL", {
        source: SOURCE,
      });
    }
    const key = await this.#key();
    const token = signPublicMediaToken(key, {
      objectKey,
      expiresAt: Math.floor(this.#now() / 1000) + ttl,
    });
    return `${this.#base}${PUBLIC_MEDIA_PATH}${token}`;
  }

  #key(): Promise<Buffer> {
    this.#signingKey ??= (async () => {
      const secret =
        typeof this.#secret === "function" ? await this.#secret() : this.#secret;
      return deriveSigningKey(secret);
    })().catch((error: unknown) => {
      this.#signingKey = null; // que el próximo intento reintente
      throw new PortError("provider_unavailable", "The local secret key cannot be read", {
        source: SOURCE,
        cause: error,
      });
    });
    return this.#signingKey;
  }
}

/** El adaptador desde el entorno: `FASTGRAM_PUBLIC_URL` y `FASTGRAM_HOME`. */
export function publicMediaUrlsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): TunnelPublicMediaUrls {
  return new TunnelPublicMediaUrls({
    publicBaseUrl: env["FASTGRAM_PUBLIC_URL"],
    secretKey: () => loadOrCreateSecretKey(env),
  });
}
