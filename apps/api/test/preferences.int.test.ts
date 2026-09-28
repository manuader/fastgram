/**
 * Preferencias aprendidas desde Blitz — sprint 9 (agente Q), `PU-S9-011`.
 *
 * Lo que persigue este archivo, contra Postgres real y con RLS:
 *
 *  - aceptar, descartar y editar **por la API** dejan su señal y los pesos
 *    de la marca (y el aporte al dueño) se recalculan;
 *  - editar dos veces el mismo aspecto deja **una** señal (la última), y
 *    volver al original la borra;
 *  - si guardar la señal falla, la decisión **sigue** (savepoint);
 *  - `GET /preferences` muestra lo aprendido; otra marca del mismo dueño lo
 *    hereda como prior; `GET /preferences/owner` es owner-level;
 *  - reset con confirmación; cruce de tenant → 404.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { preferencesViewSchema, type PreferencesView } from "@fastgram/contracts";
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

const HEADER = "x-fastgram-workspace";

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
const discard = (b: Brand, suggestionId: string) =>
  call(b, "POST", `/blitz/queue/${suggestionId}/discard`);

async function view(
  b: Brand,
  headers: Record<string, string> = {},
): Promise<PreferencesView> {
  const res = await call(b, "GET", "/preferences", undefined, headers);
  expect(res.status, res.raw).toBe(200);
  return preferencesViewSchema.parse(res.body?.["data"]);
}

interface SignalRow {
  kind: string;
  aspect: string;
  features: string[];
  removed: string[];
  added: string[];
  content_id: string | null;
}

async function signalsOf(b: Brand): Promise<SignalRow[]> {
  return (await api.handle.sql`
    select kind, aspect, features, removed, added, content_id
      from preference_signals where company_id = ${b.companyId}::uuid
     order by occurred_at, kind, aspect
  `) as unknown as SignalRow[];
}

async function weightsOf(
  b: Brand,
): Promise<{ signal_count: number; stats: unknown } | undefined> {
  const rows = (await api.handle.sql`
    select signal_count, stats from preference_weights where company_id = ${b.companyId}::uuid
  `) as unknown as { signal_count: number; stats: unknown }[];
  return rows[0];
}

async function ownerBrandKeys(ownerUserId: string): Promise<string[]> {
  const rows = (await api.handle.sql`
    select coalesce(array(select jsonb_object_keys(brand_stats)), '{}') as keys
      from owner_preferences where owner_user_id = ${ownerUserId}::uuid
  `) as unknown as { keys: string[] }[];
  return rows[0]?.keys ?? [];
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

describe("captura de señales por la API", () => {
  it("aceptar deja una señal accept con los rasgos, y recalcula marca y dueño", async () => {
    const owner = await newOwner();
    const b = await newBrand(owner);
    const id = await greenScreen(b, ["dark", "office"]);

    const res = await accept(b, id);
    expect(res.status).toBe(202);
    const contentId = (res.body?.["data"] as { _id: string })._id;

    const signals = await signalsOf(b);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: "accept",
      aspect: "",
      content_id: contentId,
    });
    expect(signals[0]?.features).toEqual(
      expect.arrayContaining([
        "format=green-screen",
        "bg.tone=dark",
        "clip.kind=reaction",
        "clip.kind=shock",
        "text.len=short",
        "origin=refill",
        "duration=short",
      ]),
    );
    expect((await weightsOf(b))?.signal_count).toBe(1);
    expect(await ownerBrandKeys(owner)).toEqual([b.companyId]);
  });

  it("descartar deja una señal discard; los pesos suben de a una", async () => {
    const b = await newBrand(await newOwner());
    const one = await greenScreen(b, ["dark"]);
    const two = await greenScreen(b, ["dark"]);

    expect((await discard(b, one)).status).toBe(204);
    expect((await discard(b, two)).status).toBe(204);

    const signals = await signalsOf(b);
    expect(signals.map((s) => s.kind)).toEqual(["discard", "discard"]);
    expect((await weightsOf(b))?.signal_count).toBe(2);
  });

  it("editar después de aceptar: una señal por aspecto, la última gana, y volver al original la borra", async () => {
    const b = await newBrand(await newOwner());
    const id = await greenScreen(b, ["dark"]);
    const light = await seedMedia(b, "image", ["bright", "kitchen"]);
    const other = await seedMedia(b, "image", ["white", "studio"]);

    const res = await accept(b, id);
    const contentId = (res.body?.["data"] as { _id: string })._id;
    await markCreated(contentId);

    const patch = async (url: string) => {
      const ed = await editable(b, contentId);
      const r = await api.request({
        method: "PATCH",
        path: `/api/v1/content/${contentId}`,
        token: b.token,
        idempotencyKey: randomUUID(),
        body: {
          revision: ed.revision,
          textBoxes: ed.textBoxes,
          assets: { image: { url } },
        },
      });
      expect(r.status, r.raw).toBe(200);
      await markCreated(contentId);
    };

    await patch(light.url);
    let edits = (await signalsOf(b)).filter((s) => s.kind === "edit_after_accept");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      aspect: "background",
      removed: ["bg.tone=dark"],
      added: ["bg.tone=light"],
      content_id: contentId,
    });

    // Otro fondo claro: la misma señal (upsert), no dos.
    await patch(other.url);
    edits = (await signalsOf(b)).filter((s) => s.kind === "edit_after_accept");
    expect(edits).toHaveLength(1);

    // De vuelta al fondo original: ya no es una corrección.
    const original = (await api.handle.sql`
      select r2_url from media where company_id = ${b.companyId}::uuid
        and 'dark' = any(tags)
    `) as unknown as { r2_url: string }[];
    await patch(original[0]?.r2_url ?? "");
    edits = (await signalsOf(b)).filter((s) => s.kind === "edit_after_accept");
    expect(edits).toHaveLength(0);
  });

  it("si guardar la señal falla, la aceptación sigue (savepoint) y no queda señal", async () => {
    const b = await newBrand(await newOwner());
    const id = await greenScreen(b, ["dark"]);
    await api.handle.sql.unsafe(
      `alter table preference_signals add constraint prefs_test_block check (weight < 0) not valid`,
    );
    try {
      const res = await accept(b, id);
      expect(res.status).toBe(202);
      const pieces = (await api.handle.sql`
        select count(*)::int as n from contents where company_id = ${b.companyId}::uuid
      `) as unknown as [{ n: number }];
      expect(pieces[0].n).toBe(1);
      expect(await signalsOf(b)).toEqual([]);
    } finally {
      await api.handle.sql.unsafe(
        `alter table preference_signals drop constraint prefs_test_block`,
      );
    }
  });
});

describe("lo que se muestra y se configura", () => {
  let owner: string;
  let home: Brand;
  let sibling: Brand;

  beforeAll(async () => {
    owner = await newOwner();
    home = await newBrand(owner);
    sibling = await newBrand(owner);
    // Cuatro fondos oscuros descartados: pasa la evidencia mínima (3).
    for (let i = 0; i < 4; i += 1) {
      expect((await discard(home, await greenScreen(home, ["dark"]))).status).toBe(204);
    }
  });

  it("GET /preferences: lo aprendido con su evidencia", async () => {
    const v = await view(home);
    expect(v.scope).toBe("brand");
    expect(v.signals.total).toBe(4);
    const dark = v.learned.find((l) => l.feature === "bg.tone=dark");
    expect(dark).toMatchObject({
      direction: "avoids",
      accepts: 0,
      total: 4,
      source: "brand",
    });
    expect(v.settings).toMatchObject({
      enabled: true,
      exploration: 0.15,
      halfLifeDays: 30,
      explorationSource: "owner",
    });
  });

  it("otra marca del mismo dueño lo hereda como prior (fuente: owner)", async () => {
    const v = await view(sibling);
    expect(v.signals.total).toBe(0);
    const dark = v.learned.find((l) => l.feature === "bg.tone=dark");
    expect(dark?.direction).toBe("avoids");
    expect(dark?.source).toBe("owner");
  });

  it("GET /preferences/owner ignora la marca activa", async () => {
    const plain = await call(home, "GET", "/preferences/owner");
    const other = await call(home, "GET", "/preferences/owner", undefined, {
      [HEADER]: sibling.companyId,
    });
    expect(plain.status).toBe(200);
    expect(other.body).toEqual(plain.body);
    const v = preferencesViewSchema.parse(plain.body?.["data"]);
    expect(v.scope).toBe("owner");
    expect(v.learned.find((l) => l.feature === "bg.tone=dark")?.direction).toBe("avoids");
  });

  it("PATCH: la marca fija su exploración; el dueño cambia el default de las demás", async () => {
    const res = await call(home, "PATCH", "/preferences", { exploration: 0.3 });
    expect(res.status).toBe(200);
    expect(preferencesViewSchema.parse(res.body?.["data"]).settings).toMatchObject({
      exploration: 0.3,
      explorationSource: "brand",
    });
    const o = await call(home, "PATCH", "/preferences/owner", { exploration: 0.25 });
    expect(o.status).toBe(200);
    expect((await view(sibling)).settings).toMatchObject({
      exploration: 0.25,
      explorationSource: "owner",
    });
    expect((await view(home)).settings.exploration).toBe(0.3);

    expect((await call(home, "PATCH", "/preferences", { exploration: 0.9 })).status).toBe(
      400,
    );
    expect((await call(home, "PATCH", "/preferences", {})).status).toBe(400);
  });

  it("reset: sin confirmación 400; con ella la marca olvida y sale del dueño", async () => {
    expect(
      (await call(home, "POST", "/preferences/reset", { scope: "brand" })).status,
    ).toBe(400);
    const res = await call(home, "POST", "/preferences/reset", {
      scope: "brand",
      confirm: true,
    });
    expect(res.status).toBe(200);
    const v = preferencesViewSchema.parse(res.body?.["data"]);
    expect(v.signals.total).toBe(0);
    expect(v.learned).toEqual([]);
    expect(await signalsOf(home)).toEqual([]);
    expect(await ownerBrandKeys(owner)).not.toContain(home.companyId);
    // La configuración sobrevive al reset.
    expect(v.settings.exploration).toBe(0.3);
  });

  it("reset del dueño: el nivel del dueño se vacía, las marcas conservan lo suyo", async () => {
    await discard(sibling, await greenScreen(sibling, ["dark"]));
    expect(await ownerBrandKeys(owner)).toContain(sibling.companyId);
    const res = await call(sibling, "POST", "/preferences/reset", {
      scope: "owner",
      confirm: true,
    });
    expect(res.status).toBe(200);
    expect(await ownerBrandKeys(owner)).toEqual([]);
    expect(await signalsOf(sibling)).toHaveLength(1);
  });
});

describe("cruce de tenant → 404", () => {
  it("descartar la sugerencia de otro dueño es 404 y no deja señal en ninguna marca", async () => {
    const mine = await newBrand(await newOwner());
    const theirs = await newBrand(await newOwner());
    const id = await greenScreen(theirs, ["dark"]);

    expect((await discard(mine, id)).status).toBe(404);
    expect(await signalsOf(mine)).toEqual([]);
    expect(await signalsOf(theirs)).toEqual([]);
  });

  it("GET /preferences con la marca de otro dueño en el header es 404", async () => {
    const mine = await newBrand(await newOwner());
    const theirs = await newBrand(await newOwner());
    const res = await call(mine, "GET", "/preferences", undefined, {
      [HEADER]: theirs.companyId,
    });
    expect(res.status).toBe(404);
  });

  it("editar la pieza de otro dueño es 404 y no deja señal", async () => {
    const mine = await newBrand(await newOwner());
    const theirs = await newBrand(await newOwner());
    const res = await accept(theirs, await greenScreen(theirs, ["dark"]));
    const contentId = (res.body?.["data"] as { _id: string })._id;
    await markCreated(contentId);
    const r = await api.request({
      method: "PATCH",
      path: `/api/v1/content/${contentId}`,
      token: mine.token,
      idempotencyKey: randomUUID(),
      body: {
        revision: 1,
        textBoxes: [
          {
            id: "slide-0-text-0",
            text: "hola",
            position: { x: 50, y: 15 },
            widthPercent: 90,
            font: { family: "inter", weight: 400, size: 18 },
            color: "#FFFFFF",
            stroke: { width: 3, color: "#000000" },
            background: null,
          },
        ],
      },
    });
    expect(r.status).toBe(404);
    expect((await signalsOf(theirs)).map((s) => s.kind)).toEqual(["accept"]);
  });
});
