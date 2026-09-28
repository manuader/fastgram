/**
 * El decisor de assets (sprint 9, O) con respuestas de juicio falsas: fija la
 * ponderación, el umbral de seguridad, el empate y el fallback. Sin red.
 */
import { describe, expect, it } from "vitest";
import type { NoulAnswer, ScoreAnswer } from "@fastgram/ports";

import {
  ASSET_WEIGHTS,
  ASSET_WEIGHTS_VERSION,
  HARM_MAX,
  NSFW_MAX,
  VERIFIABLE_LICENSES,
  assetQuestions,
  assetSafetyState,
  assetState,
  decideAsset,
  formatNeeds,
  normalizeScore,
  planAssetDecision,
  shortlistCandidates,
  topScored,
  type AssetCandidate,
  type CandidateAnswers,
  type ShortlistEntry,
} from "./index.js";

/** Un `ScoreAnswer` de 4 niveles con todo el peso en `level` (1-based). */
function score(level: number): ScoreAnswer {
  const probabilities = [0, 0, 0, 0];
  probabilities[level - 1] = 1;
  return { kind: "score", value: level, probabilities, confidence: 1 };
}
const noul = (p: number): NoulAnswer => ({ kind: "noul", probability: p });
/** Seguridad con p(NSFW) = `p` y p(daño) = `harm`. */
const sf = (p: number, harm = 0) => ({ harm: noul(harm), nsfw: noul(p) });

const clip = (id: string, extra: Partial<AssetCandidate> = {}): AssetCandidate => ({
  id,
  kind: "meme_clip",
  source: "brand",
  description: `clip ${id}`,
  ...extra,
});

function entries(ids: readonly string[]): ShortlistEntry[] {
  return ids.map((id, i) => ({ candidate: clip(id), textRank: i, textScore: 0 }));
}

describe("normalizeScore", () => {
  it("[1, n] → [0, 1]", () => {
    expect(normalizeScore(score(1))).toBe(0);
    expect(normalizeScore(score(4))).toBe(1);
    expect(normalizeScore(score(2))).toBeCloseTo(1 / 3, 9);
  });
});

describe("decideAsset — ponderación", () => {
  it("meme: gana el mejor ponderado (idea .4, remate .3, marca .15, texto .15)", () => {
    const answers = new Map<string, CandidateAnswers>([
      // idea 4, remate 1, marca 4, texto 0 → 0.4 + 0 + 0.15 + 0 = 0.55
      [
        "a",
        {
          fit: { ideaFit: score(4), punchline: score(1), brandFit: score(4) },
          safety: sf(0.1),
        },
      ],
      // idea 3, remate 4, marca 2 → 0.4·⅔ + 0.3 + 0.15·⅓ = 0.6167
      [
        "b",
        {
          fit: { ideaFit: score(3), punchline: score(4), brandFit: score(2) },
          safety: sf(0.1),
        },
      ],
      // idea 1 → pierde
      [
        "c",
        {
          fit: { ideaFit: score(1), punchline: score(4), brandFit: score(4) },
          safety: sf(0.1),
        },
      ],
    ]);
    const d = decideAsset({ role: "meme", shortlist: entries(["a", "b", "c"]), answers });
    expect(d.mode).toBe("judged");
    expect(d.chosenId).toBe("b");
    expect(d.weightsVersion).toBe(ASSET_WEIGHTS_VERSION);
    const byId = new Map(d.scored.map((s) => [s.id, s.total]));
    expect(byId.get("a")).toBeCloseTo(0.55, 9);
    expect(byId.get("b")).toBeCloseTo(0.4 * (2 / 3) + 0.3 + 0.15 * (1 / 3), 9);
    expect(topScored(d, 2).map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("la relevancia textual ancla cuando el juicio no separa", () => {
    // Juicio plano (todos 3/3/3): gana el que el ranking textual ya prefería,
    // aunque vaya segundo en la shortlist.
    const flat = {
      fit: { ideaFit: score(3), punchline: score(3), brandFit: score(3) },
      safety: sf(0),
    };
    const d = decideAsset({
      role: "meme",
      shortlist: [
        { candidate: clip("words0"), textRank: 0, textScore: 0 },
        { candidate: clip("words3"), textRank: 1, textScore: 3 },
      ],
      answers: new Map([
        ["words0", flat],
        ["words3", flat],
      ]),
    });
    expect(d.chosenId).toBe("words3");
  });

  it("recalcular con otros pesos no pide nada nuevo: cambia el elegido", () => {
    const answers = new Map<string, CandidateAnswers>([
      [
        "a",
        {
          fit: { ideaFit: score(4), punchline: score(1), brandFit: score(4) },
          safety: sf(0),
        },
      ],
      [
        "b",
        {
          fit: { ideaFit: score(3), punchline: score(4), brandFit: score(2) },
          safety: sf(0),
        },
      ],
    ]);
    const d = decideAsset({
      role: "meme",
      shortlist: entries(["a", "b"]),
      answers,
      weights: { ideaFit: 1 },
      weightsVersion: "test",
    });
    expect(d.chosenId).toBe("a");
    expect(d.weightsVersion).toBe("test");
  });

  it("fondo: no hay remate, pesan idea y marca", () => {
    expect(ASSET_WEIGHTS.background.punchline).toBeUndefined();
    expect(assetQuestions("background").map((q) => q.id)).toEqual([
      "ideaFit",
      "brandFit",
    ]);
    expect(assetQuestions("meme").map((q) => q.id)).toEqual([
      "ideaFit",
      "brandFit",
      "punchline",
    ]);
  });

  it("empate (±1e-3) → el mejor del ranking textual", () => {
    const same = { fit: { ideaFit: score(3), brandFit: score(3) }, safety: sf(0) };
    const answers = new Map<string, CandidateAnswers>([
      ["late", same],
      ["early", same],
    ]);
    const d = decideAsset({
      role: "background",
      // `early` tiene mejor ranking textual aunque va segundo en el mapa.
      shortlist: [
        { candidate: clip("late"), textRank: 3, textScore: 0 },
        { candidate: clip("early"), textRank: 1, textScore: 2 },
      ],
      answers,
    });
    expect(d.chosenId).toBe("early");
  });
});

describe("decideAsset — umbral de seguridad duro", () => {
  it(`p(daño) ≥ ${String(HARM_MAX)} también queda fuera`, () => {
    const answers = new Map<string, CandidateAnswers>([
      [
        "violent",
        { fit: { ideaFit: score(4), brandFit: score(4) }, safety: sf(0, HARM_MAX) },
      ],
      [
        "calm",
        {
          fit: { ideaFit: score(2), brandFit: score(2) },
          safety: sf(0, HARM_MAX - 0.01),
        },
      ],
    ]);
    const d = decideAsset({
      role: "background",
      shortlist: entries(["violent", "calm"]),
      answers,
    });
    expect(d.chosenId).toBe("calm");
    expect(d.scored.find((s) => s.id === "violent")).toMatchObject({
      status: "unsafe",
      harm: HARM_MAX,
    });
  });

  it(`p(NSFW) ≥ ${String(NSFW_MAX)} queda fuera aunque sea el mejor`, () => {
    const answers = new Map<string, CandidateAnswers>([
      ["best", { fit: { ideaFit: score(4), brandFit: score(4) }, safety: sf(NSFW_MAX) }],
      [
        "ok",
        { fit: { ideaFit: score(2), brandFit: score(2) }, safety: sf(NSFW_MAX - 0.01) },
      ],
    ]);
    const d = decideAsset({
      role: "background",
      shortlist: entries(["best", "ok"]),
      answers,
    });
    expect(d.chosenId).toBe("ok");
    expect(d.scored.find((s) => s.id === "best")?.status).toBe("unsafe");
  });

  it("todos inseguros → nadie (no «el menos malo»)", () => {
    const answers = new Map<string, CandidateAnswers>([
      ["a", { fit: { ideaFit: score(4), brandFit: score(4) }, safety: sf(0.95) }],
      ["b", { fit: { ideaFit: score(4), brandFit: score(4) }, safety: sf(0, 0.6) }],
    ]);
    const d = decideAsset({
      role: "background",
      shortlist: entries(["a", "b"]),
      answers,
    });
    expect(d.mode).toBe("all_unsafe");
    expect(d.chosenId).toBeNull();
  });

  it("sin respuesta de seguridad no compite", () => {
    const answers = new Map<string, CandidateAnswers>([
      ["unchecked", { fit: { ideaFit: score(4), brandFit: score(4) } }],
      ["checked", { fit: { ideaFit: score(2), brandFit: score(2) }, safety: sf(0.1) }],
    ]);
    const d = decideAsset({
      role: "background",
      shortlist: entries(["unchecked", "checked"]),
      answers,
    });
    expect(d.chosenId).toBe("checked");
  });
});

describe("decideAsset — fallback (nunca bloquea)", () => {
  it("sin juicio → el primero del ranking textual", () => {
    const d = decideAsset({
      role: "meme",
      shortlist: entries(["t0", "t1"]),
      answers: null,
    });
    expect(d.mode).toBe("fallback");
    expect(d.chosenId).toBe("t0");
    expect(d.reason).toMatch(/not available/);
  });

  it("juicio que no llegó para nadie (timeout) → ranking textual", () => {
    const d = decideAsset({
      role: "meme",
      shortlist: entries(["t0", "t1"]),
      answers: new Map(),
    });
    expect(d.mode).toBe("fallback");
    expect(d.chosenId).toBe("t0");
    expect(d.reason).toMatch(/in time/);
  });

  it("en el fallback no se elige uno que el juicio ya marcó inseguro", () => {
    const answers = new Map<string, CandidateAnswers>([["t0", { safety: sf(0.95) }]]);
    const d = decideAsset({ role: "meme", shortlist: entries(["t0", "t1"]), answers });
    expect(d.mode).toBe("fallback");
    expect(d.chosenId).toBe("t1");
  });

  it("respuestas parciales: decide entre los que llegaron", () => {
    const answers = new Map<string, CandidateAnswers>([
      [
        "t2",
        {
          fit: { ideaFit: score(3), brandFit: score(3), punchline: score(3) },
          safety: sf(0),
        },
      ],
    ]);
    const d = decideAsset({
      role: "meme",
      shortlist: entries(["t0", "t1", "t2"]),
      answers,
    });
    expect(d.mode).toBe("judged");
    expect(d.chosenId).toBe("t2");
  });

  it("shortlist vacía → empty", () => {
    const d = decideAsset({ role: "meme", shortlist: [], answers: null });
    expect(d.mode).toBe("empty");
    expect(d.chosenId).toBeNull();
  });
});

describe("filtro y shortlist", () => {
  const meme = formatNeeds("green-screen").find((n) => n.role === "meme");
  const bg = formatNeeds("green-screen").find((n) => n.role === "background");
  if (meme === undefined || bg === undefined) throw new Error("faltan roles");

  it("clase, duración, aspecto y licencia; lo desconocido pasa", () => {
    const r = shortlistCandidates({
      idea: "monday",
      needs: meme,
      candidates: [
        clip("ok"),
        clip("no-duration", { durationSec: null }),
        clip("long", { durationSec: 45 }),
        clip("bg", { kind: "background_image" }),
        clip("lib-unlicensed", { source: "library", license: null }),
        clip("lib-nc", { source: "library", license: "cc-by-nc" }),
        clip("lib-cc0", { source: "library", license: "cc0" }),
      ],
    });
    expect(r.shortlist.map((e) => e.candidate.id).sort()).toEqual([
      "lib-cc0",
      "no-duration",
      "ok",
    ]);
    expect(Object.fromEntries(r.excluded.map((e) => [e.id, e.reason]))).toEqual({
      long: "duration",
      bg: "kind",
      "lib-unlicensed": "license",
      "lib-nc": "license",
    });

    const aspect = shortlistCandidates({
      idea: null,
      needs: bg,
      candidates: [
        clip("wide", { kind: "background_image", aspect: "16:9" }),
        clip("tall", { kind: "background_video", aspect: "9:16" }),
        clip("unknown", { kind: "background_image" }),
      ],
    });
    expect(aspect.shortlist.map((e) => e.candidate.id)).toEqual(["tall", "unknown"]);
  });

  it("los recientes salen, salvo que no quede nadie", () => {
    const r = shortlistCandidates({
      idea: null,
      needs: meme,
      candidates: [clip("a"), clip("b")],
      recentIds: new Set(["a"]),
    });
    expect(r.shortlist.map((e) => e.candidate.id)).toEqual(["b"]);
    expect(r.excluded).toEqual([{ id: "a", reason: "recent" }]);

    const all = shortlistCandidates({
      idea: null,
      needs: meme,
      candidates: [clip("a")],
      recentIds: new Set(["a"]),
    });
    expect(all.shortlist.map((e) => e.candidate.id)).toEqual(["a"]);
  });

  it("ranking textual primero, sin descartar a los de relevancia 0, con tope", () => {
    const r = shortlistCandidates({
      idea: "a meme about mondays",
      needs: meme,
      candidates: [
        clip("x", { description: "cat falls" }),
        clip("y", { description: "hates mondays", tags: ["monday"] }),
        clip("z", { description: "dog" }),
      ],
      size: 2,
    });
    expect(r.shortlist.map((e) => [e.candidate.id, e.textRank])).toEqual([
      ["y", 0],
      ["x", 1],
    ]);
    expect(r.excluded).toEqual([{ id: "z", reason: "shortlist" }]);
  });

  it("las licencias verificables son las de la biblioteca global (N)", () => {
    expect([...VERIFIABLE_LICENSES]).toEqual([
      "cc0",
      "cc-by",
      "pexels",
      "pixabay",
      "own",
      "generated",
    ]);
  });
});

describe("estado y plan", () => {
  it("el estado lleva idea, marca, formato y un candidato limpio; sin id", () => {
    const state = assetState({
      idea: "  lunes​ odiosos ",
      brand: {
        name: "Café Lunes",
        identity: "specialty coffee",
        tone: "playful",
        audience: "office workers",
      },
      format: "green-screen",
      role: "meme",
      candidate: clip("secret-id", {
        description: "office worker groans",
        tags: ["monday"],
        durationSec: 7.4,
      }),
    });
    expect(state).toEqual({
      idea: "lunes odiosos",
      brand: {
        name: "Café Lunes",
        identity: "specialty coffee",
        tone: "playful",
        audience: "office workers",
      },
      format: "green-screen (meme)",
      candidate: {
        kind: "green-screen reaction meme clip",
        description: "office worker groans",
        tags: ["monday"],
        durationSec: 7,
      },
    });
    expect(JSON.stringify(state)).not.toContain("secret-id");
    expect(assetSafetyState(clip("q", { description: "sunset" }))).toEqual({
      candidate: "sunset",
    });
  });

  it("planAssetDecision arma un pedido de encaje y uno de seguridad por candidato", () => {
    const plan = planAssetDecision({
      idea: "mondays",
      brand: { name: "B" },
      format: "green-screen",
      role: "meme",
      candidates: [clip("a"), clip("b")],
    });
    expect(plan?.requests.map((r) => r.id)).toEqual(["a", "b"]);
    expect(plan?.questions).toHaveLength(3);
    expect(
      planAssetDecision({
        idea: null,
        brand: { name: "B" },
        format: "static",
        role: "music",
        candidates: [],
      }),
    ).toBeNull();
  });
});
