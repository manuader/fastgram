/**
 * `ModelCatalog` contra cualquier endpoint compatible con OpenAI —
 * `PU-MODEL-001` y `PU-MODEL-002` (la pantalla lo usa para «listar modelos» y
 * «probar conexión»).
 *
 * Dos llamadas del estándar y nada más:
 *
 *  - `GET {baseUrl}/models` → la lista que devuelve el proveedor. Es de donde
 *    sale el id del modelo en la pantalla, que es la forma de no tener ninguno
 *    fijo en el código (ADR-009).
 *  - `POST {baseUrl}/chat/completions` con `max_tokens: 1` → la prueba mínima
 *    de que base URL + key + modelo funcionan juntos. Cuesta un token de
 *    salida; es lo más barato que confirma los tres.
 *
 * Las URLs se arman con la convención del SDK de OpenAI (base + recurso), no
 * con la de `OpenAiCompatibleLlm` (que agrega `/v1`): ver `openAiEndpoint` en
 * `packages/core/src/models/config.ts` para el porqué. La función se repite
 * acá porque `adapters` no depende de `core`.
 *
 * ## Lo que se tolera de cada proveedor
 *
 * - Ollama devuelve `{"object":"list","data":null}` sin modelos bajados
 *   (visto el 2026-09-24 contra un Ollama local): es una lista vacía, no un
 *   error.
 * - La ventana del modelo se toma **sólo si el proveedor la publica**:
 *   `context_length` (OpenRouter) o `context_window` (Groq). No se deduce.
 *
 * Los errores se traducen igual que en `OpenAiCompatibleLlm`, con mensajes
 * neutrales: el texto del proveedor va al `cause`, que sólo llega al log.
 */
import {
  PortError,
  type ConnectionTestResult,
  type ListedModel,
  type ModelCatalog,
  type ModelEndpoint,
} from "@fastgram/ports";

const SOURCE = "ModelCatalog/openai-compatible";

/** Como el `FetchLike` del LLM, pero también con `GET` sin cuerpo. */
export type CatalogFetch = (
  input: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface OpenAiModelCatalogConfig {
  /**
   * Presupuesto por llamada. Obligatorio: el default correcto depende de
   * quién espera (la API detrás del proxy de `apps/web` tiene su propio corte).
   */
  readonly timeoutMs: number;
  readonly fetch?: CatalogFetch;
}

const endpoint = (baseUrl: string, path: "models" | "chat/completions"): string =>
  `${baseUrl.trim().replace(/\/+$/, "")}/${path}`;

export class OpenAiModelCatalog implements ModelCatalog {
  readonly #timeoutMs: number;
  readonly #fetch: CatalogFetch;

  constructor(config: OpenAiModelCatalogConfig) {
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) {
      throw new PortError("bad_request", "timeoutMs must be a positive integer", {
        source: SOURCE,
      });
    }
    this.#timeoutMs = config.timeoutMs;
    this.#fetch = config.fetch ?? ((input, init) => fetch(input, init));
  }

  async listModels(target: ModelEndpoint): Promise<readonly ListedModel[]> {
    const json = await this.#call(endpoint(target.baseUrl, "models"), {
      method: "GET",
      headers: headers(target.apiKey),
    });
    if (typeof json !== "object" || json === null) throw malformed("not an object");
    const data = (json as { data?: unknown }).data;
    // Ollama sin modelos: `data: null`.
    if (data === null || data === undefined) return [];
    if (!Array.isArray(data)) throw malformed("data is not an array");

    const out: ListedModel[] = [];
    for (const item of data as unknown[]) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      const id = record["id"];
      if (typeof id !== "string" || id.length === 0) continue;
      const window =
        positiveInt(record["context_length"]) ?? positiveInt(record["context_window"]);
      const ownedBy = record["owned_by"];
      out.push({
        id,
        ...(window === null ? {} : { contextWindowTokens: window }),
        ...(typeof ownedBy === "string" && ownedBy.length > 0 ? { ownedBy } : {}),
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async testConnection(
    target: ModelEndpoint & { readonly model: string },
  ): Promise<ConnectionTestResult> {
    const started = Date.now();
    const json = await this.#call(endpoint(target.baseUrl, "chat/completions"), {
      method: "POST",
      headers: { ...headers(target.apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: target.model,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 1,
      }),
    });
    const latencyMs = Date.now() - started;
    if (typeof json !== "object" || json === null) throw malformed("not an object");
    const choices = (json as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) throw malformed("no choices");
    const model = (json as { model?: unknown }).model;
    return {
      model: typeof model === "string" && model.length > 0 ? model : target.model,
      latencyMs,
    };
  }

  async #call(
    url: string,
    init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url, { ...init, signal: controller.signal });
    } catch (cause) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new PortError("timeout", "The model provider did not answer in time", {
          source: SOURCE,
          cause,
        });
      }
      throw new PortError("provider_unavailable", "Could not reach the model provider", {
        source: SOURCE,
        cause,
      });
    }

    try {
      if (!response.ok) throw await translateHttp(response);
      try {
        return await response.json();
      } catch (cause) {
        throw new PortError(
          "provider_contract_violation",
          "The endpoint did not answer like an OpenAI-compatible API",
          { source: SOURCE, cause },
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function headers(apiKey: string | undefined): Record<string, string> {
  const out: Record<string, string> = { Accept: "application/json" };
  if (apiKey !== undefined && apiKey.length > 0)
    out["Authorization"] = `Bearer ${apiKey}`;
  return out;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function malformed(why: string): PortError {
  return new PortError(
    "provider_contract_violation",
    "The endpoint did not answer like an OpenAI-compatible API",
    { source: SOURCE, cause: why },
  );
}

async function translateHttp(response: Response): Promise<PortError> {
  const status = response.status;
  const cause = await response.text().catch(() => "");
  const opts = {
    source: SOURCE,
    cause: `HTTP ${String(status)}: ${cause.slice(0, 500)}`,
  };

  if (status === 401 || status === 403) {
    return new PortError("unauthorized", "The model provider rejected the API key", opts);
  }
  if (status === 404) {
    return new PortError(
      "not_found",
      "The model provider does not know that model or endpoint",
      opts,
    );
  }
  if (status === 402 || (status === 429 && cause.includes("insufficient_quota"))) {
    return new PortError(
      "quota_exceeded",
      "The model provider account is out of credit",
      opts,
    );
  }
  if (status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    return new PortError(
      "rate_limited",
      "The model provider is rate limiting requests",
      Number.isFinite(retryAfter) && retryAfter > 0
        ? { ...opts, retryAfterSeconds: retryAfter }
        : opts,
    );
  }
  if (status === 408 || status === 504) {
    return new PortError("timeout", "The model provider timed out", opts);
  }
  if (status >= 500) {
    return new PortError(
      "provider_unavailable",
      "The model provider is unavailable",
      opts,
    );
  }
  return new PortError("bad_request", "The model provider rejected the request", opts);
}
