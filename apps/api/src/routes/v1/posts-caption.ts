/**
 * El LLM de la caption (sprint 7, publish-flow) — `POST /content/:id/caption`
 * y `enableCaptionGeneration` de `POST /content/:id/schedule`.
 *
 * La API no tenía ningún LLM síncrono: todo lo que usa el modelo `text` corre
 * en el worker. La caption es la excepción porque el usuario la espera en el
 * diálogo, mirando el campo. Por eso:
 *
 * - el modelo sale del **registro de modelos** (`~/.fastgram/models.json`,
 *   tarea `text`), releído en cada pedido (el `FileModelRegistry` lee el
 *   archivo), con las `LLM_*` de siempre como respaldo — la misma resolución
 *   que `apps/worker/src/llm/registry-llm.ts` (`resolveLlmConfig`);
 * - cada llamada tiene {@link CAPTION_LLM_TIMEOUT_MS}, **por debajo** de los
 *   10 s con los que el proxy de `apps/web` corta: un modelo local lento llega
 *   como `service_unavailable` con motivo, no como «la API no respondió».
 *
 * La URL: para lo que sale del registro se usa la convención del SDK de OpenAI
 * (base + `/chat/completions`, `openAiEndpoint`), igual que el worker; el
 * adaptador le agrega `/v1` a una base que no termina en `/v1`, y con Gemini
 * eso arma una URL que no existe. Sin key (Ollama) no se manda `Authorization`.
 *
 * `buildCaptionLlm` duplica `buildLlm` del worker: moverlo a un paquete
 * compartido (`packages/adapters`) no es de esta tarea. Está en el reporte.
 */
import {
  OpenAiCompatibleLlm,
  FileModelRegistry,
  modelRegistryPath,
} from "@fastgram/adapters";
import {
  legacyLlmFromEnv,
  openAiEndpoint,
  resolveLlmConfig,
  type ResolvedLlmConfig,
  type SecretEnv,
} from "@fastgram/core";
import type { Llm, ModelRegistry } from "@fastgram/ports";

/** Presupuesto de una llamada. Ver la cabecera. */
export const CAPTION_LLM_TIMEOUT_MS = 9_000;

export interface CaptionLlm {
  readonly llm: Llm;
  readonly model: string;
}

/** El LLM de la tarea `text` **ahora**, o `null` si no hay ninguno configurado. */
export interface CaptionLlmSource {
  current(): Promise<CaptionLlm | null>;
}

export function buildCaptionLlm(config: ResolvedLlmConfig): Llm {
  const endpoint = openAiEndpoint(config.baseUrl, "chat/completions");
  return new OpenAiCompatibleLlm({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    contextWindowTokens: config.contextWindowTokens,
    defaultTimeoutMs: CAPTION_LLM_TIMEOUT_MS,
    ...(config.source === "registry"
      ? {
          fetch: (_ignored, init) => {
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

export function registryCaptionLlmSource(
  registry: ModelRegistry,
  env: SecretEnv,
): CaptionLlmSource {
  return {
    async current() {
      let snapshot;
      try {
        snapshot = await registry.read();
      } catch {
        // Un registro ilegible no tumba la ruta: se cae a las `LLM_*`.
        snapshot = { tasks: {} };
      }
      const config = resolveLlmConfig("text", snapshot, legacyLlmFromEnv(env), env);
      if (config === null) return null;
      return { llm: buildCaptionLlm(config), model: config.model };
    },
  };
}

/** `PUBLISH_X_ALLOW_LINKS`, la misma variable que lee el worker (`publishing/mount.ts`). */
export function xAllowLinksFromEnv(env: SecretEnv): boolean {
  return env["PUBLISH_X_ALLOW_LINKS"]?.trim().toLowerCase() === "true";
}

export interface PostRouteDeps {
  readonly captionLlm: CaptionLlmSource;
  readonly xAllowLinks: boolean;
}

/**
 * Sin argumentos se arman de `process.env` (`FASTGRAM_HOME`, `LLM_*`,
 * `PUBLISH_X_ALLOW_LINKS`), como `models.ts`: `server/types.ts` y `main.ts` no
 * son de esta tarea.
 */
export function defaultPostRouteDeps(env: SecretEnv = process.env): PostRouteDeps {
  return {
    captionLlm: registryCaptionLlmSource(
      new FileModelRegistry({ path: modelRegistryPath(env) }),
      env,
    ),
    xAllowLinks: xAllowLinksFromEnv(env),
  };
}
