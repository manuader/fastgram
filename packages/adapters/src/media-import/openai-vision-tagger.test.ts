import { describe, expect, it } from "vitest";
import type { ClipTags } from "@fastgram/ports";

import type { FetchLike } from "../llm/openai-compatible.js";
import { OpenAiVisionTagger } from "./openai-vision-tagger.js";

const TAGS: ClipTags = {
  emotion: "shocked",
  situation: "sees bill",
  people: 1,
  tags: ["money"],
};

function tagger(fetch: FetchLike, apiKey = "sk-test-0123456789") {
  return new OpenAiVisionTagger({
    endpoint: "https://gateway.example/v1/chat/completions",
    apiKey,
    model: "some/vision-model",
    systemPrompt: "SYSTEM",
    userPrompt: "USER",
    parse: (text) => (text.includes("shocked") ? TAGS : null),
    fetch,
  });
}

describe("OpenAiVisionTagger", () => {
  it("manda las imágenes como partes image_url con data URL base64", async () => {
    let sent: { url: string; headers: Record<string, string>; body: string } | null =
      null;
    const fetch: FetchLike = async (url, init) => {
      sent = { url, headers: init.headers, body: init.body };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(TAGS) } }] }),
        { status: 200 },
      );
    };
    const out = await tagger(fetch).tag([
      new Uint8Array([0xff, 0xd8, 0xff]),
      new Uint8Array([1]),
    ]);
    expect(out).toEqual(TAGS);
    expect(sent).not.toBeNull();
    const s = sent as unknown as {
      url: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(s.url).toBe("https://gateway.example/v1/chat/completions");
    expect(s.headers["authorization"]).toBe("Bearer sk-test-0123456789");
    const body = JSON.parse(s.body) as {
      model: string;
      messages: { role: string; content: unknown }[];
    };
    expect(body.model).toBe("some/vision-model");
    const user = body.messages[1];
    expect(user?.role).toBe("user");
    expect(user?.content).toEqual([
      { type: "text", text: "USER" },
      {
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,/9j/", detail: "low" },
      },
      {
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,AQ==", detail: "low" },
      },
    ]);
  });

  it("sin key no manda Authorization (Ollama)", async () => {
    let headers: Record<string, string> = {};
    const fetch: FetchLike = async (_u, init) => {
      headers = init.headers;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "shocked" } }] }),
      );
    };
    await tagger(fetch, "").tag([new Uint8Array([1])]);
    expect(headers["authorization"]).toBeUndefined();
  });

  it("traduce errores HTTP y salidas que no cumplen", async () => {
    const status =
      (n: number): FetchLike =>
      async () =>
        new Response("prompt echo", { status: n });
    await expect(tagger(status(401)).tag([])).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(tagger(status(429)).tag([])).rejects.toMatchObject({
      code: "rate_limited",
    });
    await expect(tagger(status(400)).tag([])).rejects.toMatchObject({
      code: "bad_request",
    });
    const junk: FetchLike = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "no sé" } }] }));
    await expect(tagger(junk).tag([])).rejects.toMatchObject({
      code: "provider_contract_violation",
    });
  });
});
