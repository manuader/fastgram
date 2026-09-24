/**
 * Engagement contra Postgres — `P4-ENGAGE-003/004/008/009/010/011`.
 *
 * Todo real (repositorios, RLS con `fastgram_app`, `RedditApi` del adaptador)
 * salvo tres dobles: un `fetch` que imita las respuestas documentadas de
 * Reddit (**nunca** red real), un `Judgment` guionado y un LLM de texto
 * guionado. Lo que se mide:
 *
 * - descubrimiento: filtro por palabra clave, dedupe, juicio JV-2 con las
 *   respuestas crudas guardadas y la composición de core; `Why this lead?`
 *   sólo para los visibles;
 * - límite de tasa: corta, anota la pausa y encola la continuación;
 * - borrador de respuesta y su fallo sin LLM;
 * - ban meter: el juicio sólo etiqueta, el nivel lo calcula el código;
 * - seguimiento del hilo: `tracking` / `comment_missing`;
 * - ningún handler publica (ninguna llamada a `/api/comment`).
 */
import { randomUUID } from "node:crypto";

import { FixedClock, RedditApi } from "@fastgram/adapters";
import {
  JOB_QUEUES,
  LEAD_SCORING_VERSION,
  scoreLead,
  parseStoredLeadAnswers,
} from "@fastgram/core";
import {
  APP_ROLE,
  banRiskAssessments,
  engagementReplies,
  engagementStore,
  leads,
  withCompany,
  type DbHandle,
} from "@fastgram/db";
import {
  PortError,
  type AskRequest,
  type ChoiceAnswer,
  type ChoiceRequest,
  type EnqueuedJob,
  type JobSpec,
  type Judgment,
  type JudgmentBatchOutcome,
  type JudgmentOutcome,
  type JudgmentQuestion,
  type Llm,
  type LlmCompletion,
  type Queue,
} from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import { createEngagementHandlers } from "../src/engagement/handlers.js";
import type { RedditAccess } from "../src/engagement/reddit.js";
import type { LlmSource } from "../src/llm/registry-llm.js";
import { openDb, seedCompany } from "./helpers/fixtures.js";

const silent: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = "2026-09-24T12:00:00.000Z";
const nowSec = Date.parse(NOW) / 1000;

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

const noul = (p: number) => ({ kind: "noul" as const, probability: p });
const score = (level: number, levels: number) => ({
  kind: "score" as const,
  value: level,
  probabilities: Array.from({ length: levels }, (_, i) => (i + 1 === level ? 1 : 0)),
  confidence: 1,
});

/**
 * Responde JV-2 según una palabra del título y JV-5 según el texto de la
 * respuesta. **Nunca** devuelve un nivel ni un ratio: no hay dónde.
 */
class ScriptedJudgment implements Judgment {
  readonly provenance = { adapter: "stub", model: "scripted-1" };
  asked = 0;
  chosen = 0;
  async ask<const Q extends readonly JudgmentQuestion[]>(
    request: AskRequest<Q>,
  ): Promise<JudgmentBatchOutcome<Q>> {
    this.asked += 1;
    const title = String((request.state["post"] as Record<string, unknown>)["title"]);
    const strong = /perfect/i.test(title);
    const answered = /answered/i.test(title);
    const answers = {
      hasProblem: noul(strong ? 0.95 : 0.1),
      buyingSignal: score(strong ? 4 : 1, 4),
      fitToAudience: score(strong ? 3 : 1, 3),
      replyWelcome: noul(strong ? 0.9 : 0.1),
      alreadyAnswered: noul(answered ? 0.9 : 0.05),
    };
    return { answers, usage: { latencyMs: 1 } } as unknown as JudgmentBatchOutcome<Q>;
  }
  async choice<T extends string>(
    request: ChoiceRequest<T>,
  ): Promise<JudgmentOutcome<ChoiceAnswer<T>>> {
    this.chosen += 1;
    const text = String(request.state["replyText"]);
    const value = (/buy|sign up/i.test(text) ? "direct_promo" : "value_add") as T;
    const probabilities = Object.fromEntries(
      Object.keys(request.question.criteria).map((k) => [k, k === value ? 1 : 0]),
    ) as { [K in T]: number };
    return {
      answer: { kind: "choice", value, probabilities, confidence: 1 },
      usage: { latencyMs: 1 },
    };
  }
  async score(): Promise<never> {
    throw new Error("no se usa");
  }
  async noul(): Promise<never> {
    throw new Error("no se usa");
  }
}

class ScriptedLlm implements Llm {
  calls: string[] = [];
  constructor(readonly text: string) {}
  async complete(req: {
    messages: readonly { content: string }[];
  }): Promise<LlmCompletion> {
    this.calls.push(req.messages[0]?.content ?? "");
    return {
      text: this.text,
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "scripted",
      deterministic: true,
      latencyMs: 1,
    };
  }
  async completeJson(): Promise<never> {
    throw new Error("no se usa");
  }
}

function llmSource(llm: Llm | null): LlmSource {
  return {
    current: async () =>
      llm === null
        ? null
        : {
            llm,
            config: {
              source: "registry",
              entry: "text",
              provider: null,
              baseUrl: "http://llm.test",
              apiKey: "",
              model: "scripted",
              contextWindowTokens: 8000,
            },
          },
  };
}

/* ------------------------------------------------------------------------ *
 * Reddit falso (formas de la wiki JSON y de /dev/api)
 * ------------------------------------------------------------------------ */

const t3 = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  kind: "t3",
  data: {
    id,
    name: `t3_${id}`,
    subreddit: "freelance",
    title,
    selftext: "",
    author: "someone",
    score: 4,
    num_comments: 1,
    created_utc: nowSec - 3600,
    permalink: `/r/freelance/comments/${id}/x/`,
    over_18: false,
    locked: false,
    stickied: false,
    ...extra,
  },
});
const t1 = (name: string, parent: string, author: string, body = "c") => ({
  kind: "t1",
  data: { name, parent_id: parent, author, body, score: 1, created_utc: nowSec },
});

interface FakeReddit {
  listing: unknown[];
  headers: Record<string, string>;
  status: number;
  thread: (id: string) => unknown;
  calls: string[];
}

function fakeReddit(): FakeReddit {
  return {
    listing: [],
    headers: { "x-ratelimit-remaining": "590", "x-ratelimit-reset": "300" },
    status: 200,
    thread: (id) => [
      { kind: "Listing", data: { children: [t3(id, "thread")] } },
      {
        kind: "Listing",
        data: { children: [t1("t1_x", `t3_${id}`, "other", "Try a spreadsheet")] },
      },
    ],
    calls: [],
  };
}

function accessFor(fake: FakeReddit): () => Promise<RedditAccess> {
  const fetch = (url: string) => {
    fake.calls.push(url);
    const h = { "content-type": "application/json", ...fake.headers };
    if (fake.status !== 200)
      return Promise.resolve(new Response("{}", { status: fake.status, headers: h }));
    const u = new URL(url);
    let body: unknown = {};
    if (u.pathname.endsWith("/new"))
      body = { kind: "Listing", data: { children: fake.listing } };
    else if (u.pathname.endsWith("/about/rules"))
      body = { rules: [{ short_name: "No spam", description: "Disclose affiliation" }] };
    else if (u.pathname.startsWith("/comments/"))
      body = fake.thread(u.pathname.split("/")[2] ?? "");
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: h }),
    );
  };
  return () =>
    Promise.resolve({
      ok: true,
      username: "acme_founder",
      api: new RedditApi({ userAgent: "web:test:0 (by /u/x)", accessToken: "AT", fetch }),
    });
}

/* ------------------------------------------------------------------------ *
 * Montaje
 * ------------------------------------------------------------------------ */

async function brand(
  opts: { subreddits?: string[]; keywords?: string[] } = {},
): Promise<string> {
  const companyId = await seedCompany(handle);
  await withCompany(
    handle.db,
    companyId,
    (tx) =>
      engagementStore.saveSettings(
        tx,
        { companyId },
        {
          subreddits: opts.subreddits ?? ["freelance"],
          keywords: opts.keywords ?? ["invoice"],
          replyTone: "casual",
          customRules: "",
          allowLinks: false,
          discoveryEnabled: true,
        },
      ),
    { role: APP_ROLE },
  );
  return companyId;
}

function mount(o: {
  judgment?: Judgment | null;
  llm?: Llm | null;
  reddit?: () => Promise<RedditAccess>;
  queue?: RecordingQueue;
}) {
  const queue = o.queue ?? new RecordingQueue();
  const h = createEngagementHandlers({
    db: handle.db,
    appRole: APP_ROLE,
    logger: silent,
    clock: new FixedClock(NOW),
    queue,
    llmSource: llmSource(o.llm ?? null),
    judgment: async () => (o.judgment === undefined ? null : o.judgment),
    reddit: o.reddit ?? (() => Promise.resolve({ ok: false, reason: "not_connected" })),
    sleep: () => Promise.resolve(),
  });
  return { ...h, queue };
}

const run = (handler: (ctx: never) => Promise<void>, payload: unknown) =>
  (handler as (ctx: unknown) => Promise<void>)({
    jobId: randomUUID(),
    payload,
    attempt: 1,
    maxAttempts: 5,
  });

/** Con `fastgram_app` y la marca puesta: RLS filtra (sin `drizzle-orm` en este paquete). */
const asBrand = <T>(companyId: string, fn: Parameters<typeof withCompany<T>>[2]) =>
  withCompany(handle.db, companyId, fn, { role: APP_ROLE });
const leadsOf = (companyId: string) =>
  asBrand(companyId, (tx) => tx.select().from(leads));
const leadById = async (companyId: string, id: string) =>
  (await leadsOf(companyId)).find((r) => r.id === id);

/* ------------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------------ */

describe("descubrimiento (F-191) + JV-2", () => {
  let fake: FakeReddit;
  beforeEach(() => {
    fake = fakeReddit();
  });

  it("filtra, deduplica, juzga, guarda respuestas crudas y explica sólo lo visible", async () => {
    const companyId = await brand();
    fake.listing = [
      t3("p1", "Perfect: which invoice tool should I buy?"),
      t3("p2", "Meh invoice rant"),
      t3("p3", "Nothing to do with it"),
      t3("p4", "Perfect invoice but nsfw", { over_18: true }),
      t3("p5", "Old invoice question", { created_utc: nowSec - 200 * 3600 }),
      t3("p6", "Perfect invoice question, already answered"),
    ];
    const judgment = new ScriptedJudgment();
    const llm = new ScriptedLlm("They ask for an invoicing tool.");
    const h = mount({ judgment, llm, reddit: accessFor(fake) });
    await run(h.discovery, { kind: "discover", companyId });

    const rows = await leadsOf(companyId);
    expect(rows.map((r) => r.redditPostId).sort()).toEqual(["p1", "p2", "p6"]);
    expect(judgment.asked).toBe(3);
    const p1 = rows.find((r) => r.redditPostId === "p1")!;
    expect(p1).toMatchObject({
      scoreStatus: "scored",
      leadTier: "top",
      scoreVersion: LEAD_SCORING_VERSION,
    });
    expect(p1.whyThisLead).toBe("They ask for an invoicing tool.");
    expect(p1.subredditRules).toEqual(["No spam: Disclose affiliation"]);
    expect(p1.contextComments).toEqual(["Try a spreadsheet"]);
    // Recalculable sin reinferir: la composición de core sobre lo guardado da lo guardado.
    const stored = parseStoredLeadAnswers(p1.scoreAnswers);
    expect(stored).not.toBeNull();
    expect(scoreLead(stored!).score.toFixed(4)).toBe(p1.leadScore);

    const p2 = rows.find((r) => r.redditPostId === "p2")!;
    expect(p2.leadTier).toBe("hidden");
    expect(p2.whyThisLead).toBeNull();
    expect(rows.find((r) => r.redditPostId === "p6")!.leadTier).toBe("vetoed");
    expect(llm.calls).toHaveLength(1);

    // Segunda corrida: nada nuevo, nada re-juzgado.
    await run(h.discovery, { kind: "discover", companyId });
    expect(await leadsOf(companyId)).toHaveLength(3);
    expect(judgment.asked).toBe(3);
    // Nunca publica.
    expect(fake.calls.some((u) => u.includes("/api/comment"))).toBe(false);
  });

  it("sin modelo de juicio: los leads quedan `no_judgment` (visibles), sin LLM de más", async () => {
    const companyId = await brand();
    fake.listing = [t3("q1", "Perfect invoice tool?")];
    const llm = new ScriptedLlm("x");
    await run(mount({ judgment: null, llm, reddit: accessFor(fake) }).discovery, {
      kind: "discover",
      companyId,
    });
    const rows = await leadsOf(companyId);
    expect(rows[0]?.scoreStatus).toBe("no_judgment");
    expect(llm.calls).toHaveLength(0);
  });

  it("pocas llamadas restantes: corta, anota la pausa y encola la continuación", async () => {
    const companyId = await brand({ subreddits: ["freelance", "smallbusiness"] });
    fake.listing = [t3("r1", "Perfect invoice?")];
    fake.headers = { "x-ratelimit-remaining": "2", "x-ratelimit-reset": "42" };
    const h = mount({ judgment: new ScriptedJudgment(), reddit: accessFor(fake) });
    await run(h.discovery, { kind: "discover", companyId });
    // La negativa primero: no siguió con el segundo subreddit ni guardó leads.
    expect(fake.calls.filter((u) => u.includes("/new"))).toHaveLength(1);
    expect(await leadsOf(companyId)).toHaveLength(0);
    const settings = await withCompany(
      handle.db,
      companyId,
      (tx) => engagementStore.findSettings(tx, { companyId }),
      {
        role: APP_ROLE,
      },
    );
    expect(settings?.lastDiscoveryOutcome).toBe("rate_limited");
    expect(settings?.discoveryPausedUntil?.toISOString()).toBe(
      "2026-09-24T12:00:42.000Z",
    );
    const resume = h.queue.of(JOB_QUEUES.redditLeadDiscovery);
    expect(resume).toHaveLength(1);
    expect(resume[0]?.options?.startAfter?.toISOString()).toBe(
      "2026-09-24T12:00:42.000Z",
    );

    // Con la pausa vigente, una corrida nueva no llama a Reddit.
    fake.calls.length = 0;
    await run(h.discovery, { kind: "discover", companyId });
    expect(fake.calls).toHaveLength(0);
  });

  it("un 429 también pausa (no reintenta en caliente)", async () => {
    const companyId = await brand();
    fake.status = 429;
    fake.headers = { "x-ratelimit-reset": "90" };
    const h = mount({ judgment: new ScriptedJudgment(), reddit: accessFor(fake) });
    await run(h.discovery, { kind: "discover", companyId });
    expect(fake.calls).toHaveLength(1);
    expect(
      h.queue.of(JOB_QUEUES.redditLeadDiscovery)[0]?.options?.startAfter?.toISOString(),
    ).toBe("2026-09-24T12:01:30.000Z");
  });

  it("sin acceso a Reddit: anota el motivo y no falla el job", async () => {
    const companyId = await brand();
    await run(mount({}).discovery, { kind: "discover", companyId });
    const s = await withCompany(
      handle.db,
      companyId,
      (tx) => engagementStore.findSettings(tx, { companyId }),
      {
        role: APP_ROLE,
      },
    );
    expect(s?.lastDiscoveryOutcome).toBe("not_connected");
  });

  it("barrido: una corrida por marca con cuenta activa, con clave por hora", async () => {
    const withAccount = await brand();
    const without = await brand();
    await withCompany(
      handle.db,
      withAccount,
      (tx) =>
        engagementStore.saveRedditAccount(
          tx,
          { companyId: withAccount },
          {
            redditUserId: "u",
            username: "me",
            accessToken: "c",
            refreshToken: "r",
            tokenExpiry: null,
            scopes: [],
          },
        ),
      { role: APP_ROLE },
    );
    const h = mount({});
    await run(h.discovery, {});
    await run(h.discovery, {});
    const jobs = h.queue.of(JOB_QUEUES.redditLeadDiscovery).map((j) => j.payload);
    expect(jobs).toContainEqual({ kind: "discover", companyId: withAccount });
    expect(jobs).not.toContainEqual({ kind: "discover", companyId: without });
    expect(
      jobs.filter((p) => (p as { companyId: string }).companyId === withAccount),
    ).toHaveLength(1);
  });
});

describe("borrador de respuesta (F-195)", () => {
  async function leadIn(companyId: string): Promise<string> {
    const [row] = await withCompany(
      handle.db,
      companyId,
      (tx) =>
        engagementStore.insertLeads(tx, { companyId }, [
          {
            redditPostId: `x${randomUUID().slice(0, 6)}`,
            subreddit: "freelance",
            title: "How to invoice?",
          },
        ]),
      { role: APP_ROLE },
    );
    return row!.id;
  }

  it("genera, limpia y guarda; regenerar manda el borrador anterior", async () => {
    const companyId = await brand();
    const leadId = await leadIn(companyId);
    const llm = new ScriptedLlm('Here is the comment:\n"Use a template with due dates."');
    const h = mount({ llm });
    await run(h.discovery, { kind: "reply", companyId, leadId, regenerate: false });
    const row = await leadById(companyId, leadId);
    expect(row).toMatchObject({
      replyStatus: "ready",
      generatedReply: "Use a template with due dates.",
    });
    expect(llm.calls[0]).toContain("No links of any kind");
    await run(h.discovery, { kind: "reply", companyId, leadId, regenerate: true });
    expect(llm.calls).toHaveLength(2);
  });

  it("sin LLM: `failed` con `no_llm`", async () => {
    const companyId = await brand();
    const leadId = await leadIn(companyId);
    await run(mount({ llm: null }).discovery, {
      kind: "reply",
      companyId,
      leadId,
      regenerate: false,
    });
    const row = await leadById(companyId, leadId);
    expect(row).toMatchObject({ replyStatus: "failed", replyError: "no_llm" });
  });
});

describe("ban meter (DP-003): el juicio etiqueta, el código cuenta", () => {
  it("etiqueta las respuestas sin tono y guarda el nivel calculado en código", async () => {
    const companyId = await brand();
    const [lead] = await withCompany(
      handle.db,
      companyId,
      (tx) =>
        engagementStore.insertLeads(tx, { companyId }, [
          { redditPostId: "b1", subreddit: "f", title: "t" },
        ]),
      { role: APP_ROLE },
    );
    const texts = [
      "helpful",
      "buy acme now",
      "sign up to acme",
      "buy it",
      "buy!!",
      "buy more",
    ];
    for (const text of texts) {
      await withCompany(
        handle.db,
        companyId,
        (tx) =>
          engagementStore.insertReply(
            tx,
            { companyId },
            {
              leadId: lead!.id,
              text,
              channel: "manual",
              redditCommentName: null,
              permalink: null,
              sentAt: new Date("2026-09-23T12:00:00Z"),
            },
          ),
        { role: APP_ROLE },
      );
    }
    const judgment = new ScriptedJudgment();
    await run(mount({ judgment }).banRisk, { kind: "compute", companyId });
    expect(judgment.chosen).toBe(6);
    const tones = await asBrand(companyId, (tx) =>
      tx.select({ tone: engagementReplies.tone }).from(engagementReplies),
    );
    expect(tones.map((t) => t.tone).sort()).toEqual([
      "direct_promo",
      "direct_promo",
      "direct_promo",
      "direct_promo",
      "direct_promo",
      "value_add",
    ]);
    const [assessment] = await asBrand(companyId, (tx) =>
      tx.select().from(banRiskAssessments),
    );
    // 5 de 6 directas con muestra ≥ 5 → danger, por los umbrales de core.
    expect(assessment).toMatchObject({
      level: "danger",
      sampleSize: 6,
      smallSample: false,
    });
    expect(assessment?.recommendation).toBe("engagement.banMeter.recommendation.danger");

    // Una segunda corrida no re-juzga lo etiquetado.
    await run(mount({ judgment }).banRisk, { kind: "compute", companyId });
    expect(judgment.chosen).toBe(6);
  });

  it("sin juicio: igual calcula el nivel, con las respuestas sin etiqueta fuera del ratio", async () => {
    const companyId = await brand();
    const [lead] = await withCompany(
      handle.db,
      companyId,
      (tx) =>
        engagementStore.insertLeads(tx, { companyId }, [
          { redditPostId: "b2", subreddit: "f", title: "t" },
        ]),
      { role: APP_ROLE },
    );
    await withCompany(
      handle.db,
      companyId,
      (tx) =>
        engagementStore.insertReply(
          tx,
          { companyId },
          {
            leadId: lead!.id,
            text: "buy",
            channel: "manual",
            redditCommentName: null,
            permalink: null,
            sentAt: new Date("2026-09-23T12:00:00Z"),
          },
        ),
      { role: APP_ROLE },
    );
    await run(mount({ judgment: null }).banRisk, { kind: "compute", companyId });
    const [a] = await asBrand(companyId, (tx) => tx.select().from(banRiskAssessments));
    expect(a).toMatchObject({ level: "safe", sampleSize: 0 });
    expect(a?.counts).toEqual({ valueAdd: 0, subtle: 0, direct: 0, unlabeled: 1 });
  });
});

describe("seguimiento del hilo (F-198/F-199)", () => {
  it("tracking con respuestas a nosotros; comment_missing si no aparece", async () => {
    const companyId = await brand();
    const [seen, missing] = await withCompany(
      handle.db,
      companyId,
      (tx) =>
        engagementStore.insertLeads(tx, { companyId }, [
          {
            redditPostId: "m1",
            subreddit: "f",
            title: "t",
            repliedAt: new Date("2026-09-23T12:00:00Z"),
          },
          {
            redditPostId: "m2",
            subreddit: "f",
            title: "t",
            repliedAt: new Date("2026-09-23T12:00:00Z"),
          },
        ]),
      { role: APP_ROLE },
    );
    const fake = fakeReddit();
    fake.thread = (id) => [
      { kind: "Listing", data: { children: [t3(id, "thread", { num_comments: 3 })] } },
      {
        kind: "Listing",
        data: {
          children:
            id === "m1"
              ? [
                  t1("t1_ours", `t3_${id}`, "acme_founder"),
                  t1("t1_reply", "t1_ours", "someone"),
                ]
              : [t1("t1_other", `t3_${id}`, "someone")],
        },
      },
    ];
    await run(mount({ reddit: accessFor(fake) }).monitoring, { kind: "sync", companyId });
    const rows = await leadsOf(companyId);
    expect(rows.find((r) => r.id === seen!.id)).toMatchObject({
      threadState: "tracking",
      ourComments: 1,
      repliesToUs: 1,
      numComments: 3,
    });
    expect(rows.find((r) => r.id === missing!.id)?.threadState).toBe("comment_missing");
    expect(fake.calls.some((u) => u.includes("/api/comment"))).toBe(false);
  });
});

describe("payloads", () => {
  it("un payload que no se entiende se descarta sin tocar nada", async () => {
    await expect(run(mount({}).discovery, { kind: "nope" })).resolves.toBeUndefined();
    await expect(run(mount({}).banRisk, "x")).resolves.toBeUndefined();
  });

  it("un error de Reddit que no es de tasa en el listing de un subreddit privado se saltea", async () => {
    const companyId = await brand();
    const fake = fakeReddit();
    fake.status = 403;
    await expect(
      run(
        mount({ judgment: new ScriptedJudgment(), reddit: accessFor(fake) }).discovery,
        {
          kind: "discover",
          companyId,
        },
      ),
    ).resolves.toBeUndefined();
    void PortError;
  });
});
