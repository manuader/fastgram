/**
 * `ClipTagger` sobre un endpoint de chat compatible con OpenAI con imágenes —
 * `PU-MEME-003`.
 *
 * ## El formato de las imágenes
 *
 * Verificado en la referencia de Chat Completions de OpenAI
 * (https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create,
 * 2026-09-24): un mensaje `user` lleva `content` como **lista de partes**; una
 * parte de imagen es `{ "type": "image_url", "image_url": { "url", "detail" } }`
 * y `url` puede ser una URL o **la imagen en base64 como data URL**
 * (`data:image/jpeg;base64,…`). `detail` acepta `low`, `high` y `auto`: se usa
 * `low` porque para decir «qué emoción hay» no hace falta resolución, y cada
 * imagen cuesta tokens.
 *
 * Base64 y no URL: los cuadros están en el temporal del worker, no en ningún
 * lado público, y un modelo local (Ollama) no alcanzaría a MinIO igual.
 *
 * ## Sin `response_format`
 *
 * No todos los compatibles lo aceptan igual (Ollama, Gemini y los gateways
 * difieren), y un 400 por un campo opcional apagaría el etiquetado entero. El
 * prompt pide el JSON y la salida pasa por el `parse` de `core`
 * (`parseClipTags`), que no confía en nada.
 *
 * La parte de dominio (prompts y validación) se inyecta: `adapters` no importa
 * `core`.
 */
import { PortError, type ClipTagger, type ClipTags } from "@fastgram/ports";

import type { FetchLike } from "../llm/openai-compatible.js";

const SOURCE = "ClipTagger/openai-vision";

export interface OpenAiVisionTaggerConfig {
  /** `…/chat/completions`, ya armado (`openAiEndpoint` de core). */
  readonly endpoint: string;
  /** Vacía = sin `Authorization` (Ollama, LM Studio). */
  readonly apiKey: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** Texto de la respuesta → etiquetas, o `null` si no cumple la forma. */
  readonly parse: (text: string) => ClipTags | null;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

interface ChatResponse {
  choices?: { message?: { content?: unknown } }[];
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export class OpenAiVisionTagger implements ClipTagger {
  readonly #config: OpenAiVisionTaggerConfig;
  readonly #fetch: FetchLike;

  constructor(config: OpenAiVisionTaggerConfig) {
    this.#config = config;
    this.#fetch = config.fetch ?? ((input, init) => fetch(input, init));
  }

  async tag(frames: readonly Uint8Array[]): Promise<ClipTags> {
    const c = this.#config;
    const body = JSON.stringify({
      model: c.model,
      temperature: 0,
      messages: [
        { role: "system", content: c.systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: c.userPrompt },
            ...frames.map((f) => ({
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${toBase64(f)}`, detail: "low" },
            })),
          ],
        },
      ],
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (c.apiKey.length > 0) headers["authorization"] = `Bearer ${c.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), c.timeoutMs ?? 90_000);
    let response: Response;
    try {
      response = await this.#fetch(c.endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } catch (cause) {
      throw new PortError(
        controller.signal.aborted ? "timeout" : "provider_unavailable",
        "The vision model did not answer",
        { source: SOURCE, cause },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const status = response.status;
      // El cuerpo del error no se lee ni se propaga: puede traer el prompt.
      const code =
        status === 401 || status === 403
          ? "unauthorized"
          : status === 429
            ? "rate_limited"
            : status === 404
              ? "not_found"
              : status >= 500
                ? "provider_unavailable"
                : "bad_request";
      throw new PortError(code, `The vision model answered HTTP ${status}`, {
        source: SOURCE,
      });
    }

    let parsed: ChatResponse;
    try {
      parsed = (await response.json()) as ChatResponse;
    } catch (cause) {
      throw new PortError(
        "provider_contract_violation",
        "The vision model returned invalid JSON",
        {
          source: SOURCE,
          cause,
        },
      );
    }
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new PortError(
        "provider_contract_violation",
        "The vision model returned no text",
        {
          source: SOURCE,
        },
      );
    }
    const tags = c.parse(content);
    if (tags === null) {
      throw new PortError(
        "provider_contract_violation",
        "The vision model did not return the requested labels",
        { source: SOURCE },
      );
    }
    return tags;
  }
}
