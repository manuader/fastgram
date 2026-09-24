/**
 * El piloto automático contra Postgres — `PU-AUTO-001`, `PU-AUTO-002`.
 *
 * Con un `Judgment` falso (guionado por el texto de la sugerencia) y todo lo
 * demás real: la aceptación por el caso de uso de `core`, el ledger, el
 * auto-slot, los slots planificados, RLS con `fastgram_app`. Lo que se mide:
 *
 * - aprueba → pieza `BUILDING` + build encolado + slot planificado + decisión;
 * - rechaza → sugerencia `discarded` + motivo guardado, sin pieza;
 * - timeout → la sugerencia **sigue `queued`**, `held`, y la corrida corta;
 * - marca manual → sólo relleno, el juicio no se llama;
 * - cupo → no se aprueba más de lo que la estrategia agenda en el horizonte;
 * - barrido → una corrida por marca con estrategia, clave por ventana.
 *
 * En los tests negativos la aserción negativa va primero (trampa 35).
 */
import { FixedClock, systemRng } from "@fastgram/adapters";
import { JOB_QUEUES, SUGGESTION_BUILD_PLAN_VERSION } from "@fastgram/core";
import {
  APP_ROLE,
  autopilotDecisions,
  autopilotRuns,
  brandStrategies,
  companyProfiles,
  contents,
  media,
  plannedSlots,
  suggestions,
  withCompany,
  withoutCompany,
  type DbHandle,
  type Transaction,
} from "@fastgram/db";
import {
  PortError,
  type AskRequest,
  type EnqueuedJob,
  type Judgment,
  type JobSpec,
  type JudgmentBatchOutcome,
  type JudgmentQuestion,
  type Queue,
} from "@fastgram/ports";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAutopilotHandler, type AutopilotDeps } from "../src/autopilot/handler.js";
import type { SuggestionCopywriter } from "../src/discovery/copywriter.js";
import type { BuildLogger } from "../src/content/build-handler.js";
import { openDb, seedCompany } from "./helpers/fixtures.js";

const silent: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };
/** Jueves 24/09/2026, 06:00 UTC: las ventanas de 09:00 del día están libres. */
const NOW = "2026-09-24T06:00:00.000Z";

let handle: DbHandle;

beforeAll(() => {
  handle = openDb();
});

afterAll(async () => {
  await handle?.close();
});

/* ------------------------------------------------------------------------ *
 * Dobles
 * ------------------------------------------------------------------------ */

/** Honra `singletonKey` como el adaptador real (trampa 43): clave repetida → `created: false`. */
class RecordingQueue implements Queue {
  readonly specs: JobSpec<unknown>[] = [];
  readonly #keys = new Set<string>();
  async enqueue<T>(spec: JobSpec<T>): Promise<EnqueuedJob> {
    const key = spec.options?.singletonKey;
    if (key !== undefined) {
      const full = `${spec.queue}|${key}`;
      if (this.#keys.has(full)) return { jobId: full, created: false };
      this.#keys.add(full);
    }
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
}

type Script = "good" | "third_party" | "hang" | "down";

/**
 * Un `Judgment` que responde según una palabra de la copy. Sólo `ask`: es lo
 * único que el piloto usa. Las respuestas cumplen el contrato del puerto.
 */
class ScriptedJudgment implements Judgment {
  readonly provenance = { adapter: "stub", model: "scripted-1" };
  asked = 0;
  constructor(readonly script: (caption: string) => Script) {}
  async choice(): Promise<never> {
    throw new Error("no se usa");
  }
  async score(): Promise<never> {
    throw new Error("no se usa");
  }
  async noul(): Promise<never> {
    throw new Error("no se usa");
  }
  async ask<const Q extends readonly JudgmentQuestion[]>(
    request: AskRequest<Q>,
  ): Promise<JudgmentBatchOutcome<Q>> {
    this.asked += 1;
    const caption = String(request.state["caption"]);
    const mode = this.script(caption);
    if (mode === "hang") return new Promise(() => {});
    if (mode === "down") {
      throw new PortError("provider_unavailable", "down", { source: "Judgment/test" });
    }
    const noul = (p: number) => ({ kind: "noul" as const, probability: p });
    const answers = {
      onBrand: noul(0.9),
      riskyClaims: {
        kind: "choice" as const,
        value: "none",
        probabilities: {
          none: 0.97,
          health_claim: 0.01,
          financial_claim: 0.01,
          legal_claim: 0.01,
        },
        confidence: 0.95,
      },
      thirdPartyBrands: noul(mode === "third_party" ? 0.92 : 0.05),
      coherent: noul(0.95),
      inLanguage: noul(0.95),
    };
    return {
      answers: answers as unknown as JudgmentBatchOutcome<Q>["answers"],
      usage: { latencyMs: 1 },
    };
  }
}

const copywriterOn = async (): Promise<SuggestionCopywriter> =>
  ({ write: () => Promise.reject(new Error("no se usa")) }) as SuggestionCopywriter;

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

const WINDOWS = Object.fromEntries(
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [
    d,
    ["09:00", "13:00", "19:00"],
  ]),
);

async function seedBrand(options: {
  readonly autonomy: "manual" | "autopilot";
  readonly perDay?: number;
  readonly suggestions: readonly string[];
}): Promise<{ companyId: string; suggestionIds: string[] }> {
  const companyId = await seedCompany(handle);
  const mediaId = randomUUID();
  const suggestionIds: string[] = [];
  await withoutCompany(handle.db, async (tx) => {
    await tx.insert(companyProfiles).values({
      companyId,
      status: "ready",
      coreIdentity: "Tostadores de café de especialidad",
      productOffering: "Café en grano",
    });
    await tx.insert(brandStrategies).values({
      companyId,
      networks: [
        { network: "instagram", enabled: true, perDay: options.perDay ?? 2, dailyCap: 3 },
      ],
      windows: WINDOWS,
      formatMix: {},
      language: "es",
      autonomy: options.autonomy,
      jitterMinutes: 0,
      brandGapMinutes: 0,
    });
    await tx.insert(media).values({
      mediaId,
      companyId,
      mediaType: "video",
      filename: `${mediaId}.mp4`,
      r2Url: `https://cdn.example.test/${mediaId}.mp4`,
      storageKey: `media/${mediaId}.mp4`,
      status: "ready",
      sizeMb: 1,
      categories: ["wall_of_text"],
      origin: "manual_upload",
    });
    let t = new Date("2026-09-23T10:00:00Z").getTime();
    for (const text of options.suggestions) {
      const id = randomUUID();
      suggestionIds.push(id);
      await tx.insert(suggestions).values({
        id,
        companyId,
        contentType: "wall-of-text",
        generatedText: text,
        createdAt: new Date(t),
        buildPlan: {
          version: SUGGESTION_BUILD_PLAN_VERSION,
          media: {
            format: "wall-of-text",
            video: { mediaId, url: `https://cdn.example.test/${mediaId}.mp4` },
          },
          texts: [text],
        },
      });
      t += 60_000;
    }
  });
  return { companyId, suggestionIds };
}

function deps(over: Partial<AutopilotDeps> & { queue: RecordingQueue }): AutopilotDeps {
  return {
    db: handle.db,
    appRole: APP_ROLE,
    logger: silent,
    clock: new FixedClock(NOW),
    rng: systemRng,
    copywriter: copywriterOn,
    judgment: async () => new ScriptedJudgment(() => "good"),
    quotaPolicy: "unlimited",
    personal: true,
    publishingSweep: true,
    precheckTimeoutMs: 200,
    refill: async () => {},
    ...over,
  };
}

const run = (handler: ReturnType<typeof createAutopilotHandler>, payload: unknown) =>
  handler({ jobId: randomUUID(), payload, attempt: 1, maxAttempts: 3 });

/**
 * Lecturas con el scope de la marca y `fastgram_app`: RLS filtra por ella, así
 * que no hace falta un `WHERE` (y `drizzle-orm` no es dependencia de esta app).
 */
const asBrand = <T>(companyId: string, fn: (tx: Transaction) => Promise<T>) =>
  withCompany(handle.db, companyId, fn, { role: APP_ROLE });

async function statusOf(
  companyId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const rows = await asBrand(companyId, (tx) => tx.select().from(suggestions));
  return new Map(rows.filter((r) => ids.includes(r.id)).map((r) => [r.id, r.status]));
}

const decisionsOf = (companyId: string) =>
  asBrand(companyId, (tx) => tx.select().from(autopilotDecisions));

const contentsOf = (companyId: string) =>
  asBrand(companyId, (tx) => tx.select().from(contents));

const slotsOf = (companyId: string) =>
  asBrand(companyId, (tx) => tx.select().from(plannedSlots));

const runOf = async (companyId: string) =>
  (await asBrand(companyId, (tx) => tx.select().from(autopilotRuns)))[0];

/* ------------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------------ */

describe("piloto: pre-chequeo → aprobación → calendario (PU-AUTO-002)", () => {
  it("aprueba: pieza BUILDING con su build encolado, slot planificado y decisión con respuestas", async () => {
    const { companyId, suggestionIds } = await seedBrand({
      autonomy: "autopilot",
      suggestions: ["Tostamos cada lunes: así se nota en la taza"],
    });
    const queue = new RecordingQueue();
    await run(createAutopilotHandler(deps({ queue })), { companyId });

    const [id] = suggestionIds;
    expect((await statusOf(companyId, suggestionIds)).get(id as string)).toBe("popped");

    const pieces = await contentsOf(companyId);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.status).toBe("BUILDING");
    expect(queue.of(JOB_QUEUES.contentBuild)).toHaveLength(1);

    const slots = await slotsOf(companyId);
    expect(slots.map((s) => s.network)).toEqual(["instagram"]);
    // La primera ventana libre del día, sin jitter: 09:00 UTC.
    expect(slots[0]?.scheduledAtUtc.toISOString()).toBe("2026-09-24T09:00:00.000Z");
    expect(slots[0]?.contentId).toBe(pieces[0]?.id);

    const [decision] = await decisionsOf(companyId);
    expect(decision?.decision).toBe("approved");
    expect(decision?.contentId).toBe(pieces[0]?.id);
    const details = decision?.details as Record<string, unknown>;
    expect(details["answers"]).not.toBeNull();
    expect(details["scheduled"]).toEqual([
      { network: "instagram", atMs: Date.parse("2026-09-24T09:00:00.000Z") },
    ]);

    // El barrido de publicación convierte el slot cuando la pieza termine.
    expect(queue.of(JOB_QUEUES.publishingSweep)).toHaveLength(1);
    const state = await runOf(companyId);
    expect(state).toMatchObject({ outcome: "ran", approved: 1, rejected: 0, held: 0 });
  });

  it("rechaza: la descarta con el motivo guardado, sin pieza", async () => {
    const { companyId, suggestionIds } = await seedBrand({
      autonomy: "autopilot",
      suggestions: ["Mejor que Starbucks, y lo decimos en serio"],
    });
    const queue = new RecordingQueue();
    const judgment = new ScriptedJudgment((c) =>
      c.includes("Starbucks") ? "third_party" : "good",
    );
    await run(createAutopilotHandler(deps({ queue, judgment: async () => judgment })), {
      companyId,
    });

    const pieces = await contentsOf(companyId);
    expect(pieces).toHaveLength(0);
    expect(queue.of(JOB_QUEUES.contentBuild)).toHaveLength(0);
    expect(
      (await statusOf(companyId, suggestionIds)).get(suggestionIds[0] as string),
    ).toBe("discarded");
    const [decision] = await decisionsOf(companyId);
    expect(decision).toMatchObject({ decision: "rejected", reason: "third_party_brand" });
    expect((decision?.details as Record<string, unknown>)["reasons"]).toEqual([
      "third_party_brand",
    ]);
    expect(await runOf(companyId)).toMatchObject({ rejected: 1, approved: 0 });
  });

  it("timeout del juicio: sigue queued, held, y la corrida corta (no aprueba nada)", async () => {
    const { companyId, suggestionIds } = await seedBrand({
      autonomy: "autopilot",
      suggestions: ["uno", "dos"],
    });
    const queue = new RecordingQueue();
    const judgment = new ScriptedJudgment(() => "hang");
    await run(
      createAutopilotHandler(
        deps({ queue, judgment: async () => judgment, precheckTimeoutMs: 50 }),
      ),
      { companyId },
    );

    expect(queue.of(JOB_QUEUES.contentBuild)).toHaveLength(0);
    const status = await statusOf(companyId, suggestionIds);
    expect([...status.values()]).toEqual(["queued", "queued"]);
    // Una sola pregunta: después del primer timeout no sigue gastando.
    expect(judgment.asked).toBe(1);
    const decisions = await decisionsOf(companyId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decision: "held", reason: "judgment_timeout" });
    expect(await runOf(companyId)).toMatchObject({ held: 1, approved: 0 });

    // La held no la vuelve a tomar: la próxima corrida juzga la otra.
    const next = new ScriptedJudgment(() => "down");
    await run(createAutopilotHandler(deps({ queue, judgment: async () => next })), {
      companyId,
    });
    expect(next.asked).toBe(1);
    const again = await decisionsOf(companyId);
    expect(again.map((d) => d.reason).sort()).toEqual([
      "judgment_timeout",
      "judgment_unavailable",
    ]);
    expect([...(await statusOf(companyId, suggestionIds)).values()]).toEqual([
      "queued",
      "queued",
    ]);
  });

  it("marca manual: rellena al objetivo de su estrategia y no juzga nada", async () => {
    const { companyId, suggestionIds } = await seedBrand({
      autonomy: "manual",
      perDay: 3,
      suggestions: ["uno"],
    });
    const queue = new RecordingQueue();
    const refills: { companyId: string; target: number }[] = [];
    let judgmentCalls = 0;
    await run(
      createAutopilotHandler(
        deps({
          queue,
          refill: async (cid, target) => {
            refills.push({ companyId: cid, target });
          },
          judgment: async () => {
            judgmentCalls += 1;
            return new ScriptedJudgment(() => "good");
          },
        }),
      ),
      { companyId },
    );
    expect(judgmentCalls).toBe(0);
    expect(await decisionsOf(companyId)).toHaveLength(0);
    expect([...(await statusOf(companyId, suggestionIds)).values()]).toEqual(["queued"]);
    // 1 red × 3 por día × 2 días.
    expect(refills).toEqual([{ companyId, target: 6 }]);
    expect(await runOf(companyId)).toMatchObject({ outcome: "manual", queueTarget: 6 });
  });

  it("cupo: no aprueba más de lo que la estrategia agenda en el horizonte", async () => {
    // 1 por día × 2 días = 2; ya hay uno agendado → cupo 1.
    const { companyId, suggestionIds } = await seedBrand({
      autonomy: "autopilot",
      perDay: 1,
      suggestions: ["uno", "dos", "tres"],
    });
    await withoutCompany(handle.db, async (tx) => {
      const [piece] = await tx
        .insert(contents)
        .values({ companyId, type: "wall-of-text", status: "CREATED" })
        .returning({ id: contents.id });
      await tx.insert(plannedSlots).values({
        companyId,
        contentId: piece?.id as string,
        network: "instagram",
        scheduledAtUtc: new Date("2026-09-24T13:00:00Z"),
      });
    });
    const queue = new RecordingQueue();
    const judgment = new ScriptedJudgment(() => "good");
    await run(createAutopilotHandler(deps({ queue, judgment: async () => judgment })), {
      companyId,
    });

    const status = await statusOf(companyId, suggestionIds);
    expect([...status.values()].filter((s) => s === "popped")).toHaveLength(1);
    expect([...status.values()].filter((s) => s === "queued")).toHaveLength(2);
    expect(judgment.asked).toBe(1);
    expect(await runOf(companyId)).toMatchObject({ approved: 1 });
  });

  it("sin LLM de texto: no rellena ni juzga, y lo deja dicho en la corrida", async () => {
    const { companyId } = await seedBrand({
      autonomy: "autopilot",
      suggestions: ["uno"],
    });
    const queue = new RecordingQueue();
    let refilled = false;
    await run(
      createAutopilotHandler(
        deps({
          queue,
          copywriter: async () => null,
          refill: async () => {
            refilled = true;
          },
        }),
      ),
      { companyId },
    );
    expect(refilled).toBe(false);
    expect(await decisionsOf(companyId)).toHaveLength(0);
    expect(await runOf(companyId)).toMatchObject({ outcome: "no_llm" });
  });
});

describe("barrido (PU-AUTO-001)", () => {
  it("encola una corrida por marca con estrategia, una sola por ventana de 15 min", async () => {
    const a = await seedBrand({ autonomy: "autopilot", suggestions: [] });
    const m = await seedBrand({ autonomy: "manual", suggestions: [] });
    const without = await seedCompany(handle);
    const queue = new RecordingQueue();
    const clock = new FixedClock(NOW);
    const handler = createAutopilotHandler(deps({ queue, clock }));

    await run(handler, {});
    await run(handler, {});
    const mine = (ids: string[]) =>
      queue
        .of(JOB_QUEUES.automationGeneration)
        .map((s) => (s.payload as { companyId: string }).companyId)
        .filter((id) => ids.includes(id));
    expect(mine([without])).toEqual([]);
    expect(mine([a.companyId, m.companyId]).sort()).toEqual(
      [a.companyId, m.companyId].sort(),
    );

    // La ventana siguiente es otra clave (trampa 39): se vuelve a encolar.
    clock.advanceMs(15 * 60_000);
    await run(handler, {});
    expect(mine([a.companyId])).toHaveLength(2);
  });

  it("sin LLM el barrido no encola nada", async () => {
    await seedBrand({ autonomy: "autopilot", suggestions: [] });
    const queue = new RecordingQueue();
    await run(createAutopilotHandler(deps({ queue, copywriter: async () => null })), {});
    expect(queue.of(JOB_QUEUES.automationGeneration)).toHaveLength(0);
  });
});
