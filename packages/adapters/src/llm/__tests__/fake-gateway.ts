/**
 * Gateway OpenAI-compatible falso, para correr la suite de contrato de `Llm`
 * sin red y sin gastar tokens.
 *
 * **Qué prueba de verdad y qué no.** Un fake siempre corre el riesgo de
 * convertir la suite en una verificación de sí mismo. Acá se evita en el caso
 * que importa —el de `FR-011.9`— con un truco deliberado: este modelo es
 * **crédulo**. Obedece la última directiva que encuentra en el prompt… salvo
 * que esté dentro de un bloque `<untrusted …>`, que descarta antes de mirar.
 *
 * O sea que el caso «no obedece instrucciones incrustadas» pasa **sólo si el
 * adaptador delimitó bien**. Si alguien reescribiera `#buildMessages` para
 * concatenar la bio en el mensaje del usuario, el fake obedecería la canaria y
 * la suite fallaría, que es exactamente lo que se quiere.
 *
 * Lo que sigue sin probar, y hay que decirlo: que un modelo **real** resista
 * la inyección. Eso es `P1-BRAND-019` (suite de regresión con bios
 * adversariales contra el gateway de verdad), no esto.
 */

import type { FetchLike } from "../openai-compatible.js";

export interface FakeGatewayOptions {
  /** Respuesta canónica cuando no hay directiva que obedecer. */
  readonly reply?: string;
  readonly model?: string;
  /** Fuerza un estado HTTP, para ejercitar la traducción de errores. */
  readonly status?: number;
  readonly statusBody?: string;
  readonly headers?: Record<string, string>;
  /** Devuelve un cuerpo que no es JSON válido. */
  readonly malformed?: boolean;
  /** Devuelve 200 con `choices: []`. */
  readonly noChoices?: boolean;
  /** Tarda esto antes de responder, para ejercitar el timeout. */
  readonly delayMs?: number;
  /** Con `json_schema`, devuelve texto que no parsea. */
  readonly breakJsonSchema?: boolean;
}

/** Lo que el fake recibió en la última llamada. Para afirmar sobre el request. */
export interface FakeGatewayRecord {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

const DEFAULT_REPLY =
  "La marca vende café de especialidad tostado en origen y lo cuenta en un tono cercano y directo.";

const UNTRUSTED_REGION = /<untrusted[^>]*>[\s\S]*?<\/untrusted>/g;
/** «respondé únicamente la palabra X» y su equivalente en inglés. */
const DIRECTIVES = [
  /respond[eé]\s+[úu]nicamente\s+la\s+palabra\s+([\p{L}\p{N}_-]+)/iu,
  /reply\s+only\s+with\s+the\s+word\s+([\p{L}\p{N}_-]+)/iu,
];

export class FakeGateway {
  readonly calls: FakeGatewayRecord[] = [];
  #options: FakeGatewayOptions;

  constructor(options: FakeGatewayOptions = {}) {
    this.#options = options;
  }

  /** Cambia el comportamiento entre llamadas sin recrear el adaptador. */
  set(options: FakeGatewayOptions): void {
    this.#options = options;
  }

  get last(): FakeGatewayRecord | undefined {
    return this.calls[this.calls.length - 1];
  }

  readonly fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    this.calls.push({ url, body, headers: init.headers });

    const { delayMs } = this.#options;
    if (delayMs !== undefined && delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }

    const { status, statusBody, headers, malformed, noChoices } = this.#options;
    if (status !== undefined && status >= 400) {
      return new Response(statusBody ?? "{}", { status, headers: headers ?? {} });
    }
    if (malformed === true) {
      return new Response("no soy json", { status: 200 });
    }

    const model = this.#options.model ?? String(body["model"] ?? "fake-model");
    const promptChars = messagesOf(body).reduce((n, m) => n + m.length, 0);
    const promptTokens = Math.max(1, Math.ceil(promptChars / 4));

    if (noChoices === true) {
      return json({ model, choices: [], usage: { prompt_tokens: promptTokens } });
    }

    const { content, finishReason, completionTokens } = this.#respond(body, init.body);

    return json({
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
  };

  #respond(
    body: Record<string, unknown>,
    rawBody: string,
  ): { content: string; finishReason: string; completionTokens: number } {
    const format = body["response_format"];
    if (isJsonSchemaFormat(format)) {
      if (this.#options.breakJsonSchema === true) {
        return { content: "{ esto no parsea", finishReason: "stop", completionTokens: 5 };
      }
      // Decodificación restringida simulada: la salida se **construye** desde
      // el esquema, nunca se genera y se valida después. Es la diferencia que
      // ADR-009 marca entre una garantía y un parseo optimista.
      const schema = (format.json_schema as { schema?: unknown }).schema;
      // La semilla incluye el cuerpo entero del request, no sólo el esquema.
      // Es lo que hace que este fake sea **sensible al orden**, igual que un
      // modelo autorregresivo de verdad: mover una pregunta dentro del lote
      // cambia todas las probabilidades. Sin eso, el caso de contrato «el
      // orden del lote no cambia la respuesta» pasaría aunque el adaptador no
      // hiciera nada para garantizarlo.
      const value = fromSchema(schema, String(hash32(rawBody)));
      const content = JSON.stringify(value);
      return {
        content,
        finishReason: "stop",
        completionTokens: Math.max(1, Math.ceil(content.length / 4)),
      };
    }

    const reply = this.#obey(body) ?? this.#options.reply ?? DEFAULT_REPLY;
    const maxTokens = body["max_tokens"];
    const words = reply.split(/\s+/).filter((w) => w.length > 0);

    if (typeof maxTokens === "number" && words.length > maxTokens) {
      const cut = words.slice(0, maxTokens).join(" ");
      return { content: cut, finishReason: "length", completionTokens: maxTokens };
    }
    return {
      content: reply,
      finishReason: "stop",
      completionTokens: Math.max(1, words.length),
    };
  }

  /** El modelo crédulo. Ver el comentario de cabecera. */
  #obey(body: Record<string, unknown>): string | null {
    const trusted = messagesOf(body).join("\n").replaceAll(UNTRUSTED_REGION, " ");
    for (const directive of DIRECTIVES) {
      const match = directive.exec(trusted);
      const word = match?.[1];
      if (word !== undefined) return word;
    }
    return null;
  }
}

function messagesOf(body: Record<string, unknown>): string[] {
  const messages = body["messages"];
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    const content = (m as { content?: unknown }).content;
    return typeof content === "string" ? content : "";
  });
}

function isJsonSchemaFormat(
  value: unknown,
): value is { type: string; json_schema: Record<string, unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "json_schema" &&
    typeof (value as { json_schema?: unknown }).json_schema === "object"
  );
}

/**
 * Genera un valor que el esquema admite. Cubre lo que usa el producto.
 *
 * Los números en [0, 1] no salen en su mínimo sino repartidos, porque son
 * probabilidades y una distribución toda en cero no ejercita nada: el
 * `LlmJudgmentAdapter` la rechaza, con razón, antes de normalizar.
 */
function fromSchema(schema: unknown, path: string): unknown {
  if (typeof schema !== "object" || schema === null) return null;
  const s = schema as Record<string, unknown>;

  const enumValues = s["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues[hash32(path) % enumValues.length];
  }

  switch (s["type"]) {
    case "object": {
      const properties = (s["properties"] ?? {}) as Record<string, unknown>;
      const required = Array.isArray(s["required"])
        ? (s["required"] as string[])
        : Object.keys(properties);
      const out: Record<string, unknown> = {};
      for (const key of required) {
        out[key] = fromSchema(properties[key], `${path}.${key}`);
      }
      return out;
    }
    case "array": {
      const min = typeof s["minItems"] === "number" ? s["minItems"] : 0;
      return Array.from({ length: min }, (_, i) =>
        fromSchema(s["items"], `${path}[${String(i)}]`),
      );
    }
    case "integer":
      return typeof s["minimum"] === "number" ? s["minimum"] : 0;
    case "number": {
      const min = typeof s["minimum"] === "number" ? s["minimum"] : 0;
      const max = typeof s["maximum"] === "number" ? s["maximum"] : null;
      if (min === 0 && max === 1) {
        // Un valor en (0.05, 0.95): ni degenerado ni uniforme.
        return 0.05 + (hash32(path) / 0x1_0000_0000) * 0.9;
      }
      return min;
    }
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return "";
  }
}

/** FNV-1a de 32 bits. Sin dependencias: es un fake de test. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
