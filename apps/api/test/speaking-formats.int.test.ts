/**
 * Sprint 8 (agente L) en la API: formatos con voz y character swap
 * (`P4-FORMAT-002`, `P4-INFL-011`, `AI-010`).
 *
 * Registro, gasto y corridas son archivos reales en un `FASTGRAM_HOME`
 * temporal. fal no se llama: estimar es el precio de lista del catálogo
 * verificado y generar lo hace el worker (`apps/worker/test/
 * speaking-formats.int.test.ts`). La biblioteca de modelos (agente K) se
 * prueba en unidad del lado de K; acá se usa un retrato del Media Bank.
 *
 * Lo que NO cubre: el camino con `characterModelId` contra la biblioteca real
 * (depende de la tabla de K) ni «Generate script» con un modelo de texto real.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JOB_QUEUES } from "@fastgram/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;
let home: string;
let previousHome: string | undefined;

const FAL = "https://queue.fal.run";
const KEY = "fal-shared-secret-key-0001";

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "fastgram-api-speaking-"));
  previousHome = process.env["FASTGRAM_HOME"];
  process.env["FASTGRAM_HOME"] = home;
  api = await startApi({ now: "2026-09-24T12:00:00.000Z" });
}, 180_000);

afterAll(async () => {
  await api?.close();
  if (previousHome === undefined) delete process.env["FASTGRAM_HOME"];
  else process.env["FASTGRAM_HOME"] = previousHome;
  if (home !== undefined) await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  api.queue.reset();
  await writeFile(
    join(home, "models.json"),
    JSON.stringify({
      version: 1,
      tasks: {
        video: {
          provider: "fal",
          baseUrl: FAL,
          model: "fal-ai/wan/v2.2-a14b/text-to-video",
          apiKey: KEY,
        },
        // Sin key propia: usan la de video (mismo origen).
        speech: {
          provider: "fal",
          baseUrl: FAL,
          model: "fal-ai/elevenlabs/tts/eleven-v3",
        },
        avatar: {
          provider: "fal",
          baseUrl: FAL,
          model: "fal-ai/bytedance/omnihuman/v1.5",
        },
        swap: {
          provider: "fal",
          baseUrl: FAL,
          model: "fal-ai/wan/v2.2-14b/animate/replace",
        },
      },
    }),
  );
  await rm(join(home, "spend.json"), { force: true });
  await rm(join(home, "speaking-runs"), { recursive: true, force: true });
});

async function seedMedia(
  companyId: string,
  type: "image" | "video",
  durationSec: number | null = null,
): Promise<string> {
  const ext = type === "image" ? "png" : "mp4";
  const key = `media/${companyId}/seed-${randomUUID()}.${ext}`;
  const rows = await api.handle.sql`
    insert into media (company_id, media_type, filename, r2_url, storage_key,
                       status, size_mb, categories, origin, video_duration_sec)
    values (${companyId}::uuid, ${type}, ${`seed.${ext}`},
            ${`http://localhost:9000/fastgram/${key}`}, ${key}, 'ready', 0.001,
            '{}'::text[], 'manual_upload', ${durationSec})
    returning media_id`;
  return (rows[0] as unknown as { media_id: string }).media_id;
}

function detail(res: Parameters<typeof errorOf>[0], key: string): unknown {
  return (errorOf(res).details as Record<string, unknown> | undefined)?.[key];
}

const SCRIPT = "Stop scrolling. This app saves me an hour every single day.";

describe("catálogo", () => {
  it("GET /ai-studio/formats: con voz, swap y dos bloqueados con motivo", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/ai-studio/formats" });
    expect(res.status).toBe(200);
    const formats = (
      dataOf(res) as { formats: { id: string; status: string; reason: string | null }[] }
    ).formats;
    const by = new Map(formats.map((f) => [f.id, f]));
    expect(by.get("talking-head-ugc")?.status).toBe("speaking");
    expect(by.get("character-swap")?.status).toBe("swap");
    expect(by.get("talking-objects")).toMatchObject({
      status: "blocked",
      reason: "needs_non_human_avatar",
    });
    expect(by.get("green-screen-mobile-app")?.reason).toBe("needs_screen_replacement");
  });

  it("GET /ai-studio/speaking/options: configurado con la key compartida, sin la key", async () => {
    const res = await api.request({
      method: "GET",
      path: "/api/v1/ai-studio/speaking/options",
    });
    expect(res.status).toBe(200);
    const body = dataOf(res) as {
      speech: { configured: boolean; models: { id: string; voices: string[] }[] };
      avatar: { configured: boolean; defaultModel: string };
      swap: { configured: boolean };
      durations: number[];
      scriptWriter: boolean;
    };
    expect(body.speech.configured).toBe(true);
    expect(body.speech.models.map((m) => m.id)).toContain(
      "fal-ai/elevenlabs/tts/eleven-v3",
    );
    expect(body.avatar).toMatchObject({
      configured: true,
      defaultModel: "fal-ai/bytedance/omnihuman/v1.5",
    });
    expect(body.swap.configured).toBe(true);
    expect(body.durations).toContain(60);
    expect(body.scriptWriter).toBe(false);
    expect(res.raw).not.toContain(KEY);
  });

  it("GET /models: las tareas de voz quedan listas con la key de video", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/models" });
    const tasks = (dataOf(res) as { tasks: { task: string; status: string }[] }).tasks;
    for (const t of ["speech", "avatar", "swap"]) {
      expect(tasks.find((x) => x.task === t)?.status).toBe("ready");
    }
    expect(res.raw).not.toContain(KEY);
  });

  it("PUT /models/speech exige un modelo del catálogo de voz", async () => {
    const bad = await api.request({
      method: "PUT",
      path: "/api/v1/models/speech",
      body: { provider: "fal", model: "fal-ai/flux/schnell" },
    });
    expect(bad.status).toBe(400);
    const ok = await api.request({
      method: "PUT",
      path: "/api/v1/models/speech",
      body: { provider: "fal", model: "fal-ai/minimax/speech-02-turbo" },
    });
    expect(ok.status).toBe(200);
  });
});

describe("formato con voz: estimar y arrancar", () => {
  it("estima voz + avatar con la guía de AI-010", async () => {
    const portraitMediaId = await seedMedia(api.data.a.companyId, "image");
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/speaking/talking-head-ugc/estimate",
      body: { script: SCRIPT, durationSeconds: 5, portraitMediaId },
    });
    expect(res.status).toBe(200);
    const est = dataOf(res) as {
      usd: number;
      voice: { estimate: { usd: number } };
      video: { estimate: { usd: number } };
      videoSeconds: number;
      guidance: { level: string; min: number; max: number };
      fits: boolean;
    };
    // 11 palabras → 6 s × $0.16 + 59 caracteres × $0.10/1000.
    expect(est.videoSeconds).toBe(6);
    expect(est.video.estimate.usd).toBeCloseTo(0.96);
    expect(est.voice.estimate.usd).toBeCloseTo(0.0059);
    expect(est.guidance).toMatchObject({ level: "ok", min: 10, max: 15 });
    expect(est.fits).toBe(true);
  });

  it("arranca: 202, job con speakingRunId, dos reservas y la corrida se lee (404 de otra marca)", async () => {
    const portraitMediaId = await seedMedia(api.data.a.companyId, "image");
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/speaking/news-anchor/runs",
      body: { script: SCRIPT, durationSeconds: 5, portraitMediaId, voiceId: "Aria" },
    });
    expect(res.status).toBe(202);
    const run = dataOf(res) as { id: string; stage: string; voice: { voiceId: string } };
    expect(run.stage).toBe("queued");
    expect(run.voice.voiceId).toBe("Aria");

    const jobs = api.queue.forQueue(JOB_QUEUES.aiStudioGeneration);
    expect(jobs.map((j) => j.payload)).toEqual([
      { companyId: api.data.a.companyId, speakingRunId: run.id },
    ]);
    const spend = JSON.parse(await readFile(join(home, "spend.json"), "utf8")) as {
      months: Record<string, Record<string, { state: string }>>;
    };
    expect(Object.keys(spend.months["2026-09"] ?? {}).sort()).toEqual(
      [`${run.id}:video`, `${run.id}:voice`].sort(),
    );

    const own = await api.request({
      method: "GET",
      path: `/api/v1/ai-studio/speaking-runs/${run.id}`,
    });
    expect(own.status).toBe(200);
    const cross = await api.request({
      method: "GET",
      path: `/api/v1/ai-studio/speaking-runs/${run.id}`,
      token: api.data.b.token,
    });
    expect(cross.status).toBe(404);
    const listB = await api.request({
      method: "GET",
      path: "/api/v1/ai-studio/speaking-runs",
      token: api.data.b.token,
    });
    expect(dataOf(listB)).toEqual([]);
  });

  it("un retrato de otra marca es 400 en el campo (no existe acá)", async () => {
    const other = await seedMedia(api.data.b.companyId, "image");
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/speaking/talking-head-ugc/estimate",
      body: { script: SCRIPT, durationSeconds: 5, portraitMediaId: other },
    });
    expect(res.status).toBe(400);
    expect(detail(res, "field")).toBe("portraitMediaId");
  });

  it("speaking-hook sin demo: 400 en demoMediaId; con demo: 200", async () => {
    const portraitMediaId = await seedMedia(api.data.a.companyId, "image");
    const bad = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/speaking/speaking-hook/estimate",
      body: { script: SCRIPT, durationSeconds: 5, portraitMediaId },
    });
    expect(bad.status).toBe(400);
    expect(detail(bad, "field")).toBe("demoMediaId");
    const demoMediaId = await seedMedia(api.data.a.companyId, "video", 8);
    const ok = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/speaking/speaking-hook/estimate",
      body: { script: SCRIPT, durationSeconds: 5, portraitMediaId, demoMediaId },
    });
    expect(ok.status).toBe(200);
  });

  it("un guion que pasa el tope del modelo es 400 en script; sin retrato, 400", async () => {
    const portraitMediaId = await seedMedia(api.data.a.companyId, "image");
    const long = Array(200).fill("word").join(" ");
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/speaking/talking-head-ugc/estimate",
      body: { script: long, durationSeconds: 60, portraitMediaId },
    });
    expect(res.status).toBe(400);
    expect(detail(res, "field")).toBe("script");
    const none = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/speaking/talking-head-ugc/estimate",
      body: { script: SCRIPT, durationSeconds: 5 },
    });
    expect(none.status).toBe(400);
  });

  it("sin modelo de texto, «Generate script» es 409 not_configured", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/speaking/talking-head-ugc/script",
      body: { durationSeconds: 10, topic: "late invoices" },
    });
    expect(res.status).toBe(409);
    expect(detail(res, "reason")).toBe("not_configured");
  });

  it("formatos que no son de voz: bloqueado 409, clip 404; la ruta de clip rechaza uno con voz", async () => {
    const blocked = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/speaking/talking-objects/estimate",
      body: { script: SCRIPT, durationSeconds: 5 },
    });
    expect(blocked.status).toBe(409);
    const clip = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/speaking/on-a-walk/estimate",
      body: { script: SCRIPT, durationSeconds: 5 },
    });
    expect(clip.status).toBe(404);
    const viaClip = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/formats/news-anchor/estimate",
      body: { overlayText: "x" },
    });
    expect(viaClip.status).toBe(409);
  });

  it("sin speech configurado: 409 con la tarea que falta", async () => {
    await writeFile(
      join(home, "models.json"),
      JSON.stringify({
        version: 1,
        tasks: {
          avatar: {
            provider: "fal",
            baseUrl: FAL,
            model: "fal-ai/bytedance/omnihuman/v1.5",
            apiKey: KEY,
          },
        },
      }),
    );
    const portraitMediaId = await seedMedia(api.data.a.companyId, "image");
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/speaking/talking-head-ugc/estimate",
      body: { script: SCRIPT, durationSeconds: 5, portraitMediaId },
    });
    expect(res.status).toBe(409);
    expect(detail(res, "task")).toBe("speech");
  });
});

describe("character swap", () => {
  it("estima por la duración del video; sin duración, 400", async () => {
    const portraitMediaId = await seedMedia(api.data.a.companyId, "image");
    const sourceMediaId = await seedMedia(api.data.a.companyId, "video", 5);
    const ok = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/swap/estimate",
      body: { sourceMediaId, portraitMediaId },
    });
    expect(ok.status).toBe(200);
    // 5 s × 60 fps (desconocido: el caro) ÷ 16 × $0.04 a 480p.
    expect((dataOf(ok) as { usd: number }).usd).toBeCloseTo(0.75);

    const unknown = await seedMedia(api.data.a.companyId, "video", null);
    const bad = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/swap/estimate",
      body: { sourceMediaId: unknown, portraitMediaId },
    });
    expect(bad.status).toBe(400);
    expect(detail(bad, "field")).toBe("sourceMediaId");
  });

  it("arranca: 202 y una sola reserva (video)", async () => {
    const portraitMediaId = await seedMedia(api.data.a.companyId, "image");
    const sourceMediaId = await seedMedia(api.data.a.companyId, "video", 4);
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/swap/runs",
      body: { sourceMediaId, portraitMediaId },
    });
    expect(res.status).toBe(202);
    const run = dataOf(res) as { id: string; kind: string };
    expect(run.kind).toBe("swap");
    const spend = JSON.parse(await readFile(join(home, "spend.json"), "utf8")) as {
      months: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(spend.months["2026-09"] ?? {})).toEqual([`${run.id}:video`]);
  });
});
