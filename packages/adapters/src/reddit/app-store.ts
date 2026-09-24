/**
 * Credenciales de la app de Reddit — `F-190`. Archivo local
 * `$FASTGRAM_HOME/reddit-app.json` (0600), **fuera del repo**, con el mismo
 * patrón que `integrations.json` (escritura atómica, un archivo roto no se
 * pisa).
 *
 * No va en `integrations.json`: ese archivo tiene un esquema estricto por
 * `OAUTH_PLATFORMS` y una clave `reddit` lo haría ilegible para Connections
 * (ver `packages/core/src/connections/reddit.ts` por qué Reddit no es una de
 * esas redes).
 *
 * Guarda además el **usuario de Reddit del dueño de la app**: el User-Agent
 * documentado lo exige (`(by /u/<reddit username>)`).
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { PortError } from "@fastgram/ports";
import { z } from "zod";

import { resolveFastgramHome } from "../model-registry/file-model-registry.js";

const SOURCE = "RedditAppStore/file";
export const REDDIT_APP_FILE_NAME = "reddit-app.json";

export interface RedditAppConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Usuario de Reddit del dueño de la app, sin `u/`. */
  readonly developerUsername: string;
  readonly updatedAt?: string;
}

const fileSchema = z
  .object({
    version: z.literal(1),
    clientId: z.string().min(1).max(256),
    clientSecret: z.string().min(1).max(1024),
    developerUsername: z.string().min(1).max(64),
    updatedAt: z.string().optional(),
  })
  .strict();

export function redditAppPath(env: Readonly<Record<string, string | undefined>>): string {
  return join(resolveFastgramHome(env), REDDIT_APP_FILE_NAME);
}

export interface RedditAppStore {
  read(): Promise<RedditAppConfig | null>;
  write(config: RedditAppConfig | null): Promise<void>;
}

export class FileRedditAppStore implements RedditAppStore {
  readonly #path: string;
  readonly #now: () => Date;
  #writes: Promise<void> = Promise.resolve();

  constructor(config: { readonly path: string; readonly now?: () => Date }) {
    this.#path = config.path;
    this.#now = config.now ?? (() => new Date());
  }

  async read(): Promise<RedditAppConfig | null> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (cause) {
      if ((cause as { code?: unknown }).code === "ENOENT") return null;
      throw new PortError("provider_unavailable", "The Reddit app file cannot be read", {
        source: SOURCE,
        cause,
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new PortError(
        "provider_contract_violation",
        "The Reddit app file is not valid JSON",
        {
          source: SOURCE,
        },
      );
    }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) {
      throw new PortError(
        "provider_contract_violation",
        "The Reddit app file has an unexpected shape",
        // Paths de Zod, nunca valores (ahí está el secret).
        { source: SOURCE, cause: parsed.error.issues.map((i) => i.path.join(".")) },
      );
    }
    const d = parsed.data;
    return {
      clientId: d.clientId,
      clientSecret: d.clientSecret,
      developerUsername: d.developerUsername,
      ...(d.updatedAt === undefined ? {} : { updatedAt: d.updatedAt }),
    };
  }

  write(config: RedditAppConfig | null): Promise<void> {
    const next = this.#writes.then(() => this.#writeNow(config));
    this.#writes = next.catch(() => undefined);
    return next;
  }

  async #writeNow(config: RedditAppConfig | null): Promise<void> {
    if (config === null) {
      await rm(this.#path, { force: true });
      return;
    }
    const body = `${JSON.stringify(
      {
        version: 1,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        developerUsername: config.developerUsername,
        updatedAt: this.#now().toISOString(),
      },
      null,
      2,
    )}\n`;
    const dir = dirname(this.#path);
    const tmp = join(
      dir,
      `.${REDDIT_APP_FILE_NAME}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(tmp, body, { mode: 0o600, flag: "wx" });
      await chmod(tmp, 0o600);
      await rename(tmp, this.#path);
    } catch (cause) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new PortError(
        "provider_unavailable",
        "The Reddit app file cannot be written",
        {
          source: SOURCE,
          cause,
        },
      );
    }
  }
}

/** Store en memoria para tests. */
export class MemoryRedditAppStore implements RedditAppStore {
  #config: RedditAppConfig | null;
  constructor(initial: RedditAppConfig | null = null) {
    this.#config = initial;
  }
  read(): Promise<RedditAppConfig | null> {
    return Promise.resolve(this.#config);
  }
  write(config: RedditAppConfig | null): Promise<void> {
    this.#config = config;
    return Promise.resolve();
  }
}
