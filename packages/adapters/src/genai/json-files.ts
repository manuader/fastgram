/**
 * Persistencia local de AI Studio y del presupuesto — `PU-MODEL-005`,
 * `PU-LATER-005`.
 *
 * **Por qué archivos y no una tabla**: este sprint no tiene migración, y el
 * plan (§4, D-06) es uso personal en una sola máquina. El gasto del mes y las
 * generaciones viven al lado del registro de modelos, en `~/.fastgram/`
 * (`FASTGRAM_HOME`), con las mismas tres garantías que `models.json`:
 *
 * 1. **Escritura atómica**: temporal `0600` + `rename`. Quien lee ve el
 *    documento viejo o el nuevo, nunca uno a medio escribir.
 * 2. **`0600` / `0700`**: el gasto y los prompts son del usuario.
 * 3. **Leer-modificar-escribir bajo lock entre procesos**: la API reserva
 *    gasto y el worker lo liquida, y son dos procesos. El lock es un archivo
 *    `….lock` creado con `O_EXCL` (`flag: "wx"`), que es atómico en un
 *    filesystem local; uno más viejo que {@link STALE_LOCK_MS} se considera
 *    abandonado (un proceso que murió con el lock tomado).
 *
 * Este módulo **no conoce la forma** de lo que guarda (`unknown`): la valida
 * `core/genai` al leer. Así `adapters` no depende de `core`.
 *
 * Si la app pasa a un VPS con más de una máquina, esto se muda a Postgres:
 * un lock de archivo no cruza hosts.
 */
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { PortError } from "@fastgram/ports";

import { resolveFastgramHome } from "../model-registry/file-model-registry.js";

const SOURCE = "GenAi/json-files";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
/** Un lock más viejo que esto es de un proceso muerto. Las secciones duran ms. */
export const STALE_LOCK_MS = 30_000;
/** Cuánto se espera un lock antes de rendirse. */
const LOCK_WAIT_MS = 10_000;

export const SPEND_FILE_NAME = "spend.json";
export const AI_STUDIO_DIR_NAME = "ai-studio";

export function spendLedgerPath(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return join(resolveFastgramHome(env), SPEND_FILE_NAME);
}

export function aiStudioDir(env: Readonly<Record<string, string | undefined>>): string {
  return join(resolveFastgramHome(env), AI_STUDIO_DIR_NAME);
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Corre `fn` con el lock `lockPath` tomado. Ver la garantía 3. */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  waitMs: number = LOCK_WAIT_MS,
): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true, mode: DIR_MODE });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx", mode: FILE_MODE });
      break;
    } catch (error) {
      if (!isCode(error, "EEXIST")) {
        throw new PortError("provider_unavailable", "Local state cannot be locked", {
          source: SOURCE,
          cause: error,
        });
      }
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // Se liberó entre el intento y el `stat`: probar de nuevo.
        continue;
      }
      if (Date.now() > deadline) {
        throw new PortError("timeout", "Local state is busy", { source: SOURCE });
      }
      await sleep(15 + Math.floor(Math.random() * 25));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function readJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw new PortError("provider_unavailable", "Local state cannot be read", {
      source: SOURCE,
      cause: error,
    });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    // No se «repara» pisándolo: ver `FileModelRegistry`.
    throw new PortError("provider_contract_violation", "Local state file is not JSON", {
      source: SOURCE,
      cause,
    });
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
      mode: FILE_MODE,
      flag: "wx",
    });
    await chmod(tmp, FILE_MODE);
    await rename(tmp, path);
  } catch (cause) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new PortError("provider_unavailable", "Local state cannot be written", {
      source: SOURCE,
      cause,
    });
  }
}

/** Qué hacer con el documento: `next` ausente = no escribir. */
export interface DocumentUpdate<T> {
  readonly next?: unknown;
  readonly result: T;
}

/** Un documento JSON (el gasto del mes). */
export class JsonFileDocument {
  readonly #path: string;
  readonly #lockWaitMs: number;

  /**
   * `lockWaitMs` existe para el test de contención (100 escritores a la vez):
   * con la suite entera en paralelo, el último espera más que los 10 s de
   * producción, donde nunca hay más que un par de escritores.
   */
  constructor(path: string, options: { readonly lockWaitMs?: number } = {}) {
    this.#path = path;
    this.#lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
  }

  /** `null` si todavía no existe. */
  read(): Promise<unknown> {
    return readJson(this.#path);
  }

  /** Leer-modificar-escribir bajo lock. `fn` tiene que ser sincrónica y pura. */
  update<T>(fn: (current: unknown) => DocumentUpdate<T>): Promise<T> {
    return withFileLock(
      `${this.#path}.lock`,
      async () => {
        const out = fn(await readJson(this.#path));
        if (out.next !== undefined) await writeJsonAtomic(this.#path, out.next);
        return out.result;
      },
      this.#lockWaitMs,
    );
  }
}

/** Ids que pueden ser un segmento de ruta: nada de `..` ni separadores. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function segment(value: string): string {
  if (!SEGMENT.test(value)) {
    throw new PortError("bad_request", "Invalid local state id", { source: SOURCE });
  }
  return value;
}

/**
 * Una colección de documentos JSON por scope: `{root}/{scope}/{id}.json`. El
 * scope es el `companyId`: un id de otra marca **no existe** en este scope
 * (la API lo traduce a 404, nunca a 403).
 */
export class JsonFileCollection {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  #path(scope: string, id: string): string {
    return join(this.#root, segment(scope), `${segment(id)}.json`);
  }

  async get(scope: string, id: string): Promise<unknown> {
    return readJson(this.#path(scope, id));
  }

  /** Los documentos del scope, sin orden (el orden es del dominio). */
  async list(scope: string): Promise<unknown[]> {
    const dir = join(this.#root, segment(scope));
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isCode(error, "ENOENT")) return [];
      throw new PortError("provider_unavailable", "Local state cannot be listed", {
        source: SOURCE,
        cause: error,
      });
    }
    const out: unknown[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      try {
        const value = await readJson(join(dir, name));
        if (value !== null) out.push(value);
      } catch {
        // Un archivo roto no tapa al resto de la galería.
      }
    }
    return out;
  }

  /** Crea el documento. `conflict` si ya existe. */
  async create(scope: string, id: string, value: unknown): Promise<void> {
    const path = this.#path(scope, id);
    await withFileLock(`${path}.lock`, async () => {
      if ((await readJson(path)) !== null) {
        throw new PortError("conflict", "Local state document already exists", {
          source: SOURCE,
        });
      }
      await writeJsonAtomic(path, value);
    });
  }

  /** Leer-modificar-escribir un documento bajo su lock. */
  async update<T>(
    scope: string,
    id: string,
    fn: (current: unknown) => DocumentUpdate<T>,
  ): Promise<T> {
    const path = this.#path(scope, id);
    return withFileLock(`${path}.lock`, async () => {
      const out = fn(await readJson(path));
      if (out.next !== undefined) await writeJsonAtomic(path, out.next);
      return out.result;
    });
  }
}
