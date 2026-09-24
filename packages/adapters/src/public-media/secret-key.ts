/**
 * `${FASTGRAM_HOME:-~/.fastgram}/secret.key` — la clave local de la Mac.
 *
 * 32 bytes aleatorios, modo 0600, fuera del repo. Se crea la primera vez que
 * alguien la pide. **Es compartida**: la usa también el cifrado de tokens de
 * OAuth. Por eso:
 *  - La creación es atómica con `O_EXCL` (`wx`): si dos procesos arrancan a la
 *    vez, uno gana y el otro lee lo que escribió el ganador. Sin eso, dos
 *    claves distintas en carrera invalidan todo lo que firmó el perdedor.
 *  - Se lee sin asumir formato: quien la creó primero puede haberla guardado en
 *    binario o en texto. Los consumidores derivan su subclave con HKDF (ver
 *    `token.ts`), así que alcanza con que sean ≥ 32 bytes.
 *
 * Nunca se loguea ni se imprime.
 */

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveFastgramHome } from "../model-registry/file-model-registry.js";
import { MIN_SECRET_KEY_BYTES } from "./token.js";

export const SECRET_KEY_FILE_NAME = "secret.key";

export function secretKeyPath(env: Readonly<Record<string, string | undefined>>): string {
  return join(resolveFastgramHome(env), SECRET_KEY_FILE_NAME);
}

async function readKey(path: string): Promise<Buffer> {
  const bytes = await readFile(path);
  if (bytes.byteLength < MIN_SECRET_KEY_BYTES) {
    // Un archivo vacío o truncado: puede ser el otro proceso a mitad de la
    // escritura. El que llama reintenta una vez; si sigue corto, es un error real.
    throw Object.assign(new Error(`${path} has fewer than 32 bytes`), {
      code: "SECRET_KEY_SHORT",
    });
  }
  return bytes;
}

/** Lee la clave o la crea (32 bytes, 0600). */
export async function loadOrCreateSecretKey(
  env: Readonly<Record<string, string | undefined>>,
): Promise<Buffer> {
  const home = resolveFastgramHome(env);
  const path = join(home, SECRET_KEY_FILE_NAME);
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      const key = randomBytes(32);
      await handle.writeFile(key);
      await handle.sync();
      return key;
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  try {
    return await readKey(path);
  } catch (error: unknown) {
    if ((error as { code?: string }).code !== "SECRET_KEY_SHORT") throw error;
    await new Promise((r) => setTimeout(r, 100));
    return readKey(path);
  }
}
