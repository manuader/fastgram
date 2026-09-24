/**
 * `IntegrationStore` sobre un archivo local — `PU-PUB-002`.
 *
 * `${FASTGRAM_HOME:-~/.fastgram}/integrations.json`, `0600`, fuera del repo.
 * Copia deliberada de `FileModelRegistry` (`../model-registry/`): mismas tres
 * garantías — escritura atómica por `rename`, `0600` siempre, escrituras en
 * cola dentro del proceso — y la misma regla de no reparar: un archivo que no
 * parsea es `provider_contract_violation` y **no se pisa**, porque tiene
 * secretos que el usuario puede no tener en otro lado.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  OAUTH_PLATFORMS,
  PortError,
  type IntegrationAppConfig,
  type IntegrationStore,
  type IntegrationsSnapshot,
  type OAuthPlatform,
} from "@fastgram/ports";
import { z } from "zod";

import { resolveFastgramHome } from "../model-registry/file-model-registry.js";

const SOURCE = "IntegrationStore/file";

export const INTEGRATIONS_FILE_NAME = "integrations.json";
export const INTEGRATIONS_FILE_VERSION = 1;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export function integrationsPath(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return join(resolveFastgramHome(env), INTEGRATIONS_FILE_NAME);
}

const entrySchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1).optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

const appsShape = Object.fromEntries(
  OAUTH_PLATFORMS.map((p) => [p, entrySchema.optional()]),
) as Record<OAuthPlatform, z.ZodOptional<typeof entrySchema>>;

const fileSchema = z
  .object({
    version: z.literal(INTEGRATIONS_FILE_VERSION),
    apps: z.object(appsShape).strict().default({}),
  })
  .strict();

function toConfig(entry: z.infer<typeof entrySchema>): IntegrationAppConfig {
  return {
    clientId: entry.clientId,
    ...(entry.clientSecret === undefined ? {} : { clientSecret: entry.clientSecret }),
    ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
  };
}

export class FileIntegrationStore implements IntegrationStore {
  readonly #path: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(config: { readonly path: string }) {
    this.#path = config.path;
  }

  get path(): string {
    return this.#path;
  }

  async read(): Promise<IntegrationsSnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (cause) {
      if ((cause as { code?: unknown }).code === "ENOENT") return { apps: {} };
      throw new PortError(
        "provider_unavailable",
        "The integrations file cannot be read",
        {
          source: SOURCE,
          cause,
        },
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      // Sin `cause`: el mensaje de `JSON.parse` puede citar un pedazo del archivo.
      throw new PortError(
        "provider_contract_violation",
        "The integrations file is not valid JSON",
        { source: SOURCE },
      );
    }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) {
      throw new PortError(
        "provider_contract_violation",
        "The integrations file has an unexpected shape",
        {
          source: SOURCE,
          // Paths de Zod, nunca los valores (ahí están los secrets).
          cause: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        },
      );
    }
    const apps: Partial<Record<OAuthPlatform, IntegrationAppConfig>> = {};
    for (const p of OAUTH_PLATFORMS) {
      const entry = parsed.data.apps[p];
      if (entry !== undefined) apps[p] = toConfig(entry);
    }
    return { apps };
  }

  write(platform: OAuthPlatform, config: IntegrationAppConfig | null): Promise<void> {
    const next = this.#writes.then(() => this.#writeNow(platform, config));
    this.#writes = next.catch(() => undefined);
    return next;
  }

  async #writeNow(platform: OAuthPlatform, config: IntegrationAppConfig | null) {
    // Si el archivo está roto, `read` lanza y no se escribe nada: no se repara.
    const current = await this.read();
    const apps: Partial<Record<OAuthPlatform, IntegrationAppConfig>> = {
      ...current.apps,
    };
    if (config === null) delete apps[platform];
    else apps[platform] = config;

    const body = `${JSON.stringify({ version: INTEGRATIONS_FILE_VERSION, apps }, null, 2)}\n`;
    const dir = dirname(this.#path);
    const tmp = join(
      dir,
      `.${INTEGRATIONS_FILE_NAME}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
      await writeFile(tmp, body, { mode: FILE_MODE, flag: "wx" });
      await chmod(tmp, FILE_MODE);
      await rename(tmp, this.#path);
    } catch (cause) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new PortError(
        "provider_unavailable",
        "The integrations file cannot be written",
        {
          source: SOURCE,
          cause,
        },
      );
    }
  }
}
