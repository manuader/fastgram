/**
 * Con qué etiquetar y con qué recortar, releído del registro de modelos en
 * cada job — `PU-MEME-002`, `PU-MEME-003`.
 *
 * - Etiquetas: la tarea `vision` (un endpoint de chat compatible con OpenAI que
 *   acepte imágenes). Sin entrada completa → `null` y el etiquetado se saltea.
 *   No cae a las `LLM_*`: un modelo de texto sin visión rechazaría las imágenes.
 * - Recorte: la tarea `background_removal`, si apunta a la cola de fal
 *   (`resolveBackgroundRemovalConfig`). Sin eso → `null` y el clip queda
 *   «needs background removal».
 *
 * Nunca se loguea una key: sólo si hay o no proveedor, y a dónde se habla.
 */
import {
  FalBirefnetBackgroundRemoval,
  OpenAiVisionTagger,
  type FalFetch,
  type FetchLike,
} from "@fastgram/adapters";
import {
  CLIP_TAGGING_SYSTEM_PROMPT,
  CLIP_TAGGING_USER_PROMPT,
  extractJsonObject,
  openAiEndpoint,
  parseClipTags,
  resolveBackgroundRemovalConfig,
  resolveLlmConfig,
  type SecretEnv,
} from "@fastgram/core";
import type { BackgroundRemoval, ClipTagger, ModelRegistry } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";

export interface MediaImportProviderDeps {
  readonly registry: ModelRegistry;
  readonly secrets: SecretEnv;
  readonly logger: BuildLogger;
  /** Sólo tests. */
  readonly fetch?: FetchLike;
  readonly falFetch?: FalFetch;
}

export interface MediaImportProviders {
  tagger(): Promise<ClipTagger | null>;
  backgroundRemoval(): Promise<BackgroundRemoval | null>;
}

export function createMediaImportProviders(
  deps: MediaImportProviderDeps,
): MediaImportProviders {
  const snapshot = async () => {
    try {
      return await deps.registry.read();
    } catch (error: unknown) {
      deps.logger.warn(
        { reason: error instanceof Error ? error.message : String(error) },
        "no se pudo leer el registro de modelos: sin etiquetas ni recorte en este import",
      );
      return { tasks: {} };
    }
  };

  return {
    async tagger() {
      const config = resolveLlmConfig("vision", await snapshot(), null, deps.secrets);
      if (config === null) return null;
      return new OpenAiVisionTagger({
        endpoint: openAiEndpoint(config.baseUrl, "chat/completions"),
        apiKey: config.apiKey,
        model: config.model,
        systemPrompt: CLIP_TAGGING_SYSTEM_PROMPT,
        userPrompt: CLIP_TAGGING_USER_PROMPT,
        parse: (text) => parseClipTags(extractJsonObject(text)),
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      });
    },
    async backgroundRemoval() {
      const resolved = resolveBackgroundRemovalConfig(await snapshot(), deps.secrets);
      if (!resolved.ok) {
        if (resolved.why !== "unset") {
          deps.logger.warn(
            { why: resolved.why },
            "la tarea background_removal no apunta a fal con key: no se recorta",
          );
        }
        return null;
      }
      return new FalBirefnetBackgroundRemoval({
        baseUrl: resolved.config.baseUrl,
        endpoint: resolved.config.endpoint,
        apiKey: resolved.config.apiKey,
        ...(deps.falFetch === undefined ? {} : { fetch: deps.falFetch }),
      });
    },
  };
}
