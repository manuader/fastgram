/**
 * Sprint 9 (T, `PU-S9-015`): las preferencias aprendidas sobre el mix del
 * refill (`biasMixByPreferences`). Todo con `Rng` sembrado: los números de
 * abajo son exactos para estas semillas.
 */
import { describe, expect, it } from "vitest";
import type { Rng } from "@fastgram/ports";

import {
  aggregatePreferenceSignals,
  buildPreferences,
  type LearnedPreferences,
  type PreferenceSignal,
} from "../preferences/model.js";
import type { BlitzPreferences } from "./blitz-preferences.js";
import { biasMixByPreferences, planSuggestion } from "./plan-suggestion.js";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const A1 = "0b9a8c9e-6f0e-4d7c-9a51-3f1e2d4c5b61";
const A2 = "0b9a8c9e-6f0e-4d7c-9a51-3f1e2d4c5b62";

function seeded(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return {
    next,
    nextInt: (min, max) => min + Math.floor(next() * (max - min)),
    weightedPick<T>(items: readonly { value: T; weight: number }[]): T {
      const total = items.reduce((s, i) => s + i.weight, 0);
      if (total <= 0) throw new Error("weightedPick sin peso");
      let target = next() * total;
      for (const item of items) {
        target -= item.weight;
        if (target < 0) return item.value;
      }
      const last = items[items.length - 1];
      if (last === undefined) throw new Error("vacío");
      return last.value;
    },
  };
}

const mix = (over: Partial<BlitzPreferences> = {}): BlitzPreferences => ({
  slideshowWeight: 25,
  wallOfTextWeight: 25,
  greenScreenWeight: 25,
  videoHookWeight: 25,
  remixPercentage: 0,
  ownMediaPercentage: 50,
  mentionBusinessPercentage: 50,
  influencerChance: 0,
  smartTextPositioning: true,
  genderFilter: null,
  angleWeights: { [A1]: 50, [A2]: 50 },
  textStyleWeights: {},
  ...over,
});

const context = { activeAngleIds: [A1, A2], influencers: [] };

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

/** El dueño aceptó 6 green-screen del ángulo 1 y descartó 6 slideshows. */
const PATTERN: PreferenceSignal[] = [
  ...times(6, {
    kind: "accept",
    features: ["format=green-screen", `angle=${A1}`],
    occurredAtMs: NOW,
  }),
  ...times(6, { kind: "discard", features: ["format=slideshow"], occurredAtMs: NOW }),
];

/** El reparto de formatos de `n` planes con la semilla dada. */
function shares(
  seed: number,
  n: number,
  prefs: LearnedPreferences | null,
  base = mix(),
): Record<string, number> {
  const rng = seeded(seed);
  const out: Record<string, number> = {};
  for (let i = 0; i < n; i += 1) {
    const bias = biasMixByPreferences(rng, base, prefs);
    const plan = planSuggestion(rng, bias.preferences, context);
    out[plan.contentType] = (out[plan.contentType] ?? 0) + 1;
    out[`angle:${plan.angleId ?? "none"}`] =
      (out[`angle:${plan.angleId ?? "none"}`] ?? 0) + 1;
  }
  return out;
}

describe("biasMixByPreferences — sin nada aprendido es el plan de antes", () => {
  it("preferencias vacías: mismas preferencias, sin tirar el dado, mismo plan con la misma semilla", () => {
    const empty = learned([]);
    for (const seed of [1, 7, 42, 1234]) {
      const a = seeded(seed);
      const b = seeded(seed);
      for (let i = 0; i < 50; i += 1) {
        const bias = biasMixByPreferences(a, mix(), empty);
        expect(bias.applied).toBe(false);
        expect(bias.preferences).toEqual(mix());
        expect(planSuggestion(a, bias.preferences, context)).toEqual(
          planSuggestion(b, mix(), context),
        );
      }
    }
  });

  it("`null` (no se pudieron leer) y las preferencias apagadas: lo mismo", () => {
    const off = buildPreferences({
      brand: aggregatePreferenceSignals(PATTERN, { nowMs: NOW }),
      owner: null,
      settings: { enabled: false },
      nowMs: NOW,
    });
    for (const p of [null, off]) {
      const a = seeded(9);
      const b = seeded(9);
      const bias = biasMixByPreferences(a, mix(), p);
      expect(bias.applied).toBe(false);
      expect(planSuggestion(a, bias.preferences, context)).toEqual(
        planSuggestion(b, mix(), context),
      );
    }
  });

  it("rasgos aprendidos que no son formato ni ángulo (p. ej. el fondo) no tocan el mix ni el dado", () => {
    const bgOnly = learned(
      times(8, { kind: "accept", features: ["bg.tone=dark"], occurredAtMs: NOW }),
    );
    const a = seeded(3);
    const bias = biasMixByPreferences(a, mix(), bgOnly);
    expect(bias.applied).toBe(false);
    expect(a.next()).toBe(seeded(3).next());
  });
});

describe("biasMixByPreferences — con un patrón aprendido el plan se corre", () => {
  it("los multiplicadores son los de `scoreCandidate` (fuerza 2): 6 sí → ×2,83; 6 no → ×1/2,83", () => {
    const bias = biasMixByPreferences(seeded(1), mix(), learned(PATTERN, 0));
    expect(bias.applied).toBe(true);
    expect(bias.explored).toBe(false);
    // Beta(1,1) con 6 a favor: 2·7/8 − 1 = 0,75 → 2^(2·0,75) = 2,828.
    expect(bias.formatMultipliers["green-screen"]).toBeCloseTo(2 ** 1.5, 9);
    expect(bias.formatMultipliers.slideshow).toBeCloseTo(2 ** -1.5, 9);
    expect(bias.formatMultipliers["video-hook"]).toBe(1);
    expect(bias.preferences.greenScreenWeight).toBeCloseTo(25 * 2 ** 1.5, 9);
    expect(bias.preferences.slideshowWeight).toBeCloseTo(25 * 2 ** -1.5, 9);
    expect(bias.preferences.angleWeights[A1]).toBeCloseTo(50 * 2 ** 1.5, 9);
    expect(bias.preferences.angleWeights[A2]).toBe(50);
  });

  it("2000 planes, semilla 42: green-screen 23,8 % → 48,1 %; slideshow 25,3 % → 10,1 %; ángulo 1 49 % → 68,9 %", () => {
    const before = shares(42, 2000, null);
    const after = shares(42, 2000, learned(PATTERN));
    // Números exactos para esta semilla (el test los fija: si cambian, cambió
    // el sorteo o el modelo, y hay que mirarlo).
    expect(before["green-screen"]).toBe(475);
    expect(after["green-screen"]).toBe(962);
    expect(before["slideshow"]).toBe(506);
    expect(after["slideshow"]).toBe(201);
    expect(before[`angle:${A1}`]).toBe(980);
    expect(after[`angle:${A1}`]).toBe(1378);
  });

  it("un formato en 0 sigue en 0 aunque el dueño lo ame (AI-012)", () => {
    const love = learned(
      times(10, { kind: "accept", features: ["format=video-hook"], occurredAtMs: NOW }),
      0,
    );
    const base = mix({ videoHookWeight: 0, slideshowWeight: 50 });
    const s = shares(5, 500, love, base);
    expect(s["video-hook"]).toBeUndefined();
  });
});

describe("biasMixByPreferences — exploración con Rng fijo", () => {
  it("con exploración 1 siempre explora: el mix sin sesgo", () => {
    const rng = seeded(11);
    for (let i = 0; i < 20; i += 1) {
      const bias = biasMixByPreferences(rng, mix(), learned(PATTERN, 0.5));
      expect(bias.applied).toBe(true);
      if (bias.explored) expect(bias.preferences).toEqual(mix());
    }
  });

  it("semilla 42, exploración 15 %: 323 de 2000 sugerencias exploran (16,2 %)", () => {
    const rng = seeded(42);
    const prefs = learned(PATTERN);
    let explored = 0;
    for (let i = 0; i < 2000; i += 1) {
      const bias = biasMixByPreferences(rng, mix(), prefs);
      if (bias.explored) explored += 1;
      planSuggestion(rng, bias.preferences, context);
    }
    expect(explored).toBe(323);
  });

  it("exploración 0: nunca explora", () => {
    const rng = seeded(8);
    for (let i = 0; i < 200; i += 1) {
      expect(biasMixByPreferences(rng, mix(), learned(PATTERN, 0)).explored).toBe(false);
    }
  });
});
