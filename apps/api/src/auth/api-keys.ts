/**
 * API keys de máquina — P1-API-005 · PRD §9.1 y FR-180 (PRD:1851-1872).
 *
 * El contrato normativo, literal:
 *   - `Authorization: Bearer fsln_live_<32 caracteres base62>`
 *   - almacenadas **hasheadas**
 *   - **workspace-scoped**: actúan sobre el workspace vigente al crearlas y NO
 *     siguen el cambio de workspace del usuario
 *   - mostradas **una sola vez**, al crearlas
 *   - revocación inmediata → el siguiente request es 401
 *   - todos los 401 llevan `WWW-Authenticate: Bearer realm="api"`
 *
 * ## Por qué SHA-256 y no bcrypt/argon2
 *
 * bcrypt existe para secretos de **baja entropía** elegidos por humanos, donde el
 * coste por intento es lo único que frena un diccionario. Acá el secreto son 32
 * caracteres base62 de `randomBytes`: ~190 bits de entropía. No hay diccionario que
 * recorrer, así que el factor de trabajo no compra seguridad — y sí la gasta: un KDF
 * lento en el camino de autenticación pone 50-100 ms en **cada** request de la API,
 * que es justo el presupuesto que §9.6 asume con 60 req/min.
 *
 * Lo que sí importa y está resuelto: el secreto nunca se guarda, el hash no lleva sal
 * (no hace falta con entropía así y permite el índice `api_keys_hash_idx`, que es lo
 * que hace la búsqueda O(log n) en vez de un scan por fila).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** FR-180 (PRD:1861) — prefijo literal del token. */
export const API_KEY_PREFIX = "fsln_live_";
/** FR-180 (PRD:1861) — longitud literal de la parte secreta. */
export const API_KEY_SECRET_LENGTH = 32;
/** base62 = dígitos + mayúsculas + minúsculas. */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `fsln_live_` + exactamente 32 base62, anclado a los dos extremos. */
const API_KEY_RE = new RegExp(`^${API_KEY_PREFIX}[0-9A-Za-z]{${API_KEY_SECRET_LENGTH}}$`);

/**
 * Genera la parte secreta sin sesgo de módulo.
 *
 * `randomBytes(n) % 62` **no** es uniforme: 256 no es múltiplo de 62, así que los
 * primeros 8 símbolos del alfabeto salen más seguido. Con rejection sampling se
 * descartan los bytes del tramo incompleto y la distribución queda plana. El coste
 * es tirar ~3% de los bytes; el beneficio es no regalar entropía en un secreto que
 * es la única credencial de un workspace.
 */
function randomBase62(length: number): string {
  const max = Math.floor(256 / BASE62.length) * BASE62.length; // 248
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= max) continue;
      out += BASE62[byte % BASE62.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export interface GeneratedApiKey {
  /** El token completo. **Se muestra una vez y no se persiste nunca.** */
  readonly token: string;
  /** Lo único que va a la base. */
  readonly hash: string;
  readonly prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const token = `${API_KEY_PREFIX}${randomBase62(API_KEY_SECRET_LENGTH)}`;
  return { token, hash: hashApiKey(token), prefix: API_KEY_PREFIX };
}

/** Hash de almacenamiento y de búsqueda. Determinista: sin sal, ver cabecera. */
export function hashApiKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isWellFormedApiKey(token: string): boolean {
  return API_KEY_RE.test(token);
}

/**
 * Compara dos hashes en tiempo constante.
 *
 * La búsqueda por índice ya decide la mayoría de los casos, pero donde comparamos
 * en JavaScript lo hacemos así por costumbre defendible: `===` sobre strings corta
 * en el primer byte distinto y filtra información por tiempo.
 */
export function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Motivos de rechazo. Van al **log**, nunca al cuerpo: ver `describeRejection`. */
export type ApiKeyRejection =
  | "missing_header"
  | "wrong_scheme"
  | "empty_token"
  | "malformed_token"
  | "no_match"
  | "revoked"
  | "expired"
  | "workspace_soft_deleted";

/**
 * Extrae el token de `Authorization`.
 *
 * Los cinco motivos de 401 de FR-180 (PRD:1867) se distinguen acá porque el log los
 * necesita: "esquema distinto de Bearer" y "key revocada" piden acciones opuestas de
 * quien integra. Hacia afuera los cinco son el mismo 401 con el mismo mensaje.
 */
export function extractBearerToken(
  header: string | undefined,
): { ok: true; token: string } | { ok: false; reason: ApiKeyRejection } {
  if (header === undefined || header.trim() === "") {
    return { ok: false, reason: "missing_header" };
  }
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme === undefined || scheme.toLowerCase() !== "bearer") {
    return { ok: false, reason: "wrong_scheme" };
  }
  const token = rest.join("");
  if (token === "") return { ok: false, reason: "empty_token" };
  if (!isWellFormedApiKey(token)) return { ok: false, reason: "malformed_token" };
  return { ok: true, token };
}

/**
 * El único mensaje que sale hacia afuera.
 *
 * FR-180 (PRD:1866) fija el cuerpo literal:
 *   `{"error":{"code":"unauthorized","message":"Invalid or revoked API key"}}`
 *
 * Es el mismo para los ocho motivos **a propósito**: un mensaje que distinga
 * "revocada" de "no existe" le confirma a quien sondea que esa key existió.
 */
export const INVALID_API_KEY_MESSAGE = "Invalid or revoked API key";

/** Texto para el log. Nunca se serializa hacia el cliente. */
export function describeRejection(reason: ApiKeyRejection): string {
  return `api key rejected: ${reason}`;
}
