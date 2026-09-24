/**
 * `FalClient` contra un `fetch` que contesta lo que documenta
 * `https://fal.ai/docs/documentation/model-apis/inference/queue` (2026-09-24):
 * el envío con `request_id`/`status_url`/`response_url`, los estados
 * `IN_QUEUE`/`IN_PROGRESS`/`COMPLETED`, el resultado de FLUX con
 * `has_nsfw_concepts`, el `content_policy_violation` de `/model-apis/errors`
 * y el 429 de `/model-apis/concurrency-limits`. Ninguna llamada real.
 */
import { describe, expect, it } from "vitest";
import { isPortError, type GenJobHandle } from "@fastgram/ports";

import type { GenFetch } from "../genai/http.js";
import { FalClient } from "./client.js";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
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

const BASE = "https://queue.fal.run";
const RID = "764cabcf-b745-4b3e-ae38-1200304cf45b";
const ACCEPTED = {
  request_id: RID,
  response_url: `${BASE}/fal-ai/flux/schnell/requests/${RID}/response`,
  status_url: `${BASE}/fal-ai/flux/schnell/requests/${RID}/status`,
  cancel_url: `${BASE}/fal-ai/flux/schnell/requests/${RID}/cancel`,
  queue_position: 0,
};
const HANDLE: GenJobHandle = {
  requestId: RID,
  statusUrl: ACCEPTED.status_url,
  responseUrl: ACCEPTED.response_url,
};

const client = (fetch: GenFetch) =>
  new FalClient({ baseUrl: BASE, apiKey: "fal-key", fetch, timeoutMs: 1000 });

async function portCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (isPortError(e)) return e.code;
    throw e;
  }
  throw new Error("expected a PortError");
}

describe("FalClient — enviar", () => {
  it("POST queue.fal.run/{endpoint_id}, Key auth, image_size explícito y num_images", async () => {
    const { fetch, seen } = fake(() => json(200, ACCEPTED));
    const sub = await client(fetch).generateImage({
      model: "fal-ai/flux/schnell",
      prompt: "a sunset over mountains",
      aspectRatio: "9:16",
      n: 2,
    });
    expect(seen[0]?.url).toBe(`${BASE}/fal-ai/flux/schnell`);
    expect(seen[0]?.headers["Authorization"]).toBe("Key fal-key");
    expect(seen[0]?.body).toEqual({
      prompt: "a sunset over mountains",
      image_size: { width: 720, height: 1280 },
      num_images: 2,
    });
    expect(sub).toEqual({ kind: "accepted", handle: HANDLE });
  });

  it("Wan 2.2: num_frames = 16 × s + 1 y 480p; Kling: duration como cadena", async () => {
    const { fetch, seen } = fake(() => json(200, ACCEPTED));
    const c = client(fetch);
    await c.generateVideo({
      model: "fal-ai/wan/v2.2-a14b/text-to-video",
      prompt: "waves",
      aspectRatio: "9:16",
      durationSeconds: 5,
    });
    expect(seen[0]?.body).toEqual({
      prompt: "waves",
      num_frames: 81,
      resolution: "480p",
      aspect_ratio: "9:16",
    });
    await c.generateVideo({
      model: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
      prompt: "move",
      imageUrl: "https://example.com/a.png",
      aspectRatio: "9:16",
      durationSeconds: 10,
    });
    expect(seen[1]?.body).toEqual({
      prompt: "move",
      image_url: "https://example.com/a.png",
      duration: "10",
    });
  });

  it("422 content_policy_violation al enviar = rechazo nsfw, no excepción", async () => {
    const { fetch } = fake(() =>
      json(422, {
        detail: [
          {
            loc: ["body", "prompt"],
            msg: "The content could not be processed",
            type: "content_policy_violation",
            url: "https://docs.fal.ai/errors#content_policy_violation",
          },
        ],
      }),
    );
    const sub = await client(fetch).generateImage({
      model: "fal-ai/flux/schnell",
      prompt: "x",
      aspectRatio: "1:1",
    });
    expect(sub.kind).toBe("rejected");
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [422, "bad_request"],
    [429, "rate_limited"],
    [500, "provider_unavailable"],
    [503, "provider_unavailable"],
    [504, "timeout"],
  ])("HTTP %s → %s", async (status, code) => {
    const { fetch } = fake(() =>
      json(
        status,
        status === 429
          ? { detail: "Concurrency limit", error_type: "concurrent_requests_limit" }
          : { detail: [{ loc: ["body"], msg: "nope", type: "x" }] },
        status === 429 ? { "X-Fal-Needs-Retry": "1" } : {},
      ),
    );
    expect(
      await portCode(
        client(fetch).generateImage({
          model: "fal-ai/flux/schnell",
          prompt: "x",
          aspectRatio: "1:1",
        }),
      ),
    ).toBe(code);
  });
});

describe("FalClient — polling y resultado", () => {
  it("IN_QUEUE → IN_PROGRESS → COMPLETED y lee response_url", async () => {
    const answers = [
      json(200, { status: "IN_QUEUE", request_id: RID, queue_position: 2 }),
      json(200, { status: "IN_PROGRESS", request_id: RID, logs: [] }),
      json(200, {
        status: "COMPLETED",
        request_id: RID,
        response_url: ACCEPTED.response_url,
        metrics: { inference_time: 3.42 },
      }),
      json(200, {
        images: [
          {
            url: "https://v3.fal.media/files/rabbit/abc123.png",
            width: 1024,
            height: 1024,
            content_type: "image/png",
          },
        ],
        prompt: "a sunset over mountains",
        seed: 42,
        has_nsfw_concepts: [false],
      }),
    ];
    const { fetch, seen } = fake((_, i) => answers[i] ?? json(500, {}));
    const c = client(fetch);
    expect((await c.poll(HANDLE)).status).toBe("queued");
    expect((await c.poll(HANDLE)).status).toBe("in_progress");
    expect(await c.poll(HANDLE)).toEqual({
      status: "completed",
      outputs: [
        { url: "https://v3.fal.media/files/rabbit/abc123.png", contentType: "image/png" },
      ],
    });
    expect(seen.map((s) => s.url)).toEqual([
      ACCEPTED.status_url,
      ACCEPTED.status_url,
      ACCEPTED.status_url,
      ACCEPTED.response_url,
    ]);
  });

  it("descarta las imágenes marcadas; si son todas, el resultado es nsfw", async () => {
    const answers = [
      json(200, { status: "COMPLETED", request_id: RID }),
      json(200, {
        images: [
          { url: "https://v3.fal.media/a.jpg" },
          { url: "https://v3.fal.media/b.jpg" },
        ],
        has_nsfw_concepts: [true, false],
      }),
      json(200, { status: "COMPLETED", request_id: RID }),
      json(200, {
        images: [{ url: "https://v3.fal.media/a.jpg" }],
        has_nsfw_concepts: [true],
      }),
    ];
    const { fetch } = fake((_, i) => answers[i] ?? json(500, {}));
    const c = client(fetch);
    expect((await c.poll(HANDLE)).outputs).toEqual([
      { url: "https://v3.fal.media/b.jpg" },
    ]);
    expect((await c.poll(HANDLE)).status).toBe("nsfw");
  });

  it("COMPLETED con error = failed; resultado 422 content_policy = nsfw", async () => {
    const failed = fake(() =>
      json(200, {
        status: "COMPLETED",
        request_id: RID,
        error: "Request timed out",
        error_type: "request_timeout",
      }),
    );
    expect(await client(failed.fetch).poll(HANDLE)).toEqual({
      status: "failed",
      outputs: [],
      message: "Request timed out",
    });

    const answers = [
      json(200, { status: "COMPLETED", request_id: RID }),
      json(422, {
        detail: [{ loc: ["body"], msg: "flagged", type: "content_policy_violation" }],
      }),
    ];
    const nsfw = fake((_, i) => answers[i] ?? json(500, {}));
    expect((await client(nsfw.fetch).poll(HANDLE)).status).toBe("nsfw");
  });

  it("un 5xx del resultado se relanza (reintentable), no se marca fallido", async () => {
    const answers = [json(200, { status: "COMPLETED", request_id: RID }), json(503, {})];
    const { fetch } = fake((_, i) => answers[i] ?? json(500, {}));
    expect(await portCode(client(fetch).poll(HANDLE))).toBe("provider_unavailable");
  });

  it("video: video.url", async () => {
    const answers = [
      json(200, { status: "COMPLETED", request_id: RID }),
      json(200, {
        video: { url: "https://v3.fal.media/v.mp4", content_type: "video/mp4" },
      }),
    ];
    const { fetch } = fake((_, i) => answers[i] ?? json(500, {}));
    expect((await client(fetch).poll(HANDLE)).outputs).toEqual([
      { url: "https://v3.fal.media/v.mp4", contentType: "video/mp4" },
    ]);
  });
});

describe("FalClient — precio de lista (estimación)", () => {
  it("FLUX schnell: MP × $0.003", async () => {
    const { fetch, seen } = fake(() => json(500, {}));
    const est = await client(fetch).estimateImage({
      model: "fal-ai/flux/schnell",
      prompt: "x",
      aspectRatio: "1:1",
      n: 4,
    });
    // 4 × 1.048576 MP × 0.003 = 0.01258…
    expect(est.usd).toBeCloseTo(0.0126, 4);
    expect(est.source).toBe("price_list");
    expect(est.sourceUrl).toContain("fal.ai/models/fal-ai/flux/schnell");
    expect(seen).toHaveLength(0);
  });

  it("Wan 480p: (16 s + 1)/16 × $0.04; Kling: $0.35 + $0.07 por segundo extra", async () => {
    const { fetch } = fake(() => json(500, {}));
    const c = client(fetch);
    const wan = await c.estimateVideo({
      model: "fal-ai/wan/v2.2-a14b/text-to-video",
      prompt: "x",
      aspectRatio: "9:16",
      durationSeconds: 5,
    });
    expect(wan.usd).toBeCloseTo(0.2025, 4);
    const kling = await c.estimateVideo({
      model: "fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
      prompt: "x",
      aspectRatio: "9:16",
      durationSeconds: 10,
    });
    expect(kling.usd).toBeCloseTo(0.7, 4);
  });

  it("checkCredentials: GET api.fal.ai/v1/models/pricing con la key", async () => {
    const { fetch, seen } = fake(() =>
      json(200, {
        prices: [
          {
            endpoint_id: "fal-ai/flux/schnell",
            unit_price: 0.003,
            unit: "megapixels",
            currency: "USD",
          },
        ],
        next_cursor: null,
        has_more: false,
      }),
    );
    const out = await client(fetch).checkCredentials("fal-ai/flux/schnell");
    expect(out.probe).toBe("pricing endpoint");
    expect(seen[0]?.url).toBe(
      "https://api.fal.ai/v1/models/pricing?endpoint_id=fal-ai%2Fflux%2Fschnell",
    );
    expect(seen[0]?.headers["Authorization"]).toBe("Key fal-key");
  });
});
