/**
 * Selección y aprendizaje en el refill — sprint 9 (T), `PU-S9-015`, contra
 * Postgres real y con `SET LOCAL ROLE fastgram_app`.
 *
 * Qué persigue:
 *
 *  1. **Preferencias en el plan**: dos marcas idénticas, mismo `Rng`
 *     sembrado; la que aprendió «green-screen sí, slideshow no» recibe una
 *     cola sesgada, y la que no aprendió nada, la de siempre. Las preferencias
 *     se leen de verdad (`preferenceSnapshotStore` bajo el rol de la app).
 *  2. **La biblioteca global en el decisor, con Laya real** (si
 *     `127.0.0.1:3006` responde): un green-screen donde los memes de la marca
 *     no tienen nada que ver con el tema y los de la biblioteca sí. El ganador
 *     sale de la biblioteca, se copia al Media Bank de la marca, la sugerencia
 *     apunta a la copia, y `asset_decisions` guarda candidatos, fuente y
 *     exclusiones.
 *     Sin Laya, el test se saltea y lo dice.
 *  3. **Estilo del design system** en la copy y el `build_plan` (parche de M).
 */
import {
  FixedClock,
  MemoryStorage,
  SeededRng,
  SystemOneJudgmentAdapter,
  canonicalObjectUrl,
} from "@fastgram/adapters";
import { aggregatePreferenceSignals, type PreferenceSignal } from "@fastgram/core";
import {
  APP_ROLE,
  blitzPreferences,
  brandDesignSystems,
  companyProfiles,
  contentAngles,
  libraryAssets,
  media,
  preferenceWeightsStore,
  withoutCompany,
  type DbHandle,
} from "@fastgram/db";
import type { JobContext, Llm, LlmJsonRequest } from "@fastgram/ports";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import { createLlmCopywriter } from "../src/discovery/copywriter.js";
import type { Jv6JudgmentProvider } from "../src/discovery/jv6.js";
import { createDiscoveryRefillHandler } from "../src/discovery/refill-handler.js";
import { createAssetJudge } from "../src/judgment/asset-decider.js";
import { libraryCopyMediaId } from "../src/judgment/library-source.js";
import { openDb, seedCompany } from "./helpers/fixtures.js";

const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };
const LAYA_URL = "http://127.0.0.1:3006";
const NOW = Date.now();

let handle: DbHandle;
const storage = new MemoryStorage(new FixedClock(new Date("2026-09-28T12:00:00.000Z")));

beforeAll(async () => {
  handle = openDb();
  // La biblioteca es de la instalación: lo que dejó otra suite compite.
  await handle.db.delete(libraryAssets);
}, 120_000);

afterAll(async () => {
  await handle?.close();
});

/** Un LLM falso detrás del copywriter real; graba los pedidos. */
class FakeLlm implements Llm {
  readonly requests: LlmJsonRequest[] = [];
  async complete(): Promise<never> {
    throw new Error("la copy va por completeJson");
  }
  async completeJson(req: LlmJsonRequest) {
    this.requests.push(req);
    const value = { texts: ["Texto generado"], explanation: ["Hook claro"] };
    return {
      value,
      raw: JSON.stringify(value),
      finishReason: "stop" as const,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "fake-model",
      deterministic: true,
      latencyMs: 0,
    };
  }
}

const ctx = (payload: unknown): JobContext<unknown> => ({
  jobId: `job_${randomUUID().slice(0, 8)}`,
  payload,
  attempt: 1,
  maxAttempts: 3,
});

async function seedMix(
  companyId: string,
  w: { slideshow: number; wall: number; green: number; hook: number },
  angleWeights: Record<string, number>,
): Promise<void> {
  await withoutCompany(handle.db, async (tx) => {
    await tx.insert(blitzPreferences).values({
      companyId,
      slideshowWeight: w.slideshow,
      wallOfTextWeight: w.wall,
      greenScreenWeight: w.green,
      videoHookWeight: w.hook,
      remixPercentage: 0,
      ownMediaPercentage: 0,
      mentionBusinessPercentage: 0,
      influencerChance: 0,
      genderFilter: null,
      angleWeights,
      textStyleWeights: {},
    });
    await tx.insert(companyProfiles).values({
      companyId,
      status: "ready",
      coreIdentity: "An accounting app for freelancers",
      toneOfVoice: "funny, relaxed",
      targetAudience: "freelancers",
    });
  });
}

async function seedAngle(companyId: string, title: string): Promise<string> {
  return withoutCompany(handle.db, async (tx) => {
    const [row] = await tx
      .insert(contentAngles)
      .values({ companyId, title, isActive: true })
      .returning({ id: contentAngles.id });
    if (row === undefined) throw new Error("no se creó el ángulo");
    return row.id;
  });
}

async function seedMedia(
  companyId: string,
  type: "image" | "video",
  category: string,
  filename: string,
  tags: string[] = [],
): Promise<string> {
  const mediaId = randomUUID();
  const ext = type === "image" ? "png" : "mp4";
  const storageKey = `media/${companyId}/${mediaId}.${ext}`;
  await withoutCompany(handle.db, async (tx) => {
    await tx.insert(media).values({
      mediaId,
      companyId,
      mediaType: type,
      filename: `${filename}.${ext}`,
      r2Url: await canonicalObjectUrl(storage, storageKey),
      storageKey,
      status: "ready",
      sizeMb: 1,
      categories: [category],
      tags,
      origin: "manual_upload",
    });
  });
  return mediaId;
}

async function seedFullBank(companyId: string): Promise<void> {
  await seedMedia(companyId, "image", "slideshow-image", "a");
  await seedMedia(companyId, "image", "slideshow-image", "b");
  await seedMedia(companyId, "image", "green-screen-background", "c");
  await seedMedia(companyId, "video", "background-video", "d");
  await seedMedia(companyId, "video", "green-screen-video", "e");
  await seedMedia(companyId, "video", "hook-video", "f");
}

async function learn(companyId: string, signals: PreferenceSignal[]): Promise<void> {
  const stats = aggregatePreferenceSignals(signals, { nowMs: NOW });
  await withoutCompany(handle.db, (tx) =>
    preferenceWeightsStore.putStats(
      tx,
      { companyId },
      { stats, signalCount: stats.signalCount, computedAt: new Date(NOW) },
    ),
  );
}

async function queueOf(companyId: string) {
  return (await handle.sql`
    select content_type, angle_id, generated_text, ai_explanation, build_plan
      from suggestions where company_id = ${companyId}::uuid
     order by created_at, id
  `) as unknown as {
    content_type: string;
    angle_id: string | null;
    generated_text: string | null;
    ai_explanation: string | null;
    build_plan: Record<string, unknown>;
  }[];
}

const tally = (rows: readonly { content_type: string }[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.content_type] = (out[r.content_type] ?? 0) + 1;
  return out;
};

describe("preferencias en el plan del refill", () => {
  it("misma semilla: sin señales la cola de siempre; con «green-screen sí, slideshow no» se corre", async () => {
    const plain = await seedCompany(handle);
    const tuned = await seedCompany(handle);
    for (const c of [plain, tuned]) {
      const angle = await seedAngle(c, "Freelancers and late invoices");
      await seedMix(
        c,
        { slideshow: 25, wall: 25, green: 25, hook: 25 },
        { [angle]: 100 },
      );
      await seedFullBank(c);
    }
    const times = (n: number, s: Omit<PreferenceSignal, "occurredAtMs">) =>
      Array.from({ length: n }, () => ({ ...s, occurredAtMs: NOW }));
    await learn(tuned, [
      ...times(8, { kind: "accept", features: ["format=green-screen"] }),
      ...times(8, { kind: "discard", features: ["format=slideshow"] }),
    ]);

    const run = async (companyId: string) => {
      const handler = createDiscoveryRefillHandler({
        db: handle.db,
        rng: new SeededRng(4242),
        copywriter: createLlmCopywriter({
          llm: new FakeLlm(),
          fence: () => "fence-0123456789abcdef",
        }),
        appRole: APP_ROLE,
        logger: {
          ...silencioso,
          info: (obj, msg) => {
            if (msg === "cola rellenada")
              console.info("[T] refill log:", JSON.stringify(obj));
          },
        },
        targetQueuedItems: 200,
      });
      await handler(ctx({ companyId }));
      return tally(await queueOf(companyId));
    };
    const before = await run(plain);
    const after = await run(tuned);
    // Los números del run de referencia (semilla 4242, 200 sugerencias).
    console.info(
      "[T] refill 200, semilla 4242 — sin señales:",
      before,
      "— con señales:",
      after,
    );
    expect(Object.values(before).reduce((a, b) => a + b, 0)).toBe(200);
    expect(Object.values(after).reduce((a, b) => a + b, 0)).toBe(200);
    expect(after["green-screen"] ?? 0).toBeGreaterThan(before["green-screen"] ?? 0);
    expect(after["slideshow"] ?? 0).toBeLessThan(before["slideshow"] ?? 0);
  }, 60_000);
});

describe("estilo del design system en el refill (parche de M)", () => {
  it("la voz va a la copy como dato y el estilo de caption al build_plan", async () => {
    const c = await seedCompany(handle);
    const angle = await seedAngle(c, "Tax season");
    await seedMix(c, { slideshow: 100, wall: 0, green: 0, hook: 0 }, { [angle]: 100 });
    await seedFullBank(c);
    await withoutCompany(handle.db, async (tx) => {
      await tx.insert(brandDesignSystems).values({
        companyId: c,
        name: "Test DS",
        status: "ready",
        active: true,
        version: 1,
        source: "derived",
        tokens: {
          colors: [],
          semantic: {
            surfaceDark: "#101828",
            surfaceLight: "#FFFFFF",
            textOnDark: "#FFFFFF",
            textOnLight: "#101828",
            accents: ["#FF5A1F"],
          },
        },
        style: {
          voice: "Dry humor, short sentences, never uses emojis.",
          origin: "owner",
        },
      });
    });
    const llm = new FakeLlm();
    await createDiscoveryRefillHandler({
      db: handle.db,
      rng: new SeededRng(7),
      copywriter: createLlmCopywriter({ llm, fence: () => "fence-0123456789abcdef" }),
      appRole: APP_ROLE,
      logger: silencioso,
      targetQueuedItems: 1,
    })(ctx({ companyId: c }));
    const request = JSON.stringify(llm.requests[0] ?? {});
    const [row] = await queueOf(c);
    console.info(
      "[T] design system → copy:",
      request.includes("Dry humor") ? "voz presente" : "SIN voz",
      "| build_plan.textStyle:",
      JSON.stringify(row?.build_plan["textStyle"] ?? null),
    );
    expect(request).toContain("Dry humor");
  }, 60_000);
});

async function layaUp(): Promise<boolean> {
  try {
    const res = await fetch(`${LAYA_URL}/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { status?: string; loaded?: unknown[] };
    return res.ok && body.status === "ok" && (body.loaded?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

const CC0 = {
  type: "cc0",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Example.webm",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  verifiedAt: "2026-09-28T12:00:00.000Z",
};
const CC_BY = {
  type: "cc-by",
  version: "4.0",
  attribution: "Jane Doe / Wikimedia Commons",
  author: "Jane Doe",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Example2.webm",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  verifiedAt: "2026-09-28T12:00:00.000Z",
};

async function seedLibraryClip(o: {
  title: string;
  description: string;
  emotions: string[];
  useCases: string[];
  tags: string[];
  license: Record<string, unknown>;
  licenseType: string;
}): Promise<string> {
  const id = randomUUID();
  const storageKey = `library/${id}/clip.mp4`;
  await storage.put({
    key: storageKey,
    body: new TextEncoder().encode(`clip ${o.title}`),
    contentType: "video/mp4",
  });
  const metadata = {
    schemaVersion: 1,
    kind: "green_screen_video",
    description: o.description,
    memeType: "reaction",
    emotions: o.emotions,
    useCases: o.useCases,
    characters: ["office worker"],
    tags: o.tags,
    language: null,
    hasSpeech: false,
    durationSec: 4,
    aspect: { ratio: "9:16", width: 1080, height: 1920 },
    framing: "half_body",
    chroma: { type: "green", keyQuality: 0.95, keyColor: "#00FF00" },
    nsfw: false,
    energy: "high",
    needsReview: false,
    license: o.license,
  };
  await handle.db.insert(libraryAssets).values({
    id,
    title: o.title,
    kind: "green_screen_video",
    mediaType: "video",
    status: "ready",
    provider: "wikimedia",
    externalId: `File:${id}.webm`,
    storageKey,
    url: await canonicalObjectUrl(storage, storageKey),
    contentType: "video/mp4",
    sizeMb: 0.1,
    durationSec: 4,
    width: 1080,
    height: 1920,
    license: o.license,
    licenseType: o.licenseType,
    licenseSourceUrl: `https://commons.wikimedia.org/wiki/File:${id}.webm`,
    metadata,
    searchText: [o.title, o.description, ...o.emotions, ...o.useCases, ...o.tags].join(
      " \n",
    ),
  });
  return id;
}

describe("la biblioteca global en el decisor, con Laya real", () => {
  it("un green-screen donde gana un clip de la biblioteca: se copia a la marca y queda en asset_decisions", async (t) => {
    if (!(await layaUp())) {
      console.warn(`[T] Laya no responde en ${LAYA_URL}: test salteado`);
      t.skip();
      return;
    }
    const c = await seedCompany(handle);
    const angle = await seedAngle(c, "When a client finally pays a late invoice");
    await seedMix(c, { slideshow: 0, wall: 0, green: 100, hook: 0 }, { [angle]: 100 });
    // La marca: tres memes que no tienen nada que ver con el tema, y fondos.
    const brandClips = [
      await seedMedia(c, "video", "green-screen-video", "cat sleeping on a sofa", [
        "cat",
        "sleeping",
        "sofa",
      ]),
      await seedMedia(c, "video", "green-screen-video", "car driving on a highway", [
        "car",
        "highway",
        "driving",
      ]),
      await seedMedia(c, "video", "green-screen-video", "chef cooking pasta", [
        "cooking",
        "pasta",
        "kitchen",
      ]),
    ];
    await seedMedia(c, "image", "green-screen-background", "plain office background", [
      "office",
    ]);
    await seedMedia(c, "image", "green-screen-background", "sunset beach", ["beach"]);

    // La biblioteca: cuatro con el tema (CC0 / CC BY). Una licencia no
    // verificable (CC BY-SA) no puede ni entrar a la tabla (CHECK de la 0036):
    // el filtro `license` del decisor está fijado en los tests de `core`.
    const lib = [
      await seedLibraryClip({
        title: "Man celebrating with money raining",
        description:
          "An excited man throws money in the air and celebrates getting paid.",
        emotions: ["joy", "excitement"],
        useCases: ["when a client finally pays", "payday", "an invoice gets paid"],
        tags: ["money", "celebrate", "payday", "invoice"],
        license: CC0,
        licenseType: "cc0",
      }),
      await seedLibraryClip({
        title: "Woman dancing in relief at her desk",
        description:
          "A freelancer dances with relief at her desk after checking her bank account.",
        emotions: ["joy", "calm"],
        useCases: ["when the payment finally arrives", "late invoice paid"],
        tags: ["dance", "relief", "freelancer", "payment"],
        license: CC_BY,
        licenseType: "cc-by",
      }),
      await seedLibraryClip({
        title: "Office worker laughing hysterically",
        description: "An office worker laughs hysterically at his computer screen.",
        emotions: ["laughter"],
        useCases: ["when something absurd happens at work"],
        tags: ["laugh", "office"],
        license: CC0,
        licenseType: "cc0",
      }),
      await seedLibraryClip({
        title: "Man sighing and waiting impatiently",
        description:
          "A man taps his fingers and sighs, waiting for something that never comes.",
        emotions: ["frustration", "boredom"],
        useCases: ["waiting for a client to pay", "waiting forever"],
        tags: ["waiting", "impatient", "invoice"],
        license: CC0,
        licenseType: "cc0",
      }),
    ];

    const titles = new Map(
      (
        (await handle.sql`select id::text, title from library_assets`) as unknown as {
          id: string;
          title: string;
        }[]
      ).map((r) => [r.id, r.title]),
    );
    const laya = new SystemOneJudgmentAdapter({
      baseUrl: LAYA_URL,
      model: "auto",
      adapter: "laya",
      defaultTimeoutMs: 8000,
    });
    const logs: { msg: string; obj: unknown }[] = [];
    const logger: BuildLogger = {
      info: (obj, msg) => logs.push({ obj, msg }),
      warn: (obj, msg) => logs.push({ obj, msg }),
      error: (obj, msg) => logs.push({ obj, msg }),
    };
    const jv6: Jv6JudgmentProvider = Object.assign(async () => null, {
      assets: async (subject: { companyId: string; subjectType: string }) =>
        createAssetJudge({
          judgment: laya,
          subject,
          db: handle.db,
          appRole: APP_ROLE,
          logger,
        }),
    });

    const started = Date.now();
    await createDiscoveryRefillHandler({
      db: handle.db,
      rng: new SeededRng(99),
      copywriter: createLlmCopywriter({
        llm: new FakeLlm(),
        fence: () => "fence-0123456789abcdef",
      }),
      appRole: APP_ROLE,
      logger,
      storage,
      judgment: jv6,
      targetQueuedItems: 1,
    })(ctx({ companyId: c }));
    const elapsed = Date.now() - started;
    for (const l of logs) {
      if (/juicio|biblioteca|copiado|decisor/u.test(l.msg)) {
        console.info("[T] log:", l.msg, JSON.stringify(l.obj).slice(0, 400));
      }
    }

    const [row] = await queueOf(c);
    expect(row?.content_type).toBe("green-screen");
    const plan = row?.build_plan as {
      media: { video: { mediaId: string; url: string }; image: { mediaId: string } };
    };
    const decisions = (await handle.sql`
      select role, chosen_id, mode, reason, latency_ms, candidates, excluded, scored
        from asset_decisions where company_id = ${c}::uuid order by created_at
    `) as unknown as {
      role: string;
      chosen_id: string | null;
      mode: string;
      reason: string;
      latency_ms: number;
      candidates: { id: string; source: string; textRank: number }[];
      excluded: { id: string; reason: string }[];
      scored: { id: string; total: number | null; fit: number | null; status: string }[];
    }[];
    const meme = decisions.find((d) => d.role === "meme");
    const name = (id: string | null) =>
      id === null
        ? "—"
        : brandClips.includes(id)
          ? `marca:${id.slice(0, 8)}`
          : lib.includes(id)
            ? `biblioteca:${titles.get(id) ?? id.slice(0, 8)}`
            : id.slice(0, 8);
    console.info(
      "[T] Laya refill green-screen: total %d ms; decisiones:",
      elapsed,
      decisions.map((d) => ({
        role: d.role,
        mode: d.mode,
        latencyMs: d.latency_ms,
        chosen: name(d.chosen_id),
        candidates: d.candidates.map((x) => `${x.source}:${x.id.slice(0, 8)}`),
        excluded: d.excluded.map((x) => `${x.id.slice(0, 8)}:${x.reason}`),
        top: [...d.scored]
          .filter((s) => s.total !== null)
          .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
          .slice(0, 4)
          .map((s) => `${name(s.id)} ${(s.total ?? 0).toFixed(3)}`),
        reason: d.reason,
      })),
    );

    expect(meme).toBeDefined();
    expect(meme?.candidates.some((x) => x.source === "library")).toBe(true);
    expect(meme?.mode).toBe("judged");
    const winner = meme?.chosen_id ?? null;
    expect(lib).toContain(winner);
    // La sugerencia apunta a la **copia** en la marca, no a `library/`.
    const copyId = libraryCopyMediaId(c, winner ?? "");
    expect(plan.media.video.mediaId).toBe(copyId);
    expect(decodeURIComponent(plan.media.video.url)).toContain(`media/${c}/library/`);
    const [copy] = (await handle.sql`
      select status, categories, origin, deleted_at from media
       where company_id = ${c}::uuid and media_id = ${copyId}::uuid
    `) as unknown as { status: string; categories: string[]; origin: string }[];
    expect(copy).toMatchObject({
      status: "ready",
      categories: ["green-screen-video"],
      origin: "manual_upload",
    });
    expect(row?.ai_explanation ?? "").toContain("global library");
  }, 120_000);
});
