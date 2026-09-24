/**
 * Formatos generativos — `P4-FORMAT-001`/`002`.
 */
import { describe, expect, it } from "vitest";
import type { GenCostEstimate, GenModelSpec, VideoGenRequest } from "@fastgram/ports";

import { EMPTY_SPEND_LEDGER, parseSpendLedger } from "../../genai/budget.js";
import { parseGenerationRecord } from "../../genai/record.js";
import {
  GENERATIVE_FORMATS,
  availableGenerativeFormats,
  findGenerativeFormat,
  matchGenerativeFormat,
} from "./catalog.js";
import {
  FORMAT_OVERLAY_MAX_CHARS,
  generativeFormatBuildPayload,
  pickDuration,
  planGenerativeFormat,
} from "./plan.js";
import { formatRunStatus, parseFormatRunRecord } from "./run.js";
import {
  estimateGenerativeFormatRun,
  formatVideoModels,
  startGenerativeFormatRun,
  type FormatRunDeps,
} from "./start.js";

const C = "7f0c7d2e-7a52-4a38-9d0f-2d4a3b6f1c11";
const ID = "5d6e7f80-91a2-4b3c-8d4e-5f6a7b8c9d0e";

const video = (over: Partial<GenModelSpec> = {}): GenModelSpec => ({
  id: "t2v",
  label: "T2V",
  kind: "video",
  aspectRatios: ["9:16", "16:9"],
  aspectFromImage: false,
  counts: [1],
  durationsSeconds: [5, 10],
  promptRequired: true,
  imageInput: "none",
  maxReferenceImages: 0,
  docsUrl: "https://docs.example/t2v",
  listPrice: null,
  ...over,
});

describe("catálogo (F-070/F-084)", () => {
  it("son los 17 del PRD, con label y descripción literales", () => {
    expect(GENERATIVE_FORMATS).toHaveLength(17);
    expect(findGenerativeFormat("on-a-walk")).toMatchObject({
      label: "On a Walk",
      description: "Your text over a generated walking selfie",
      status: "available",
    });
  });

  it("sprint 8: los que piden voz se hacen con voz; dos quedan bloqueados con motivo", () => {
    for (const id of [
      "speaking-hook",
      "talking-head-ugc",
      "talking-head-green-screen",
      "notes-green-screen",
      "product-spokesperson",
      "street-interview",
      "news-anchor",
    ]) {
      expect(findGenerativeFormat(id)).toMatchObject({ status: "speaking" });
    }
    expect(findGenerativeFormat("green-screen-mobile-app")).toMatchObject({
      status: "blocked",
      reason: "needs_screen_replacement",
    });
    expect(findGenerativeFormat("talking-objects")).toMatchObject({
      status: "blocked",
      reason: "needs_non_human_avatar",
    });
    expect(findGenerativeFormat("character-swap")).toMatchObject({ status: "swap" });
  });

  it("un formato con voz no se planifica como clip + texto", () => {
    const r = planGenerativeFormat({ formatId: "news-anchor", overlayText: "x" });
    expect(r.ok).toBe(false);
  });

  it("siete se pueden hacer como clip + texto", () => {
    expect(availableGenerativeFormats().map((f) => f.id)).toEqual([
      "on-a-walk",
      "cutting-fruit",
      "netflix-documentary",
      "claymation",
      "lego",
      "felt",
      "skeleton",
    ]);
  });

  it("Blitz: reconoce un formato disponible nombrado en el tema, no uno bloqueado", () => {
    expect(matchGenerativeFormat("A claymation about our app")?.id).toBe("claymation");
    expect(matchGenerativeFormat("netflix documentary style reveal")?.id).toBe(
      "netflix-documentary",
    );
    expect(matchGenerativeFormat("me on a walk talking about focus")?.id).toBe(
      "on-a-walk",
    );
    expect(matchGenerativeFormat("a news anchor segment")).toBeNull();
    expect(matchGenerativeFormat("legoland")).toBeNull();
  });
});

describe("plan", () => {
  it("escena + tema, texto recortado", () => {
    const r = planGenerativeFormat({
      formatId: "cutting-fruit",
      topic: "  a jar\nof protein powder ",
      overlayText: "  POV: breakfast in 30s ",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.overlayText).toBe("POV: breakfast in 30s");
    expect(r.plan.topic).toBe("a jar of protein powder");
    expect(r.plan.videoPrompt).toContain("slicing fresh colorful fruit");
    expect(r.plan.videoPrompt).toContain("with a jar of protein powder visible");
  });

  it("stop-motion sin tema usa lo que ofrece la marca, salvo que se apague", () => {
    const brand = { productOffering: "A budgeting app for freelancers" };
    const on = planGenerativeFormat({ formatId: "lego", overlayText: "x", brand });
    const off = planGenerativeFormat({
      formatId: "lego",
      overlayText: "x",
      brand,
      includeBrand: false,
    });
    expect(on.ok && on.plan.videoPrompt).toContain("budgeting app for freelancers");
    expect(off.ok && off.plan.videoPrompt).not.toContain("budgeting");
  });

  it("rechaza bloqueados, inexistentes, texto vacío o largo", () => {
    expect(
      planGenerativeFormat({ formatId: "news-anchor", overlayText: "x" }),
    ).toMatchObject({ ok: false, field: "formatId" });
    expect(planGenerativeFormat({ formatId: "nope", overlayText: "x" }).ok).toBe(false);
    expect(planGenerativeFormat({ formatId: "lego", overlayText: "  " })).toMatchObject({
      ok: false,
      field: "overlayText",
    });
    expect(
      planGenerativeFormat({
        formatId: "lego",
        overlayText: "a".repeat(FORMAT_OVERLAY_MAX_CHARS + 1),
      }).ok,
    ).toBe(false);
  });

  it("duración: la pedida, la preferida o la más cercana (empate: la corta)", () => {
    const f = { preferredDurationSeconds: 5 };
    expect(pickDuration(f, [5, 10], 10)).toBe(10);
    expect(pickDuration(f, [5, 10], 7)).toBe(5);
    expect(pickDuration(f, [4, 6, 8])).toBe(4);
    expect(pickDuration(f, [6, 8, 10])).toBe(6);
    expect(pickDuration(f, [])).toBeNull();
  });

  it("el payload es wall-of-text a canvas completo con el texto", () => {
    const p = generativeFormatBuildPayload({
      clip: { mediaId: ID, url: "http://localhost:9000/m/clip.mp4" },
      overlayText: "hola",
    });
    expect(p).toMatchObject({
      canvas: { width: 1080, height: 1920 },
      video: { url: "http://localhost:9000/m/clip.mp4", drawX: 0, drawY: 0 },
      text: { content: "hola" },
    });
  });
});

describe("estado de la corrida", () => {
  const run = { contentId: null, error: null };
  it("sigue a la generación y después a la pieza", () => {
    expect(formatRunStatus(run, "queued", null)).toBe("queued");
    expect(formatRunStatus(run, "generating", null)).toBe("generating");
    expect(formatRunStatus(run, "nsfw", null)).toBe("nsfw");
    expect(formatRunStatus(run, "ready", null)).toBe("building");
    const withContent = { contentId: ID, error: null };
    expect(formatRunStatus(withContent, "ready", "BUILDING")).toBe("building");
    expect(formatRunStatus(withContent, "ready", "CREATED")).toBe("ready");
    expect(formatRunStatus(withContent, "ready", "FAILED")).toBe("failed");
    expect(
      formatRunStatus(
        { contentId: null, error: { code: "clip_missing", message: "" } },
        "ready",
        null,
      ),
    ).toBe("failed");
    expect(formatRunStatus(run, null, null)).toBe("failed");
  });
});

/* ------------------------------------------------------------------------ *
 * El caso de uso, con archivos en memoria
 * ------------------------------------------------------------------------ */

function memoryCollection() {
  const docs = new Map<string, unknown>();
  return {
    docs,
    async create(scope: string, id: string, value: unknown) {
      const k = `${scope}/${id}`;
      if (docs.has(k)) throw new Error("conflict");
      docs.set(k, value);
    },
    async update<T>(
      scope: string,
      id: string,
      fn: (c: unknown) => { next?: unknown; result: T },
    ): Promise<T> {
      const k = `${scope}/${id}`;
      const out = fn(docs.get(k) ?? null);
      if (out.next !== undefined) docs.set(k, out.next);
      return out.result;
    },
  };
}

function deps(over: Partial<FormatRunDeps> = {}) {
  let ledger: unknown = null;
  const generations = memoryCollection();
  const runs = memoryCollection();
  const enqueued: unknown[] = [];
  const estimates: VideoGenRequest[] = [];
  const d: FormatRunDeps = {
    now: () => new Date("2026-09-24T12:00:00Z"),
    newId: () => ID,
    env: { FASTGRAM_MONTHLY_BUDGET_USD: "10" },
    videoTask: async () => ({
      provider: "higgsfield",
      defaultModel: "i2v",
      models: [
        video({ id: "i2v", imageInput: "required" }),
        video(),
        video({ id: "img", kind: "image" }),
      ],
    }),
    estimate: async (r): Promise<GenCostEstimate> => {
      estimates.push(r);
      return { usd: 0.5, source: "provider", basis: "5 s" };
    },
    ledger: {
      async update<T>(fn: (c: unknown) => { next?: unknown; result: T }) {
        const out = fn(ledger);
        if (out.next !== undefined) ledger = out.next;
        return out.result;
      },
    },
    generations,
    runs,
    enqueue: async (job) => {
      enqueued.push(job);
    },
    ...over,
  };
  return { d, generations, runs, enqueued, estimates, ledger: () => ledger };
}

describe("startGenerativeFormatRun", () => {
  const input = {
    companyId: C,
    formatId: "on-a-walk",
    overlayText: "Stop scrolling",
    source: "studio" as const,
  };

  it("sólo modelos de texto a video", () => {
    const d = deps();
    void d;
    expect(
      formatVideoModels([video(), video({ id: "x", imageInput: "required" })]).map(
        (m) => m.id,
      ),
    ).toEqual(["t2v"]);
  });

  it("estima con el primer texto a video si el de Settings es image-to-video", async () => {
    const { d, estimates } = deps();
    const r = await estimateGenerativeFormatRun(d, input);
    expect(r).toMatchObject({ ok: true, model: "t2v", durationSeconds: 5 });
    expect(estimates[0]).toMatchObject({ model: "t2v", aspectRatio: "9:16" });
  });

  it("reserva, escribe corrida y generación con el mismo id, y encola", async () => {
    const x = deps();
    const r = await startGenerativeFormatRun(x.d, input);
    expect(r.ok).toBe(true);
    const run = parseFormatRunRecord(x.runs.docs.get(`${C}/${ID}`));
    const gen = parseGenerationRecord(x.generations.docs.get(`${C}/${ID}`));
    expect(run).toMatchObject({
      id: ID,
      formatId: "on-a-walk",
      overlayText: "Stop scrolling",
    });
    expect(gen).toMatchObject({ id: ID, kind: "video", status: "queued", model: "t2v" });
    expect(x.enqueued).toEqual([{ companyId: C, generationId: ID }]);
    const ledger = parseSpendLedger(x.ledger());
    expect(ledger?.months["2026-09"]?.[ID]).toMatchObject({
      usd: 0.5,
      state: "reserved",
    });
  });

  it("sin modelo de video: not_configured, sin tocar nada", async () => {
    const x = deps({ videoTask: async () => null });
    expect(await startGenerativeFormatRun(x.d, input)).toMatchObject({
      ok: false,
      reason: "not_configured",
    });
    expect(x.runs.docs.size).toBe(0);
  });

  it("pasaría el tope: budget_exceeded", async () => {
    const x = deps({
      estimate: async () => ({ usd: 50, source: "provider", basis: "" }),
    });
    expect(await startGenerativeFormatRun(x.d, input)).toMatchObject({
      ok: false,
      reason: "budget_exceeded",
      estimateUsd: 50,
    });
    expect(x.enqueued).toHaveLength(0);
  });

  it("duración que el modelo no acepta: invalid", async () => {
    const x = deps();
    expect(
      await startGenerativeFormatRun(x.d, { ...input, durationSeconds: 7 }),
    ).toMatchObject({ ok: false, reason: "invalid", field: "durationSeconds" });
  });

  it("si encolar falla, libera la reserva y cierra la generación", async () => {
    const x = deps({
      enqueue: async () => {
        throw new Error("queue down");
      },
    });
    await expect(startGenerativeFormatRun(x.d, input)).rejects.toThrow("queue down");
    const ledger = parseSpendLedger(x.ledger()) ?? EMPTY_SPEND_LEDGER;
    expect(ledger.months["2026-09"]?.[ID]).toBeUndefined();
    expect(parseGenerationRecord(x.generations.docs.get(`${C}/${ID}`))?.status).toBe(
      "failed",
    );
  });
});
