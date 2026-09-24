/**
 * `HiggsfieldClient` contra un `fetch` que contesta **exactamente lo que
 * documenta** https://docs.higgsfield.ai (2026-09-24): el envío de
 * `/docs/concepts/requests`, el estado de
 * `/docs/api-reference/requests/get-request-status`, el estimador de
 * `/docs/concepts/billing-and-retention` y los errores de
 * `/docs/concepts/errors` y `/docs/concepts/rate-limits`. Ninguna llamada real.
 */
import { describe, expect, it } from "vitest";
import { isPortError, type GenJobHandle } from "@fastgram/ports";

import type { GenFetch } from "../genai/http.js";
import { HiggsfieldClient } from "./client.js";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function fake(respond: (req: Seen, i: number) => Response): {
  fetch: GenFetch;
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
        ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }),
      };
      seen.push(req);
      return Promise.resolve(respond(req, seen.length - 1));
    },
  };
}

const BASE = "https://api.higgsfield.ai";
const RID = "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff";
const ACCEPTED = {
  status: "queued",
  request_id: RID,
  status_url: `${BASE}/requests/${RID}/status`,
  cancel_url: `${BASE}/requests/${RID}/cancel`,
};

const client = (fetch: GenFetch) =>
  new HiggsfieldClient({ baseUrl: BASE, apiKey: "KEYID:SECRET", fetch, timeoutMs: 1000 });

async function portCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (isPortError(e)) return e.code;
    throw e;
  }
  throw new Error("expected a PortError");
}

describe("HiggsfieldClient — enviar", () => {
  it("POST {base}/{endpoint_id} con Authorization: Key id:secret y el cuerpo del modelo", async () => {
    const { fetch, seen } = fake(() => json(200, ACCEPTED));
    const sub = await client(fetch).generateImage({
      model: "higgsfield-ai/soul/v2/standard",
      prompt: "a vase",
      aspectRatio: "9:16",
      n: 4,
    });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe(`${BASE}/higgsfield-ai/soul/v2/standard`);
    expect(seen[0]?.headers["Authorization"]).toBe("Key KEYID:SECRET");
    expect(seen[0]?.body).toEqual({
      prompt: "a vase",
      aspect_ratio: "9:16",
      batch_size: 4,
    });
    expect(sub).toEqual({
      kind: "accepted",
      handle: { requestId: RID, statusUrl: ACCEPTED.status_url },
    });
  });

  it("video: kling 2.6 t2v con duration, aspect y sound off", async () => {
    const { fetch, seen } = fake(() => json(200, ACCEPTED));
    await client(fetch).generateVideo({
      model: "kling-video/v2.6/pro/text-to-video",
      prompt: "waves",
      aspectRatio: "9:16",
      durationSeconds: 10,
    });
    expect(seen[0]?.url).toBe(`${BASE}/kling-video/v2.6/pro/text-to-video`);
    expect(seen[0]?.body).toEqual({
      prompt: "waves",
      duration: 10,
      aspect_ratio: "9:16",
      sound: "off",
    });
  });

  it("rechaza sin llamar: modelo fuera del catálogo, relación o cantidad no documentadas", async () => {
    const { fetch, seen } = fake(() => json(200, ACCEPTED));
    const c = client(fetch);
    expect(
      await portCode(
        c.generateImage({ model: "made/up", prompt: "x", aspectRatio: "1:1" }),
      ),
    ).toBe("bad_request");
    expect(
      await portCode(
        c.generateImage({
          model: "higgsfield-ai/soul/v2/standard",
          prompt: "x",
          aspectRatio: "4:5",
        }),
      ),
    ).toBe("bad_request");
    expect(
      await portCode(
        c.generateImage({
          model: "higgsfield-ai/soul/v2/standard",
          prompt: "x",
          aspectRatio: "1:1",
          n: 2,
        }),
      ),
    ).toBe("bad_request");
    expect(
      await portCode(
        c.generateVideo({
          model: "kling-video/v2.6/pro/image-to-video",
          prompt: "x",
          aspectRatio: "9:16",
          durationSeconds: 5,
        }),
      ),
    ).toBe("bad_request");
    expect(seen).toHaveLength(0);
  });

  it("no manda la credencial a un status_url de otro origen", async () => {
    const { fetch } = fake(() =>
      json(200, { ...ACCEPTED, status_url: "https://evil.example/requests/x/status" }),
    );
    expect(
      await portCode(
        client(fetch).generateImage({
          model: "z-image/turbo",
          prompt: "x",
          aspectRatio: "1:1",
        }),
      ),
    ).toBe("provider_contract_violation");
  });

  it("la credencial tiene que ser KEY_ID:KEY_SECRET", () => {
    const { fetch } = fake(() => json(200, {}));
    expect(
      () => new HiggsfieldClient({ baseUrl: BASE, apiKey: "solo-id", fetch }),
    ).toThrow(/KEY_ID:KEY_SECRET/);
  });
});

describe("HiggsfieldClient — polling", () => {
  const handle: GenJobHandle = { requestId: RID, statusUrl: ACCEPTED.status_url };

  it("queued → in_progress → completed con images[].url", async () => {
    const answers = [
      { status: "queued", request_id: RID },
      { status: "in_progress", request_id: RID },
      {
        status: "completed",
        request_id: RID,
        images: [
          { url: "https://cdn.example.com/image-1.jpg" },
          { url: "https://cdn.example.com/image-2.jpg" },
        ],
      },
    ];
    const { fetch, seen } = fake((_, i) => json(200, answers[i]));
    const c = client(fetch);
    expect((await c.poll(handle)).status).toBe("queued");
    expect((await c.poll(handle)).status).toBe("in_progress");
    const done = await c.poll(handle);
    expect(done).toEqual({
      status: "completed",
      outputs: [
        { url: "https://cdn.example.com/image-1.jpg" },
        { url: "https://cdn.example.com/image-2.jpg" },
      ],
    });
    expect(seen.every((s) => s.method === "GET" && s.url === ACCEPTED.status_url)).toBe(
      true,
    );
  });

  it("completed de video: video.url", async () => {
    const { fetch } = fake(() =>
      json(200, {
        status: "completed",
        request_id: RID,
        video: { url: "https://cdn.example.com/video.mp4" },
      }),
    );
    expect((await client(fetch).poll(handle)).outputs).toEqual([
      { url: "https://cdn.example.com/video.mp4" },
    ]);
  });

  it("failed con error y nsfw son estados, no excepciones", async () => {
    const failed = fake(() =>
      json(200, { status: "failed", request_id: RID, error: "Generation failed" }),
    );
    expect(await client(failed.fetch).poll(handle)).toEqual({
      status: "failed",
      outputs: [],
      message: "Generation failed",
    });
    const nsfw = fake(() => json(200, { status: "nsfw", request_id: RID }));
    const state = await client(nsfw.fetch).poll(handle);
    expect(state.status).toBe("nsfw");
    expect(state.message).toMatch(/moderation/);
  });

  it("un estado desconocido es provider_contract_violation", async () => {
    const { fetch } = fake(() => json(200, { status: "weird", request_id: RID }));
    expect(await portCode(client(fetch).poll(handle))).toBe(
      "provider_contract_violation",
    );
  });
});

describe("HiggsfieldClient — estimador", () => {
  it("POST {base}/estimate/{endpoint_id} con el mismo cuerpo; usd y credits vienen como cadenas", async () => {
    const { fetch, seen } = fake(() => json(200, { credits: "1.500", usd: "0.094" }));
    const est = await client(fetch).estimateImage({
      model: "higgsfield-ai/soul/v2/standard",
      prompt: "Editorial portrait in soft daylight",
      aspectRatio: "1:1",
    });
    expect(seen[0]?.url).toBe(`${BASE}/estimate/higgsfield-ai/soul/v2/standard`);
    expect(seen[0]?.body).toEqual({
      prompt: "Editorial portrait in soft daylight",
      aspect_ratio: "1:1",
      batch_size: 1,
    });
    expect(est).toMatchObject({ usd: 0.094, credits: 1.5, source: "provider" });
  });

  it("checkCredentials usa el estimador (no genera)", async () => {
    const { fetch, seen } = fake(() => json(200, { credits: "1", usd: "0.06" }));
    const out = await client(fetch).checkCredentials("z-image/turbo");
    expect(out.probe).toBe("estimate endpoint");
    expect(seen[0]?.url).toBe(`${BASE}/estimate/z-image/turbo`);
  });
});

describe("HiggsfieldClient — errores documentados", () => {
  it.each([
    [401, { detail: "Invalid credentials" }, "unauthorized"],
    [403, { detail: "Not enough credits" }, "quota_exceeded"],
    [404, { detail: "Not found" }, "not_found"],
    [422, { detail: [{ msg: "field required" }] }, "bad_request"],
    [423, { detail: "Model is blocked" }, "provider_unavailable"],
    [503, { detail: "Model disabled" }, "provider_unavailable"],
    [500, { detail: "boom" }, "provider_unavailable"],
    [
      400,
      { detail: "Maximum number of concurrent requests (4) has been reached" },
      "rate_limited",
    ],
    [400, { detail: "Invalid aspect ratio" }, "bad_request"],
    [429, { detail: "Too many" }, "rate_limited"],
  ])("HTTP %s → %s", async (status, body, code) => {
    const { fetch } = fake(() => json(status, body));
    expect(
      await portCode(
        client(fetch).generateImage({
          model: "z-image/turbo",
          prompt: "x",
          aspectRatio: "1:1",
        }),
      ),
    ).toBe(code);
  });

  it("el cuerpo del proveedor no llega al mensaje público", async () => {
    const { fetch } = fake(() =>
      json(401, { detail: "Invalid credentials KEYID:SECRET" }),
    );
    try {
      await client(fetch).poll({ requestId: RID, statusUrl: ACCEPTED.status_url });
      throw new Error("expected failure");
    } catch (e) {
      expect(isPortError(e)).toBe(true);
      if (isPortError(e)) expect(JSON.stringify(e.toPublic())).not.toContain("SECRET");
    }
  });

  it("red caída → provider_unavailable", async () => {
    const fetch: GenFetch = () => Promise.reject(new Error("ECONNREFUSED"));
    expect(
      await portCode(
        client(fetch).poll({ requestId: RID, statusUrl: ACCEPTED.status_url }),
      ),
    ).toBe("provider_unavailable");
  });
});
