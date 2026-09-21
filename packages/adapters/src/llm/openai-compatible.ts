/**
 * Adaptador `Llm` sobre un gateway compatible con la API de OpenAI — ADR-009.
 *
 * ADR-009 elige «un gateway compatible con la API de OpenAI, apuntando a
 * modelos de pesos abiertos» por portabilidad y costo, y `COST-MODEL.md` §5.3
 * le pone el número: `gpt-oss-120b` cotiza **al centavo idéntico** en Groq,
 * Fireworks y Together. Esa es toda la razón de que este adaptador sirva para
 * los tres.
 *
 * **Ni el modelo ni el precio están en este archivo, y no es un olvido.**
 * ADR-009 lo prohíbe explícitamente —«no se fijan modelos ni precios: cambian
 * mes a mes»— y `COST-MODEL.md` §5 se declara *«válida al 2026-09-21 y no
 * después»*. El modelo entra por {@link OpenAiCompatibleLlmConfig.model}, que
 * es `LLM_MODEL` en `.env.example`. Un default en el código volvería a atar la
 * evaluación fechada de `P1-JUDGE-006` a un deploy.
 *
 * **`contextWindowTokens` también es configuración, por el mismo motivo**: es
 * una propiedad del modelo elegido, no del adaptador. Sin ella no se puede
 * cumplir el caso de contrato «un prompt por encima de la ventana es
 * `bad_request`», y el valor correcto cambia cada vez que cambia `LLM_MODEL`.
 *
 * ## Lo que este adaptador NO verifica
 *
 * Que el gateway aplique de verdad la decodificación restringida. `COST-MODEL`
 * §5.2 lo tiene verificado para DeepInfra, Together y vLLM, y **`[UNKNOWN]`
 * para Fireworks y Groq**. Acá se pide `response_format: json_schema` con
 * `strict: true` y, si lo que vuelve no parsea, se traduce a
 * `provider_contract_violation` — que es el síntoma de que el gateway no la
 * está aplicando. Es detección, no garantía.
 */

import {
  PortError,
  type Llm,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmFinishReason,
  type LlmJsonCompletion,
  type LlmJsonRequest,
  type LlmMessage,
} from "@fastgram/ports";
import { renderUntrusted } from "./untrusted.js";

const SOURCE = "Llm/openai-compatible";

/** El `fetch` global alcanza; entra por config para poder testear sin red. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface OpenAiCompatibleLlmConfig {
  /** `LLM_BASE_URL`. Con o sin `/v1` final: se normaliza. */
  readonly baseUrl: string;
  /** `LLM_API_KEY`. Nunca se loguea ni sale en un `PortError`. */
  readonly apiKey: string;
  /** `LLM_MODEL`. Ver la nota de arriba: no hay default. */
  readonly model: string;
  /**
   * Ventana del modelo. Propiedad de `model`, así que viaja con él.
   * `COST-MODEL.md` §5 no publica ventanas: hay que tomarla de la ficha del
   * gateway al elegir el modelo.
   */
  readonly contextWindowTokens: number;
  readonly defaultTimeoutMs?: number;
  readonly fetch?: FetchLike;
}

/**
 * Caracteres por token, para estimar si el prompt entra.
 *
 * Es una **estimación**, no un conteo: contar de verdad exige el tokenizador
 * del modelo, y ADR-009 hace que el modelo cambie por variable de entorno —
 * un tokenizador incrustado sería justo lo que el ADR evita. 4 es la regla de
 * pulgar habitual para texto latino; para CJK subestima.
 *
 * Por eso la estimación **sólo sirve para rechazar lo evidentemente grande**.
 * Un prompt que se pasa por poco lo va a rechazar el gateway con un 400, que
 * también se traduce a `bad_request`. Los dos caminos llegan al mismo código,
 * que es lo que el contrato promete.
 */
const CHARS_PER_TOKEN = 4;

export class OpenAiCompatibleLlm implements Llm {
  readonly #config: OpenAiCompatibleLlmConfig;
  readonly #fetch: FetchLike;
  readonly #endpoint: string;

  constructor(config: OpenAiCompatibleLlmConfig) {
    if (config.baseUrl.length === 0) {
      throw new PortError("bad_request", "LLM base URL is not configured", {
        source: SOURCE,
      });
    }
    if (config.model.length === 0) {
      throw new PortError("bad_request", "LLM model is not configured", {
        source: SOURCE,
      });
    }
    this.#config = config;
    this.#fetch = config.fetch ?? ((input, init) => fetch(input, init));
    const base = config.baseUrl.replace(/\/+$/, "");
    this.#endpoint = base.endsWith("/v1")
      ? `${base}/chat/completions`
      : `${base}/v1/chat/completions`;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    const messages = this.#buildMessages(request.messages, request.untrusted);
    this.#assertFitsContext(messages);

    const body = this.#baseBody(request, messages);
    const { json, latencyMs } = await this.#call(body, request.timeoutMs);
    const choice = firstChoice(json);

    return {
      text: typeof choice.message?.content === "string" ? choice.message.content : "",
      ...finishFields(choice),
      usage: usageOf(json),
      model:
        typeof json.model === "string" && json.model.length > 0
          ? json.model
          : this.#config.model,
      deterministic: request.seed !== undefined && json.system_fingerprint !== undefined,
      latencyMs,
    };
  }

  async completeJson(request: LlmJsonRequest): Promise<LlmJsonCompletion> {
    const messages = this.#buildMessages(request.messages, request.untrusted);
    this.#assertFitsContext(messages);

    const body = {
      ...this.#baseBody(request, messages),
      // ADR-009: restringida, no sugerida. `strict: true` es lo que la
      // distingue de `json_object`, que sólo pide «que sea JSON».
      response_format: {
        type: "json_schema",
        json_schema: {
          name: request.schemaName,
          schema: request.schema,
          strict: true,
        },
      },
    };

    const { json, latencyMs } = await this.#call(body, request.timeoutMs);
    const choice = firstChoice(json);
    const raw = typeof choice.message?.content === "string" ? choice.message.content : "";

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (cause) {
      // Con decodificación restringida esto no debería poder pasar. Que pase
      // significa que el gateway no la está aplicando — ver `COST-MODEL` §5.2,
      // donde Fireworks y Groq figuran como `[UNKNOWN]`.
      throw new PortError(
        "provider_contract_violation",
        "The model returned a response that is not valid JSON",
        { source: SOURCE, cause },
      );
    }

    return {
      value,
      raw,
      ...finishFields(choice),
      usage: usageOf(json),
      model:
        typeof json.model === "string" && json.model.length > 0
          ? json.model
          : this.#config.model,
      deterministic: request.seed !== undefined && json.system_fingerprint !== undefined,
      latencyMs,
    };
  }

  /* -------------------------------------------------------------------- */

  #buildMessages(
    messages: readonly LlmMessage[],
    untrusted: LlmCompletionRequest["untrusted"],
  ): LlmMessage[] {
    const out = [...messages];
    const block = renderUntrusted(untrusted);
    if (block !== null) {
      // Va **después** de la instrucción del producto, no antes: el último
      // mensaje es el que el modelo pondera más, y lo que tiene que pesar más
      // es la tarea, no el material de terceros.
      out.push({ role: "user", content: block });
    }
    return out;
  }

  #assertFitsContext(messages: readonly LlmMessage[]): void {
    let chars = 0;
    for (const message of messages) chars += message.content.length;
    const estimated = Math.ceil(chars / CHARS_PER_TOKEN);
    if (estimated > this.#config.contextWindowTokens) {
      throw new PortError(
        "bad_request",
        `The prompt is too large for the configured model (about ${String(estimated)} tokens, limit ${String(this.#config.contextWindowTokens)})`,
        { source: SOURCE },
      );
    }
  }

  #baseBody(
    request: LlmCompletionRequest | LlmJsonRequest,
    messages: readonly LlmMessage[],
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model ?? this.#config.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (request.temperature !== undefined) body["temperature"] = request.temperature;
    if (request.topP !== undefined) body["top_p"] = request.topP;
    if (request.maxOutputTokens !== undefined) {
      body["max_tokens"] = request.maxOutputTokens;
    }
    if (request.stop !== undefined) body["stop"] = [...request.stop];
    if (request.seed !== undefined) body["seed"] = request.seed;
    return body;
  }

  async #call(
    body: Record<string, unknown>,
    timeoutMs: number | undefined,
  ): Promise<{ json: ChatResponse; latencyMs: number }> {
    const started = Date.now();
    const effectiveTimeout = timeoutMs ?? this.#config.defaultTimeoutMs;
    const controller = new AbortController();
    const timer =
      effectiveTimeout === undefined
        ? undefined
        : setTimeout(() => {
            controller.abort();
          }, effectiveTimeout);

    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      throw translateTransport(cause, controller.signal.aborted);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (!response.ok) {
      throw await translateHttp(response);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new PortError(
        "provider_contract_violation",
        "The model gateway returned a malformed response",
        { source: SOURCE, cause },
      );
    }

    return { json: json as ChatResponse, latencyMs: Date.now() - started };
  }
}

/* ------------------------------------------------------------------------ *
 * Forma de la respuesta del gateway
 * ------------------------------------------------------------------------ */

interface ChatChoice {
  readonly message?: { readonly content?: unknown };
  readonly finish_reason?: unknown;
  readonly content_filter_results?: unknown;
}

interface ChatResponse {
  readonly choices?: readonly ChatChoice[];
  readonly model?: unknown;
  readonly system_fingerprint?: unknown;
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
  };
}

function firstChoice(json: ChatResponse): ChatChoice {
  const choice = json.choices?.[0];
  if (choice === undefined) {
    throw new PortError(
      "provider_contract_violation",
      "The model gateway returned no choices",
      { source: SOURCE },
    );
  }
  return choice;
}

function usageOf(json: ChatResponse): { inputTokens: number; outputTokens: number } {
  const input = json.usage?.prompt_tokens;
  const output = json.usage?.completion_tokens;
  return {
    inputTokens: typeof input === "number" ? input : 0,
    outputTokens: typeof output === "number" ? output : 0,
  };
}

/**
 * `finishReason` y, si corresponde, su causa.
 *
 * Se devuelve como objeto y no como dos campos porque
 * `exactOptionalPropertyTypes` impide asignar `undefined` a
 * `contentFilterCause?: string`: la propiedad tiene que **no estar**.
 */
function finishFields(
  choice: ChatChoice,
):
  | { finishReason: LlmFinishReason }
  | { finishReason: LlmFinishReason; contentFilterCause: string } {
  const raw = typeof choice.finish_reason === "string" ? choice.finish_reason : "stop";
  if (raw === "length") return { finishReason: "length" };
  if (raw === "content_filter") {
    // `NFR-018` exige mensajes diferenciados por causa. Si el gateway no la
    // dice, se devuelve una etiqueta neutral en vez de omitir el campo: quien
    // llama mapea a copy y necesita algo con qué hacerlo.
    return {
      finishReason: "content_filter",
      contentFilterCause: contentFilterCauseOf(choice) ?? "unspecified",
    };
  }
  // `stop`, `tool_calls`, `function_call` y lo que el gateway invente caen en
  // `stop`: el enum del puerto es cerrado y no puede crecer con cada proveedor.
  return { finishReason: "stop" };
}

function contentFilterCauseOf(choice: ChatChoice): string | null {
  const results = choice.content_filter_results;
  if (typeof results !== "object" || results === null) return null;
  const flagged: string[] = [];
  for (const [category, detail] of Object.entries(results as Record<string, unknown>)) {
    if (
      typeof detail === "object" &&
      detail !== null &&
      (detail as { filtered?: unknown }).filtered === true
    ) {
      flagged.push(category);
    }
  }
  return flagged.length > 0 ? flagged.sort().join(",") : null;
}

/* ------------------------------------------------------------------------ *
 * Traducción de errores — PRD §10, `NFR-022`
 * ------------------------------------------------------------------------ */

/**
 * Los mensajes de acá cruzan hacia el cliente (`PortError.toPublic`), así que
 * son neutrales a propósito: nunca el nombre del gateway, nunca su texto. El
 * error original viaja en `cause`, que sólo llega al log.
 */
async function translateHttp(response: Response): Promise<PortError> {
  const status = response.status;
  // Se lee el cuerpo sólo para el `cause`. Que falle no cambia el código.
  const cause = await response.text().catch(() => "");

  if (status === 401 || status === 403) {
    return new PortError("unauthorized", "The model gateway rejected the credentials", {
      source: SOURCE,
      cause,
    });
  }
  if (status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    // Un 429 puede ser ritmo o saldo. `insufficient_quota` es la convención
    // de la API de OpenAI y la copian los gateways compatibles; si está, es
    // `quota_exceeded`, que el API traduce a 402 y no a 429.
    if (typeof cause === "string" && cause.includes("insufficient_quota")) {
      return new PortError("quota_exceeded", "The model gateway quota is exhausted", {
        source: SOURCE,
        cause,
      });
    }
    return new PortError(
      "rate_limited",
      "The model gateway is rate limiting requests",
      retryAfter === null
        ? { source: SOURCE, cause }
        : { source: SOURCE, cause, retryAfterSeconds: retryAfter },
    );
  }
  if (status === 402) {
    return new PortError("quota_exceeded", "The model gateway quota is exhausted", {
      source: SOURCE,
      cause,
    });
  }
  if (status === 408 || status === 504) {
    return new PortError("timeout", "The model gateway timed out", {
      source: SOURCE,
      cause,
    });
  }
  if (status >= 500) {
    return new PortError("provider_unavailable", "The model gateway is unavailable", {
      source: SOURCE,
      cause,
    });
  }
  if (status === 404) {
    // Modelo inexistente o ruta mal configurada. Es `bad_request` y no
    // `not_found`: `not_found` en el contrato público significa «el recurso
    // que pediste no existe», y el cliente no pidió un modelo.
    return new PortError("bad_request", "The configured model is not available", {
      source: SOURCE,
      cause,
    });
  }
  return new PortError("bad_request", "The model gateway rejected the request", {
    source: SOURCE,
    cause,
  });
}

function translateTransport(cause: unknown, aborted: boolean): PortError {
  if (aborted) {
    return new PortError("timeout", "The model gateway timed out", {
      source: SOURCE,
      cause,
    });
  }
  return new PortError("provider_unavailable", "The model gateway is unreachable", {
    source: SOURCE,
    cause,
  });
}

function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  // La forma de fecha HTTP también es válida y algunos gateways la usan.
  const at = Date.parse(header);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}
