import { describe, expect, it } from "vitest";
import { isPortError } from "@fastgram/ports";

import { OpenAiModelCatalog, type CatalogFetch } from "./openai-model-catalog.js";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(respond: (req: Seen) => Response): {
  fetch: CatalogFetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: (url, init) => {
      const req: Seen = {
        url,
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      };
      seen.push(req);
      return Promise.resolve(respond(req));
    },
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("OpenAiModelCatalog.listModels", () => {
  it("GET {base}/models, con la convención del SDK (Gemini termina en /)", async () => {
    const { fetch, seen } = fakeFetch(() => json(200, { object: "list", data: [] }));
    const catalog = new OpenAiModelCatalog({ timeoutMs: 1000, fetch });
    await catalog.listModels({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      apiKey: "k",
    });
    expect(seen[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/models",
    );
    expect(seen[0]?.headers["Authorization"]).toBe("Bearer k");
  });

  it("sin key no manda Authorization", async () => {
    const { fetch, seen } = fakeFetch(() => json(200, { data: [] }));
    await new OpenAiModelCatalog({ timeoutMs: 1000, fetch }).listModels({
      baseUrl: "http://localhost:11434/v1",
    });
    expect(seen[0]?.headers["Authorization"]).toBeUndefined();
  });

  it("Ollama sin modelos devuelve data: null → lista vacía", async () => {
    const { fetch } = fakeFetch(() => json(200, { object: "list", data: null }));
    await expect(
      new OpenAiModelCatalog({ timeoutMs: 1000, fetch }).listModels({
        baseUrl: "http://localhost:11434/v1",
      }),
    ).resolves.toEqual([]);
  });

  it("toma la ventana sólo si el proveedor la publica, y ordena", async () => {
    const { fetch } = fakeFetch(() =>
      json(200, {
        data: [
          { id: "z-model", context_window: 131072, owned_by: "x" },
          { id: "a-model", context_length: 8192 },
          { id: "m-model" },
          { nope: true },
        ],
      }),
    );
    const models = await new OpenAiModelCatalog({ timeoutMs: 1000, fetch }).listModels({
      baseUrl: "https://x.example/v1",
    });
    expect(models).toEqual([
      { id: "a-model", contextWindowTokens: 8192 },
      { id: "m-model" },
      { id: "z-model", contextWindowTokens: 131072, ownedBy: "x" },
    ]);
  });

  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not_found"],
    [402, "quota_exceeded"],
    [429, "rate_limited"],
    [503, "provider_unavailable"],
    [504, "timeout"],
    [400, "bad_request"],
  ] as const)(
    "HTTP %i → %s, sin el texto del proveedor en el mensaje",
    async (status, code) => {
      const { fetch } = fakeFetch(() =>
        json(status, { error: { message: "secret detail" } }),
      );
      const error = await new OpenAiModelCatalog({ timeoutMs: 1000, fetch })
        .listModels({ baseUrl: "https://x.example/v1", apiKey: "k" })
        .catch((e: unknown) => e);
      expect(isPortError(error) && error.code).toBe(code);
      expect(isPortError(error) && error.message).not.toContain("secret detail");
    },
  );

  it("no conectar es provider_unavailable", async () => {
    const catalog = new OpenAiModelCatalog({
      timeoutMs: 1000,
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    const error = await catalog
      .listModels({ baseUrl: "http://localhost:1/v1" })
      .catch((e: unknown) => e);
    expect(isPortError(error) && error.code).toBe("provider_unavailable");
  });

  it("no contestar a tiempo es timeout", async () => {
    const catalog = new OpenAiModelCatalog({
      timeoutMs: 10,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });
    const error = await catalog
      .listModels({ baseUrl: "http://localhost:1/v1" })
      .catch((e: unknown) => e);
    expect(isPortError(error) && error.code).toBe("timeout");
  });

  it("una página HTML no es una API compatible", async () => {
    const { fetch } = fakeFetch(() => new Response("<html></html>", { status: 200 }));
    const error = await new OpenAiModelCatalog({ timeoutMs: 1000, fetch })
      .listModels({ baseUrl: "https://x.example" })
      .catch((e: unknown) => e);
    expect(isPortError(error) && error.code).toBe("provider_contract_violation");
  });
});

describe("OpenAiModelCatalog.testConnection", () => {
  it("una llamada mínima a chat/completions con el modelo pedido", async () => {
    const { fetch, seen } = fakeFetch(() =>
      json(200, {
        model: "qwen2.5:7b-instruct",
        choices: [{ message: { content: "OK" } }],
      }),
    );
    const result = await new OpenAiModelCatalog({
      timeoutMs: 1000,
      fetch,
    }).testConnection({
      baseUrl: "http://localhost:11434/v1/",
      model: "qwen2.5:7b-instruct",
    });
    expect(seen[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({
      model: "qwen2.5:7b-instruct",
      max_tokens: 1,
    });
    expect(result.model).toBe("qwen2.5:7b-instruct");
  });
});
