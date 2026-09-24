/**
 * Cómo se monta el trabajo real de `influencer-pipeline` — `PU-LATER-004`.
 *
 * Se monta **siempre** que haya storage: construirlo no toca red ni disco, y
 * Higgsfield (base URL y key) se resuelve en cada job contra el registro de
 * modelos, como AI Studio. Sin Higgsfield configurado, la API no crea el
 * personaje (409); un job que llega igual es de alguien que lo sacó en el
 * medio y se cierra con `not_configured`.
 *
 * Para enchufarlo, en `handlers.ts`, al crear el handler de la cola:
 *
 * ```ts
 * createInfluencerPipelineHandler({
 *   db, clock, appRole, logger,
 *   characters: createInfluencerCharacterMount({ storage, env: process.env }),
 * })
 * ```
 *
 * Variables (opcionales): `FASTGRAM_HOME` (dónde viven `models.json` y
 * `spend.json`).
 */
import {
  FileModelRegistry,
  HiggsfieldClient,
  JsonFileDocument,
  modelRegistryPath,
  spendLedgerPath,
} from "@fastgram/adapters";
import type { SecretEnv } from "@fastgram/core";
import type { Storage } from "@fastgram/ports";

import { httpDownloader } from "../genai/handler.js";
import type { InfluencerCharacterMount } from "./image-handler.js";

/** Por llamada HTTP a Higgsfield (enviar, estado, subir una foto). */
const PROVIDER_TIMEOUT_MS = 30_000;
/** Bajar una imagen de SOUL V2. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Ninguna imagen razonable se acerca; es para no llenar la memoria. */
const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** Bajar un video de 5–15 s (mismos números que AI Studio). */
const VIDEO_DOWNLOAD_TIMEOUT_MS = 180_000;
const VIDEO_DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024;

export function createInfluencerCharacterMount(deps: {
  readonly storage: Storage;
  /** `process.env`: `FASTGRAM_HOME` y los `apiKeyEnv` del registro. */
  readonly env: SecretEnv;
}): InfluencerCharacterMount {
  const download = httpDownloader({
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    maxBytes: DOWNLOAD_MAX_BYTES,
  });
  return {
    storage: deps.storage,
    registry: new FileModelRegistry({ path: modelRegistryPath(deps.env) }),
    secrets: deps.env,
    ledger: new JsonFileDocument(spendLedgerPath(deps.env)),
    clientFor: (config) =>
      new HiggsfieldClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: PROVIDER_TIMEOUT_MS,
      }),
    download,
    // Sprint 7 (agente G): image-to-video de Higgsfield para «Animate this image».
    video: {
      videoClientFor: (config) =>
        new HiggsfieldClient({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          timeoutMs: PROVIDER_TIMEOUT_MS,
        }),
      downloadVideo: httpDownloader({
        timeoutMs: VIDEO_DOWNLOAD_TIMEOUT_MS,
        maxBytes: VIDEO_DOWNLOAD_MAX_BYTES,
      }),
    },
  };
}
