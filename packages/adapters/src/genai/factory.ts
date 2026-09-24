/**
 * Qué adaptador de generación corresponde a cada proveedor del registro de
 * modelos — `PU-MODEL-003`/`004`.
 *
 * Los ids (`higgsfield`, `fal`, `comfyui`) son los de `MODEL_PROVIDERS`.
 * `custom` no tiene adaptador de imagen/video: no hay un protocolo estándar
 * que hablarle.
 */
import type {
  ComfyWorkflowConfig,
  GenMediaKind,
  GenModelSpec,
  ImageGen,
  VideoGen,
} from "@fastgram/ports";

import { ComfyUiClient } from "../comfyui/client.js";

import { FAL_MODELS } from "../fal/catalog.js";
import { FalClient } from "../fal/client.js";
import { HIGGSFIELD_MODELS } from "../higgsfield/catalog.js";
import { HiggsfieldClient } from "../higgsfield/client.js";
import type { GenFetch } from "./http.js";

export type GenClient = ImageGen & VideoGen;

export const GEN_PROVIDERS = ["higgsfield", "fal", "comfyui"] as const;
export type GenProviderId = (typeof GEN_PROVIDERS)[number];

export function isGenProvider(value: string): value is GenProviderId {
  return (GEN_PROVIDERS as readonly string[]).includes(value);
}

export interface GenClientConfig {
  readonly provider: GenProviderId;
  readonly baseUrl: string;
  /** Vacía con `comfyui` (local, sin key). */
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly fetch?: GenFetch;
  /**
   * Sólo `comfyui` (`PU-LATER-003`): la tarea, el workflow y su nombre. Sin
   * ellos el cliente sólo sirve para «Test connection».
   */
  readonly task?: GenMediaKind;
  readonly model?: string;
  readonly comfyWorkflow?: ComfyWorkflowConfig;
}

/** Lanza `unauthorized` si la credencial no tiene la forma que el proveedor pide. */
export function createGenClient(config: GenClientConfig): GenClient {
  if (config.provider === "comfyui") {
    return new ComfyUiClient({
      baseUrl: config.baseUrl,
      ...(config.task === undefined ? {} : { task: config.task }),
      ...(config.model === undefined ? {} : { model: config.model }),
      ...(config.comfyWorkflow === undefined ? {} : { workflow: config.comfyWorkflow }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    });
  }
  const common = {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  };
  return config.provider === "higgsfield"
    ? new HiggsfieldClient(common)
    : new FalClient(common);
}

/**
 * El catálogo sin credenciales (para listar en Settings antes de tener key).
 * ComfyUI no tiene catálogo: su «modelo» es el workflow que sube el usuario.
 */
export function genCatalog(provider: GenProviderId): readonly GenModelSpec[] {
  if (provider === "comfyui") return [];
  return (provider === "higgsfield" ? HIGGSFIELD_MODELS : FAL_MODELS).map((m) => m.spec);
}
