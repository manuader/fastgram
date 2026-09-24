/**
 * Formatos generativos en el worker — sprint 7 (agente G), `P4-FORMAT-001`.
 *
 * El handler real de `ai-studio-generation` con `afterReady` = el armador de
 * la pieza (`src/formats/finish.ts`), contra Postgres real. El proveedor es un
 * doble con guion; el storage, el de memoria; la cola, una que anota.
 *
 * Lo que se mide:
 *  · clip listo → pieza `wall-of-text` en `BUILDING` con **el id de la
 *    corrida**, el clip del Media Bank como fondo y el texto encima, y el
 *    `content-build` encolado **en la transacción**; la corrida anota la pieza;
 *  · una reentrega con la generación ya `ready` no crea otra pieza ni otro job;
 *  · si la pieza ya existe pero la corrida no la anotó (el worker murió), sólo
 *    se anota;
 *  · una generación sin corrida (AI Studio normal) no arma nada;
 *  · el clip borrado antes de armar → la corrida queda `clip_missing`.
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
  type GenClient,
} from "@fastgram/adapters";
import {
  CONTENT_BUILD_QUEUE,
  EMPTY_SPEND_LEDGER,
  newFormatRunRecord,
  newGenerationRecord,
  parseFormatRunRecord,
  parseSpendLedger,
  reserveSpend,
  type GenerationRecord,
} from "@fastgram/core";
import type { DbHandle } from "@fastgram/db";
import type { EnqueuedJob, JobContext, JobSpec, Queue } from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import { createFormatRunFinisher } from "../src/formats/finish.js";
import { createAiStudioGenerationHandler } from "../src/genai/handler.js";
import { Semaphore } from "../src/genai/semaphore.js";
import { openDb, seedCompany } from "./helpers/fixtures.js";

const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = "2026-09-24T12:00:00.000Z";
const MONTH = "2026-09";
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
const MODEL = "kling-video/v2.6/pro/text-to-video";

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
  home = await mkdtemp(join(tmpdir(), "fastgram-formats-"));
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
        return Promise.resolve({
          jobId: randomUUID(),
          created: true,
        } as unknown as EnqueuedJob);
      },
    } as unknown as Queue;
  }
}

function client(): GenClient {
  return {
    provider: "higgsfield",
    models: () => [],
    estimateImage: () => Promise.reject(new Error("unused")),
    estimateVideo: () => Promise.reject(new Error("unused")),
    checkCredentials: () => Promise.reject(new Error("unused")),
    generateImage: () => Promise.reject(new Error("unused")),
    generateVideo: () =>
      Promise.resolve({
        kind: "accepted",
        handle: {
          requestId: "r1",
          statusUrl: "https://api.higgsfield.ai/requests/r1/status",
        },
      }),
    poll: () =>
      Promise.resolve({
        status: "completed",
        outputs: [{ url: "https://cdn.higgsfield.ai/out.mp4" }],
      }),
  };
}

interface Setup {
  readonly companyId: string;
  readonly record: GenerationRecord;
  readonly generations: JsonFileCollection;
  readonly runs: JsonFileCollection;
  readonly ledger: JsonFileDocument;
  readonly storage: MemoryStorage;
  readonly queue: RecordingQueue;
}

async function setup(withRun = true): Promise<Setup> {
  const companyId = await seedCompany(handle);
  const registry = new FileModelRegistry({ path: join(home, "models.json") });
  await registry.write("video", {
    provider: "higgsfield",
    baseUrl: "https://api.higgsfield.ai",
    model: MODEL,
    apiKey: "id:secret",
  });
  const generations = new JsonFileCollection(join(home, "ai-studio"));
  const runs = new JsonFileCollection(join(home, "format-runs"));
  const ledger = new JsonFileDocument(join(home, "spend.json"));
  const id = randomUUID();
  const record = newGenerationRecord({
    id,
    companyId,
    kind: "video",
    provider: "higgsfield",
    model: MODEL,
    prompt: "Vertical close-up video of hands slicing fresh colorful fruit",
    aspectRatio: "9:16",
    count: 1,
    durationSeconds: 5,
    imageUrl: null,
    estimate: { usd: 0.35, source: "provider", basis: "test", sourceUrl: null },
    spendMonth: MONTH,
    now: NOW,
  });
  await generations.create(companyId, id, record);
  if (withRun) {
    await runs.create(
      companyId,
      id,
      newFormatRunRecord({
        id,
        companyId,
        formatId: "cutting-fruit",
        topic: null,
        overlayText: "POV: breakfast in 30s",
        videoPrompt: record.prompt,
        source: "studio",
        now: NOW,
      }),
    );
  }
  await ledger.update((raw) => {
    const r = reserveSpend(
      parseSpendLedger(raw) ?? EMPTY_SPEND_LEDGER,
      {
        month: MONTH,
        generationId: id,
        usd: 0.35,
        provider: "higgsfield",
        model: MODEL,
        kind: "video",
        companyId,
        at: NOW,
      },
      {},
    );
    if (!r.ok) throw new Error("reserve failed");
    return { next: r.next, result: null };
  });
  return {
    companyId,
    record,
    generations,
    runs,
    ledger,
    storage: new MemoryStorage(new FixedClock(new Date(NOW))),
    queue: new RecordingQueue(),
  };
}

function run(s: Setup) {
  const h = createAiStudioGenerationHandler({
    db: handle.db,
    storage: s.storage,
    logger: silencioso,
    registry: new FileModelRegistry({ path: join(home, "models.json") }),
    secrets: {},
    ledger: s.ledger,
    generations: s.generations,
    clientFor: () => client(),
    semaphoreFor: () => new Semaphore(2),
    download: () => Promise.resolve({ body: MP4, contentType: "video/mp4" }),
    now: () => new Date(NOW),
    sleep: () => Promise.resolve(),
    random: () => 0,
    afterReady: createFormatRunFinisher({
      db: handle.db,
      queue: s.queue.queue(),
      runs: s.runs,
      logger: silencioso,
      now: () => new Date(NOW),
    }),
  });
  return () =>
    h({
      jobId: randomUUID(),
      payload: { companyId: s.companyId, generationId: s.record.id },
      attempt: 1,
      maxAttempts: 2,
    } satisfies JobContext<unknown>);
}

async function contents(companyId: string) {
  return handle.sql<
    {
      id: string;
      type: string;
      status: string;
      generated_text: string;
      build_payload: unknown;
    }[]
  >`
    select id::text, type::text, status::text, generated_text, build_payload
      from contents where company_id = ${companyId}::uuid
  `;
}

async function runOf(s: Setup) {
  return parseFormatRunRecord(await s.runs.get(s.companyId, s.record.id));
}

describe("formatos generativos: del clip a la pieza", () => {
  it("clip listo → wall-of-text con el clip y el texto, build encolado en la transacción", async () => {
    const s = await setup();
    await run(s)();

    const rows = await contents(s.companyId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      id: s.record.id,
      type: "wall-of-text",
      status: "BUILDING",
      generated_text: "POV: breakfast in 30s",
    });
    const payload = row?.build_payload as {
      canvas: { width: number; height: number };
      video: { url: string; drawW: number };
      text: { content: string };
    };
    expect(payload.canvas).toEqual({ width: 1080, height: 1920 });
    expect(decodeURIComponent(payload.video.url)).toContain(
      `media/${s.companyId}/ai-studio/${s.record.id}-1.mp4`,
    );
    expect(payload.text.content).toBe("POV: breakfast in 30s");

    expect(s.queue.jobs).toHaveLength(1);
    expect(s.queue.jobs[0]?.spec.queue).toBe(CONTENT_BUILD_QUEUE);
    expect(s.queue.jobs[0]?.inTx).toBe(true);
    expect(s.queue.jobs[0]?.spec.payload).toMatchObject({
      contentId: s.record.id,
      contentType: "wall-of-text",
      reason: "create",
    });
    expect((await runOf(s))?.contentId).toBe(s.record.id);
  });

  it("una reentrega con la generación ya lista no arma otra pieza", async () => {
    const s = await setup();
    const go = run(s);
    await go();
    await go();
    expect(await contents(s.companyId)).toHaveLength(1);
    expect(s.queue.jobs).toHaveLength(1);
  });

  it("la pieza ya existía y la corrida no la anotó: sólo se anota", async () => {
    const s = await setup();
    await run(s)();
    // Simula que el worker murió antes de anotar.
    await s.runs.update(s.companyId, s.record.id, (raw) => ({
      next: { ...(raw as Record<string, unknown>), contentId: null },
      result: null,
    }));
    await run(s)();
    expect(await contents(s.companyId)).toHaveLength(1);
    expect(s.queue.jobs).toHaveLength(1);
    expect((await runOf(s))?.contentId).toBe(s.record.id);
  });

  it("una generación de AI Studio sin corrida no arma nada", async () => {
    const s = await setup(false);
    await run(s)();
    expect(await contents(s.companyId)).toHaveLength(0);
    expect(s.queue.jobs).toHaveLength(0);
  });

  it("clip borrado antes de armar → la corrida queda clip_missing", async () => {
    const s = await setup();
    // Primero sin corrida: la generación queda lista con su media.
    const run0 = parseFormatRunRecord(await s.runs.get(s.companyId, s.record.id));
    await rm(join(home, "format-runs"), { recursive: true, force: true });
    await run(s)();
    await handle.sql`delete from media where company_id = ${s.companyId}::uuid`;
    // Vuelve la corrida y llega la reentrega.
    await s.runs.create(s.companyId, s.record.id, run0);
    await run(s)();
    expect(await contents(s.companyId)).toHaveLength(0);
    expect((await runOf(s))?.error?.code).toBe("clip_missing");
  });
});
