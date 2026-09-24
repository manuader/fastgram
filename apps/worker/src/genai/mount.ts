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
import { join } from "node:path";

import {
  FileModelRegistry,
  JsonFileCollection,
  resolveFastgramHome,
  JsonFileDocument,
  aiStudioDir,
  createGenClient,
  isGenProvider,
  modelRegistryPath,
  spendLedgerPath,
} from "@fastgram/adapters";
import { FORMAT_RUNS_DIR_NAME, type SecretEnv } from "@fastgram/core";
import type { Database } from "@fastgram/db";
import { PortError, type JobHandler, type Queue, type Storage } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { createFormatRunFinisher } from "../formats/finish.js";
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
  /**
   * Sprint 7 (agente G): con la cola, una generación que es el clip de un
   * formato generativo arma su pieza al quedar lista. Sin cola, no.
   */
  readonly queue?: Queue | undefined;
}

export function createAiStudioMount(deps: AiStudioMountDeps): {
  readonly handler: JobHandler<unknown>;
  readonly concurrency: number;
} {
  const concurrency = genAiConcurrencyFromEnv(deps.env);
  const semaphores = new Map<string, Semaphore>();
  const httpsOnly = httpDownloader({
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    maxBytes: DOWNLOAD_MAX_BYTES,
  });
  const afterReady =
    deps.queue === undefined
      ? undefined
      : createFormatRunFinisher({
          db: deps.db,
          appRole: deps.appRole,
          queue: deps.queue,
          runs: new JsonFileCollection(
            join(resolveFastgramHome(deps.env), FORMAT_RUNS_DIR_NAME),
          ),
          logger: deps.logger,
        });
  const handler = createAiStudioGenerationHandler({
    ...(afterReady === undefined ? {} : { afterReady }),
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
        // ComfyUI (`PU-LATER-003`): el workflow es el modelo.
        task: config.task,
        model: config.model,
        ...(config.comfyWorkflow === undefined
          ? {}
          : { comfyWorkflow: config.comfyWorkflow }),
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
    download: (url, config) =>
      (config.provider === "comfyui"
        ? // `GET /view` del ComfyUI local, por `http://` y sólo desde su base.
          httpDownloader({
            timeoutMs: DOWNLOAD_TIMEOUT_MS,
            maxBytes: DOWNLOAD_MAX_BYTES,
            allowHttpOrigin: config.baseUrl,
          })
        : httpsOnly)(url),
  });
  return { handler, concurrency };
}
