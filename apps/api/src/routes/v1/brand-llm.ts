/**
 * Los modelos que usan las rutas de marca y de ángulos, leídos del registro —
 * `P2-ANGLE-005` (generador de ángulos con el modelo `text`) y `P1-BRAND-014`
 * (OCR de capturas: `services/vision` o el modelo `vision`).
 *
 * Mismo criterio que `models.ts`: esta es una ruta que lee el entorno por su
 * cuenta (`FASTGRAM_HOME`, las `LLM_*`, `VISION_SERVICE_URL`), porque
 * `server/types.ts` y `main.ts` no son de esta tarea. Se resuelve **en cada
 * pedido**: un modelo nuevo en Settings → Models llega al próximo, sin
 * reiniciar la API.
 *
 * La URL del chat sale de `openAiEndpoint` (convención del SDK de OpenAI), la
 * misma que usa el worker para lo que viene del registro (ver
 * `apps/worker/src/llm/registry-llm.ts`): con la base de Gemini, la
 * normalización propia de `OpenAiCompatibleLlm` arma una URL que no existe.
 */
import {
  FileModelRegistry,
  OpenAiCompatibleLlm,
  OpenAiVisionTagger,
  VisionOcr,
  loopbackPublisher,
  modelRegistryPath,
} from "@fastgram/adapters";
import {
  legacyLlmFromEnv,
  openAiEndpoint,
  parseReferenceVision,
  resolveLlmConfig,
  type ResolvedLlmConfig,
  type SecretEnv,
} from "@fastgram/core";
import type { ClipTagger, Llm, ModelRegistry, ModelTask, Ocr } from "@fastgram/ports";

/** `extractJsonObject` del worker, en chico: el primer objeto JSON del texto. */
function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface BrandModels {
  /** El LLM de `task` ahora, o `null` si no hay ninguno configurado. */
  llm(task: ModelTask): Promise<{ readonly llm: Llm; readonly model: string } | null>;
  /** OCR de `services/vision`, o `null` sin `VISION_SERVICE_URL`. */
  ocr(): Ocr | null;
  /** Etiquetador de visión (`vision` del registro) con prompts dados, o `null`. */
  visionTagger(prompts: {
    readonly systemPrompt: string;
    readonly userPrompt: string;
  }): Promise<ClipTagger | null>;
}

function buildLlm(config: ResolvedLlmConfig): Llm {
  const endpoint = openAiEndpoint(config.baseUrl, "chat/completions");
  return new OpenAiCompatibleLlm({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    contextWindowTokens: config.contextWindowTokens,
    ...(config.source === "registry"
      ? {
          fetch: (_ignored, init) => {
            // Sin key (Ollama, LM Studio) no va `Authorization` vacío.
            const headers =
              config.apiKey.length === 0
                ? Object.fromEntries(
                    Object.entries(init.headers).filter(
                      ([name]) => name.toLowerCase() !== "authorization",
                    ),
                  )
                : init.headers;
            return fetch(endpoint, { ...init, headers });
          },
        }
      : {}),
  });
}

export function registryBrandModels(
  env: SecretEnv = process.env,
  registry: ModelRegistry = new FileModelRegistry({ path: modelRegistryPath(env) }),
): BrandModels {
  let ocr: Ocr | null | undefined;
  return {
    async llm(task) {
      const snapshot = await registry.read();
      const config = resolveLlmConfig(task, snapshot, legacyLlmFromEnv(env), env);
      return config === null ? null : { llm: buildLlm(config), model: config.model };
    },
    ocr() {
      if (ocr !== undefined) return ocr;
      const url = env["VISION_SERVICE_URL"]?.trim() ?? "";
      ocr =
        url === ""
          ? null
          : new VisionOcr({ baseUrl: url, publisher: loopbackPublisher() });
      return ocr;
    },
    async visionTagger(prompts) {
      const snapshot = await registry.read();
      const config = resolveLlmConfig("vision", snapshot, null, env);
      if (config === null) return null;
      return new OpenAiVisionTagger({
        endpoint: openAiEndpoint(config.baseUrl, "chat/completions"),
        apiKey: config.apiKey,
        model: config.model,
        systemPrompt: prompts.systemPrompt,
        userPrompt: prompts.userPrompt,
        parse: (text) => parseReferenceVision(firstJsonObject(text)),
      });
    },
  };
}
