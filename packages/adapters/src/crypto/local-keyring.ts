/**
 * Cifrado de tokens en reposo con una clave local — `PU-PUB-001`
 * (`= P3-OAUTH-007`, `NFR-007`).
 *
 * La clave: `${FASTGRAM_HOME:-~/.fastgram}/secret.key`, 32 bytes crudos,
 * `0600`, generada al primer uso si no existe. **Nunca** en el repo ni en un
 * log; perderla es perder los tokens (se reconecta), no los datos.
 *
 * - {@link LocalTokenCipher}: AES-256-GCM. Formato `v1.<iv>.<tag>.<ct>` en
 *   base64url, autocontenido. Un texto alterado o cifrado con otra clave falla
 *   la autenticación de GCM y es `provider_contract_violation`, nunca basura.
 * - {@link LocalStateSigner}: HMAC-SHA256 con una subclave derivada por HKDF
 *   (etiqueta `fastgram/oauth-state/v1`). Una clave, dos usos, dos subclaves.
 *
 * ## La clave es compartida
 *
 * La misma `secret.key` la usa la media pública (`../public-media/secret-key.ts`,
 * otra subclave por HKDF). Las reglas son las mismas de los dos lados: se crea
 * con `wx` (el que pierde la carrera lee la del ganador), se aceptan **≥ 32
 * bytes** (cada consumidor deriva la suya) y una lectura corta se reintenta una
 * vez (puede ser el otro proceso a mitad de la escritura).
 *
 * ## Qué pasa con una clave rota
 *
 * Un `secret.key` que existe y tiene menos de 32 bytes **no se pisa**: generar
 * una nueva dejaría ilegibles todos los tokens guardados sin que nadie lo
 * decida. Es `provider_contract_violation` hasta que alguien lo mire. Si los
 * permisos están más abiertos que `0600`, se cierran al cargar (como el
 * registro de modelos en su próxima escritura).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { PortError, type StateSigner, type TokenCipher } from "@fastgram/ports";

import { resolveFastgramHome } from "../model-registry/file-model-registry.js";

const SOURCE = "TokenCipher/local";
const SECRET_KEY_FILE_NAME = "secret.key";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const FORMAT = "v1";

export function localKeyPath(env: Readonly<Record<string, string | undefined>>): string {
  return join(resolveFastgramHome(env), SECRET_KEY_FILE_NAME);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * Lee la clave o la crea. Dos procesos que arrancan a la vez (API y worker)
 * no se pisan: la creación es `flag: "wx"`, y el que pierde la carrera lee la
 * del que ganó.
 */
export async function loadOrCreateLocalKey(path: string): Promise<Buffer> {
  const read = async (): Promise<Buffer | null> => {
    try {
      const key = await readFile(path);
      const info = await stat(path);
      if ((info.mode & 0o077) !== 0) await chmod(path, FILE_MODE);
      return key;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw new PortError("provider_unavailable", "The secret key cannot be read", {
        source: SOURCE,
        cause: error,
      });
    }
  };

  let key = await read();
  if (key !== null && key.length < KEY_BYTES) {
    await new Promise((r) => setTimeout(r, 100));
    key = await read();
  }
  if (key === null) {
    try {
      await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
      await writeFile(path, randomBytes(KEY_BYTES), { mode: FILE_MODE, flag: "wx" });
      await chmod(path, FILE_MODE);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw new PortError("provider_unavailable", "The secret key cannot be created", {
          source: SOURCE,
          cause: error,
        });
      }
    }
    key = await read();
    if (key !== null && key.length < KEY_BYTES) {
      await new Promise((r) => setTimeout(r, 100));
      key = await read();
    }
  }
  if (key === null || key.length < KEY_BYTES) {
    // Sin el contenido en el `cause`: es la clave.
    throw new PortError(
      "provider_contract_violation",
      `The secret key file must hold at least ${String(KEY_BYTES)} bytes`,
      { source: SOURCE },
    );
  }
  return key;
}

/**
 * La clave de la instalación, cargada una vez (perezosa) y compartida por el
 * cifrado y la firma del `state`.
 */
export class LocalKeyring {
  readonly #path: string;
  #key: Promise<Buffer> | null = null;

  constructor(config: { readonly path: string }) {
    this.#path = config.path;
  }

  key(): Promise<Buffer> {
    if (this.#key === null) {
      this.#key = loadOrCreateLocalKey(this.#path);
      // Un fallo no se cachea: el próximo uso vuelve a intentar.
      this.#key.catch(() => {
        this.#key = null;
      });
    }
    return this.#key;
  }

  async subkey(label: string): Promise<Buffer> {
    const master = await this.key();
    return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), label, KEY_BYTES));
  }
}

export class LocalTokenCipher implements TokenCipher {
  readonly #keyring: LocalKeyring;
  constructor(keyring: LocalKeyring) {
    this.#keyring = keyring;
  }

  async encrypt(plaintext: string): Promise<string> {
    const key = await this.#keyring.subkey("fastgram/token-cipher/v1");
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [FORMAT, iv, tag, ct]
      .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
      .join(".");
  }

  async decrypt(ciphertext: string): Promise<string> {
    const parts = ciphertext.split(".");
    const bad = () =>
      new PortError(
        "provider_contract_violation",
        "The stored token cannot be decrypted",
        {
          source: SOURCE,
        },
      );
    if (parts.length !== 4 || parts[0] !== FORMAT) throw bad();
    const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
    const iv = Buffer.from(ivB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw bad();
    const key = await this.#keyring.subkey("fastgram/token-cipher/v1");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(ctB64, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw bad();
    }
  }
}

export class LocalStateSigner implements StateSigner {
  readonly #keyring: LocalKeyring;
  constructor(keyring: LocalKeyring) {
    this.#keyring = keyring;
  }

  async sign(data: string): Promise<string> {
    const key = await this.#keyring.subkey("fastgram/oauth-state/v1");
    return createHmac("sha256", key).update(data, "utf8").digest("base64url");
  }
}

/** Nonce aleatorio para el `state` (128 bits). */
export function randomNonce(): string {
  return randomBytes(16).toString("base64url");
}
