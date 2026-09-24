/**
 * Biblioteca de modelos del dueño en el worker — sprint 8 (agente K).
 *
 * `influencer-pipeline` con un payload `{op: "model-train"}` entrena un
 * modelo **a nivel dueño**: las fotos son claves propias en
 * `models/{owner}/…` (las copió la API), el estado va a `character_models`.
 * El proveedor es un doble de `CharacterGen` con los estados documentados de
 * Higgsfield (`/docs/models/soul-id/create-character`). Ninguna llamada real.
 *
 * Y `P4-JV-004`: `readRefillSubject` trae el perfil del modelo de cada
 * influencer que viene de la biblioteca, para que `JV-6` lo use.
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
import type { CharacterGen, CharacterSnapshot } from "@fastgram/core";
import {
  APP_ROLE,
  CHARACTER_MODEL_TRAIN_OP,
  withCompany,
  type DbHandle,
} from "@fastgram/db";
import type { JobContext } from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import { readRefillSubject } from "../src/discovery/refill-handler.js";
import { createInfluencerPipelineHandler } from "../src/influencers/pipeline-handler.js";
import { openDb, seedCompany } from "./helpers/fixtures.js";

const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = new Date("2026-09-24T12:00:00.000Z");
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
  home = await mkdtemp(join(tmpdir(), "fastgram-models-"));
});

class FakeHiggsfield {
  uploads = 0;
  creates: { name: string; imageUrls: readonly string[] }[] = [];
  gets = 0;
  constructor(private readonly statuses: CharacterSnapshot["status"][]) {}
  client(): CharacterGen {
    return {
      uploadImage: () => {
        this.uploads += 1;
        return Promise.resolve(`https://cdn.higgsfield.ai/u/${String(this.uploads)}.png`);
      },
      createCharacter: (input) => {
        this.creates.push(input);
        return Promise.resolve(snap("queued"));
      },
      getCharacter: () => {
        const s =
          this.statuses[Math.min(this.gets++, this.statuses.length - 1)] ?? "completed";
        return Promise.resolve(snap(s));
      },
      estimateCharacterImage: () => Promise.reject(new Error("unused")),
      generateCharacterImage: () => Promise.reject(new Error("unused")),
      poll: () => Promise.reject(new Error("unused")),
    };
  }
}

function snap(status: CharacterSnapshot["status"]): CharacterSnapshot {
  return {
    id: SOUL,
    status,
    thumbnailUrl: null,
    failReason: status === "failed" ? "No face detected" : null,
  };
}

async function ownerOf(companyId: string): Promise<string> {
  const rows =
    await handle.sql`select owner_user_id from companies where id = ${companyId}::uuid`;
  return (rows[0] as unknown as { owner_user_id: string }).owner_user_id;
}

interface World {
  readonly ownerUserId: string;
  readonly companyId: string;
  readonly storage: MemoryStorage;
  readonly modelId: string;
}

async function world(
  opts: { photos?: number; configured?: boolean; soulId?: string } = {},
): Promise<World> {
  const companyId = await seedCompany(handle);
  const ownerUserId = await ownerOf(companyId);
  const storage = new MemoryStorage(new FixedClock(NOW));
  const modelId = randomUUID();
  const keys: string[] = [];
  for (let i = 0; i < (opts.photos ?? 4); i += 1) {
    const key = `models/${ownerUserId}/${modelId}/ref-${String(i)}.png`;
    await storage.put({ key, body: PNG, contentType: "image/png" });
    keys.push(key);
  }
  await handle.sql`
    insert into character_models (id, owner_user_id, name, source, status, progress,
                                  portrait_key, portrait_url, reference_keys, soul_id)
    values (${modelId}::uuid, ${ownerUserId}::uuid, 'Mia', 'photos', 'training', 0,
            ${keys[0] ?? null}, 'http://localhost:9000/fastgram/x.png', ${keys}::text[],
            ${opts.soulId ?? null})
  `;
  if (opts.configured !== false) {
    await new FileModelRegistry({ path: join(home, "models.json") }).write("image", {
      provider: "higgsfield",
      baseUrl: "https://api.higgsfield.ai",
      model: "higgsfield-ai/soul/v2/standard",
      apiKey: "KEYID:SECRET",
    });
  }
  return { ownerUserId, companyId, storage, modelId };
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
      ledger: new JsonFileDocument(join(home, "spend.json")),
      clientFor: () => fake.client(),
      download: () => Promise.resolve({ body: PNG, contentType: "image/png" }),
      sleep: () => Promise.resolve(),
      random: () => 0,
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

async function readModel(id: string) {
  const rows = await handle.sql`
    select status, progress, soul_id, failure_code from character_models where id = ${id}::uuid`;
  return rows[0] as unknown as {
    status: string;
    progress: number;
    soul_id: string | null;
    failure_code: string | null;
  };
}

const job = (w: World) => ({
  op: CHARACTER_MODEL_TRAIN_OP,
  modelId: w.modelId,
  ownerUserId: w.ownerUserId,
});

describe("model-train — entrenar un modelo del dueño", () => {
  it("sube las fotos de la biblioteca, crea UNA vez y termina ready con el Soul ID", async () => {
    const w = await world();
    const fake = new FakeHiggsfield(["queued", "in_progress", "completed"]);
    await handler(w, fake)(job(w));
    expect(fake.uploads).toBe(4);
    expect(fake.creates).toHaveLength(1);
    expect(fake.creates[0]?.name).toBe("Mia");
    expect(await readModel(w.modelId)).toEqual({
      status: "ready",
      progress: 100,
      soul_id: SOUL,
      failure_code: null,
    });
  });

  it("una reentrega con el Soul ID guardado sólo hace polling", async () => {
    const w = await world({ soulId: SOUL });
    const fake = new FakeHiggsfield(["completed"]);
    await handler(w, fake)(job(w));
    expect(fake.uploads).toBe(0);
    expect(fake.creates).toHaveLength(0);
    expect((await readModel(w.modelId)).status).toBe("ready");
  });

  it("Higgsfield lo cierra failed → training_failed", async () => {
    const w = await world();
    await handler(w, new FakeHiggsfield(["in_progress", "failed"]))(job(w));
    expect(await readModel(w.modelId)).toMatchObject({
      status: "failed",
      failure_code: "training_failed",
    });
  });

  it("sin Higgsfield → not_configured, sin tocar al proveedor", async () => {
    const w = await world({ configured: false });
    const fake = new FakeHiggsfield([]);
    await handler(w, fake)(job(w));
    expect(fake.uploads).toBe(0);
    expect((await readModel(w.modelId)).failure_code).toBe("not_configured");
  });

  it("una foto que ya no está en el storage → upload_failed, sin crear", async () => {
    const w = await world();
    const rows = await handle.sql`
      select reference_keys from character_models where id = ${w.modelId}::uuid`;
    const keys = (rows[0] as unknown as { reference_keys: string[] }).reference_keys;
    await w.storage.delete(keys[2] as string);
    const fake = new FakeHiggsfield([]);
    await handler(w, fake)(job(w));
    expect(fake.creates).toHaveLength(0);
    expect((await readModel(w.modelId)).status).toBe("failed");
  });

  it("el job con el dueño equivocado no toca el modelo (scope por dueño)", async () => {
    const w = await world();
    const other = await ownerOf(await seedCompany(handle));
    const fake = new FakeHiggsfield(["completed"]);
    await handler(w, fake)({ ...job(w), ownerUserId: other });
    expect(fake.uploads).toBe(0);
    expect((await readModel(w.modelId)).status).toBe("training");
  });
});

describe("P4-JV-004 — el perfil del modelo llega a JV-6", () => {
  it("readRefillSubject trae edad, estilo y notas de los influencers de la biblioteca", async () => {
    const companyId = await seedCompany(handle);
    const ownerUserId = await ownerOf(companyId);
    const modelId = randomUUID();
    await handle.sql`
      insert into character_models (id, owner_user_id, name, source, status, progress,
                                    soul_id, portrait_url, age, style, notes)
      values (${modelId}::uuid, ${ownerUserId}::uuid, 'Mia', 'soul_id', 'ready', 100,
              ${SOUL}, 'http://localhost:9000/fastgram/x.png', 27, 'streetwear',
              'gym and coffee')`;
    const linked = await handle.sql`
      insert into influencers (company_id, name, status, progress, provider, soul_id, model_id)
      values (${companyId}::uuid, 'Mia', 'ready', 100, 'higgsfield', ${SOUL}, ${modelId}::uuid)
      returning id`;
    const own = await handle.sql`
      insert into influencers (company_id, name, status, progress)
      values (${companyId}::uuid, 'Local', 'ready', 100)
      returning id`;
    const linkedId = (linked[0] as unknown as { id: string }).id;
    const ownId = (own[0] as unknown as { id: string }).id;

    const subject = await withCompany(
      handle.db,
      companyId,
      (tx) => readRefillSubject(tx, companyId),
      { role: APP_ROLE },
    );
    expect(subject.influencerProfiles?.get(linkedId)).toBe(
      "age: 27; style: streetwear; notes: gym and coffee",
    );
    expect(subject.influencerProfiles?.has(ownId)).toBe(false);
  });
});
