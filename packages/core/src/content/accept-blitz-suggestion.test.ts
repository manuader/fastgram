import { describe, expect, it } from "vitest";
import type {
  Clock,
  EnqueuedJob,
  JobSpec,
  Queue,
  QueueTransaction,
} from "@fastgram/ports";
import { DomainError } from "../errors.js";
import type { IdGenerator } from "../ids.js";
import type { SavesLedger, SwipesLedger } from "../quota/content-saves.js";
import type { IdempotencyRecord } from "../idempotency.js";
import {
  BLITZ_ACCEPT_ENDPOINT,
  CONTENT_BUILD_QUEUE,
  acceptBlitzSuggestionUseCase,
  type BlitzAcceptanceRepository,
  type BlitzQuotaSnapshot,
  type ContentBuildJob,
  type Suggestion,
} from "./accept-blitz-suggestion.js";
import type { Content } from "./content.js";
import type { ContentTextBox } from "./text-boxes.js";

const NOW = new Date("2026-09-21T10:00:00Z");

/** Un handle opaco. El dominio no lo mira: sólo lo pasa. */
const TX: QueueTransaction = { __tx: "t1" };
const OTHER_TX: QueueTransaction = { __tx: "t2" };

const box: ContentTextBox = {
  id: "slide-0-text-0",
  slideIndex: 0,
  text: "One idea, everywhere",
  position: { x: 50, y: 70 },
  widthPercent: 80,
  font: { family: "montserrat", weight: 600, size: 18 },
  color: "#FFFFFF",
  stroke: { width: 3, color: "#000000" },
  background: null,
};

const suggestion = (over: Partial<Suggestion> = {}): Suggestion => ({
  id: "sug_1",
  companyId: "co_1",
  contentType: "slideshow",
  generatedText: "One idea, everywhere",
  aiExplanation: "Curiosity hook taps into emotional desire",
  status: "queued",
  textBoxes: [box],
  slideCount: 3,
  angleId: "ang_1",
  ...over,
});

const saves = (over: Partial<SavesLedger> = {}): SavesLedger => ({
  plan: "starter",
  includedUsed: 5,
  purchasedRemaining: 0,
  overageUsed: 0,
  overageEnabled: false,
  resetAt: new Date("2026-10-01T00:00:00Z"),
  ...over,
});

const swipes = (over: Partial<SwipesLedger> = {}): SwipesLedger => ({
  dailyLimit: 30,
  used: 4,
  resetAt: new Date("2026-09-22T00:00:00Z"),
  ...over,
});

const clock: Clock = { now: () => NOW, nowMs: () => NOW.getTime() };

function idGenerator(): IdGenerator {
  let n = 0;
  return { newId: (prefix) => `${prefix}_${++n}` };
}

/** Registra cada llamada con la transacción que recibió. */
interface Trace {
  readonly step: string;
  readonly transaction: QueueTransaction;
}

interface Harness {
  readonly repository: BlitzAcceptanceRepository;
  readonly queue: Queue;
  readonly trace: Trace[];
  readonly enqueued: JobSpec<unknown>[];
  readonly inserted: Content[];
  readonly savedQuota: BlitzQuotaSnapshot[];
  readonly records: Map<string, IdempotencyRecord>;
}

function harness(
  options: {
    suggestion?: Suggestion | null | undefined;
    quota?: BlitzQuotaSnapshot | undefined;
    queueFails?: boolean | undefined;
    seedRecord?: IdempotencyRecord | undefined;
  } = {},
): Harness {
  const trace: Trace[] = [];
  const enqueued: JobSpec<unknown>[] = [];
  const inserted: Content[] = [];
  const savedQuota: BlitzQuotaSnapshot[] = [];
  const records = new Map<string, IdempotencyRecord>();
  if (options.seedRecord) records.set(options.seedRecord.key, options.seedRecord);

  const repository: BlitzAcceptanceRepository = {
    async findSuggestion(_companyId, _id, transaction) {
      trace.push({ step: "findSuggestion", transaction });
      return options.suggestion === undefined ? suggestion() : options.suggestion;
    },
    async loadQuota(_companyId, transaction) {
      trace.push({ step: "loadQuota", transaction });
      return options.quota ?? { saves: saves(), swipes: swipes() };
    },
    async saveQuota(_companyId, quota, transaction) {
      trace.push({ step: "saveQuota", transaction });
      savedQuota.push(quota);
    },
    async insertContent(content, transaction) {
      trace.push({ step: "insertContent", transaction });
      inserted.push(content);
    },
    async markSuggestionPopped(_companyId, _id, transaction) {
      trace.push({ step: "markSuggestionPopped", transaction });
    },
    async findIdempotencyRecord(_companyId, key, transaction) {
      trace.push({ step: "findIdempotencyRecord", transaction });
      return records.get(key) ?? null;
    },
    async putIdempotencyRecord(record, transaction) {
      trace.push({ step: "putIdempotencyRecord", transaction });
      records.set(record.key, record);
    },
  };

  const queue: Queue = {
    async enqueue<T>(job: JobSpec<T>): Promise<EnqueuedJob> {
      trace.push({
        step: "enqueue",
        transaction: job.options?.transaction as QueueTransaction,
      });
      enqueued.push(job as JobSpec<unknown>);
      if (options.queueFails) {
        throw new Error("queue unreachable");
      }
      return { jobId: "job_1", created: true };
    },
    async enqueueMany() {
      throw new Error("no usado");
    },
    async work() {
      throw new Error("no usado");
    },
    async getJob() {
      return null;
    },
    async cancel() {
      return false;
    },
    async scheduleRecurring() {},
    async start() {},
    async stop() {},
  };

  return { repository, queue, trace, enqueued, inserted, savedQuota, records };
}

function run(h: Harness, over: Record<string, unknown> = {}) {
  return acceptBlitzSuggestionUseCase(
    {
      clock,
      queue: h.queue,
      ids: idGenerator(),
      repository: h.repository,
    },
    {
      companyId: "co_1",
      actorId: "usr_1",
      suggestionId: "sug_1",
      transaction: TX,
      ...over,
    } as Parameters<typeof acceptBlitzSuggestionUseCase>[1],
  );
}

// ───────────────────────────────────────────────────────────────────────────
// La invariante que sostiene el reembolso
// ───────────────────────────────────────────────────────────────────────────

describe("el encolado ocurre en la MISMA transacción (IMPL §2.3, ADR-005)", () => {
  it("enqueue recibe exactamente la transacción que se le pasó al caso de uso", () => {
    // Sin esto, un fallo entre el commit y el push deja cuota consumida sin
    // trabajo: no hay job, así que nada falla, así que el save no se reembolsa
    // nunca y se pierde en silencio.
    const h = harness();
    return run(h).then(() => {
      const spec = h.enqueued[0];
      expect(spec?.options?.transaction).toBe(TX);
      expect(spec?.options?.transaction).not.toBe(OTHER_TX);
    });
  });

  it("TODOS los pasos usan la misma transacción — ninguno escribe fuera", async () => {
    const h = harness();
    await run(h);
    expect(h.trace.length).toBeGreaterThan(4);
    for (const t of h.trace) {
      expect(t.transaction, `paso ${t.step}`).toBe(TX);
    }
  });

  it("el encolado va ÚLTIMO: lo que puede fallar por causa externa va al final", async () => {
    const h = harness();
    await run(h);
    const steps = h.trace.map((t) => t.step);
    expect(steps.at(-1)).toBe("enqueue");
    expect(steps.indexOf("insertContent")).toBeLessThan(steps.indexOf("enqueue"));
    expect(steps.indexOf("saveQuota")).toBeLessThan(steps.indexOf("enqueue"));
  });

  it("si la cola no responde, el error se propaga y aborta la transacción", async () => {
    // El puerto Queue lo exige: «en el camino transaccional esto **debe**
    // abortar la transacción». El caso de uso no lo puede tragar.
    const h = harness({ queueFails: true });
    await expect(run(h)).rejects.toThrow("queue unreachable");
  });

  it("encola en la cola que el worker lee, con singleton por pieza", async () => {
    const h = harness();
    const out = await run(h);
    const spec = h.enqueued[0] as JobSpec<ContentBuildJob>;
    expect(spec.queue).toBe(CONTENT_BUILD_QUEUE);
    // El nombre sale de `JOB_QUEUES`, que es lo que el worker lee. El literal
    // se escribe acá a mano a propósito: si alguien renombra la cola de un lado,
    // este test tiene que romperse en vez de seguir a la constante.
    expect(spec.queue).toBe("content-build");
    expect(spec.options?.singletonKey).toBe(`content-build:${out.content.id}`);
    expect(spec.payload.contentId).toBe(out.content.id);
    expect(spec.payload.companyId).toBe("co_1");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Cuota — FR-050 criterio 2
// ───────────────────────────────────────────────────────────────────────────

describe("aceptar descuenta exactamente 1 swipe y 1 save (FR-050, criterio 2)", () => {
  it("un save y un swipe, ni más ni menos", async () => {
    const h = harness();
    const out = await run(h);
    expect(out.saves.includedUsed).toBe(6);
    expect(out.swipes.used).toBe(5);
    expect(h.savedQuota).toHaveLength(1);
    expect(h.savedQuota[0]?.saves.includedUsed).toBe(6);
  });

  it("persiste el bucket del que salió el save — sin eso el reembolso miente", async () => {
    const h = harness({
      quota: {
        saves: saves({ includedUsed: 20, purchasedRemaining: 3 }),
        swipes: swipes(),
      },
    });
    const out = await run(h);
    expect(out.content.saveBucket).toBe("purchased");
    expect(h.inserted[0]?.saveBucket).toBe("purchased");
  });

  it("sin saves NO se gasta el swipe: el gate de saves va primero", async () => {
    // Cobrar el swipe primero le quema al usuario un swipe diario —que no
    // vuelve hasta mañana— por una operación que igual iba a fallar.
    const h = harness({
      quota: {
        saves: saves({ includedUsed: 20 }),
        swipes: swipes({ used: 4 }),
      },
    });
    await expect(run(h)).rejects.toThrow(DomainError);
    expect(h.savedQuota).toHaveLength(0);
    expect(h.enqueued).toHaveLength(0);
    expect(h.inserted).toHaveLength(0);
  });

  it("sin saves el error es blitz_quota_blocked, no content_quota_exceeded", async () => {
    const h = harness({
      quota: { saves: saves({ includedUsed: 20 }), swipes: swipes() },
    });
    try {
      await run(h);
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).code).toBe("blitz_quota_blocked");
    }
  });

  it("sin swipes tampoco se crea la pieza ni se encola", async () => {
    const h = harness({
      quota: { saves: saves(), swipes: swipes({ used: 30, dailyLimit: 30 }) },
    });
    await expect(run(h)).rejects.toThrow(DomainError);
    expect(h.enqueued).toHaveLength(0);
    expect(h.inserted).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// La pieza que se crea
// ───────────────────────────────────────────────────────────────────────────

describe("la pieza nace en BUILDING", () => {
  it("BUILDING, revision 0, sin archivos y atada a la sugerencia", async () => {
    const h = harness();
    const out = await run(h);
    expect(out.content.status).toBe("BUILDING");
    expect(out.content.revision).toBe(1);
    expect(out.content.files).toEqual([]);
    expect(out.content.suggestionId).toBe("sug_1");
    expect(out.content.angleId).toBe("ang_1");
    expect(out.content.companyId).toBe("co_1");
  });

  it("green-screen NUNCA arrastra el influencer de la sugerencia", async () => {
    const h = harness({
      suggestion: suggestion({
        contentType: "green-screen",
        influencerId: "inf_1",
        slideCount: 1,
      }),
    });
    const out = await run(h);
    expect(out.content.influencerId).toBeUndefined();
  });

  it("en los formatos que lo admiten el influencer viaja", async () => {
    const h = harness({
      suggestion: suggestion({
        contentType: "video-hook",
        influencerId: "inf_1",
        slideCount: 1,
      }),
    });
    const out = await run(h);
    expect(out.content.influencerId).toBe("inf_1");
  });

  it("marca la sugerencia como popped", async () => {
    const h = harness();
    await run(h);
    expect(h.trace.map((t) => t.step)).toContain("markSuggestionPopped");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Estados de la sugerencia y scope
// ───────────────────────────────────────────────────────────────────────────

describe("sugerencia: existencia, estado y workspace", () => {
  it("una sugerencia inexistente es not_found", async () => {
    const h = harness({ suggestion: null });
    try {
      await run(h);
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).code).toBe("not_found");
    }
  });

  it("una de OTRO workspace es not_found aunque al repositorio le falte el WHERE", async () => {
    // Este test simula exactamente el bug que la segunda capa cubre: un
    // repositorio que ignora el scope. Debe seguir sin filtrar nada.
    const h = harness({ suggestion: suggestion({ companyId: "co_ajeno" }) });
    try {
      await run(h);
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      const err = e as DomainError;
      expect(err.code).toBe("not_found");
      expect(err.details?.crossTenant).toBe(true);
      expect(err.toPublic().message).toBe("suggestion not found");
    }
    expect(h.enqueued).toHaveLength(0);
  });

  it("una ya usada (popped) no se puede volver a aceptar", async () => {
    const h = harness({ suggestion: suggestion({ status: "popped" }) });
    try {
      await run(h);
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).code).toBe("invalid_state");
    }
  });

  it("una descartada tampoco", async () => {
    const h = harness({ suggestion: suggestion({ status: "discarded" }) });
    await expect(run(h)).rejects.toThrow(DomainError);
  });

  it("un aspectRatio fuera de slideshow se rechaza antes de tocar la cuota", async () => {
    const h = harness({
      suggestion: suggestion({ contentType: "wall-of-text", slideCount: 1 }),
    });
    await expect(run(h, { aspectRatio: "4:5" })).rejects.toThrow(DomainError);
    expect(h.savedQuota).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Idempotencia — NFR-004 / DATA-027
// ───────────────────────────────────────────────────────────────────────────

describe("idempotencia (NFR-004, DATA-027)", () => {
  const withKey = { idempotencyKey: "key-1", requestHash: "hash-A" };

  it("sin key la operación corre y no reserva nada", async () => {
    const h = harness();
    const out = await run(h);
    expect(out.replayed).toBe(false);
    expect(h.records.size).toBe(0);
  });

  it("con key reserva y luego cierra la reserva con la respuesta", async () => {
    const h = harness();
    const out = await run(h, withKey);
    expect(out.replayed).toBe(false);
    const record = h.records.get("key-1");
    expect(record?.state).toBe("completed");
    expect(record?.endpoint).toBe(BLITZ_ACCEPT_ENDPOINT);
    expect(record?.requestHash).toBe("hash-A");
  });

  it("misma key + mismo body = replay, sin cobrar de nuevo", async () => {
    const h = harness();
    const first = await run(h, withKey);

    const replay = harness({ seedRecord: h.records.get("key-1") });
    const out = await run(replay, withKey);

    expect(out.replayed).toBe(true);
    expect(out.content.id).toBe(first.content.id);
    // Lo importante: no se cobró, no se creó nada y no se encoló nada.
    expect(replay.savedQuota).toHaveLength(0);
    expect(replay.inserted).toHaveLength(0);
    expect(replay.enqueued).toHaveLength(0);
  });

  it("misma key + body distinto = conflict", async () => {
    const h = harness();
    await run(h, withKey);

    const retry = harness({ seedRecord: h.records.get("key-1") });
    try {
      await run(retry, { idempotencyKey: "key-1", requestHash: "hash-B" });
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).code).toBe("conflict");
    }
    expect(retry.savedQuota).toHaveLength(0);
  });

  it("la lectura de la key va ANTES del gate de cuota: un replay no cobra", async () => {
    const h = harness();
    await run(h, withKey);

    const replay = harness({ seedRecord: h.records.get("key-1") });
    await run(replay, withKey);

    const steps = replay.trace.map((t) => t.step);
    expect(steps).toContain("findIdempotencyRecord");
    expect(steps).not.toContain("loadQuota");
  });

  it("una key sin huella de cuerpo es un error de cliente", async () => {
    const h = harness();
    await expect(run(h, { idempotencyKey: "key-1" })).rejects.toThrow(DomainError);
  });
});
