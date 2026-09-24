/**
 * `ai-studio-generation` contra Postgres real — `PU-LATER-005`,
 * `PU-MODEL-003`/`004`/`005`.
 *
 * El proveedor es un doble de `GenClient` con guion (los estados que
 * documentan Higgsfield y fal); el registro, las generaciones y el gasto son
 * los archivos reales en un `FASTGRAM_HOME` temporal; el storage es el de
 * memoria. Ninguna llamada a Higgsfield ni a fal.
 *
 * Lo que se mide:
 *  · completed → la media se copia a `media/<marca>/ai-studio/…`, nacen filas
 *    `ready`/`brand_kit` categorizadas, el registro queda `ready` con sus ids
 *    y la reserva pasa a cobrada;
 *  · nsfw y failed cierran el registro y **liberan** la reserva;
 *  · un tope de concurrencia al enviar se espera y se reintenta;
 *  · un timeout al enviar (ambiguo) no se reenvía y queda **cobrado**;
 *  · una reentrega con el pedido ya aceptado retoma el polling sin reenviar,
 *    y no duplica la media;
 *  · el semáforo del proveedor limita cuántas corren a la vez.
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
  EMPTY_SPEND_LEDGER,
  newGenerationRecord,
  parseGenerationRecord,
  parseSpendLedger,
  reserveSpend,
  type GenerationRecord,
} from "@fastgram/core";
import { type DbHandle } from "@fastgram/db";
import {
  PortError,
  type GenJobState,
  type GenSubmission,
  type JobContext,
} from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import { createAiStudioGenerationHandler } from "../src/genai/handler.js";
import { Semaphore } from "../src/genai/semaphore.js";
import { openDb, seedCompany } from "./helpers/fixtures.js";

const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = "2026-09-24T12:00:00.000Z";
const MONTH = "2026-09";
const FAL_KEY = "fal-key-0123456789";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

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
  home = await mkdtemp(join(tmpdir(), "fastgram-ai-studio-"));
});

interface Script {
  submit?: (GenSubmission | PortError)[];
  polls?: (GenJobState | PortError)[];
}

class ScriptedClient {
  submits = 0;
  polls = 0;
  active = 0;
  maxActive = 0;
  constructor(private readonly script: Script) {}

  client(): GenClient {
    const step = <T>(list: (T | PortError)[] | undefined, i: number): Promise<T> => {
      const item = list?.[Math.min(i, (list?.length ?? 1) - 1)];
      if (item === undefined) return Promise.reject(new Error("script exhausted"));
      return item instanceof PortError ? Promise.reject(item) : Promise.resolve(item);
    };
    const submit = async (): Promise<GenSubmission> => {
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      const i = this.submits++;
      try {
        return await step(this.script.submit, i);
      } finally {
        this.active -= 1;
      }
    };
    return {
      provider: "fal",
      models: () => [],
      estimateImage: () => Promise.reject(new Error("unused")),
      estimateVideo: () => Promise.reject(new Error("unused")),
      checkCredentials: () => Promise.reject(new Error("unused")),
      generateImage: submit,
      generateVideo: submit,
      poll: async () => {
        // Un tick para que otras entregas intenten entrar mientras ésta «corre».
        await new Promise((r) => setTimeout(r, 1));
        return step(this.script.polls, this.polls++);
      },
    };
  }
}

const accepted = (id = "req-1"): GenSubmission => ({
  kind: "accepted",
  handle: {
    requestId: id,
    statusUrl: `https://queue.fal.run/fal-ai/flux/schnell/requests/${id}/status`,
    responseUrl: `https://queue.fal.run/fal-ai/flux/schnell/requests/${id}/response`,
  },
});
const queued: GenJobState = { status: "queued", outputs: [] };
const running: GenJobState = { status: "in_progress", outputs: [] };
const done = (n: number, kind: "image" | "video" = "image"): GenJobState => ({
  status: "completed",
  outputs: Array.from({ length: n }, (_, i) => ({
    url: `https://v3.fal.media/files/out-${String(i)}.${kind === "image" ? "png" : "mp4"}`,
  })),
});

interface Setup {
  readonly companyId: string;
  readonly record: GenerationRecord;
  readonly generations: JsonFileCollection;
  readonly ledger: JsonFileDocument;
  readonly storage: MemoryStorage;
  readonly downloads: string[];
  readonly semaphore: Semaphore;
}

async function setup(
  kind: "image" | "video" = "image",
  over: Partial<GenerationRecord> = {},
  companyId?: string,
  shared?: { semaphore?: Semaphore; storage?: MemoryStorage },
): Promise<Setup> {
  const company = companyId ?? (await seedCompany(handle));
  const registry = new FileModelRegistry({ path: join(home, "models.json") });
  await registry.write(kind, {
    provider: "fal",
    baseUrl: "https://queue.fal.run",
    model:
      kind === "image" ? "fal-ai/flux/schnell" : "fal-ai/wan/v2.2-a14b/text-to-video",
    apiKey: FAL_KEY,
  });
  const generations = new JsonFileCollection(join(home, "ai-studio"));
  const ledger = new JsonFileDocument(join(home, "spend.json"));
  const record = {
    ...newGenerationRecord({
      id: randomUUID(),
      companyId: company,
      kind,
      provider: "fal",
      model:
        kind === "image" ? "fal-ai/flux/schnell" : "fal-ai/wan/v2.2-a14b/text-to-video",
      prompt: "a neon skyline",
      aspectRatio: "9:16",
      count: kind === "image" ? 2 : 1,
      durationSeconds: kind === "video" ? 5 : null,
      imageUrl: null,
      estimate: { usd: 0.25, source: "price_list", basis: "test", sourceUrl: null },
      spendMonth: MONTH,
      now: NOW,
    }),
    ...over,
  };
  await generations.create(company, record.id, record);
  await ledger.update((raw) => {
    const r = reserveSpend(
      parseSpendLedger(raw) ?? EMPTY_SPEND_LEDGER,
      {
        month: MONTH,
        generationId: record.id,
        usd: 0.25,
        provider: "fal",
        model: record.model,
        kind,
        companyId: company,
        at: NOW,
      },
      {},
    );
    if (!r.ok) throw new Error("reserve failed");
    return { next: r.next, result: null };
  });
  return {
    companyId: company,
    record,
    generations,
    ledger,
    storage: shared?.storage ?? new MemoryStorage(new FixedClock(new Date(NOW))),
    downloads: [],
    semaphore: shared?.semaphore ?? new Semaphore(2),
  };
}

function handler(s: Setup, client: ScriptedClient, maxAttempts = 2) {
  const h = createAiStudioGenerationHandler({
    db: handle.db,
    storage: s.storage,
    logger: silencioso,
    registry: new FileModelRegistry({ path: join(home, "models.json") }),
    secrets: {},
    ledger: s.ledger,
    generations: s.generations,
    clientFor: () => client.client(),
    semaphoreFor: () => s.semaphore,
    download: (url) => {
      s.downloads.push(url);
      return Promise.resolve(
        url.endsWith(".mp4")
          ? { body: MP4, contentType: "video/mp4" }
          : { body: PNG, contentType: "image/png" },
      );
    },
    now: () => new Date(NOW),
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  return (attempt = 1) =>
    h({
      jobId: randomUUID(),
      payload: { companyId: s.companyId, generationId: s.record.id },
      attempt,
      maxAttempts,
    } satisfies JobContext<unknown>);
}

async function recordOf(s: Setup): Promise<GenerationRecord> {
  const r = parseGenerationRecord(await s.generations.get(s.companyId, s.record.id));
  if (r === null) throw new Error("record missing");
  return r;
}

async function spendOf(s: Setup) {
  const ledger = parseSpendLedger(await s.ledger.read());
  return ledger?.months[MONTH]?.[s.record.id];
}

async function mediaRows(companyId: string) {
  return handle.sql<
    {
      media_id: string;
      storage_key: string;
      status: string;
      origin: string;
      categories: string[];
      media_type: string;
      video_duration_sec: number | null;
    }[]
  >`
    select media_id::text, storage_key, status::text, origin::text, categories, media_type::text, video_duration_sec
      from media where company_id = ${companyId}::uuid order by storage_key
  `;
}

describe("ai-studio-generation", () => {
  it("completed: copia a storage, crea media brand_kit categorizada, registro ready, gasto cobrado", async () => {
    const s = await setup("image");
    const client = new ScriptedClient({
      submit: [accepted()],
      polls: [queued, running, done(2)],
    });
    await handler(s, client)();

    const rec = await recordOf(s);
    expect(rec.status).toBe("ready");
    expect(rec.providerRequest?.requestId).toBe("req-1");
    expect(rec.mediaIds).toHaveLength(2);
    expect(client.submits).toBe(1);
    expect(client.polls).toBe(3);
    expect(s.downloads).toHaveLength(2);

    const rows = await mediaRows(s.companyId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(
        row.storage_key.startsWith(`media/${s.companyId}/ai-studio/${s.record.id}-`),
      ).toBe(true);
      expect(row).toMatchObject({
        status: "ready",
        origin: "brand_kit",
        media_type: "image",
      });
      expect(row.categories).toEqual(["slideshow-image", "green-screen-background"]);
    }
    expect(new Set(rec.mediaIds)).toEqual(new Set(rows.map((r) => r.media_id)));
    expect((await spendOf(s))?.state).toBe("charged");
  });

  it("video: background-video con la duración pedida", async () => {
    const s = await setup("video");
    await handler(
      s,
      new ScriptedClient({ submit: [accepted()], polls: [done(1, "video")] }),
    )();
    const rows = await mediaRows(s.companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ media_type: "video", video_duration_sec: 5 });
    expect(rows[0]?.categories).toEqual(["background-video"]);
    expect(rows[0]?.storage_key.endsWith(".mp4")).toBe(true);
  });

  it("nsfw: registro nsfw con nsfw_rejected, reserva liberada, sin media", async () => {
    const s = await setup("image");
    await handler(
      s,
      new ScriptedClient({
        submit: [accepted()],
        polls: [running, { status: "nsfw", outputs: [], message: "flagged" }],
      }),
    )();
    const rec = await recordOf(s);
    expect(rec).toMatchObject({ status: "nsfw", error: { code: "nsfw_rejected" } });
    expect(await spendOf(s)).toBeUndefined();
    expect(await mediaRows(s.companyId)).toHaveLength(0);
  });

  it("rechazo por contenido al enviar (fal 422): nsfw, liberado, sin polling", async () => {
    const s = await setup("image");
    const client = new ScriptedClient({
      submit: [{ kind: "rejected", status: "nsfw", message: "flagged" }],
    });
    await handler(s, client)();
    expect((await recordOf(s)).status).toBe("nsfw");
    expect(client.polls).toBe(0);
    expect(await spendOf(s)).toBeUndefined();
  });

  it("failed: generation_failed y reserva liberada (no se cobra)", async () => {
    const s = await setup("image");
    await handler(
      s,
      new ScriptedClient({
        submit: [accepted()],
        polls: [{ status: "failed", outputs: [], message: "Generation failed" }],
      }),
    )();
    expect(await recordOf(s)).toMatchObject({
      status: "failed",
      error: { code: "generation_failed", message: "Generation failed" },
    });
    expect(await spendOf(s)).toBeUndefined();
  });

  it("tope de concurrencia al enviar (429/400): espera y reintenta dentro del job", async () => {
    const s = await setup("image");
    const limited = new PortError("rate_limited", "limit", { source: "test" });
    const client = new ScriptedClient({
      submit: [limited, limited, accepted()],
      polls: [done(1)],
    });
    await handler(s, client)();
    expect(client.submits).toBe(3);
    expect((await recordOf(s)).status).toBe("ready");
  });

  it("rechazo definitivo al enviar (401): failed, liberado", async () => {
    const s = await setup("image");
    await handler(
      s,
      new ScriptedClient({
        submit: [
          new PortError("unauthorized", "fal rejected the API key", { source: "t" }),
        ],
      }),
    )();
    expect(await recordOf(s)).toMatchObject({
      status: "failed",
      error: { code: "unauthorized" },
    });
    expect(await spendOf(s)).toBeUndefined();
  });

  it("timeout al enviar (ambiguo): no se reenvía y queda cobrado", async () => {
    const s = await setup("image");
    const client = new ScriptedClient({
      submit: [new PortError("timeout", "slow", { source: "t" }), accepted()],
    });
    await handler(s, client)();
    expect(client.submits).toBe(1);
    expect(await recordOf(s)).toMatchObject({
      status: "failed",
      error: { code: "timeout" },
    });
    expect((await spendOf(s))?.state).toBe("charged");
  });

  it("reentrega con el pedido ya aceptado: retoma el polling, no reenvía ni duplica media", async () => {
    const s = await setup("image", {
      status: "generating",
      providerRequest: {
        requestId: "req-9",
        statusUrl: "https://queue.fal.run/x/requests/req-9/status",
        responseUrl: null,
      },
    });
    const client = new ScriptedClient({ submit: [accepted()], polls: [done(2)] });
    await handler(s, client)();
    expect(client.submits).toBe(0);
    expect((await recordOf(s)).status).toBe("ready");

    // Otra entrega del mismo job (p. ej. vencido y reintentado): nada nuevo.
    await handler(s, new ScriptedClient({ polls: [done(2)] }))();
    expect(await mediaRows(s.companyId)).toHaveLength(2);
  });

  it("polling que no termina: se suelta la entrega (reintento) y en la última se cierra cobrado", async () => {
    const s = await setup("image");
    const errors = Array.from(
      { length: 20 },
      () => new PortError("provider_unavailable", "down", { source: "t" }),
    );
    const first = handler(
      s,
      new ScriptedClient({ submit: [accepted()], polls: errors }),
      2,
    );
    await expect(first(1)).rejects.toThrow();
    const mid = await recordOf(s);
    expect(mid.status).toBe("generating");
    expect((await spendOf(s))?.state).toBe("reserved");

    await handler(s, new ScriptedClient({ polls: errors }), 2)(2);
    expect(await recordOf(s)).toMatchObject({
      status: "failed",
      error: { code: "timeout" },
    });
    expect((await spendOf(s))?.state).toBe("charged");
  });

  it("sin configuración (la borraron en el medio): not_configured y liberado", async () => {
    const s = await setup("image");
    await new FileModelRegistry({ path: join(home, "models.json") }).write("image", null);
    await handler(s, new ScriptedClient({ submit: [accepted()] }))();
    expect(await recordOf(s)).toMatchObject({
      status: "failed",
      error: { code: "not_configured" },
    });
    expect(await spendOf(s)).toBeUndefined();
  });

  it("el semáforo del proveedor: con tope 2, nunca más de 2 pedidos a la vez", async () => {
    const companyId = await seedCompany(handle);
    const semaphore = new Semaphore(2);
    const storage = new MemoryStorage(new FixedClock(new Date(NOW)));
    const setups: Setup[] = [];
    for (let i = 0; i < 5; i++) {
      setups.push(await setup("image", {}, companyId, { semaphore, storage }));
    }
    let active = 0;
    let maxActive = 0;
    const runs = setups.map((s) => {
      const scripted = new ScriptedClient({
        submit: [accepted()],
        polls: [running, done(1)],
      });
      const base = scripted.client();
      const tracked: GenClient = {
        ...base,
        generateImage: async (r) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          return base.generateImage(r);
        },
        poll: async (h) => {
          const state = await base.poll(h);
          if (state.status === "completed") active -= 1;
          return state;
        },
      };
      const h = createAiStudioGenerationHandler({
        db: handle.db,
        storage,
        logger: silencioso,
        registry: new FileModelRegistry({ path: join(home, "models.json") }),
        secrets: {},
        ledger: s.ledger,
        generations: s.generations,
        clientFor: () => tracked,
        semaphoreFor: () => semaphore,
        download: () => Promise.resolve({ body: PNG, contentType: "image/png" }),
        now: () => new Date(NOW),
        sleep: () => new Promise((r) => setTimeout(r, 2)),
        random: () => 0,
      });
      return h({
        jobId: randomUUID(),
        payload: { companyId, generationId: s.record.id },
        attempt: 1,
        maxAttempts: 2,
      });
    });
    await Promise.all(runs);
    expect(maxActive).toBe(2);
    for (const s of setups) expect((await recordOf(s)).status).toBe("ready");
  });
});
