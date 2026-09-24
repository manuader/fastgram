/**
 * `influencer-pipeline` con personajes de Higgsfield, contra Postgres real —
 * `PU-LATER-004`, `FR-080`, `FR-081`, `F-094`.
 *
 * El proveedor es un doble de `CharacterGen` con guion: devuelve los estados
 * que documenta Higgsfield (`/docs/models/soul-id/create-character`,
 * `/docs/api-reference/requests/get-request-status`). El registro y el libro de
 * gasto son archivos reales en un `FASTGRAM_HOME` temporal; el storage, el de
 * memoria. Ninguna llamada a Higgsfield.
 *
 * Lo que se mide:
 *  · train: sube las fotos de nuestro storage, crea el personaje **una vez**,
 *    guarda el id antes de hacer polling y termina `ready` con progress 100;
 *  · una reentrega con el id guardado no vuelve a crear ni a subir;
 *  · fallos con código estable en la fila (`failure_code`), sin Higgsfield y
 *    con fotos borradas;
 *  · image: envía con el id del personaje, copia al Media Bank **sin
 *    categoría**, crea el set SLIDESHOW del influencer (lo que lee Blitz), los
 *    `influencer_assets`, y cobra la reserva; un fallo la libera; una reentrega
 *    con el pedido aceptado no reenvía.
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
  type CharacterSnapshot,
} from "@fastgram/core";
import { APP_ROLE, discoveryQueueStore, withCompany, type DbHandle } from "@fastgram/db";
import {
  PortError,
  type GenJobState,
  type GenSubmission,
  type JobContext,
} from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import { createInfluencerPipelineHandler } from "../src/influencers/pipeline-handler.js";
import { openDb, seedCompany } from "./helpers/fixtures.js";

const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = new Date("2026-09-24T12:00:00.000Z");
const MONTH = "2026-09";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SOUL = "3eb3ad49-775d-40bd-b5e5-38b105108780";

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
  home = await mkdtemp(join(tmpdir(), "fastgram-influencers-"));
});

interface Script {
  create?: CharacterSnapshot | PortError;
  characters?: CharacterSnapshot["status"][];
  submit?: GenSubmission | PortError;
  polls?: GenJobState[];
}

class FakeHiggsfield {
  uploads: { size: number; contentType: string }[] = [];
  creates: { name: string; imageUrls: readonly string[] }[] = [];
  gets = 0;
  submits: Parameters<CharacterGen["generateCharacterImage"]>[0][] = [];
  polls = 0;
  constructor(private readonly script: Script) {}

  client(): CharacterGen {
    return {
      uploadImage: (input) => {
        this.uploads.push({
          size: input.body.byteLength,
          contentType: input.contentType,
        });
        return Promise.resolve(
          `https://cdn.higgsfield.ai/uploads/${String(this.uploads.length)}.png`,
        );
      },
      createCharacter: (input) => {
        this.creates.push(input);
        const c = this.script.create ?? snapshot("queued");
        return c instanceof PortError ? Promise.reject(c) : Promise.resolve(c);
      },
      getCharacter: () => {
        const list = this.script.characters ?? ["completed"];
        const status = list[Math.min(this.gets++, list.length - 1)] ?? "completed";
        return Promise.resolve(snapshot(status));
      },
      estimateCharacterImage: () => Promise.reject(new Error("unused")),
      generateCharacterImage: (req) => {
        this.submits.push(req);
        const s = this.script.submit ?? accepted;
        return s instanceof PortError ? Promise.reject(s) : Promise.resolve(s);
      },
      poll: () => {
        const list = this.script.polls ?? [done(2)];
        return Promise.resolve(list[Math.min(this.polls++, list.length - 1)] ?? done(2));
      },
    };
  }
}

function snapshot(status: CharacterSnapshot["status"]): CharacterSnapshot {
  return {
    id: SOUL,
    status,
    thumbnailUrl: null,
    failReason: status === "failed" ? "No face detected" : null,
  };
}
const accepted: GenSubmission = {
  kind: "accepted",
  handle: {
    requestId: "req-1",
    statusUrl: "https://api.higgsfield.ai/requests/req-1/status",
  },
};
const done = (n: number): GenJobState => ({
  status: "completed",
  outputs: Array.from({ length: n }, (_, i) => ({
    url: `https://cdn.higgsfield.ai/out-${String(i)}.png`,
  })),
});

interface World {
  readonly companyId: string;
  readonly storage: MemoryStorage;
  readonly ledger: JsonFileDocument;
  readonly mediaIds: string[];
}

async function world(
  opts: { references?: number; configured?: boolean } = {},
): Promise<World> {
  const companyId = await seedCompany(handle);
  const storage = new MemoryStorage(new FixedClock(NOW));
  const mediaIds: string[] = [];
  for (let i = 0; i < (opts.references ?? 4); i += 1) {
    const key = `media/${companyId}/ref-${String(i)}.png`;
    await storage.put({ key, body: PNG, contentType: "image/png" });
    const rows = await handle.sql`
      insert into media (company_id, media_type, filename, r2_url, storage_key,
                         status, size_mb, categories, origin)
      values (${companyId}::uuid, 'image', ${`ref-${String(i)}.png`},
              ${`http://localhost:9000/fastgram/${key}`}, ${key}, 'ready', 0.001,
              '{}'::text[], 'manual_upload')
      returning media_id
    `;
    mediaIds.push((rows[0] as unknown as { media_id: string }).media_id);
  }
  if (opts.configured !== false) {
    await new FileModelRegistry({ path: join(home, "models.json") }).write("image", {
      provider: "higgsfield",
      baseUrl: "https://api.higgsfield.ai",
      model: "higgsfield-ai/soul/v2/standard",
      apiKey: "KEYID:SECRET",
    });
  }
  return {
    companyId,
    storage,
    ledger: new JsonFileDocument(join(home, "spend.json")),
    mediaIds,
  };
}

async function seedCharacter(
  w: World,
  over: { soulId?: string; status?: string; referenceMediaIds?: string[] } = {},
): Promise<string> {
  const refs = over.referenceMediaIds ?? w.mediaIds;
  const rows = await handle.sql`
    insert into influencers (company_id, name, status, progress, provider,
                             reference_media_ids, soul_id)
    values (${w.companyId}::uuid, 'Emily',
            ${over.status ?? "generating_variations"}::influencer_status, 0,
            'higgsfield', ${refs}::uuid[], ${over.soulId ?? null})
    returning id
  `;
  return (rows[0] as unknown as { id: string }).id;
}

function handler(w: World, fake: FakeHiggsfield) {
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
      clientFor: () => fake.client(),
      download: () => Promise.resolve({ body: PNG, contentType: "image/png" }),
      sleep: () => Promise.resolve(),
      random: () => 0,
    },
  });
  return (payload: unknown, attempt = 1) =>
    h({
      jobId: randomUUID(),
      payload,
      attempt,
      maxAttempts: 2,
    } satisfies JobContext<unknown>);
}

async function readRow(id: string) {
  const rows = await handle.sql`
    select status, progress, soul_id, failure_code, failure_message
      from influencers where id = ${id}::uuid
  `;
  return rows[0] as unknown as {
    status: string;
    progress: number;
    soul_id: string | null;
    failure_code: string | null;
    failure_message: string | null;
  };
}

describe("train — crear el personaje", () => {
  it("sube las 4 fotos, crea UNA vez, guarda el id y termina ready 100", async () => {
    const w = await world();
    const id = await seedCharacter(w);
    const fake = new FakeHiggsfield({
      characters: ["queued", "in_progress", "completed"],
    });

    await handler(w, fake)({ companyId: w.companyId, influencerId: id });

    expect(fake.uploads).toHaveLength(4);
    expect(fake.uploads.every((u) => u.contentType === "image/png")).toBe(true);
    expect(fake.creates).toHaveLength(1);
    expect(fake.creates[0]?.name).toBe("Emily");
    expect(fake.creates[0]?.imageUrls).toHaveLength(4);
    expect(await readRow(id)).toMatchObject({
      status: "ready",
      progress: 100,
      soul_id: SOUL,
      failure_code: null,
    });
  });

  it("una reentrega con el id guardado sólo hace polling", async () => {
    const w = await world();
    const id = await seedCharacter(w, { soulId: SOUL, status: "training" });
    const fake = new FakeHiggsfield({ characters: ["completed"] });

    await handler(w, fake)({ companyId: w.companyId, influencerId: id });

    expect(fake.uploads).toHaveLength(0);
    expect(fake.creates).toHaveLength(0);
    expect((await readRow(id)).status).toBe("ready");
  });

  it("Higgsfield lo cierra failed → failed con training_failed y su motivo", async () => {
    const w = await world();
    const id = await seedCharacter(w);
    const fake = new FakeHiggsfield({ characters: ["in_progress", "failed"] });

    await handler(w, fake)({ companyId: w.companyId, influencerId: id });

    expect(await readRow(id)).toMatchObject({
      status: "failed",
      failure_code: "training_failed",
      failure_message: "No face detected",
    });
  });

  it("sin Higgsfield en el registro → not_configured, sin tocar al proveedor", async () => {
    const w = await world({ configured: false });
    const id = await seedCharacter(w);
    const fake = new FakeHiggsfield({});

    await handler(w, fake)({ companyId: w.companyId, influencerId: id });

    expect(fake.uploads).toHaveLength(0);
    expect((await readRow(id)).failure_code).toBe("not_configured");
  });

  it("fotos borradas del Media Bank → references_missing", async () => {
    const w = await world();
    const id = await seedCharacter(w);
    await handle.sql`
      update media set deleted_at = now()
       where media_id = any(${w.mediaIds.slice(0, 2)}::uuid[])
    `;
    const fake = new FakeHiggsfield({});

    await handler(w, fake)({ companyId: w.companyId, influencerId: id });

    expect(fake.creates).toHaveLength(0);
    expect((await readRow(id)).failure_code).toBe("references_missing");
  });

  it("crear rechazado (403 sin créditos) → quota_exceeded", async () => {
    const w = await world();
    const id = await seedCharacter(w);
    const fake = new FakeHiggsfield({
      create: new PortError(
        "quota_exceeded",
        "The Higgsfield account has no credits left",
        {
          source: "test",
        },
      ),
    });

    await handler(w, fake)({ companyId: w.companyId, influencerId: id });

    expect(await readRow(id)).toMatchObject({
      status: "failed",
      failure_code: "quota_exceeded",
    });
  });
});

async function seedGeneration(w: World, influencerId: string): Promise<string> {
  const genId = randomUUID();
  await handle.sql`
    insert into influencer_generations
      (id, company_id, influencer_id, provider, model, prompt, aspect_ratio, count,
       estimate_usd, estimate_basis, spend_month)
    values (${genId}::uuid, ${w.companyId}::uuid, ${influencerId}::uuid, 'higgsfield',
            'higgsfield-ai/soul/v2/standard', 'at the gym, selfie', '9:16', 4,
            0.12, 'Higgsfield estimate', ${MONTH})
  `;
  await w.ledger.update((raw) => {
    const r = reserveSpend(
      parseSpendLedger(raw) ?? EMPTY_SPEND_LEDGER,
      {
        month: MONTH,
        generationId: genId,
        usd: 0.12,
        provider: "higgsfield",
        model: "higgsfield-ai/soul/v2/standard",
        kind: "image",
        companyId: w.companyId,
        at: NOW.toISOString(),
      },
      {},
    );
    if (!r.ok) throw new Error("reserve failed");
    return { next: r.next, result: null };
  });
  return genId;
}

async function spendState(w: World, genId: string): Promise<string | undefined> {
  const ledger = parseSpendLedger(await w.ledger.read());
  return ledger?.months[MONTH]?.[genId]?.state;
}

describe("image — imágenes del personaje", () => {
  it("envía con el personaje, copia al Media Bank sin categoría, arma el set y cobra", async () => {
    const w = await world();
    const inf = await seedCharacter(w, { soulId: SOUL, status: "ready" });
    const genId = await seedGeneration(w, inf);
    const fake = new FakeHiggsfield({
      polls: [{ status: "in_progress", outputs: [] }, done(2)],
    });
    const payload = {
      op: "image",
      companyId: w.companyId,
      influencerId: inf,
      generationId: genId,
    };

    await handler(w, fake)(payload);

    expect(fake.submits).toEqual([
      { characterId: SOUL, prompt: "at the gym, selfie", aspectRatio: "9:16", n: 4 },
    ]);
    const gen = (
      await handle.sql`
        select status, media_ids::text[] as media_ids, provider_request_id
          from influencer_generations where id = ${genId}::uuid`
    )[0] as unknown as {
      status: string;
      media_ids: string[];
      provider_request_id: string;
    };
    expect(gen.status).toBe("ready");
    expect(gen.provider_request_id).toBe("req-1");
    expect(gen.media_ids).toHaveLength(2);

    const media = await handle.sql`
      select categories, origin::text as origin, status::text as status
        from media where media_id = any(${gen.media_ids}::uuid[])`;
    for (const m of media as unknown as {
      categories: string[];
      origin: string;
      status: string;
    }[]) {
      expect(m.categories).toEqual([]);
      expect(m.origin).toBe("brand_kit");
      expect(m.status).toBe("ready");
    }
    const assets = await handle.sql`
      select count(*)::int as n from influencer_assets where influencer_id = ${inf}::uuid`;
    expect((assets[0] as unknown as { n: number }).n).toBe(2);
    expect(await spendState(w, genId)).toBe("charged");

    // Lo que lee Blitz: el set del influencer, con las dos imágenes.
    const planning = await withCompany(handle.db, w.companyId, (tx) =>
      discoveryQueueStore.listPlanningMedia(tx, { companyId: w.companyId }),
    );
    expect(planning.influencerSets).toEqual([
      { influencerId: inf, kind: "SLIDESHOW", mediaIds: gen.media_ids },
    ]);
    expect(planning.media.filter((m) => gen.media_ids.includes(m.id))).toHaveLength(2);

    // Una reentrega del mismo job no reenvía ni duplica.
    await handler(w, fake)(payload);
    expect(fake.submits).toHaveLength(1);
  });

  it("con el pedido ya aceptado, una reentrega retoma el polling sin reenviar", async () => {
    const w = await world();
    const inf = await seedCharacter(w, { soulId: SOUL, status: "ready" });
    const genId = await seedGeneration(w, inf);
    await handle.sql`
      update influencer_generations
         set status = 'generating', provider_request_id = 'req-9',
             provider_status_url = 'https://api.higgsfield.ai/requests/req-9/status'
       where id = ${genId}::uuid`;
    const fake = new FakeHiggsfield({ polls: [done(1)] });

    await handler(
      w,
      fake,
    )({
      op: "image",
      companyId: w.companyId,
      influencerId: inf,
      generationId: genId,
    });

    expect(fake.submits).toHaveLength(0);
    expect(fake.polls).toBe(1);
    const sets = await handle.sql`
      select cardinality(media_ids) as n from media_sets where influencer_id = ${inf}::uuid`;
    expect((sets[0] as unknown as { n: number }).n).toBe(1);
  });

  it("failed del proveedor → failed y la reserva se libera", async () => {
    const w = await world();
    const inf = await seedCharacter(w, { soulId: SOUL, status: "ready" });
    const genId = await seedGeneration(w, inf);
    const fake = new FakeHiggsfield({
      polls: [{ status: "failed", outputs: [], message: "boom" }],
    });

    await handler(
      w,
      fake,
    )({
      op: "image",
      companyId: w.companyId,
      influencerId: inf,
      generationId: genId,
    });

    const gen = (
      await handle.sql`
        select status, error_code from influencer_generations where id = ${genId}::uuid`
    )[0] as unknown as { status: string; error_code: string };
    expect(gen).toEqual({ status: "failed", error_code: "generation_failed" });
    expect(await spendState(w, genId)).toBeUndefined();
  });

  it("un rechazo 4xx al enviar no se cobró: se libera", async () => {
    const w = await world();
    const inf = await seedCharacter(w, { soulId: SOUL, status: "ready" });
    const genId = await seedGeneration(w, inf);
    const fake = new FakeHiggsfield({
      submit: new PortError("bad_request", "Higgsfield rejected the parameters", {
        source: "test",
      }),
    });

    await handler(
      w,
      fake,
    )({
      op: "image",
      companyId: w.companyId,
      influencerId: inf,
      generationId: genId,
    });

    expect(await spendState(w, genId)).toBeUndefined();
  });
});
