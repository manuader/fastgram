/**
 * `FalBirefnetBackgroundRemoval` contra un `fetch` que imita la cola de fal
 * **tal como la documenta** (https://fal.ai/docs/model-apis/model-endpoints/queue
 * y https://fal.ai/models/fal-ai/birefnet/v2/video/api, 2026-09-24). Ninguna
 * llamada real.
 */
import { describe, expect, it } from "vitest";
import { PortError } from "@fastgram/ports";

import { FalBirefnetBackgroundRemoval, type FalFetch } from "./fal-birefnet.js";

const BASE = "https://queue.fal.run";
const ENDPOINT = "fal-ai/birefnet/v2/video";
const KEY = "fal-key-0123456789";
const RID = "764cabcf-b745-4b3e-ae38-1200304cf45b";
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

function fakeFal(
  options: { statuses?: string[]; submitStatus?: number; statusUrl?: string } = {},
) {
  const calls: Call[] = [];
  const statuses = [...(options.statuses ?? ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"])];
  const fetch: FalFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    if (init.method === "POST" && url === `${BASE}/${ENDPOINT}`) {
      if (options.submitStatus !== undefined)
        return json({ detail: "x" }, options.submitStatus);
      // Forma documentada del submit.
      return json({
        request_id: RID,
        response_url: `${BASE}/fal-ai/birefnet/requests/${RID}`,
        status_url: options.statusUrl ?? `${BASE}/fal-ai/birefnet/requests/${RID}/status`,
        cancel_url: `${BASE}/fal-ai/birefnet/requests/${RID}/cancel`,
        queue_position: 0,
      });
    }
    if (url.endsWith("/status")) {
      return json({ status: statuses.shift() ?? "COMPLETED", request_id: RID });
    }
    if (url === `${BASE}/fal-ai/birefnet/requests/${RID}`) {
      // Forma documentada de la salida del endpoint de video.
      return json({
        video: {
          url: "https://v3.fal.media/files/abc/out.webm",
          content_type: "video/webm",
          file_name: "out.webm",
          width: 720,
          height: 1280,
          fps: 30,
          duration: 3,
          num_frames: 90,
        },
      });
    }
    if (url === "https://v3.fal.media/files/abc/out.webm") {
      return new Response(WEBM, {
        status: 200,
        headers: { "content-length": String(WEBM.length) },
      });
    }
    return json({}, 404);
  };
  return { fetch, calls };
}

const remover = (fetch: FalFetch) =>
  new FalBirefnetBackgroundRemoval({
    baseUrl: BASE,
    endpoint: ENDPOINT,
    apiKey: KEY,
    fetch,
    sleep: async () => {},
    readFile: async () => new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
  });

describe("FalBirefnetBackgroundRemoval", () => {
  it("submit con data URI y VP9, poll hasta COMPLETED, resultado y descarga", async () => {
    const { fetch, calls } = fakeFal();
    const out = await remover(fetch).remove({
      path: "/tmp/x.mp4",
      contentType: "video/mp4",
    });
    expect(out).toEqual({
      kind: "alpha_video",
      body: WEBM,
      contentType: "video/webm",
      extension: "webm",
    });

    const submit = calls[0];
    expect(submit?.url).toBe(`${BASE}/${ENDPOINT}`);
    expect(submit?.headers["authorization"]).toBe(`Key ${KEY}`);
    const body = JSON.parse(submit?.body ?? "{}") as Record<string, unknown>;
    expect(body["video_output_type"]).toBe("VP9 (.webm)");
    expect(String(body["video_url"])).toMatch(/^data:video\/mp4;base64,/);

    // Tres consultas de estado, en la URL que devolvió el submit.
    expect(calls.filter((c) => c.url.endsWith("/status"))).toHaveLength(3);
    // La descarga del CDN va sin la key.
    const download = calls.at(-1);
    expect(download?.url).toBe("https://v3.fal.media/files/abc/out.webm");
    expect(download?.headers["authorization"]).toBeUndefined();
  });

  it("no manda la key a un status_url de otro origen", async () => {
    const { fetch, calls } = fakeFal({ statusUrl: "https://evil.example/status" });
    await expect(
      remover(fetch).remove({ path: "/tmp/x.mp4", contentType: "video/mp4" }),
    ).rejects.toMatchObject({ code: "provider_contract_violation" });
    expect(calls.some((c) => c.url.startsWith("https://evil.example"))).toBe(false);
  });

  it("401 del submit → unauthorized, sin el cuerpo", async () => {
    const { fetch } = fakeFal({ submitStatus: 401 });
    const error = await remover(fetch)
      .remove({ path: "/tmp/x.mp4", contentType: "video/mp4" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortError);
    expect((error as PortError).code).toBe("unauthorized");
    expect((error as PortError).message).not.toContain(KEY);
  });

  it("un estado desconocido es violación de contrato", async () => {
    const { fetch } = fakeFal({ statuses: ["IN_QUEUE", "EXPLODED"] });
    await expect(
      remover(fetch).remove({ path: "/tmp/x.mp4", contentType: "video/mp4" }),
    ).rejects.toMatchObject({ code: "provider_contract_violation" });
  });

  it("vencido el plazo, timeout", async () => {
    const { fetch } = fakeFal({ statuses: Array.from({ length: 50 }, () => "IN_QUEUE") });
    let t = 0;
    const r = new FalBirefnetBackgroundRemoval({
      baseUrl: BASE,
      endpoint: ENDPOINT,
      apiKey: KEY,
      fetch,
      sleep: async () => {},
      readFile: async () => new Uint8Array([1]),
      timeoutMs: 10,
      now: () => (t += 5),
    });
    await expect(
      r.remove({ path: "/x", contentType: "video/mp4" }),
    ).rejects.toMatchObject({
      code: "timeout",
    });
  });
});
