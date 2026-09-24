/**
 * Token de `GET /public-media/<token>` — `PU-RUN-005`, PRD D-17.
 *
 * Forma: `<payload>.<firma>`, las dos partes en base64url.
 *  - payload: JSON `{"k": <objectKey>, "e": <expiración, segundos Unix>}`.
 *  - firma: HMAC-SHA256 del payload **tal como viaja** (los bytes base64url),
 *    con una subclave derivada por HKDF de `secret.key`.
 *
 * **Por qué una subclave y no `secret.key` directo.** El archivo es compartido
 * (otro agente lo usa para cifrar tokens de OAuth): usar la misma clave para
 * dos propósitos distintos es la receta para que un artefacto de uno sirva
 * como el otro. HKDF con un `info` propio separa los dominios y no importa en
 * qué formato esté guardado el archivo (binario, hex o base64: son bytes de
 * entrada, y alcanza con que tengan ≥ 32).
 *
 * **La clave del objeto viaja legible** (base64 no es cifrado). Se aceptó: la
 * URL la ven sólo Instagram/TikTok, y la clave dice `media/<companyId>/…`, que
 * es un UUID interno sin valor fuera de esta Mac. Si molestara, el cambio es
 * pasar a AES-GCM sin tocar a nadie: el token es opaco para todos menos este
 * archivo.
 *
 * `verify` no dice por qué falló hacia afuera: el servidor responde 404 igual
 * para firma mala, vencido o clave fuera de prefijo. El motivo es para el log.
 */

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { isPublicMediaKey } from "@fastgram/ports";

const HKDF_INFO = "fastgram/public-media/token/v1";
/** Tope defensivo: una clave de S3 es ≤ 1024 bytes; el token entero, poco más. */
const MAX_TOKEN_LENGTH = 2048;
export const MIN_SECRET_KEY_BYTES = 32;

/** Subclave de firma. Se calcula una vez por proceso. */
export function deriveSigningKey(secret: Uint8Array): Buffer {
  if (secret.byteLength < MIN_SECRET_KEY_BYTES) {
    throw new Error(`secret key must have at least ${MIN_SECRET_KEY_BYTES} bytes`);
  }
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), HKDF_INFO, 32));
}

function mac(signingKey: Uint8Array, payload: string): Buffer {
  return createHmac("sha256", signingKey).update(payload, "utf8").digest();
}

export interface SignPublicMediaTokenInput {
  readonly objectKey: string;
  /** Segundos Unix. */
  readonly expiresAt: number;
}

export function signPublicMediaToken(
  signingKey: Uint8Array,
  input: SignPublicMediaTokenInput,
): string {
  const payload = Buffer.from(
    JSON.stringify({ k: input.objectKey, e: Math.floor(input.expiresAt) }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${mac(signingKey, payload).toString("base64url")}`;
}

export type VerifyFailure = "malformed" | "bad_signature" | "expired" | "forbidden_key";

export type VerifyResult =
  | { readonly ok: true; readonly objectKey: string; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: VerifyFailure };

const B64URL = /^[A-Za-z0-9_-]+$/;

export function verifyPublicMediaToken(
  signingKey: Uint8Array,
  token: string,
  nowSeconds: number,
): VerifyResult {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payload, signature] = parts as [string, string];
  if (!B64URL.test(payload) || !B64URL.test(signature)) {
    return { ok: false, reason: "malformed" };
  }

  // La firma primero: no se parsea JSON que no firmamos nosotros.
  const expected = mac(signingKey, payload);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "malformed" };
  }
  const { k, e } = parsed as { k?: unknown; e?: unknown };
  if (typeof k !== "string" || typeof e !== "number" || !Number.isFinite(e)) {
    return { ok: false, reason: "malformed" };
  }
  if (e <= nowSeconds) return { ok: false, reason: "expired" };
  // Aunque esté firmado: sólo `media/` y `content/` salen por el túnel.
  if (!isPublicMediaKey(k)) return { ok: false, reason: "forbidden_key" };
  return { ok: true, objectKey: k, expiresAt: e };
}
