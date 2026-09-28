/**
 * El etiquetador del JSON con la tarea `vision` del registro de modelos —
 * sprint 9 (agente N), `PU-S9-006`.
 *
 * Reusa el adaptador de `PU-MEME-003` (`OpenAiVisionTagger`: mismo endpoint
 * compatible con OpenAI, mismos cuadros JPEG) con otro prompt. El adaptador
 * está tipado a `ClipTags` (emoción, situación, personas, tags); en vez de
 * tocar `packages/adapters` (no es de esta tanda), el `parse` guarda la
 * propuesta completa en una variable de la instancia y le devuelve al
 * adaptador un `ClipTags` derivado. Por eso se crea **un etiquetador por
 * asset**: la variable no se comparte entre jobs.
 *
 * Sin entrada completa para `vision` → `null` y el asset queda con lo
 * medible (ver `metadata.ts`). No cae a las `LLM_*`: un modelo de texto sin
 * visión rechazaría las imágenes.
 */
import { OpenAiVisionTagger, type FetchLike } from "@fastgram/adapters";
import {
  LIBRARY_TAGGING_USER_PROMPT,
  extractJsonObject,
  libraryTaggingSystemPrompt,
  openAiEndpoint,
  parseLibraryTags,
  resolveLlmConfig,
  type LibraryTagProposal,
  type SecretEnv,
} from "@fastgram/core";
import type { ModelRegistry } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { LIBRARY_VOCABULARY } from "./metadata.js";

export interface LibraryTagger {
  /** El modelo que se usó (para el log; nunca la key). */
  readonly model: string;
  tag(frames: readonly Uint8Array[]): Promise<LibraryTagProposal>;
}

export type LibraryTaggerProvider = () => Promise<LibraryTagger | null>;

export interface LibraryTaggerDeps {
  readonly registry: ModelRegistry;
  readonly secrets: SecretEnv;
  readonly logger: BuildLogger;
  /** Sólo tests. */
  readonly fetch?: FetchLike;
}

export function createLibraryTaggerProvider(
  deps: LibraryTaggerDeps,
): LibraryTaggerProvider {
  return async () => {
    let snapshot;
    try {
      snapshot = await deps.registry.read();
    } catch (error: unknown) {
      deps.logger.warn(
        { reason: error instanceof Error ? error.message : String(error) },
        "no se pudo leer el registro de modelos: el asset queda sin etiquetar",
      );
      return null;
    }
    const config = resolveLlmConfig("vision", snapshot, null, deps.secrets);
    if (config === null) return null;
    return {
      model: config.model,
      async tag(frames) {
        const holder: { proposal: LibraryTagProposal | null } = { proposal: null };
        const adapter = new OpenAiVisionTagger({
          endpoint: openAiEndpoint(config.baseUrl, "chat/completions"),
          apiKey: config.apiKey,
          model: config.model,
          systemPrompt: libraryTaggingSystemPrompt(LIBRARY_VOCABULARY),
          userPrompt: LIBRARY_TAGGING_USER_PROMPT,
          // Ver la cabecera: la propuesta entera queda acá; al adaptador le
          // alcanza con un `ClipTags` que no se usa.
          parse: (text) => {
            const proposal = parseLibraryTags(
              extractJsonObject(text),
              LIBRARY_VOCABULARY,
            );
            holder.proposal = proposal;
            if (proposal === null) return null;
            return {
              emotion: proposal.emotions[0] ?? "neutral",
              situation: proposal.description.slice(0, 80),
              people: proposal.characters.length,
              tags: proposal.tags,
            };
          },
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
          timeoutMs: 180_000,
        });
        await adapter.tag(frames);
        if (holder.proposal === null) throw new Error("vision_parse_failed");
        return holder.proposal;
      },
    };
  };
}
