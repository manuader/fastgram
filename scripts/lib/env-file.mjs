/**
 * Lectura mínima de archivos `KEY=VALUE` (`.env.local`, `.env.example`).
 *
 * Sin dependencias a propósito (nada de `dotenv`: `package.json` no se toca por
 * un parser de veinte líneas). Soporta lo que usa el repo y nada más:
 * comentarios con `#` al principio de línea, líneas vacías, un `export `
 * opcional y comillas simples o dobles que envuelven el valor entero. **No**
 * interpola `$VAR` ni corta comentarios al final de la línea: un `#` dentro de
 * un valor (una contraseña) es parte del valor.
 */
import { existsSync, readFileSync } from "node:fs";

/**
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m === null) continue;
    let value = m[2];
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * @param {string} path
 * @returns {Record<string, string> | null} `null` si el archivo no existe.
 */
export function readEnvFile(path) {
  if (!existsSync(path)) return null;
  return parseEnv(readFileSync(path, "utf8"));
}
