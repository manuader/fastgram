/**
 * Campañas (Automations) contra Postgres — `FR-150`, `AI-012`,
 * `P3-AUTO-004…007`, `P3-AUTO-010`.
 *
 * Con un copywriter falso (guionado) y todo lo demás real: la selección de
 * `core` sobre el Media Bank sembrado, el snapshot guardado, RLS con
 * `fastgram_app`, los `FOR UPDATE SKIP LOCKED` de las tandas. Lo que se mide:
 *
 * - una campaña chica se genera por tandas y queda en `REVIEW`, con captions
 *   por destino y la cuota de la campaña sumada;
 * - copy repetida → `FAILED_GEN` con `no_unique_content` (y la cuota de cada
 *   intento); video-hook sin demo → `FAILED_GEN` con `no_demo_video`, sin
 *   gastar LLM; nunca cambia de tipo;
 * - el snapshot manda: las preferencias de la marca no cambian la campaña;
 * - re-roll con tipo forzado;
 * - el dispatcher de `automation-generation` deja al piloto como estaba;
 * - después del launch: slot `SCHEDULED`, campaña `ACTIVE`, barrido encolado,
 *   y el barrido convierte con la conexión y la caption del slot.
 *
 * En los tests negativos la aserción negativa va primero (trampa 35).
 */
import { FixedClock, systemRng } from "@fastgram/adapters";
import {
  JOB_QUEUES,
  buildPrefsSnapshot,
  type AutomationPrefsSnapshot,
  type SuggestionCopyInput,
} from "@fastgram/core";
import {
  APP_ROLE,
  automationSlots,
  automations,
  blitzPreferences,
  companyProfiles,
  connections,
  contents,
  media,
  plannedSlots,
  posts,
  withCompany,
  withoutCompany,
  type DbHandle,
  type Transaction,
} from "@fastgram/db";
import type {
  EnqueuedJob,
  JobContext,
  JobHandler,
  JobSpec,
  Queue,
} from "@fastgram/ports";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAutomationCampaignHandler,
  createAutomationGenerationDispatcher,
} from "../src/automations/generation-handler.js";
import { createAutomationBuildScheduleHandler } from "../src/automations/build-schedule-handler.js";
import { createPublishingSweepHandler } from "../src/publishing/sweep-handler.js";
import type { CopyOutcome, SuggestionCopywriter } from "../src/discovery/copywriter.js";
import type { BuildLogger } from "../src/content/build-handler.js";
import { openDb, seedCompany } from "./helpers/fixtures.js";

const silent: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = "2026-09-24T06:00:00.000Z";
const clock = new FixedClock(NOW);

let handle: DbHandle;
beforeAll(() => {
  handle = openDb();
});
afterAll(async () => {
  await handle?.close();
});

class RecordingQueue implements Queue {
  readonly specs: JobSpec<unknown>[] = [];
  async enqueue<T>(spec: JobSpec<T>): Promise<EnqueuedJob> {
    this.specs.push(spec as JobSpec<unknown>);
    return { jobId: randomUUID(), created: true };
  }
  async enqueueMany(): Promise<never> {
    throw new Error("no se usa");
  }
  async work(): Promise<void> {}
  async getJob(): Promise<null> {
    return null;
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async scheduleRecurring(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  of(queue: string): JobSpec<unknown>[] {
    return this.specs.filter((s) => s.queue === queue);
  }
  /** Saca el primero de esta cola (FIFO). */
  take(queue: string): JobSpec<unknown> | undefined {
    const i = this.specs.findIndex((s) => s.queue === queue);
    if (i < 0) return undefined;
    return this.specs.splice(i, 1)[0];
  }
}

/** Una copy distinta por llamada (o siempre la misma), con las llamadas anotadas. */
function scriptedCopywriter(mode: "unique" | "same"): SuggestionCopywriter & {
  calls: SuggestionCopyInput[];
} {
  const calls: SuggestionCopyInput[] = [];
  const topics = [
    "Cómo elegir el grano para tu cafetera italiana",
    "Tres errores comunes al moler café en casa",
    "Por qué el agua importa más que la máquina",
    "El secreto de una crema perfecta en el espresso",
    "Qué significa tueste medio y por qué nos gusta",
    "Cold brew en verano sin complicarse la vida",
    "La diferencia real entre arábica y robusta",
    "Cuánto café por taza sin pesar nada",
  ];
  return {
    calls,
    async write(input: SuggestionCopyInput): Promise<CopyOutcome> {
      calls.push(input);
      const text =
        mode === "same"
          ? "Los lunes empiezan mejor con un café de especialidad"
          : (topics[(calls.length - 1) % topics.length] ?? "x") +
            ` #${String(calls.length)}`;
      const texts = Array.from({ length: Math.min(2, input.maxTexts) }, (_, i) =>
        i === 0 ? text : `${text} — parte ${String(i + 1)}`,
      );
      return {
        ok: true,
        copy: { texts, explanation: ["Encaja con la marca"] },
        model: "fake-7b",
      };
    },
  };
}

const asBrand = <T>(companyId: string, fn: (tx: Transaction) => Promise<T>) =>
  withCompany(handle.db, companyId, fn, { role: APP_ROLE });

async function seedBrand(opts: { readonly demoVideo?: boolean } = {}): Promise<string> {
  const companyId = await seedCompany(handle);
  await withoutCompany(handle.db, async (tx) => {
    await tx.insert(companyProfiles).values({
      companyId,
      status: "ready",
      coreIdentity: "Tostadores de café de especialidad",
      productOffering: "Café en grano",
    });
    const rows: { type: "image" | "video"; categories: string[] }[] = [
      { type: "image", categories: ["slideshow-image"] },
      { type: "image", categories: ["slideshow-image"] },
      { type: "image", categories: ["slideshow-image"] },
      { type: "video", categories: ["background-video"] },
      { type: "video", categories: ["background-video"] },
      ...(opts.demoVideo === true
        ? [{ type: "video" as const, categories: ["hook-video"] }]
        : []),
    ];
    for (const r of rows) {
      const mediaId = randomUUID();
      const ext = r.type === "image" ? "png" : "mp4";
      await tx.insert(media).values({
        mediaId,
        companyId,
        mediaType: r.type,
        filename: `${mediaId}.${ext}`,
        r2Url: `https://cdn.example.test/${mediaId}.${ext}`,
        storageKey: `media/${mediaId}.${ext}`,
        status: "ready",
        sizeMb: 1,
        categories: r.categories,
        origin: "manual_upload",
      });
    }
  });
  return companyId;
}

const snapshot = (over: Partial<AutomationPrefsSnapshot> = {}): AutomationPrefsSnapshot =>
  ({
    ...buildPrefsSnapshot({
      slideshowWeight: 50,
      wallOfTextWeight: 50,
      greenScreenWeight: 0,
      videoHookWeight: 0,
      remixPercentage: 0,
      ownMediaPercentage: 100,
      mentionBusinessPercentage: 0,
      influencerChance: 0,
      smartTextPositioning: true,
      genderFilter: null,
      angleWeights: {},
      textStyleWeights: {},
    }),
    ...over,
  }) as AutomationPrefsSnapshot;

async function seedCampaign(
  companyId: string,
  opts: {
    readonly types: readonly (
      "slideshow" | "wall-of-text" | "video-hook" | "green-screen"
    )[];
    readonly prefs?: AutomationPrefsSnapshot;
    readonly status?: "GENERATING" | "REVIEW" | "BUILDING";
    readonly accounts?: unknown[];
  },
): Promise<{ automationId: string; slotIds: string[] }> {
  return withoutCompany(handle.db, async (tx) => {
    const [row] = await tx
      .insert(automations)
      .values({
        companyId,
        name: "Campaña de prueba",
        status: opts.status ?? "GENERATING",
        accounts: opts.accounts ?? [
          { platform: "instagram", accountType: "planned" },
          { platform: "youtube", accountType: "planned" },
        ],
        perAccountPerDay: 1,
        durationWeeks: 1,
        startDateUtc: new Date("2026-09-25T00:00:00Z"),
        timezone: "UTC",
        prefsSnapshot: opts.prefs ?? snapshot(),
        generationQuota: opts.types.length * 2,
      })
      .returning({ id: automations.id });
    if (row === undefined) throw new Error("seed");
    const slotIds: string[] = [];
    let i = 0;
    for (const type of opts.types) {
      const [slot] = await tx
        .insert(automationSlots)
        .values({
          automationId: row.id,
          companyId,
          slotIndex: i,
          status: "PENDING_GEN",
          contentType: type,
          scheduledAtUtc: new Date(Date.parse("2026-09-25T09:00:00Z") + i * 86_400_000),
        })
        .returning({ id: automationSlots.id });
      if (slot === undefined) throw new Error("seed slot");
      slotIds.push(slot.id);
      i += 1;
    }
    return { automationId: row.id, slotIds };
  });
}

const ctxOf = (payload: unknown): JobContext<unknown> => ({
  jobId: randomUUID(),
  payload,
  attempt: 1,
  maxAttempts: 3,
});

/** Corre la tanda inicial y las que se vayan encolando, como la cola real. */
async function drain(
  handler: JobHandler<unknown>,
  queue: RecordingQueue,
  first: unknown,
) {
  await handler(ctxOf(first));
  for (let guard = 0; guard < 20; guard += 1) {
    const next = queue.take(JOB_QUEUES.automationGeneration);
    if (next === undefined) return;
    await handler(ctxOf(next.payload));
  }
  throw new Error("la generación no terminó en 20 tandas");
}

const slotsOf = (companyId: string) =>
  asBrand(companyId, (tx) => tx.select().from(automationSlots));
const campaignOf = async (companyId: string) =>
  (await asBrand(companyId, (tx) => tx.select().from(automations)))[0];

describe("generación de una campaña chica (F-213)", () => {
  it("genera por tandas, deja todos READY con captions por destino y pasa a REVIEW", async () => {
    const companyId = await seedBrand();
    const { automationId } = await seedCampaign(companyId, {
      types: ["slideshow", "wall-of-text", "slideshow", "wall-of-text", "slideshow"],
    });
    const queue = new RecordingQueue();
    const copywriter = scriptedCopywriter("unique");
    const handler = createAutomationCampaignHandler({
      db: handle.db,
      appRole: APP_ROLE,
      logger: silent,
      clock,
      queue,
      rng: systemRng,
      copywriter: async () => copywriter,
      quotaPolicy: "unlimited",
      batchSize: 2,
    });
    await drain(handler, queue, { companyId, automationId });

    const slots = await slotsOf(companyId);
    expect(slots.map((s) => s.status)).toEqual([
      "READY",
      "READY",
      "READY",
      "READY",
      "READY",
    ]);
    // AI-012: el tipo de cada slot es el que se le asignó; nunca otro.
    expect(
      slots.sort((a, b) => a.slotIndex - b.slotIndex).map((s) => s.contentType),
    ).toEqual(["slideshow", "wall-of-text", "slideshow", "wall-of-text", "slideshow"]);
    for (const s of slots) {
      const captions = s.captionsByPlatform as Record<
        string,
        { caption: string; description?: string }
      >;
      expect(Object.keys(captions).sort()).toEqual(["instagram", "youtube"]);
      expect(captions["youtube"]?.description).toBe(s.generatedText);
      expect(s.dedupFingerprint).not.toBeNull();
    }
    const campaign = await campaignOf(companyId);
    expect(campaign?.status).toBe("REVIEW");
    expect(campaign?.generationQuotaUsed).toBe(5);
    expect(copywriter.calls).toHaveLength(5);
  });

  it("una tanda toma exactamente batchSize slots y encola la siguiente", async () => {
    const companyId = await seedBrand();
    const { automationId } = await seedCampaign(companyId, {
      types: [
        "wall-of-text",
        "wall-of-text",
        "wall-of-text",
        "wall-of-text",
        "wall-of-text",
      ],
    });
    const queue = new RecordingQueue();
    const copywriter = scriptedCopywriter("unique");
    const handler = createAutomationCampaignHandler({
      db: handle.db,
      appRole: APP_ROLE,
      logger: silent,
      clock,
      queue,
      rng: systemRng,
      copywriter: async () => copywriter,
      quotaPolicy: "unlimited",
      batchSize: 2,
    });
    await handler(ctxOf({ companyId, automationId }));
    const statuses = (await slotsOf(companyId)).map((s) => s.status).sort();
    expect(statuses).toEqual([
      "PENDING_GEN",
      "PENDING_GEN",
      "PENDING_GEN",
      "READY",
      "READY",
    ]);
    expect(queue.of(JOB_QUEUES.automationGeneration)).toHaveLength(1);
    expect((await campaignOf(companyId))?.status).toBe("GENERATING");
  });

  it("copy repetida → FAILED_GEN con no_unique_content, tras los 3 intentos", async () => {
    const companyId = await seedBrand();
    const { automationId } = await seedCampaign(companyId, {
      types: ["wall-of-text", "wall-of-text"],
    });
    const queue = new RecordingQueue();
    const copywriter = scriptedCopywriter("same");
    await drain(
      createAutomationCampaignHandler({
        db: handle.db,
        appRole: APP_ROLE,
        logger: silent,
        clock,
        queue,
        rng: systemRng,
        copywriter: async () => copywriter,
        quotaPolicy: "unlimited",
      }),
      queue,
      { companyId, automationId },
    );
    const slots = (await slotsOf(companyId)).sort((a, b) => a.slotIndex - b.slotIndex);
    expect(slots[1]?.status).toBe("FAILED_GEN");
    expect(slots[1]?.failureReason).toBe("no_unique_content");
    expect(slots[1]?.generatedText).toBeNull();
    expect(slots[0]?.status).toBe("READY");
    // 1 intento del primero + 3 del segundo.
    expect(copywriter.calls).toHaveLength(4);
    expect((await campaignOf(companyId))?.generationQuotaUsed).toBe(4);
    expect((await campaignOf(companyId))?.status).toBe("REVIEW");
  });

  it("video-hook sin demo → FAILED_GEN no_demo_video sin gastar LLM, y no cambia de tipo", async () => {
    const companyId = await seedBrand({ demoVideo: false });
    const { automationId } = await seedCampaign(companyId, {
      types: ["video-hook"],
      prefs: snapshot({
        slideshowWeight: 0,
        wallOfTextWeight: 0,
        greenScreenWeight: 0,
        videoHookWeight: 100,
      }),
    });
    const queue = new RecordingQueue();
    const copywriter = scriptedCopywriter("unique");
    await drain(
      createAutomationCampaignHandler({
        db: handle.db,
        appRole: APP_ROLE,
        logger: silent,
        clock,
        queue,
        rng: systemRng,
        copywriter: async () => copywriter,
        quotaPolicy: "unlimited",
      }),
      queue,
      { companyId, automationId },
    );
    const [slot] = await slotsOf(companyId);
    expect(copywriter.calls).toHaveLength(0);
    expect(slot?.contentType).toBe("video-hook");
    expect(slot?.status).toBe("FAILED_GEN");
    expect(slot?.failureReason).toBe("no_demo_video");
  });

  it("P3-AUTO-003: el snapshot manda, no las preferencias de la marca", async () => {
    const companyId = await seedBrand();
    // La marca pasó a 100 % slideshow DESPUÉS de crear la campaña.
    await withoutCompany(handle.db, (tx) =>
      tx.insert(blitzPreferences).values({
        companyId,
        slideshowWeight: 100,
        wallOfTextWeight: 0,
        greenScreenWeight: 0,
        videoHookWeight: 0,
        remixPercentage: 100,
        ownMediaPercentage: 0,
        mentionBusinessPercentage: 100,
        influencerChance: 0,
        angleWeights: {},
        textStyleWeights: {},
      }),
    );
    const { automationId } = await seedCampaign(companyId, {
      types: ["wall-of-text"],
      prefs: snapshot({
        slideshowWeight: 0,
        wallOfTextWeight: 100,
        greenScreenWeight: 0,
        videoHookWeight: 0,
        mentionBusinessPercentage: 0,
      }),
    });
    const queue = new RecordingQueue();
    const copywriter = scriptedCopywriter("unique");
    await drain(
      createAutomationCampaignHandler({
        db: handle.db,
        appRole: APP_ROLE,
        logger: silent,
        clock,
        queue,
        rng: systemRng,
        copywriter: async () => copywriter,
        quotaPolicy: "unlimited",
      }),
      queue,
      { companyId, automationId },
    );
    const [slot] = await slotsOf(companyId);
    expect(slot?.status).toBe("READY");
    expect(slot?.contentType).toBe("wall-of-text");
    // `mentionBusinessPercentage` 0 del snapshot, no el 100 de la marca.
    expect(copywriter.calls[0]?.mentionBusiness).toBe(false);
  });

  it("sin LLM la campaña queda FAILED con llm_not_configured", async () => {
    const companyId = await seedBrand();
    const { automationId } = await seedCampaign(companyId, { types: ["wall-of-text"] });
    const queue = new RecordingQueue();
    await drain(
      createAutomationCampaignHandler({
        db: handle.db,
        appRole: APP_ROLE,
        logger: silent,
        clock,
        queue,
        rng: systemRng,
        copywriter: async () => null,
        quotaPolicy: "unlimited",
      }),
      queue,
      { companyId, automationId },
    );
    const campaign = await campaignOf(companyId);
    expect(campaign?.status).toBe("FAILED");
    expect(campaign?.failureCode).toBe("llm_not_configured");
  });
});

describe("re-roll (F-215)", () => {
  it("regenera el slot con el tipo forzado y suma cuota", async () => {
    const companyId = await seedBrand();
    const { automationId, slotIds } = await seedCampaign(companyId, {
      types: ["slideshow"],
      status: "REVIEW",
    });
    const [slotId] = slotIds as [string];
    await withoutCompany(handle.db, (tx) =>
      tx
        .update(automationSlots)
        .set({ status: "REROLLING", contentType: "wall-of-text" }),
    );
    const queue = new RecordingQueue();
    const copywriter = scriptedCopywriter("unique");
    const handler = createAutomationCampaignHandler({
      db: handle.db,
      appRole: APP_ROLE,
      logger: silent,
      clock,
      queue,
      rng: systemRng,
      copywriter: async () => copywriter,
      quotaPolicy: "unlimited",
    });
    await handler(
      ctxOf({ companyId, automationId, slotId, contentType: "wall-of-text" }),
    );
    const [slot] = await slotsOf(companyId);
    expect(slot?.status).toBe("READY");
    expect(slot?.contentType).toBe("wall-of-text");
    expect((await campaignOf(companyId))?.generationQuotaUsed).toBe(1);
  });
});

describe("automation-generation se comparte con el piloto", () => {
  it("con automationId va a la campaña; sin él, al piloto como antes", async () => {
    const seen: string[] = [];
    const dispatcher = createAutomationGenerationDispatcher({
      campaign: async () => {
        seen.push("campaign");
      },
      autopilot: async (ctx) => {
        seen.push(`autopilot:${JSON.stringify(ctx.payload)}`);
      },
      logger: silent,
    });
    const companyId = randomUUID();
    await dispatcher(ctxOf({}));
    await dispatcher(ctxOf({ companyId }));
    await dispatcher(ctxOf({ companyId, automationId: randomUUID() }));
    expect(seen).toEqual([
      "autopilot:{}",
      `autopilot:${JSON.stringify({ companyId })}`,
      "campaign",
    ]);
  });
});

describe("después del launch (F-217): build-schedule y barrido de publicación", () => {
  async function seedLaunched(contentStatus: "CREATED" | "FAILED") {
    const companyId = await seedBrand();
    const connectionId = await withoutCompany(handle.db, async (tx) => {
      const [conn] = await tx
        .insert(connections)
        .values({
          companyId,
          platform: "instagram",
          platformUserId: `u-${randomUUID().slice(0, 8)}`,
          platformUsername: "cafe",
          publishable: true,
        })
        .returning({ id: connections.id });
      return conn?.id ?? "";
    });
    const { automationId, slotIds } = await seedCampaign(companyId, {
      types: ["wall-of-text"],
      status: "BUILDING",
      accounts: [{ platform: "instagram", accountType: "oauth", connectionId }],
    });
    const [slotId] = slotIds as [string];
    const scheduledAt = new Date("2026-09-25T09:00:00Z");
    await withoutCompany(handle.db, async (tx) => {
      const [content] = await tx
        .insert(contents)
        .values({
          companyId,
          type: "wall-of-text",
          status: contentStatus,
          files: contentStatus === "CREATED" ? ["https://cdn.example.test/out.mp4"] : [],
          generatedText: "Tres errores comunes al moler café en casa",
        })
        .returning({ id: contents.id });
      if (content === undefined) throw new Error("seed content");
      await tx.update(automationSlots).set({
        status: "QUEUED_BUILD",
        contentId: content.id,
        generatedText: "Tres errores comunes al moler café en casa",
        captionsByPlatform: { instagram: { caption: "Caption de la campaña ☕" } },
      });
      await tx.insert(plannedSlots).values({
        companyId,
        contentId: content.id,
        network: "instagram",
        scheduledAtUtc: scheduledAt,
        automationSlotId: slotId,
        connectionId,
      });
    });
    return { companyId, automationId, slotId, connectionId };
  }

  it("pieza CREATED → slot SCHEDULED, campaña ACTIVE, barrido encolado; el barrido usa conexión y caption del slot", async () => {
    const { companyId, automationId, slotId, connectionId } =
      await seedLaunched("CREATED");
    const queue = new RecordingQueue();
    const build = createAutomationBuildScheduleHandler({
      db: handle.db,
      appRole: APP_ROLE,
      logger: silent,
      clock,
      queue,
      publishingSweep: true,
    });
    await build(ctxOf({ companyId, automationId }));
    const [slot] = await slotsOf(companyId);
    expect(slot?.status).toBe("SCHEDULED");
    expect((await campaignOf(companyId))?.status).toBe("ACTIVE");
    expect(queue.of(JOB_QUEUES.publishingSweep)).toHaveLength(1);
    // ACTIVE: no se re-arma solo (lo cierra el cron).
    expect(queue.of(JOB_QUEUES.automationBuildSchedule)).toHaveLength(0);

    await createPublishingSweepHandler({
      db: handle.db,
      queue,
      clock,
      appRole: APP_ROLE,
      logger: silent,
    })(ctxOf({ companyId }));
    const [post] = await asBrand(companyId, (tx) => tx.select().from(posts));
    expect(post?.connectionId).toBe(connectionId);
    expect(post?.caption).toBe("Caption de la campaña ☕");
    expect(post?.automationSlotId).toBe(slotId);
    const [after] = await slotsOf(companyId);
    expect(after?.postIds).toEqual([post?.id]);
  });

  it("pieza FAILED → slot FAILED sin slot planificado, y la campaña FAILED (ninguna salió)", async () => {
    const { companyId, automationId } = await seedLaunched("FAILED");
    const queue = new RecordingQueue();
    await createAutomationBuildScheduleHandler({
      db: handle.db,
      appRole: APP_ROLE,
      logger: silent,
      clock,
      queue,
      publishingSweep: true,
    })(ctxOf({ companyId, automationId }));
    expect(await asBrand(companyId, (tx) => tx.select().from(plannedSlots))).toHaveLength(
      0,
    );
    const [slot] = await slotsOf(companyId);
    expect(slot?.status).toBe("FAILED");
    expect(slot?.errorCode).toBe("build_failed");
    const campaign = await campaignOf(companyId);
    expect(campaign?.status).toBe("FAILED");
    expect(campaign?.failureCode).toBe("all_builds_failed");
    expect(queue.of(JOB_QUEUES.publishingSweep)).toHaveLength(0);
  });
});
