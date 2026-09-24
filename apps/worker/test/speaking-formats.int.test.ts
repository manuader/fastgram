/**
 * Formatos con voz y character swap en el worker — sprint 8 (agente L),
 * `P4-FORMAT-002`, `P4-INFL-011`.
 *
 * El handler real (`src/formats/speaking.ts`) contra Postgres real, con la
 * corrida creada por el caso de uso real de `core` (`startSpeakingRun`). fal
 * es un doble con guion; el storage, el de memoria; la cola, una que anota.
 *
 * Lo que se mide:
 *  · voz → storage → avatar con **data URIs** (retrato y voz) → Media Bank →
 *    pieza con el id de la corrida, la voz como `audio` y el build encolado en
 *    la transacción; las dos reservas quedan cobradas;
 *  · el layout con demo arma un `video-hook` con el avatar arriba;
 *  · una reentrega con la voz ya aceptada **no la vuelve a pedir**;
 *  · una voz más larga que el tope del modelo de video no manda el avatar:
 *    voz cobrada, video liberado;
 *  · un avatar rechazado por contenido: `nsfw`, voz cobrada, video liberado;
 *  · el character swap manda el retrato y el video de origen y arma la pieza.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileModelRegistry,
  FixedClock,
  JsonFileCollection,
  JsonFileDocument,
  MemoryStorage,
} from "@fastgram/adapters";
import {
  CONTENT_BUILD_QUEUE,
  parseSpeakingRunRecord,
  parseSpendLedger,
  speakingSpendIds,
  startSpeakingRun,
  startSwapRun,
  type SpeakingRunJob,
} from "@fastgram/core";
import { brandKitStore, withCompany, type DbHandle } from "@fastgram/db";
import type {
  EnqueuedJob,
  GenSubmission,
  JobSpec,
  Queue,
  SpeechModelSpec,
  TalkingAvatarModelSpec,
  VoiceJobState,
} from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import { createSpeakingRunHandler, type VoiceClient } from "../src/formats/speaking.js";
import { Semaphore } from "../src/genai/semaphore.js";
import { openDb, seedCompany } from "./helpers/fixtures.js";

const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = "2026-09-24T12:00:00.000Z";
const MONTH = "2026-09";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const MP3 = new Uint8Array([73, 68, 51, 4, 0, 0]);
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
const FAL = "https://queue.fal.run";

const speechSpec: SpeechModelSpec = {
  id: "fal-ai/elevenlabs/tts/eleven-v3",
  label: "Eleven v3",
  maxChars: 5000,
  voices: ["Rachel", "Aria"],
  defaultVoice: "Rachel",
  languageCode: true,
  docsUrl: "https://fal.ai",
  listPrice: null,
};
const avatarSpec: TalkingAvatarModelSpec = {
  id: "fal-ai/bytedance/omnihuman/v1.5",
  label: "OmniHuman",
  resolutions: [
    { id: "720p", maxAudioSeconds: 60 },
    { id: "1080p", maxAudioSeconds: 30 },
  ],
  promptSupported: true,
  docsUrl: "https://fal.ai",
  listPrice: null,
};

let handle: DbHandle;
let home: string;

beforeAll(() => {
  handle = openDb();
});
afterAll(async () => {
  await handle?.close();
});
beforeEach(async () => {
  if (home !== undefined) await rm(home, { recursive: true, force: true });
  home = await mkdtemp(join(tmpdir(), "fastgram-speaking-"));
});

class RecordingQueue {
  readonly jobs: { spec: JobSpec<unknown>; inTx: boolean }[] = [];
  queue(): Queue {
    return {
      enqueue: <T>(spec: JobSpec<T>): Promise<EnqueuedJob> => {
        this.jobs.push({
          spec: spec as JobSpec<unknown>,
          inTx: spec.options?.transaction !== undefined,
        });
        return Promise.resolve({ jobId: randomUUID(), created: true } as EnqueuedJob);
      },
    } as unknown as Queue;
  }
}

interface FakeFal {
  readonly client: VoiceClient;
  readonly calls: { speech: number; avatar: unknown[]; swap: unknown[] };
}

function fakeFal(
  options: { avatarSubmit?: GenSubmission; billedSeconds?: number } = {},
): FakeFal {
  const calls = { speech: 0, avatar: [] as unknown[], swap: [] as unknown[] };
  const accepted = (kind: string): GenSubmission => ({
    kind: "accepted",
    handle: {
      requestId: kind,
      statusUrl: `${FAL}/${kind}/status`,
      responseUrl: `${FAL}/${kind}/response`,
    },
  });
  const client: VoiceClient = {
    provider: "fal",
    speechModels: () => [speechSpec],
    avatarModels: () => [avatarSpec],
    swapModels: () => [],
    estimateAvatar: (r) =>
      Promise.resolve({
        usd: Math.ceil(r.audioSeconds) * 0.16,
        source: "price_list",
        basis: "test",
      }),
    generateSpeech: () => {
      calls.speech += 1;
      return Promise.resolve(accepted("voice"));
    },
    generateAvatar: (r) => {
      calls.avatar.push(r);
      return Promise.resolve(options.avatarSubmit ?? accepted("avatar"));
    },
    generateSwap: (r) => {
      calls.swap.push(r);
      return Promise.resolve(accepted("swap"));
    },
    pollVoice: (h): Promise<VoiceJobState> =>
      Promise.resolve(
        h.requestId === "voice"
          ? {
              status: "completed",
              output: { url: "https://fal.media/voice.mp3", contentType: "audio/mpeg" },
            }
          : {
              status: "completed",
              output: { url: "https://fal.media/out.mp4", contentType: "video/mp4" },
              ...(options.billedSeconds === undefined
                ? {}
                : { billedSeconds: options.billedSeconds }),
            },
      ),
  };
  return { client, calls };
}

interface Setup {
  readonly companyId: string;
  readonly runId: string;
  readonly runs: JsonFileCollection;
  readonly ledger: JsonFileDocument;
  readonly storage: MemoryStorage;
  readonly queue: RecordingQueue;
  readonly registry: FileModelRegistry;
}

async function base(): Promise<Omit<Setup, "runId">> {
  const companyId = await seedCompany(handle);
  const registry = new FileModelRegistry({ path: join(home, "models.json") });
  await registry.write("video", {
    provider: "fal",
    baseUrl: FAL,
    model: "fal-ai/wan/v2.2-a14b/text-to-video",
    apiKey: "fal-key-123456789",
  });
  // Sin key propia: usan la de video (mismo origen).
  for (const [task, model] of [
    ["speech", speechSpec.id],
    ["avatar", avatarSpec.id],
    ["swap", "fal-ai/wan/v2.2-14b/animate/replace"],
  ] as const) {
    await registry.write(task, { provider: "fal", baseUrl: FAL, model });
  }
  const storage = new MemoryStorage(new FixedClock(new Date(NOW)));
  await storage.put({
    key: `media/${companyId}/portrait.png`,
    body: PNG,
    contentType: "image/png",
  });
  return {
    companyId,
    runs: new JsonFileCollection(join(home, "speaking-runs")),
    ledger: new JsonFileDocument(join(home, "spend.json")),
    storage,
    queue: new RecordingQueue(),
    registry,
  };
}

async function insertVideoRow(companyId: string, key: string): Promise<string> {
  await withCompany(handle.db, companyId, async (tx) => {
    const scope = { companyId };
    await brandKitStore.lockCompanyBrandKit(tx, scope);
    await brandKitStore.insertBrandKitMedia(tx, scope, [
      {
        mediaType: "video",
        filename: "demo.mp4",
        r2Url: `https://storage.test/${key}`,
        storageKey: key,
        sizeMb: 1,
        videoDurationSec: 8,
        categories: ["demo"],
      },
    ]);
  });
  // Después del commit: otra conexión recién ve la fila.
  const rows = await handle.sql<{ media_id: string }[]>`
    select media_id::text from media where storage_key = ${key}
  `;
  const id = rows[0]?.media_id;
  if (id === undefined) throw new Error("demo row missing");
  return id;
}

async function speakingSetup(
  over: { formatId?: string; demo?: boolean } = {},
): Promise<Setup> {
  const b = await base();
  let demo = null;
  if (over.demo === true) {
    const key = `media/${b.companyId}/demo.mp4`;
    await b.storage.put({ key, body: MP4, contentType: "video/mp4" });
    const mediaId = await insertVideoRow(b.companyId, key);
    demo = { mediaId, url: `https://storage.test/${key}`, storageKey: key };
  }
  const jobs: SpeakingRunJob[] = [];
  const r = await startSpeakingRun(
    {
      now: () => new Date(NOW),
      newId: () => randomUUID(),
      env: {},
      ledger: b.ledger,
      runs: b.runs,
      enqueue: (job) => {
        jobs.push(job);
        return Promise.resolve();
      },
      speechTask: () =>
        Promise.resolve({
          provider: "fal",
          defaultModel: speechSpec.id,
          models: [speechSpec],
        }),
      avatarTask: () =>
        Promise.resolve({
          provider: "fal",
          defaultModel: avatarSpec.id,
          models: [avatarSpec],
        }),
      estimateSpeech: () =>
        Promise.resolve({ usd: 0.01, source: "price_list", basis: "t" }),
      estimateAvatar: (req) =>
        Promise.resolve({
          usd: Math.ceil(req.audioSeconds) * 0.16,
          source: "price_list",
          basis: "t",
        }),
    },
    {
      companyId: b.companyId,
      formatId: over.formatId ?? "talking-head-ugc",
      script: "Stop scrolling. This app saves me an hour every single day.",
      durationSeconds: 5,
      voice: { model: speechSpec.id, voiceId: "Aria" },
      portrait: {
        mediaId: null,
        url: "https://storage.test/unused",
        storageKey: `media/${b.companyId}/portrait.png`,
      },
      demo,
      source: "studio",
    },
  );
  if (!r.ok) throw new Error(`start failed: ${JSON.stringify(r)}`);
  return { ...b, runId: r.run.id };
}

function handler(s: Setup, fal: FakeFal, probe: number | null = 6) {
  const h = createSpeakingRunHandler({
    db: handle.db,
    storage: s.storage,
    logger: silencioso,
    queue: s.queue.queue(),
    registry: s.registry,
    secrets: {},
    runs: s.runs,
    ledger: s.ledger,
    clientFor: () => fal.client,
    semaphoreFor: () => new Semaphore(2),
    download: (url) =>
      Promise.resolve(
        url.endsWith(".mp3")
          ? { body: MP3, contentType: "audio/mpeg" }
          : { body: MP4, contentType: "video/mp4" },
      ),
    probeSeconds: () => Promise.resolve(probe),
    now: () => new Date(NOW),
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  return () =>
    h(
      {
        jobId: randomUUID(),
        payload: { companyId: s.companyId, speakingRunId: s.runId },
        attempt: 1,
        maxAttempts: 2,
      },
      { companyId: s.companyId, speakingRunId: s.runId },
    );
}

async function contents(companyId: string) {
  return handle.sql<
    { id: string; type: string; status: string; build_payload: Record<string, unknown> }[]
  >`
    select id::text, type::text, status::text, build_payload
      from contents where company_id = ${companyId}::uuid
  `;
}

async function spendOf(s: Setup) {
  const ledger = parseSpendLedger(await s.ledger.read());
  const month = ledger?.months[MONTH] ?? {};
  const keys = speakingSpendIds(s.runId);
  return { voice: month[keys.voice]?.state, video: month[keys.video]?.state, month };
}

describe("formato con voz: voz → avatar → pieza", () => {
  it("full: wall-of-text con el avatar, la voz como audio y el build en la transacción", async () => {
    const s = await speakingSetup();
    const fal = fakeFal({ billedSeconds: 6.2 });
    await handler(s, fal)();

    expect(fal.calls.speech).toBe(1);
    const avatar = fal.calls.avatar[0] as Record<string, unknown>;
    expect(String(avatar["imageUrl"])).toMatch(/^data:image\/png;base64,/);
    expect(String(avatar["audioUrl"])).toMatch(/^data:audio\/mpeg;base64,/);
    expect(avatar["audioSeconds"]).toBe(6);
    expect(avatar["resolution"]).toBe("720p");

    const run = parseSpeakingRunRecord(await s.runs.get(s.companyId, s.runId));
    expect(run).toMatchObject({ stage: "building", contentId: s.runId, error: null });
    expect(run?.voiceStep.seconds).toBe(6);
    expect(run?.videoStep.billedSeconds).toBe(6.2);

    const rows = await contents(s.companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: s.runId,
      type: "wall-of-text",
      status: "BUILDING",
    });
    const payload = rows[0]?.build_payload as {
      audio?: { url: string };
      text: { content: string };
    };
    expect(payload.audio?.url).toBe(run?.voiceStep.url);
    expect(payload.text.content).toBe("Stop scrolling.");

    const build = s.queue.jobs.filter((j) => j.spec.queue === CONTENT_BUILD_QUEUE);
    expect(build).toHaveLength(1);
    expect(build[0]?.inTx).toBe(true);

    const spend = await spendOf(s);
    expect(spend.voice).toBe("charged");
    expect(spend.video).toBe("charged");
    // Lo cobrado por fal (6,2 s → 7 s × 0,16).
    expect(spend.month[speakingSpendIds(s.runId).video]?.usd).toBeCloseTo(1.12);
  });

  it("hook-demo: video-hook con el avatar arriba y el demo abajo", async () => {
    const s = await speakingSetup({ formatId: "speaking-hook", demo: true });
    await handler(s, fakeFal())();
    const run = parseSpeakingRunRecord(await s.runs.get(s.companyId, s.runId));
    expect(run?.error).toBeNull();
    const rows = await contents(s.companyId);
    expect(rows[0]?.type).toBe("video-hook");
    const payload = rows[0]?.build_payload as {
      hook_video: { url: string };
      demo_video: { url: string };
    };
    expect(payload.demo_video.url).toContain("demo.mp4");
    expect(payload.hook_video.url).not.toContain("demo.mp4");
  });

  it("una reentrega con la voz ya aceptada no la vuelve a pedir", async () => {
    const s = await speakingSetup();
    await s.runs.update(s.companyId, s.runId, (raw) => ({
      next: {
        ...(raw as Record<string, unknown>),
        stage: "voice",
        voiceStep: {
          request: {
            requestId: "voice",
            statusUrl: `${FAL}/voice/status`,
            responseUrl: `${FAL}/voice/response`,
          },
          storageKey: null,
          url: null,
          seconds: null,
        },
      },
      result: null,
    }));
    const fal = fakeFal();
    await handler(s, fal)();
    expect(fal.calls.speech).toBe(0);
    expect(fal.calls.avatar).toHaveLength(1);
    expect(await contents(s.companyId)).toHaveLength(1);
  });

  it("una voz más larga que el tope no manda el avatar: voz cobrada, video liberado", async () => {
    const s = await speakingSetup();
    const fal = fakeFal();
    await handler(s, fal, 75)();
    expect(fal.calls.avatar).toHaveLength(0);
    const run = parseSpeakingRunRecord(await s.runs.get(s.companyId, s.runId));
    expect(run).toMatchObject({ stage: "failed", error: { code: "voice_too_long" } });
    const spend = await spendOf(s);
    expect(spend.voice).toBe("charged");
    expect(spend.video).toBeUndefined();
    expect(await contents(s.companyId)).toHaveLength(0);
  });

  it("avatar rechazado por contenido: nsfw, voz cobrada, video liberado", async () => {
    const s = await speakingSetup();
    await handler(
      s,
      fakeFal({ avatarSubmit: { kind: "rejected", status: "nsfw", message: "flagged" } }),
    )();
    const run = parseSpeakingRunRecord(await s.runs.get(s.companyId, s.runId));
    expect(run).toMatchObject({ stage: "nsfw", error: { code: "nsfw_rejected" } });
    const spend = await spendOf(s);
    expect(spend.voice).toBe("charged");
    expect(spend.video).toBeUndefined();
  });
});

describe("character swap", () => {
  it("manda retrato y video de origen como data URI y arma la pieza", async () => {
    const b = await base();
    const key = `media/${b.companyId}/source.mp4`;
    await b.storage.put({ key, body: MP4, contentType: "video/mp4" });
    const r = await startSwapRun(
      {
        now: () => new Date(NOW),
        newId: () => randomUUID(),
        env: {},
        ledger: b.ledger,
        runs: b.runs,
        enqueue: () => Promise.resolve(),
        swapTask: () =>
          Promise.resolve({
            provider: "fal",
            defaultModel: "fal-ai/wan/v2.2-14b/animate/replace",
            models: [
              {
                id: "fal-ai/wan/v2.2-14b/animate/replace",
                label: "Wan",
                resolutions: ["480p"],
                docsUrl: "https://fal.ai",
                listPrice: null,
              },
            ],
          }),
        estimateSwap: () =>
          Promise.resolve({ usd: 0.75, source: "price_list", basis: "t" }),
      },
      {
        companyId: b.companyId,
        portrait: {
          mediaId: null,
          url: "https://storage.test/p",
          storageKey: `media/${b.companyId}/portrait.png`,
        },
        sourceVideo: {
          mediaId: null,
          url: "https://storage.test/s",
          storageKey: key,
          durationSeconds: 5,
        },
        source: "studio",
      },
    );
    if (!r.ok) throw new Error("start failed");
    const s: Setup = { ...b, runId: r.run.id };
    const fal = fakeFal();
    await handler(s, fal)();
    expect(fal.calls.speech).toBe(0);
    const swap = fal.calls.swap[0] as Record<string, unknown>;
    expect(String(swap["videoUrl"])).toMatch(/^data:video\/mp4;base64,/);
    expect(String(swap["imageUrl"])).toMatch(/^data:image\/png;base64,/);
    const rows = await contents(b.companyId);
    expect(rows[0]).toMatchObject({ id: r.run.id, type: "wall-of-text" });
    expect((await spendOf(s)).video).toBe("charged");
  });
});
