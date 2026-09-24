/**
 * Influencers con personaje del proveedor — `PU-LATER-004`, `F-094`.
 */
import { describe, expect, it } from "vitest";

import { budgetSummary, EMPTY_SPEND_LEDGER, reserveSpend } from "../genai/budget.js";
import {
  canStartCharacter,
  checkReferenceCount,
  influencerFailureFromPort,
  phaseFromCharacter,
  uploadProgress,
} from "./character.js";
import {
  influencerImageStorageKey,
  isTerminalInfluencerGeneration,
  parseInfluencerQueueJob,
} from "./jobs.js";
import * as t from "./templates.js";

const C = "7f0c7d2e-7a52-4a38-9d0f-2d4a3b6f1c11";
const I = "0b7f3c1a-2c4e-4f5a-8b6d-9e0f1a2b3c4d";
const G = "5d6e7f80-91a2-4b3c-8d4e-5f6a7b8c9d0e";

describe("fotos de referencia", () => {
  it("4–20", () => {
    expect(checkReferenceCount(3).ok).toBe(false);
    expect(checkReferenceCount(4).ok).toBe(true);
    expect(checkReferenceCount(20).ok).toBe(true);
    expect(checkReferenceCount(21).ok).toBe(false);
  });
});

describe("progress (F-094)", () => {
  it("subir fotos va de 5 a 40 y nunca retrocede", () => {
    expect(uploadProgress(0, 8)).toBe(5);
    expect(uploadProgress(8, 8)).toBe(40);
    let prev = 0;
    for (let i = 0; i <= 8; i += 1) {
      const p = uploadProgress(i, 8);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it("estado del proveedor → estado de DATA-013", () => {
    expect(phaseFromCharacter("not_ready")).toEqual({ status: "training", progress: 50 });
    expect(phaseFromCharacter("queued")).toEqual({ status: "training", progress: 50 });
    expect(phaseFromCharacter("in_progress")).toEqual({
      status: "training",
      progress: 75,
    });
    expect(phaseFromCharacter("completed")).toEqual({ status: "ready", progress: 100 });
    expect(phaseFromCharacter("failed").status).toBe("failed");
  });
});

describe("errores del proveedor → códigos estables", () => {
  it("mapea los de PortError", () => {
    expect(influencerFailureFromPort("unauthorized")).toBe("unauthorized");
    expect(influencerFailureFromPort("forbidden")).toBe("unauthorized");
    expect(influencerFailureFromPort("quota_exceeded")).toBe("quota_exceeded");
    expect(influencerFailureFromPort("not_found")).toBe("bad_request");
    expect(influencerFailureFromPort("timeout")).toBe("timeout");
  });
});

describe("el tope mensual", () => {
  it("sin saldo en el mes no se crea un personaje (su precio no es público)", () => {
    const month = "2026-09";
    const env = { FASTGRAM_MONTHLY_BUDGET_USD: "1" };
    expect(canStartCharacter(budgetSummary(EMPTY_SPEND_LEDGER, month, env))).toBe(true);
    const r = reserveSpend(
      EMPTY_SPEND_LEDGER,
      {
        month,
        generationId: G,
        usd: 1,
        provider: "higgsfield",
        model: "m",
        kind: "image",
        companyId: C,
        at: "2026-09-24T00:00:00Z",
      },
      env,
    );
    if (!r.ok) throw new Error("expected reserve");
    expect(canStartCharacter(budgetSummary(r.next, month, env))).toBe(false);
  });
});

describe("el payload de la cola", () => {
  it("sin op es el de siempre (train), y tolera los campos viejos", () => {
    const r = parseInfluencerQueueJob({
      companyId: C,
      influencerId: I,
      name: "Emily",
      creditsPeriod: "2026-09",
      creditsCharged: 250,
    });
    expect(r).toEqual({
      ok: true,
      payload: { op: "train", companyId: C, influencerId: I },
    });
  });

  it("op image exige los tres uuid", () => {
    expect(
      parseInfluencerQueueJob({
        op: "image",
        companyId: C,
        influencerId: I,
        generationId: G,
      }),
    ).toEqual({
      ok: true,
      payload: { op: "image", companyId: C, influencerId: I, generationId: G },
    });
    expect(
      parseInfluencerQueueJob({ op: "image", companyId: C, influencerId: I }).ok,
    ).toBe(false);
    expect(
      parseInfluencerQueueJob({ op: "video", companyId: C, influencerId: I }).ok,
    ).toBe(false);
    expect(parseInfluencerQueueJob(null).ok).toBe(false);
  });

  it("estados terminales y clave de storage determinista", () => {
    expect(isTerminalInfluencerGeneration("ready")).toBe(true);
    expect(isTerminalInfluencerGeneration("generating")).toBe(false);
    expect(
      influencerImageStorageKey({
        companyId: C,
        influencerId: I,
        generationId: G,
        index: 0,
        ext: "png",
      }),
    ).toBe(`media/${C}/influencers/${I}/${G}-1.png`);
  });
});

describe("templates, imagen base y video (sprint 7)", () => {
  it("{subject} según el género", () => {
    const tpl = { prompt: "{subject} at the beach" };
    expect(t.applyTemplate(tpl, "female")).toBe("her at the beach");
    expect(t.applyTemplate(tpl, "male")).toBe("him at the beach");
    expect(t.applyTemplate(tpl, undefined)).toBe("them at the beach");
  });

  it("la lista guardada se valida entera", () => {
    expect(t.checkTemplateList(t.DEFAULT_INFLUENCER_TEMPLATES).ok).toBe(true);
    expect(
      t.checkTemplateList([
        { id: "a", label: "A", prompt: "p" },
        { id: "a", label: "B", prompt: "q" },
      ]).ok,
    ).toBe(false);
    expect(t.checkTemplateList([{ id: "Bad Id", label: "A", prompt: "p" }]).ok).toBe(
      false,
    );
    expect(t.parseStoredTemplates({ version: 1, templates: [] })).toEqual([]);
    expect(t.parseStoredTemplates({ version: 2, templates: [] })).toBeNull();
  });

  it("el prompt de la imagen base describe a una persona", () => {
    expect(t.composeBaseCharacterPrompt({})).toBeNull();
    const p = t.composeBaseCharacterPrompt({
      gender: "female",
      age: 27,
      ethnicity: "Latina",
      details: "curly red hair",
      instructions: "in a coffee shop",
    });
    expect(p).toContain("single 27-year-old Latina female");
    expect(p).toContain("curly red hair, in a coffee shop");
  });

  it("el job de video se parsea", () => {
    expect(
      parseInfluencerQueueJob({
        op: "video",
        companyId: C,
        influencerId: I,
        generationId: G,
      }),
    ).toEqual({
      ok: true,
      payload: { op: "video", companyId: C, influencerId: I, generationId: G },
    });
  });
});
