/**
 * `ModelRegistry` sobre un archivo local — `PU-MODEL-001`.
 *
 * `${FASTGRAM_HOME:-~/.fastgram}/models.json`, **fuera del repo** y con
 * permisos `0600`: adentro hay API keys, y un archivo dentro del árbol del
 * proyecto termina, tarde o temprano, en un commit.
 *
 * ## Por qué un archivo y no la base
 *
 * La app es de uso personal (D-06) y el registro es de la instalación, no de
 * una marca: el mismo modelo sirve a todas. En Postgres sería una tabla sin
 * `companyId`, la única del esquema, con secretos en claro al lado de datos
 * que se respaldan y se comparten. En un archivo del usuario queda donde
 * quedaría un `~/.npmrc`.
 *
 * ## Tres garantías, y cómo se consiguen
 *
 * 1. **Nunca a medio escribir.** Se escribe un temporal en el mismo directorio
 *    y se hace `rename`, que en el mismo filesystem es atómico: quien lee (el
 *    worker, en cada job) ve el viejo o el nuevo.
 * 2. **`0600` siempre.** El temporal se crea con `0600` y el `rename` conserva
 *    ese modo, así que el archivo nunca existe con otro. El directorio, `0700`.
 *    Si alguien lo abrió a mano (`chmod 644`), la próxima escritura lo cierra.
 * 3. **Dos escrituras del mismo proceso no se pisan.** Leer-modificar-escribir
 *    va en una cola por instancia. Entre procesos no hay lock: escribe sólo la
 *    API (una por instalación personal) y el worker sólo lee.
 *
 * ## Lo que no hace: reparar
 *
 * Un archivo que no parsea es `provider_contract_violation`, y **no se pisa**
 * con uno vacío: puede tener keys que el usuario no tiene en otro lado. La
 * validación es estricta por lo mismo: una entrada rota que se descartara al
 * leer se borraría en la próxima escritura, con su key adentro.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  MODEL_PROVIDERS,
  MODEL_TASKS,
  PortError,
  type ModelRegistry,
  type ModelRegistrySnapshot,
  type ModelTask,
  type ModelTaskConfig,
} from "@fastgram/ports";
import { z } from "zod";

const SOURCE = "ModelRegistry/file";

export const MODEL_REGISTRY_FILE_NAME = "models.json";
export const MODEL_REGISTRY_FILE_VERSION = 1;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * El directorio de FastGram: `FASTGRAM_HOME` o `~/.fastgram`. Recibe el entorno
 * en vez de leer `process.env` para que el test no dependa del de la máquina.
 */
export function resolveFastgramHome(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const configured = env["FASTGRAM_HOME"]?.trim();
  return configured !== undefined && configured.length > 0
    ? configured
    : join(homedir(), ".fastgram");
}

export function modelRegistryPath(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return join(resolveFastgramHome(env), MODEL_REGISTRY_FILE_NAME);
}

/* ------------------------------------------------------------------------ *
 * Forma del archivo
 * ------------------------------------------------------------------------ */

const httpUrl = z
  .string()
  .url()
  .refine((v) => /^https?:\/\//i.test(v), "http(s) only");

const entrySchema = z
  .object({
    provider: z.enum(MODEL_PROVIDERS),
    baseUrl: httpUrl,
    model: z.string().trim().min(1),
    apiKey: z.string().min(1).optional(),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/)
      .optional(),
    contextWindowTokens: z.number().int().positive().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

const taskShape = Object.fromEntries(
  MODEL_TASKS.map((task) => [task, entrySchema.optional()]),
) as Record<ModelTask, z.ZodOptional<typeof entrySchema>>;

const fileSchema = z
  .object({
    version: z.literal(MODEL_REGISTRY_FILE_VERSION),
    tasks: z.object(taskShape).strict().default({}),
  })
  .strict();

/** Sin las claves en `undefined`: `exactOptionalPropertyTypes` no las acepta. */
function toConfig(entry: z.infer<typeof entrySchema>): ModelTaskConfig {
  return {
    provider: entry.provider,
    baseUrl: entry.baseUrl,
    model: entry.model,
    ...(entry.apiKey === undefined ? {} : { apiKey: entry.apiKey }),
    ...(entry.apiKeyEnv === undefined ? {} : { apiKeyEnv: entry.apiKeyEnv }),
    ...(entry.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: entry.contextWindowTokens }),
    ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
  };
}

/* ------------------------------------------------------------------------ *
 * El adaptador
 * ------------------------------------------------------------------------ */

export interface FileModelRegistryConfig {
  /** Ruta completa del archivo. Ver {@link modelRegistryPath}. */
  readonly path: string;
}

export class FileModelRegistry implements ModelRegistry {
  readonly #path: string;
  /** La cola de escrituras de esta instancia. Ver la garantía 3. */
  #writes: Promise<void> = Promise.resolve();

  constructor(config: FileModelRegistryConfig) {
    this.#path = config.path;
  }

  get path(): string {
    return this.#path;
  }

  async read(): Promise<ModelRegistrySnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return { tasks: {} };
      throw new PortError("provider_unavailable", "The model registry cannot be read", {
        source: SOURCE,
        cause,
      });
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (cause) {
      throw new PortError(
        "provider_contract_violation",
        "The model registry file is not valid JSON",
        { source: SOURCE, cause },
      );
    }

    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) {
      // El `cause` lleva los paths de Zod, **no** los valores: un issue de
      // Zod sobre `apiKey` no incluye la key, pero el objeto recibido sí.
      throw new PortError(
        "provider_contract_violation",
        "The model registry file has an unexpected shape",
        {
          source: SOURCE,
          cause: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        },
      );
    }

    const tasks: Partial<Record<ModelTask, ModelTaskConfig>> = {};
    for (const task of MODEL_TASKS) {
      const entry = parsed.data.tasks[task];
      if (entry !== undefined) tasks[task] = toConfig(entry);
    }
    return { tasks };
  }

  write(task: ModelTask, config: ModelTaskConfig | null): Promise<void> {
    const next = this.#writes.then(() => this.#writeNow(task, config));
    // La cola sigue aunque una escritura falle; el error lo ve quien la pidió.
    this.#writes = next.catch(() => undefined);
    return next;
  }

  async #writeNow(task: ModelTask, config: ModelTaskConfig | null): Promise<void> {
    const current = await this.read();
    const tasks: Partial<Record<ModelTask, ModelTaskConfig>> = { ...current.tasks };
    if (config === null) delete tasks[task];
    else tasks[task] = config;

    const body = `${JSON.stringify({ version: MODEL_REGISTRY_FILE_VERSION, tasks }, null, 2)}\n`;
    const dir = dirname(this.#path);
    const tmp = join(
      dir,
      `.${MODEL_REGISTRY_FILE_NAME}.${randomBytes(6).toString("hex")}.tmp`,
    );

    try {
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
      // `flag: "wx"`: el temporal es nuevo, nunca uno que alguien dejó con
      // otro modo. `mode` sólo aplica al crear, que es justo este caso.
      await writeFile(tmp, body, { mode: FILE_MODE, flag: "wx" });
      // La umask del proceso puede haber recortado bits, nunca agregado: el
      // `chmod` es para dejarlo exacto y no depender de ella.
      await chmod(tmp, FILE_MODE);
      await rename(tmp, this.#path);
    } catch (cause) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new PortError(
        "provider_unavailable",
        "The model registry cannot be written",
        {
          source: SOURCE,
          cause,
        },
      );
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
