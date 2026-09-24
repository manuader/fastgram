/**
 * «Animate this image» en el worker — sprint 7 (agente G), `F-099`, `FR-082`.
 * El trabajo `video` de `influencer-pipeline`, contra Postgres real, con un
 * doble del image-to-video de Higgsfield. Ninguna llamada real.
 *
 * Lo que se mide:
 *  · completed → el video en `media/<marca>/influencers/…`, fila de `media`
 *    video con duración, `influencer_assets` video, set VIDEO del influencer,
 *    pedido `ready` y gasto cobrado; se envía con la URL que guardó la API;
 *  · un personaje de **una** foto (base generada) entrena (el mínimo de 4 es
 *    de las fotos propias);
 *  · nsfw cierra y libera; una reentrega con el pedido aceptado no reenvía.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileModelRegistry,
  FixedClock,
  JsonFileDocument,
  MemoryStorage,
} from "@fastgram/adapters";
import {
  EMPTY_SPEND_LEDGER,
  parseSpendLedger,
  reserveSpend,
  type CharacterGen,
} from "@fastgram/core";
import { APP_ROLE, type DbHandle } from "@fastgram/db";
import type {
  GenJobState,
  GenSubmission,
  JobContext,
  VideoGen,
  VideoGenRequest,
} from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import { createInfluencerPipelineHandler } from "../src/influencers/pipeline-handler.js";
import { openDb, seedCompany } from "./helpers/fixtures.js";

const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = new Date("2026-09-24T12:00:00.000Z");
const MONTH = "2026-09";
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SOUL = "3eb3ad49-775d-40bd-b5e5-38b105108780";
const MODEL = "kling-video/v2.6/pro/image-to-video";
const SOURCE_URL = "https://cdn.higgsfield.ai/uploads/source.png";

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
  home = await mkdtemp(join(tmpdir(), "fastgram-influencer-video-"));
});

class FakeVideo {
  submits: VideoGenRequest[] = [];
  polls = 0;
  constructor(
    private readonly submit: GenSubmission = {
      kind: "accepted",
      handle: {
        requestId: "v1",
        statusUrl: "https://api.higgsfield.ai/requests/v1/status",
      },
    },
    private readonly states: GenJobState[] = [
      { status: "in_progress", outputs: [] },
      { status: "completed", outputs: [{ url: "https://cdn.higgsfield.ai/out.mp4" }] },
    ],
  ) {}
  client(): VideoGen {
    return {
      provider: "higgsfield",
      models: () => [],
      checkCredentials: () => Promise.reject(new Error("unused")),
      estimateVideo: () => Promise.reject(new Error("unused")),
      generateVideo: (r) => {
        this.submits.push(r);
        return Promise.resolve(this.submit);
      },
      poll: () =>
        Promise.resolve(
          this.states[Math.min(this.polls++, this.states.length - 1)] as GenJobState,
        ),
    };
  }
}

const noCharacters: CharacterGen = {
  uploadImage: () => Promise.resolve("https://cdn.higgsfield.ai/uploads/1.png"),
  createCharacter: () =>
    Promise.resolve({ id: SOUL, status: "queued", thumbnailUrl: null, failReason: null }),
  getCharacter: () =>
    Promise.resolve({
      id: SOUL,
      status: "completed",
      thumbnailUrl: null,
      failReason: null,
    }),
  estimateCharacterImage: () => Promise.reject(new Error("unused")),
  generateCharacterImage: () => Promise.reject(new Error("unused")),
  poll: () => Promise.reject(new Error("unused")),
};

interface World {
  readonly companyId: string;
  readonly influencerId: string;
  readonly sourceMediaId: string;
  readonly storage: MemoryStorage;
  readonly ledger: JsonFileDocument;
}

async function world(): Promise<World> {
  const companyId = await seedCompany(handle);
  await new FileModelRegistry({ path: join(home, "models.json") }).write("video", {
    provider: "higgsfield",
    baseUrl: "https://api.higgsfield.ai",
    model: MODEL,
    apiKey: "KEYID:SECRET",
  });
  const storage = new MemoryStorage(new FixedClock(NOW));
  const key = `media/${companyId}/source.png`;
  await storage.put({ key, body: PNG, contentType: "image/png" });
  const media = await handle.sql`
    insert into media (company_id, media_type, filename, r2_url, storage_key,
                       status, size_mb, categories, origin)
    values (${companyId}::uuid, 'image', 'source.png',
            ${`http://localhost:9000/fastgram/${key}`}, ${key}, 'ready', 0.001,
            '{}'::text[], 'manual_upload')
    returning media_id`;
  const sourceMediaId = (media[0] as unknown as { media_id: string }).media_id;
  const inf = await handle.sql`
    insert into influencers (company_id, name, status, progress, provider, soul_id,
                             reference_media_ids)
    values (${companyId}::uuid, 'Ella', 'ready', 100, 'higgsfield', ${SOUL},
            ${`{${sourceMediaId}}`}::uuid[])
    returning id`;
  return {
    companyId,
    influencerId: (inf[0] as unknown as { id: string }).id,
    sourceMediaId,
    storage,
    ledger: new JsonFileDocument(join(home, "spend.json")),
  };
}

async function seedVideo(w: World): Promise<string> {
  const id = randomUUID();
  await handle.sql`
    insert into influencer_generations
      (id, company_id, influencer_id, kind, status, provider, model, prompt,
       aspect_ratio, count, duration_seconds, source_media_id, source_image_url,
       estimate_usd, estimate_basis, spend_month)
    values (${id}::uuid, ${w.companyId}::uuid, ${w.influencerId}::uuid, 'video',
            'queued', 'higgsfield', ${MODEL}, 'slow zoom on the face', '9:16', 1, 5,
            ${w.sourceMediaId}::uuid, ${SOURCE_URL}, 0.7, 'test', ${MONTH})`;
  await w.ledger.update((raw) => {
    const r = reserveSpend(
      parseSpendLedger(raw) ?? EMPTY_SPEND_LEDGER,
      {
        month: MONTH,
        generationId: id,
        usd: 0.7,
        provider: "higgsfield",
        model: MODEL,
        kind: "video",
        companyId: w.companyId,
        at: NOW.toISOString(),
      },
      {},
    );
    if (!r.ok) throw new Error("reserve failed");
    return { next: r.next, result: null };
  });
  return id;
}

function handler(w: World, video: FakeVideo) {
  const h = createInfluencerPipelineHandler({
    db: handle.db,
    clock: new FixedClock(NOW),
    appRole: APP_ROLE,
    logger: silencioso,
    characters: {
      storage: w.storage,
      registry: new FileModelRegistry({ path: join(home, "models.json") }),
      secrets: {},
      ledger: w.ledger,
      clientFor: () => noCharacters,
      download: () => Promise.resolve({ body: PNG, contentType: "image/png" }),
      sleep: () => Promise.resolve(),
      random: () => 0,
      video: {
        videoClientFor: () => video.client(),
        downloadVideo: () => Promise.resolve({ body: MP4, contentType: "video/mp4" }),
      },
    },
  });
  return (payload: unknown) =>
    h({
      jobId: randomUUID(),
      payload,
      attempt: 1,
      maxAttempts: 2,
    } satisfies JobContext<unknown>);
}

async function generation(id: string) {
  const rows = await handle.sql`
    select status, error_code, provider_request_id, cardinality(media_ids) as n
      from influencer_generations where id = ${id}::uuid`;
  return rows[0] as unknown as {
    status: string;
    error_code: string | null;
    provider_request_id: string | null;
    n: number;
  };
}

describe("video del influencer", () => {
  it("completed: media de video, asset, set VIDEO, ready y cobrado", async () => {
    const w = await world();
    const id = await seedVideo(w);
    const fake = new FakeVideo();
    await handler(
      w,
      fake,
    )({
      op: "video",
      companyId: w.companyId,
      influencerId: w.influencerId,
      generationId: id,
    });

    expect(fake.submits).toEqual([
      {
        model: MODEL,
        prompt: "slow zoom on the face",
        imageUrl: SOURCE_URL,
        aspectRatio: "9:16",
        durationSeconds: 5,
      },
    ]);
    expect(await generation(id)).toMatchObject({
      status: "ready",
      n: 1,
      error_code: null,
    });
    const media = await handle.sql`
      select media_type::text as t, video_duration_sec as d, storage_key as k
        from media where company_id = ${w.companyId}::uuid and media_type = 'video'`;
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ t: "video", d: 5 });
    expect(String((media[0] as unknown as { k: string }).k)).toBe(
      `media/${w.companyId}/influencers/${w.influencerId}/${id}-video.mp4`,
    );
    const assets = await handle.sql`
      select kind::text as kind from influencer_assets
        where influencer_id = ${w.influencerId}::uuid`;
    expect(assets.map((a) => (a as unknown as { kind: string }).kind)).toEqual(["video"]);
    const sets = await handle.sql`
      select kind::text as kind, cardinality(media_ids) as n from media_sets
        where influencer_id = ${w.influencerId}::uuid`;
    expect(sets).toEqual([{ kind: "VIDEO", n: 1 }]);
    const spend = parseSpendLedger(await w.ledger.read());
    expect(spend?.months[MONTH]?.[id]?.state).toBe("charged");
  });

  it("nsfw: cierra y libera la reserva", async () => {
    const w = await world();
    const id = await seedVideo(w);
    const fake = new FakeVideo(undefined, [{ status: "nsfw", outputs: [] }]);
    await handler(
      w,
      fake,
    )({
      op: "video",
      companyId: w.companyId,
      influencerId: w.influencerId,
      generationId: id,
    });
    expect(await generation(id)).toMatchObject({
      status: "nsfw",
      error_code: "nsfw_rejected",
    });
    const spend = parseSpendLedger(await w.ledger.read());
    expect(spend?.months[MONTH]?.[id]).toBeUndefined();
  });

  it("con el pedido ya aceptado, la reentrega hace polling y no reenvía", async () => {
    const w = await world();
    const id = await seedVideo(w);
    await handle.sql`
      update influencer_generations
         set status = 'generating', provider_request_id = 'v1',
             provider_status_url = 'https://api.higgsfield.ai/requests/v1/status'
       where id = ${id}::uuid`;
    const fake = new FakeVideo();
    await handler(
      w,
      fake,
    )({
      op: "video",
      companyId: w.companyId,
      influencerId: w.influencerId,
      generationId: id,
    });
    expect(fake.submits).toHaveLength(0);
    expect((await generation(id)).status).toBe("ready");
  });
});

describe("train con una sola foto (base generada)", () => {
  it("una foto alcanza cuando el personaje se creó con una", async () => {
    const w = await world();
    const rows = await handle.sql`
      insert into influencers (company_id, name, status, progress, provider,
                               reference_media_ids)
      values (${w.companyId}::uuid, 'Base', 'generating_variations', 0, 'higgsfield',
              ${`{${w.sourceMediaId}}`}::uuid[])
      returning id`;
    const id = (rows[0] as unknown as { id: string }).id;
    await handler(w, new FakeVideo())({ companyId: w.companyId, influencerId: id });
    const row = await handle.sql`
      select status::text as status, failure_code from influencers where id = ${id}::uuid`;
    expect(row[0]).toMatchObject({ status: "ready", failure_code: null });
  });
});
