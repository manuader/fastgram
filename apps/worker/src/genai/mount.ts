/**
 * Cómo se monta `ai-studio-generation` — `PU-LATER-005`, `PU-MODEL-003`/`004`.
 *
 * Se monta **siempre**: construirlo no toca red ni disco, y la configuración
 * (proveedor, modelo, key) se resuelve en cada job contra el registro de
 * modelos, como el LLM. Sin imagen/video configurados, la API no encola
 * (409), así que un job que llega sin configuración es de alguien que la
 * borró en el medio: se cierra con `not_configured` y se libera la reserva.
 *
 * Variables (todas opcionales):
 *  - `FASTGRAM_HOME`: dónde viven `models.json`, `spend.json` y `ai-studio/`.
 *  - `FASTGRAM_GENAI_CONCURRENCY`: pedidos a la vez **por proveedor** (default 2).
 */
import {
  FileModelRegistry,
  JsonFileCollection,
  JsonFileDocument,
  aiStudioDir,
  createGenClient,
  isGenProvider,
  modelRegistryPath,
  spendLedgerPath,
} from "@fastgram/adapters";
import type { SecretEnv } from "@fastgram/core";
import type { Database } from "@fastgram/db";
import { PortError, type JobHandler, type Storage } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { createAiStudioGenerationHandler, httpDownloader } from "./handler.js";
import { Semaphore, genAiConcurrencyFromEnv } from "./semaphore.js";

/** Por llamada HTTP al proveedor (enviar, estado). */
const PROVIDER_TIMEOUT_MS = 30_000;
/** Descargar un video de ~10 s. */
const DOWNLOAD_TIMEOUT_MS = 180_000;
/** Ningún resultado razonable se acerca; es para no llenar la memoria. */
const DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024;

export interface AiStudioMountDeps {
  readonly db: Database;
  readonly storage: Storage;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  /** `process.env`: `FASTGRAM_HOME`, la concurrencia y los `apiKeyEnv`. */
  readonly env: SecretEnv;
}

export function createAiStudioMount(deps: AiStudioMountDeps): {
  readonly handler: JobHandler<unknown>;
  readonly concurrency: number;
} {
  const concurrency = genAiConcurrencyFromEnv(deps.env);
  const semaphores = new Map<string, Semaphore>();
  const handler = createAiStudioGenerationHandler({
    db: deps.db,
    storage: deps.storage,
    appRole: deps.appRole,
    logger: deps.logger,
    registry: new FileModelRegistry({ path: modelRegistryPath(deps.env) }),
    secrets: deps.env,
    ledger: new JsonFileDocument(spendLedgerPath(deps.env)),
    generations: new JsonFileCollection(aiStudioDir(deps.env)),
    clientFor: (config) => {
      if (!isGenProvider(config.provider)) {
        throw new PortError("bad_request", "That provider has no generation adapter", {
          source: "worker/ai-studio",
        });
      }
      return createGenClient({
        provider: config.provider,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: PROVIDER_TIMEOUT_MS,
      });
    },
    semaphoreFor: (provider) => {
      let s = semaphores.get(provider);
      if (s === undefined) {
        s = new Semaphore(concurrency);
        semaphores.set(provider, s);
      }
      return s;
    },
    download: httpDownloader({
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      maxBytes: DOWNLOAD_MAX_BYTES,
    }),
  });
  return { handler, concurrency };
}
