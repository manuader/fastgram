/**
 * «Edit» del deck → señal `edit_before_accept` — sprint 9 (T), `PU-S9-015`.
 *
 * Contra Postgres real y con RLS (misma arnés que `preferences.int.test.ts`
 * de Q, cuyas fixtures se repiten acá para no tocar un archivo ajeno):
 *
 *  - `POST /blitz` con `via: "edit"` guarda la aceptación como
 *    `edit_before_accept` (aspecto vacío, todos los rasgos en `added`, peso
 *    0,5) en vez de `accept`;
 *  - las ediciones siguientes de esa pieza son `edit_before_accept` por
 *    aspecto (no `edit_after_accept`);
 *  - sin `via`, todo como antes; un `via` desconocido es 400;
 *  - una copia de la biblioteca global en la marca (`media/{cid}/library/…`)
 *    aprende como `bg.source=library`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  apiKeys,
  companies,
  companyProfiles,
  media,
  suggestions,
  users,
  withoutCompany,
} from "@fastgram/db";

import { generateApiKey } from "../src/auth/api-keys.js";
import { startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;

interface Brand {
  readonly companyId: string;
  readonly token: string;
  readonly ownerUserId: string;
}

async function newOwner(): Promise<string> {
  return withoutCompany(api.handle.db, async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        externalIdentityId: `test_${randomUUID()}`,
        email: `prefs-${randomUUID()}@test.local`,
        fullName: "prefs",
        timezone: "UTC",
      })
      .returning({ id: users.id });
    if (user === undefined) throw new Error("no se creó el user");
    return user.id;
  });
}

async function newBrand(ownerUserId: string): Promise<Brand> {
  return withoutCompany(api.handle.db, async (tx) => {
    const [company] = await tx
      .insert(companies)
      .values({
        name: `prefs ${randomUUID().slice(0, 8)}`,
        ownerUserId,
        status: "active",
        planId: "growth",
        subscriptionStatus: "active",
        billingAnchorDay: 1,
        timezone: "UTC",
      })
      .returning({ id: companies.id });
    if (company === undefined) throw new Error("no se creó la company");
    await tx.insert(companyProfiles).values({
      companyId: company.id,
      status: "ready",
      coreIdentity: "pymes",
    });
    const key = generateApiKey();
    await tx.insert(apiKeys).values({
      companyId: company.id,
      label: "prefs",
      hash: key.hash,
      kind: "workspace",
    });
    return { companyId: company.id, token: key.token, ownerUserId };
  });
}

async function seedMedia(
  b: Brand,
  type: "image" | "video",
  tags: string[],
): Promise<{ mediaId: string; url: string }> {
  const mediaId = randomUUID();
  const ext = type === "image" ? "png" : "mp4";
  const url = `https://bucket.test/media/${b.companyId}/${mediaId}.${ext}`;
  await withoutCompany(api.handle.db, async (tx) => {
    await tx.insert(media).values({
      mediaId,
      companyId: b.companyId,
      mediaType: type,
      filename: `${mediaId}.${ext}`,
      r2Url: url,
      storageKey: `media/${b.companyId}/${mediaId}.${ext}`,
      status: "ready",
      sizeMb: 1,
      categories: [type === "image" ? "green-screen-background" : "green-screen-video"],
      tags,
      origin: "manual_upload",
      videoDurationSec: type === "video" ? 4 : null,
    });
  });
  return { mediaId, url };
}

/** Un green screen construible: fondo con esas etiquetas y un meme de reacción. */
async function greenScreen(b: Brand, bgTags: string[]): Promise<string> {
  const image = await seedMedia(b, "image", bgTags);
  const video = await seedMedia(b, "video", ["reaction", "shocked"]);
  return withoutCompany(api.handle.db, async (tx) => {
    const [row] = await tx
      .insert(suggestions)
      .values({
        companyId: b.companyId,
        contentType: "green-screen",
        generatedText: "POV: monday",
        aiExplanation: "porque sí",
        buildPlan: {
          version: 1,
          media: { format: "green-screen", image, video },
          texts: ["POV: monday"],
        },
      })
      .returning({ id: suggestions.id });
    if (row === undefined) throw new Error("no se creó la sugerencia");
    return row.id;
  });
}

function call(
  b: Brand,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return api.request({
    method,
    path: `/api/v1${path}`,
    token: b.token,
    ...(body === undefined ? {} : { body }),
    headers,
  });
}

const accept = (b: Brand, suggestionId: string) =>
  call(b, "POST", "/blitz", { suggestionId });

interface SignalRow {
  kind: string;
  aspect: string;
  features: string[];
  removed: string[];
  added: string[];
  content_id: string | null;
}

async function markCreated(contentId: string): Promise<void> {
  await api.handle
    .sql`update contents set status = 'CREATED' where id = ${contentId}::uuid`;
}

async function editable(b: Brand, contentId: string) {
  const res = await call(b, "GET", `/content/${contentId}/editable`);
  expect(res.status, res.raw).toBe(200);
  const [row] = (await api.handle.sql`
    select revision from contents where id = ${contentId}::uuid
  `) as unknown as [{ revision: number }];
  const body = res.body?.["data"] as { textBoxes: Record<string, unknown>[] };
  return { revision: row.revision, textBoxes: body.textBoxes };
}

beforeAll(async () => {
  api = await startApi({ now: "2026-09-28T12:00:00.000Z", mode: "personal" });
}, 180_000);

beforeEach(() => {
  api.queue.reset();
});

afterAll(async () => {
  await api?.close();
});

interface WeightedSignal extends SignalRow {
  weight: number;
}

async function weightedSignalsOf(b: Brand): Promise<WeightedSignal[]> {
  return (await api.handle.sql`
    select kind, aspect, features, removed, added, content_id, weight
      from preference_signals where company_id = ${b.companyId}::uuid
     order by occurred_at, kind, aspect
  `) as unknown as WeightedSignal[];
}

async function patchImage(b: Brand, contentId: string, url: string): Promise<void> {
  const ed = await editable(b, contentId);
  const r = await api.request({
    method: "PATCH",
    path: `/api/v1/content/${contentId}`,
    token: b.token,
    idempotencyKey: randomUUID(),
    body: { revision: ed.revision, textBoxes: ed.textBoxes, assets: { image: { url } } },
  });
  expect(r.status, r.raw).toBe(200);
  await markCreated(contentId);
}

describe('«Edit» del deck: `via: "edit"` en POST /blitz', () => {
  it("la aceptación se guarda como `edit_before_accept`: sin aspecto, rasgos en `added`, peso 0,5", async () => {
    const b = await newBrand(await newOwner());
    const id = await greenScreen(b, ["dark", "office"]);

    const res = await call(b, "POST", "/blitz", { suggestionId: id, via: "edit" });
    expect(res.status, res.raw).toBe(202);
    const contentId = (res.body?.["data"] as { _id: string })._id;

    const signals = await weightedSignalsOf(b);
    expect(signals).toHaveLength(1);
    const [s] = signals;
    expect(s).toMatchObject({
      kind: "edit_before_accept",
      aspect: "",
      content_id: contentId,
      weight: 0.5,
      removed: [],
    });
    expect(s?.added).toEqual(s?.features);
    expect(s?.features).toEqual(
      expect.arrayContaining(["format=green-screen", "bg.tone=dark", "clip.kind=shock"]),
    );

    // Y cuenta: la marca aprendió (media aceptación por rasgo).
    const [w] = (await api.handle.sql`
      select signal_count, stats from preference_weights
       where company_id = ${b.companyId}::uuid
    `) as unknown as {
      signal_count: number;
      stats: { features: Record<string, { pos: number }> };
    }[];
    expect(w?.signal_count).toBe(1);
    expect(w?.stats.features["format=green-screen"]?.pos).toBeCloseTo(0.5, 9);
  });

  it("las ediciones de esa pieza son `edit_before_accept` por aspecto (0,5), no `edit_after_accept`", async () => {
    const b = await newBrand(await newOwner());
    const id = await greenScreen(b, ["dark"]);
    const light = await seedMedia(b, "image", ["bright", "kitchen"]);

    const res = await call(b, "POST", "/blitz", { suggestionId: id, via: "edit" });
    const contentId = (res.body?.["data"] as { _id: string })._id;
    await markCreated(contentId);
    await patchImage(b, contentId, light.url);

    const signals = await weightedSignalsOf(b);
    expect(signals.map((s) => `${s.kind}:${s.aspect}`).sort()).toEqual([
      "edit_before_accept:",
      "edit_before_accept:background",
    ]);
    expect(signals.find((s) => s.aspect === "background")).toMatchObject({
      removed: ["bg.tone=dark"],
      added: ["bg.tone=light"],
      weight: 0.5,
      content_id: contentId,
    });
  });

  it("sin `via`, la aceptación es `accept` y sus ediciones `edit_after_accept` (como antes)", async () => {
    const b = await newBrand(await newOwner());
    const id = await greenScreen(b, ["dark"]);
    const light = await seedMedia(b, "image", ["bright"]);
    const res = await accept(b, id);
    const contentId = (res.body?.["data"] as { _id: string })._id;
    await markCreated(contentId);
    await patchImage(b, contentId, light.url);
    expect(
      (await weightedSignalsOf(b)).map((s) => `${s.kind}:${s.aspect}`).sort(),
    ).toEqual(["accept:", "edit_after_accept:background"]);
  });

  it("un `via` desconocido es 400 y no acepta nada", async () => {
    const b = await newBrand(await newOwner());
    const id = await greenScreen(b, ["dark"]);
    const res = await call(b, "POST", "/blitz", { suggestionId: id, via: "swipe" });
    expect(res.status, res.raw).toBe(400);
    expect(await weightedSignalsOf(b)).toHaveLength(0);
  });
});

describe("la biblioteca global en los rasgos", () => {
  it("un fondo copiado de la biblioteca (`media/{cid}/library/…`) aprende `bg.source=library`", async () => {
    const b = await newBrand(await newOwner());
    const id = await greenScreen(b, ["dark"]);
    const libId = randomUUID();
    const url = `https://bucket.test/media/${b.companyId}/library/${libId}.png`;
    await withoutCompany(api.handle.db, async (tx) => {
      await tx.insert(media).values({
        mediaId: libId,
        companyId: b.companyId,
        mediaType: "image",
        filename: "lib.png",
        r2Url: url,
        storageKey: `media/${b.companyId}/library/${libId}.png`,
        status: "ready",
        sizeMb: 1,
        categories: ["green-screen-background"],
        tags: ["night"],
        origin: "manual_upload",
      });
    });
    await api.handle.sql`
      update suggestions
         set build_plan = jsonb_set(build_plan, '{media,image}',
               ${JSON.stringify({ mediaId: libId, url })}::jsonb)
       where id = ${id}::uuid
    `;
    const res = await accept(b, id);
    expect(res.status, res.raw).toBe(202);
    const [s] = await weightedSignalsOf(b);
    expect(s?.features).toEqual(
      expect.arrayContaining(["bg.source=library", "bg.tone=dark"]),
    );
    expect(s?.features).not.toContain("bg.source=upload");
  });
});
