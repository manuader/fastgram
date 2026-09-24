/**
 * El LLM de cada job, releído del registro de modelos — `PU-MODEL-001`.
 *
 * Hasta acá el worker armaba `OpenAiCompatibleLlm` **una vez al arrancar** con
 * las cuatro `LLM_*`. Con la pantalla de Modelos eso deja de alcanzar: cambiar
 * el modelo tiene que surtir efecto en el próximo job, sin reiniciar nada.
 *
 * ## Cómo
 *
 * {@link createLlmSource} lee el registro (`~/.fastgram/models.json`) con un
 * cache corto ({@link LLM_REGISTRY_TTL_MS}) y resuelve la tarea con
 * `resolveLlmConfig` de `core`: la entrada del registro si está completa, si
 * no las `LLM_*` de siempre, si no nada. **Sin archivo, el comportamiento es
 * exactamente el de antes**: mismas variables, mismo adaptador, misma URL.
 *
 * El adaptador se reusa mientras la configuración no cambie (no tiene estado,
 * pero construirlo en cada llamada ensuciaría el log de cambios). Cuando cambia
 * —otro modelo, otra base URL, otra key— se loguea **una vez**, con base URL y
 * modelo; la key nunca.
 *
 * ## La URL, para lo que sale del registro
 *
 * `OpenAiCompatibleLlm` le agrega `/v1` a una base que no termina en `/v1`.
 * Con la base de Gemini (`…/v1beta/openai/`) eso arma una URL que no existe.
 * Para las configuraciones **del registro** se le inyecta un `fetch` que
 * ignora la URL que arma el adaptador y usa la de la convención del SDK de
 * OpenAI (`openAiEndpoint`, base + `/chat/completions`), que es la misma que
 * usa la pantalla para probar. Para las `LLM_*` no se toca nada: el contrato
 * era «nada cambia». El arreglo de verdad es una opción `endpoint` en el
 * adaptador (`packages/adapters/src/llm/openai-compatible.ts`), que no es de
 * esta tarea: está en el reporte.
 *
 * ## Si el registro no se puede leer
 *
 * Se sigue con la última lectura buena (o, si nunca hubo, con el registro
 * vacío, que cae a las `LLM_*`), y se avisa una vez por error distinto. Un
 * archivo roto a mano no puede tirar abajo la cola que andaba.
 */
import { createHash } from "node:crypto";

import { OpenAiCompatibleLlm, type FetchLike } from "@fastgram/adapters";
import {
  openAiEndpoint,
  resolveLlmConfig,
  type LegacyLlmEnv,
  type ResolvedLlmConfig,
  type SecretEnv,
} from "@fastgram/core";
import {
  PortError,
  type Llm,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmJsonCompletion,
  type LlmJsonRequest,
  type ModelRegistry,
  type ModelRegistrySnapshot,
  type ModelTask,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";

/**
 * Cuánto dura una lectura del registro. Corto a propósito: es el tiempo máximo
 * entre «guardé otro modelo en la pantalla» y «el worker lo usa». Leer un JSON
 * chico cada cinco segundos, como mucho, no se nota.
 */
export const LLM_REGISTRY_TTL_MS = 5_000;

export interface ResolvedLlm {
  readonly llm: Llm;
  readonly config: ResolvedLlmConfig;
}

export interface LlmSource {
  /** El LLM para `task` ahora, o `null` si no hay ninguno configurado. */
  current(task: ModelTask): Promise<ResolvedLlm | null>;
}

export interface LlmSourceDeps {
  readonly registry: ModelRegistry;
  /** Las `LLM_*` ya validadas por `env.ts`, o `null`. */
  readonly legacy: LegacyLlmEnv | null;
  /** Para los `apiKeyEnv` del registro. En producción, `process.env`. */
  readonly secrets: SecretEnv;
  readonly logger: BuildLogger;
  readonly ttlMs?: number;
  readonly nowMs?: () => number;
  /** Sólo tests: con qué construir el adaptador. */
  readonly build?: (config: ResolvedLlmConfig) => Llm;
}

/** El adaptador real, con el endpoint de la convención del SDK si viene del registro. */
export function buildLlm(config: ResolvedLlmConfig, fetchImpl?: FetchLike): Llm {
  const base = fetchImpl ?? ((input, init) => fetch(input, init));
  const endpoint = openAiEndpoint(config.baseUrl, "chat/completions");
  return new OpenAiCompatibleLlm({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    contextWindowTokens: config.contextWindowTokens,
    ...(config.source === "registry"
      ? {
          fetch: (_ignored, init) => {
            // Sin key (Ollama, LM Studio): el adaptador manda `Bearer ` vacío,
            // que algunos servidores rechazan. Se saca.
            const headers =
              config.apiKey.length === 0
                ? Object.fromEntries(
                    Object.entries(init.headers).filter(
                      ([name]) => name.toLowerCase() !== "authorization",
                    ),
                  )
                : init.headers;
            return base(endpoint, { ...init, headers });
          },
        }
      : fetchImpl === undefined
        ? {}
        : { fetch: fetchImpl }),
  });
}

/**
 * Qué identifica una configuración. La key entra **hasheada**: la huella vive
 * en un `Map` del proceso y no se loguea, pero una key en claro en una
 * estructura más es una key más que alguien puede volcar sin querer.
 */
function fingerprint(config: ResolvedLlmConfig): string {
  return JSON.stringify([
    config.source,
    config.baseUrl,
    config.model,
    config.contextWindowTokens,
    createHash("sha256").update(config.apiKey).digest("hex"),
  ]);
}

export function createLlmSource(deps: LlmSourceDeps): LlmSource {
  const ttl = deps.ttlMs ?? LLM_REGISTRY_TTL_MS;
  const now = deps.nowMs ?? Date.now;
  const build = deps.build ?? ((config: ResolvedLlmConfig) => buildLlm(config));

  let cached: { readonly at: number; readonly snapshot: ModelRegistrySnapshot } | null =
    null;
  let lastGood: ModelRegistrySnapshot = { tasks: {} };
  let lastReadError: string | null = null;
  const built = new Map<string, Llm>();
  const announced = new Map<ModelTask, string>();

  async function snapshot(): Promise<ModelRegistrySnapshot> {
    const t = now();
    if (cached !== null && t - cached.at < ttl) return cached.snapshot;
    try {
      const read = await deps.registry.read();
      lastGood = read;
      lastReadError = null;
      cached = { at: t, snapshot: read };
      return read;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastReadError) {
        lastReadError = message;
        deps.logger.warn(
          { reason: message },
          "no se pudo leer el registro de modelos: sigo con la última lectura buena " +
            "(o con las LLM_* si nunca hubo una)",
        );
      }
      // Se cachea igual, para no reintentar el disco en cada llamada.
      cached = { at: t, snapshot: lastGood };
      return lastGood;
    }
  }

  return {
    async current(task: ModelTask): Promise<ResolvedLlm | null> {
      const config = resolveLlmConfig(task, await snapshot(), deps.legacy, deps.secrets);
      const key = config === null ? "none" : fingerprint(config);
      if (announced.get(task) !== key) {
        announced.set(task, key);
        if (config === null) {
          deps.logger.warn({ task }, "sin LLM configurado para esta tarea");
        } else {
          // Nunca la key: sólo de dónde salió, a dónde se habla y con qué modelo.
          deps.logger.info(
            {
              task,
              source: config.source,
              entry: config.entry,
              baseUrl: config.baseUrl,
              model: config.model,
            },
            "LLM en uso",
          );
        }
      }
      if (config === null) return null;
      let llm = built.get(key);
      if (llm === undefined) {
        // Cada cambio de configuración deja un adaptador viejo acá; un tope
        // chico evita que una sesión de pruebas en la pantalla los acumule.
        if (built.size >= 8) built.clear();
        llm = build(config);
        built.set(key, llm);
      }
      return { llm, config };
    },
  };
}

/**
 * Un `Llm` que resuelve en cada llamada. Es lo que reciben el sintetizador de
 * marca y el copywriter, así que un modelo nuevo en la pantalla les llega en
 * el próximo job sin reconstruir nada.
 *
 * Sin configuración, `provider_unavailable`: es reintentable, y el handler de
 * `brand-source-analysis` lo traduce a `llm_provider_unavailable`.
 */
export function createResolvingLlm(source: LlmSource, task: ModelTask): Llm {
  const resolve = async (): Promise<Llm> => {
    const found = await source.current(task);
    if (found === null) {
      throw new PortError("provider_unavailable", "No language model is configured", {
        source: "Llm/registry",
      });
    }
    return found.llm;
  };
  return {
    async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
      return (await resolve()).complete(request);
    },
    async completeJson(request: LlmJsonRequest): Promise<LlmJsonCompletion> {
      return (await resolve()).completeJson(request);
    },
  };
}
