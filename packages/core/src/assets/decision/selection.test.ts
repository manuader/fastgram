/**
 * Sprint 9 (T, `PU-S9-015`): el decisor de O con el gusto del dueño y con la
 * biblioteca global como candidatos. Juicio falso (respuestas armadas a mano),
 * sin red.
 */
import { describe, expect, it } from "vitest";
import type { NoulAnswer, ScoreAnswer } from "@fastgram/ports";

import type { LibraryMetadataLike } from "../../library/metadata.js";
import {
  aggregatePreferenceSignals,
  buildPreferences,
  type LearnedPreferences,
  type PreferenceSignal,
} from "../../preferences/model.js";
import {
  ASSET_PREFERENCE_MAX,
  assetPreferenceFeatures,
  assetPreferenceMultipliers,
  compressPreferenceMultiplier,
  decideAsset,
  libraryAssetCandidate,
  libraryKindsForRole,
  planAssetDecision,
  rankByFit,
  type AssetCandidate,
  type CandidateAnswers,
  type ShortlistEntry,
} from "./index.js";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const BRAND_CLIP = "0b9a8c9e-6f0e-4d7c-9a51-3f1e2d4c5b61";

function score(level: number): ScoreAnswer {
  const probabilities = [0, 0, 0, 0];
  probabilities[level - 1] = 1;
  return { kind: "score", value: level, probabilities, confidence: 1 };
}
/** Un score "blando": el valor esperado es `value` (para totales intermedios). */
function soft(value: number): ScoreAnswer {
  return {
    kind: "score",
    value,
    probabilities: [0.25, 0.25, 0.25, 0.25],
    confidence: 0.25,
  };
}
const noul = (p: number): NoulAnswer => ({ kind: "noul", probability: p });
const safe = { harm: noul(0.05), nsfw: noul(0.05) };

function learned(signals: PreferenceSignal[], exploration = 0.15): LearnedPreferences {
  return buildPreferences({
    brand: aggregatePreferenceSignals(signals, { nowMs: NOW }),
    owner: null,
    settings: { exploration },
    nowMs: NOW,
  });
}
const times = (n: number, s: PreferenceSignal): PreferenceSignal[] =>
  Array.from({ length: n }, () => s);

/** El dueño aceptó 6 piezas cuyo meme era «de risa» y descartó 6 de «shock». */
const LIKES_LAUGH = learned([
  ...times(6, { kind: "accept", features: ["clip.kind=laugh"], occurredAtMs: NOW }),
  ...times(6, { kind: "discard", features: ["clip.kind=shock"], occurredAtMs: NOW }),
]);

const meme = (id: string, tags: string[]): AssetCandidate => ({
  id,
  kind: "meme_clip",
  source: "brand",
  description: `clip ${id}`,
  tags,
});

function entries(cands: readonly AssetCandidate[]): ShortlistEntry[] {
  return cands.map((candidate, i) => ({ candidate, textRank: i, textScore: 0 }));
}

describe("rasgos de preferencia de un candidato", () => {
  it("un meme: tipo, fuente y tipo de meme de sus etiquetas; sin `format`", () => {
    expect(
      assetPreferenceFeatures(
        { ...meme("a", ["laughing", "office"]), mediaSource: "upload" },
        "meme",
      ),
    ).toEqual(["clip.kind=laugh", "clip.source=upload", "clip.type=video"]);
  });

  it("un fondo de la biblioteca: `bg.source=library` aunque no lo diga, y el tono", () => {
    expect(
      assetPreferenceFeatures(
        {
          id: "x",
          kind: "background_image",
          source: "library",
          description: "",
          tags: ["dark", "night city"],
        },
        "background",
      ),
    ).toEqual(["bg.source=library", "bg.tone=dark", "bg.type=image"]);
  });

  it("música: la pista sólo si es de la marca (uuid); un personaje: su id", () => {
    expect(
      assetPreferenceFeatures(
        {
          id: BRAND_CLIP,
          kind: "audio",
          source: "brand",
          description: "",
          mediaSource: "upload",
        },
        "music",
      ),
    ).toEqual(["music.source=upload", `music.track=${BRAND_CLIP}`, "music=track"]);
    expect(
      assetPreferenceFeatures(
        { id: BRAND_CLIP, kind: "character", source: "brand", description: "" },
        "character",
      ),
    ).toEqual([`influencer=${BRAND_CLIP}`]);
  });

  it("una fuente fuera del vocabulario no es un rasgo (no inventa)", () => {
    expect(
      assetPreferenceFeatures({ ...meme("a", []), mediaSource: "youtube" }, "meme"),
    ).toEqual(["clip.type=video"]);
  });
});

describe("el multiplicador acotado", () => {
  it("comprime [1/16, 16] a [1/1,5 ; 1,5] conservando el orden", () => {
    expect(compressPreferenceMultiplier(1)).toBe(1);
    expect(compressPreferenceMultiplier(16)).toBeCloseTo(ASSET_PREFERENCE_MAX, 9);
    expect(compressPreferenceMultiplier(1 / 16)).toBeCloseTo(1 / ASSET_PREFERENCE_MAX, 9);
    // Un rasgo en 0,75 → ×2,83 en Q → ×1,164 acá; dos → ×8 → ×1,355.
    expect(compressPreferenceMultiplier(2 ** 1.5)).toBeCloseTo(1.1642, 4);
    expect(compressPreferenceMultiplier(8)).toBeCloseTo(1.3554, 4);
    expect(compressPreferenceMultiplier(Number.NaN)).toBe(1);
  });

  it("sin preferencias, apagadas o explorando: ningún multiplicador", () => {
    const cands = [meme("a", ["laugh"]), meme("b", ["shocked"])];
    expect(assetPreferenceMultipliers(cands, "meme", null).size).toBe(0);
    expect(
      assetPreferenceMultipliers(cands, "meme", { prefs: learned([]), explored: false })
        .size,
    ).toBe(0);
    expect(
      assetPreferenceMultipliers(cands, "meme", { prefs: LIKES_LAUGH, explored: true })
        .size,
    ).toBe(0);
    const m = assetPreferenceMultipliers(cands, "meme", {
      prefs: LIKES_LAUGH,
      explored: false,
    });
    expect(m.get("a")).toBeCloseTo(1.164, 3);
    expect(m.get("b")).toBeCloseTo(1 / 1.164, 3);
  });
});

describe("decisor × preferencias (juicio falso)", () => {
  // `a` (shock) encaja un poco mejor que `b` (risa) según el juicio.
  const a = meme("a", ["shocked"]);
  const b = meme("b", ["laughing"]);
  const shortlist = entries([a, b]);
  const answers = new Map<string, CandidateAnswers>([
    // idea 3, remate 3, marca 3 → (0.4+0.3+0.15)·⅔ = 0.5667 (texto 0)
    [
      "a",
      {
        fit: { ideaFit: score(3), punchline: score(3), brandFit: score(3) },
        safety: safe,
      },
    ],
    // idea 2.8 (blando), remate 3, marca 3 → 0.4·0.6 + 0.3·⅔ + 0.15·⅔ = 0.54
    [
      "b",
      {
        fit: { ideaFit: soft(2.8), punchline: score(3), brandFit: score(3) },
        safety: safe,
      },
    ],
  ]);

  it("sin preferencias gana el mejor encaje (`a`), como antes", () => {
    const d = decideAsset({ role: "meme", shortlist, answers });
    expect(d.chosenId).toBe("a");
    const sa = d.scored.find((s) => s.id === "a");
    expect(sa?.preference).toBe(1);
    expect(sa?.total).toBeCloseTo(0.5667, 4);
    expect(sa?.fit).toBeCloseTo(0.5667, 4);
  });

  it("con el gusto aprendido gana `b`: 0,54·1,164 = 0,629 > 0,567/1,164 = 0,487; y el motivo lo dice", () => {
    const preference = assetPreferenceMultipliers([a, b], "meme", {
      prefs: LIKES_LAUGH,
      explored: false,
    });
    const d = decideAsset({ role: "meme", shortlist, answers, preference });
    expect(d.chosenId).toBe("b");
    const sb = d.scored.find((s) => s.id === "b");
    expect(sb?.fit).toBeCloseTo(0.54, 4);
    expect(sb?.total).toBeCloseTo(0.54 * 1.164, 3);
    expect(d.reason).toContain("your past choices tipped it");
    // El orden de la fase de seguridad es el mismo que el de la decisión.
    const fits = new Map([...answers].map(([id, x]) => [id, x.fit ?? {}]));
    expect(rankByFit({ role: "meme", shortlist, fits, preference })).toEqual(["b", "a"]);
    expect(rankByFit({ role: "meme", shortlist, fits })).toEqual(["a", "b"]);
  });

  it("explorando, el gusto no pesa: gana `a`", () => {
    const preference = assetPreferenceMultipliers([a, b], "meme", {
      prefs: LIKES_LAUGH,
      explored: true,
    });
    expect(decideAsset({ role: "meme", shortlist, answers, preference }).chosenId).toBe(
      "a",
    );
  });

  it("el gusto desempata, no salta a uno que el juicio puso claramente abajo", () => {
    const far = new Map<string, CandidateAnswers>([
      // a: idea 4 remate 4 marca 3 → 0.4+0.3+0.1 = 0.80
      [
        "a",
        {
          fit: { ideaFit: score(4), punchline: score(4), brandFit: score(3) },
          safety: safe,
        },
      ],
      // b: idea 2 remate 3 marca 3 → 0.1333+0.2+0.1 = 0.4333; ×1.5 (el tope) = 0.65 < 0.80
      [
        "b",
        {
          fit: { ideaFit: score(2), punchline: score(3), brandFit: score(3) },
          safety: safe,
        },
      ],
    ]);
    // El gusto más fuerte posible por `b`, `a` neutro.
    const extreme = new Map([["b", ASSET_PREFERENCE_MAX]]);
    const d = decideAsset({ role: "meme", shortlist, answers: far, preference: extreme });
    expect(d.chosenId).toBe("a");
    expect(d.reason).not.toContain("past choices");
  });

  it("el fallback (sin juicio) sigue siendo el ranking textual", () => {
    const preference = new Map([["b", 1.5]]);
    const d = decideAsset({ role: "meme", shortlist, answers: null, preference });
    expect(d.mode).toBe("fallback");
    expect(d.chosenId).toBe("a");
  });

  it("`planAssetDecision` calcula los multiplicadores de la shortlist", () => {
    const plan = planAssetDecision({
      idea: "mondays",
      brand: { name: "Acme" },
      format: "green-screen",
      role: "meme",
      candidates: [a, b],
      preferences: { prefs: LIKES_LAUGH, explored: false },
    });
    expect(plan?.preference.get("b")).toBeCloseTo(1.164, 3);
    expect(plan?.preference.get("a")).toBeCloseTo(1 / 1.164, 3);
  });
});

describe("la biblioteca global como candidatos", () => {
  const meta = (over: Partial<LibraryMetadataLike> = {}): LibraryMetadataLike => ({
    schemaVersion: 1,
    kind: "green_screen_video",
    description: "A man laughing hysterically at his desk",
    memeType: "reaction",
    emotions: ["laughing"],
    useCases: ["when the client pays on time"],
    characters: ["office worker"],
    tags: ["office", "laugh"],
    language: null,
    hasSpeech: false,
    durationSec: 4,
    aspect: { ratio: "16:9", width: 1920, height: 1080 },
    framing: "medium",
    chroma: { type: "green", keyQuality: 0.92, keyColor: "#00FF00" },
    energy: "high",
    needsReview: false,
    license: { type: "cc0" },
    ...over,
  });
  const row = (
    id: string,
    over: Partial<LibraryMetadataLike> = {},
    licenseType = "cc0",
  ) => ({
    id,
    kind: over.kind ?? "green_screen_video",
    title: `asset ${id}`,
    licenseType,
    durationSec: 4,
    metadata: meta(over),
  });

  it("qué tipos pedirle a la base por rol del green-screen", () => {
    expect(libraryKindsForRole("green-screen", "meme")).toEqual(["green_screen_video"]);
    expect(libraryKindsForRole("green-screen", "background")).toEqual([
      "background_video",
      "background_image",
    ]);
    expect(libraryKindsForRole("carousel", "image")).toEqual([
      "background_image",
      "image",
    ]);
    expect(libraryKindsForRole("static", "music")).toEqual([]);
  });

  it("una fila verde es un `meme_clip` de `source: library` con su licencia y descripción", () => {
    const c = libraryAssetCandidate(row("L1"), { format: "green-screen", role: "meme" });
    expect(c).toMatchObject({
      id: "L1",
      kind: "meme_clip",
      source: "library",
      license: "cc0",
      mediaSource: "library",
      aspect: "16:9",
      durationSec: 4,
    });
    expect(c?.description).toContain("license: cc0");
  });

  it("croma azul o alfa no compite por el meme del green-screen clásico", () => {
    for (const type of ["blue", "alpha"]) {
      expect(
        libraryAssetCandidate(
          row("L2", { chroma: { type, keyQuality: 0.9, keyColor: null } }),
          {
            format: "green-screen",
            role: "meme",
          },
        ),
      ).toBeNull();
    }
    expect(
      libraryAssetCandidate(
        { ...row("L3"), metadata: null },
        { format: "green-screen", role: "meme" },
      ),
    ).toBeNull();
  });

  it("licencia no verificable → excluida con motivo `license`; aspecto fuera de 9:16 → `aspect`", () => {
    const ok = libraryAssetCandidate(row("L4"), { format: "green-screen", role: "meme" });
    const bySa = libraryAssetCandidate(row("L5", {}, "cc-by-sa"), {
      format: "green-screen",
      role: "meme",
    });
    const wideBg = libraryAssetCandidate(
      row("L6", {
        kind: "background_image",
        chroma: { type: "none", keyQuality: null, keyColor: null },
      }),
      { format: "green-screen", role: "background" },
    );
    const plan = planAssetDecision({
      idea: "laughing at work",
      brand: { name: "Acme" },
      format: "green-screen",
      role: "meme",
      candidates: [ok, bySa].filter((c): c is AssetCandidate => c !== null),
    });
    expect(plan?.shortlist.map((e) => e.candidate.id)).toEqual(["L4"]);
    expect(plan?.excluded).toEqual([{ id: "L5", reason: "license" }]);
    const bg = planAssetDecision({
      idea: "x",
      brand: { name: "Acme" },
      format: "green-screen",
      role: "background",
      candidates: wideBg === null ? [] : [wideBg],
    });
    expect(bg?.excluded).toEqual([{ id: "L6", reason: "aspect" }]);
  });

  it("marca y biblioteca compiten en la misma shortlist; el ranking textual ve las etiquetas", () => {
    const lib = libraryAssetCandidate(row("L7"), {
      format: "green-screen",
      role: "meme",
    });
    const plan = planAssetDecision({
      idea: "laughing office",
      brand: { name: "Acme" },
      format: "green-screen",
      role: "meme",
      candidates: [meme(BRAND_CLIP, ["cat"]), ...(lib === null ? [] : [lib])],
    });
    expect(plan?.shortlist.map((e) => e.candidate.id)).toEqual(["L7", BRAND_CLIP]);
  });
});
