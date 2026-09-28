import { describe, expect, it } from "vitest";
import type { Rng } from "@fastgram/ports";

import {
  DEFAULT_PREFERENCE_SETTINGS,
  aggregatePreferenceSignals,
  buildPreferences,
  combinedPreferenceScore,
  describeLearnedPreferences,
  loadPreferences,
  mergePreferenceStats,
  parsePreferenceStats,
  pickWithExploration,
  preferenceBetaScore,
  scoreCandidate,
  type PreferenceSignal,
  type PreferenceSnapshot,
} from "./model.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const BRAND = "0b9a8c9e-6f0e-4d7c-9a51-3f1e2d4c5b6a";
const OTHER = "1b9a8c9e-6f0e-4d7c-9a51-3f1e2d4c5b6a";

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

const accept = (features: string[], ageDays = 0): PreferenceSignal => ({
  kind: "accept",
  features,
  occurredAtMs: NOW - ageDays * DAY,
});
const discard = (features: string[], ageDays = 0): PreferenceSignal => ({
  kind: "discard",
  features,
  occurredAtMs: NOW - ageDays * DAY,
});

describe("prior Beta(1,1) y evidencia mínima", () => {
  it("sin evidencia es 0; bajo el mínimo, también", () => {
    expect(preferenceBetaScore(0, 0)).toBe(0);
    expect(preferenceBetaScore(2, 0)).toBe(0);
  });

  it("tres aceptaciones sin rechazos dan 0,6, no 1: el prior encoge", () => {
    expect(preferenceBetaScore(3, 0)).toBeCloseTo(0.6, 6);
    expect(preferenceBetaScore(0, 3)).toBeCloseTo(-0.6, 6);
    expect(preferenceBetaScore(30, 0)).toBeCloseTo(2 * (31 / 32) - 1, 6);
  });

  it("una sola decisión no mueve el multiplicador", () => {
    const stats = aggregatePreferenceSignals([accept(["bg.tone=dark"])], { nowMs: NOW });
    const prefs = buildPreferences({ brand: stats, owner: null, nowMs: NOW });
    expect(scoreCandidate(["bg.tone=dark"], prefs).multiplier).toBe(1);
  });
});

describe("decaimiento temporal", () => {
  it("una señal de hace una vida media pesa la mitad", () => {
    const stats = aggregatePreferenceSignals([accept(["format=slideshow"], 30)], {
      nowMs: NOW,
      halfLifeDays: 30,
    });
    expect(stats.features["format=slideshow"]?.pos).toBeCloseTo(0.5, 6);
    // La cuenta cruda (para «12 de 14») no decae.
    expect(stats.features["format=slideshow"]?.accepts).toBe(1);
  });

  it("lo viejo deja de alcanzar la evidencia mínima y vuelve a 0", () => {
    const signals = [0, 1, 2, 3].map(() => discard(["bg.tone=dark"], 90));
    const fresh = buildPreferences({
      brand: aggregatePreferenceSignals(signals, { nowMs: NOW - 90 * DAY }),
      owner: null,
      nowMs: NOW - 90 * DAY,
    });
    expect(fresh.features.get("bg.tone=dark")?.score).toBeLessThan(-0.5);
    // Las mismas estadísticas, vistas 90 días después (3 vidas medias: ×1/8).
    const later = buildPreferences({
      brand: aggregatePreferenceSignals(signals, { nowMs: NOW - 90 * DAY }),
      owner: null,
      nowMs: NOW,
    });
    expect(later.features.get("bg.tone=dark")?.score).toBe(0);
  });

  it("sinceMs (reset del dueño) ignora lo anterior", () => {
    const stats = aggregatePreferenceSignals(
      [accept(["format=slideshow"], 5), accept(["format=slideshow"], 1)],
      { nowMs: NOW, sinceMs: NOW - 2 * DAY },
    );
    expect(stats.features["format=slideshow"]?.total).toBe(1);
    expect(stats.signalCount).toBe(1);
  });
});

describe("ediciones", () => {
  it("editar después de aceptar: negativa débil sobre lo que sacó, positiva débil sobre lo que puso", () => {
    const stats = aggregatePreferenceSignals(
      [
        {
          kind: "edit_after_accept",
          features: [],
          removed: ["bg.tone=dark"],
          added: ["bg.tone=light"],
          occurredAtMs: NOW,
        },
      ],
      { nowMs: NOW },
    );
    expect(stats.features["bg.tone=dark"]).toMatchObject({
      pos: 0,
      neg: 0.3,
      accepts: 0,
      total: 1,
    });
    expect(stats.features["bg.tone=light"]).toMatchObject({
      pos: 0.3,
      neg: 0,
      accepts: 1,
      total: 1,
    });
  });
});

describe("marca + dueño (encogimiento)", () => {
  const ownerLikesSlides = aggregatePreferenceSignals(
    Array.from({ length: 20 }, () => accept(["format=slideshow"])),
    { nowMs: NOW },
  );

  it("una marca sin evidencia hereda el gusto del dueño", () => {
    const prefs = buildPreferences({ brand: null, owner: ownerLikesSlides, nowMs: NOW });
    const s = prefs.features.get("format=slideshow")?.score ?? 0;
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(prefs.features.get("format=slideshow")?.owner?.score ?? 0);
  });

  it("con mucha evidencia propia, la marca manda aunque el dueño opine lo contrario", () => {
    const brand = aggregatePreferenceSignals(
      Array.from({ length: 40 }, () => discard(["format=slideshow"])),
      { nowMs: NOW },
    );
    const prefs = buildPreferences({ brand, owner: ownerLikesSlides, nowMs: NOW });
    expect(prefs.features.get("format=slideshow")?.score).toBeLessThan(-0.7);
  });

  it("con poca evidencia propia, queda entre las dos", () => {
    const k = DEFAULT_PREFERENCE_SETTINGS;
    const brandStat = { pos: 0, neg: 2, accepts: 0, total: 2, lastMs: NOW };
    const mixed = combinedPreferenceScore(brandStat, 0.9, 20, k);
    expect(mixed).toBeGreaterThan(-0.2);
    expect(mixed).toBeLessThan(0.6);
  });

  it("los ids de una marca (ángulo, pista) no pasan al dueño", () => {
    const owner = aggregatePreferenceSignals(
      Array.from({ length: 10 }, () => accept([`angle=${OTHER}`])),
      { nowMs: NOW },
    );
    const prefs = buildPreferences({ brand: null, owner, nowMs: NOW });
    expect(prefs.features.get(`angle=${OTHER}`)?.score).toBe(0);
  });
});

describe("scoreCandidate", () => {
  const brand = aggregatePreferenceSignals(
    [
      ...Array.from({ length: 8 }, () => accept(["clip.kind=reaction"])),
      ...Array.from({ length: 8 }, () => discard(["bg.tone=dark"])),
    ],
    { nowMs: NOW },
  );
  const prefs = buildPreferences({ brand, owner: null, nowMs: NOW });

  it("sube lo que acepta, baja lo que descarta, y dice por qué", () => {
    const liked = scoreCandidate(["clip.kind=reaction", "bg.tone=light"], prefs);
    const disliked = scoreCandidate(["bg.tone=dark"], prefs);
    expect(liked.multiplier).toBeGreaterThan(1.5);
    expect(disliked.multiplier).toBeLessThan(0.67);
    expect(liked.contributions.map((c) => c.feature)).toEqual(["clip.kind=reaction"]);
  });

  it("apagadas, multiplicador 1", () => {
    const off = buildPreferences({
      brand,
      owner: null,
      nowMs: NOW,
      settings: { enabled: false },
    });
    expect(scoreCandidate(["clip.kind=reaction"], off).multiplier).toBe(1);
  });

  it("acotado a [1/16, 16]", () => {
    const anims = ["pop", "fade", "slide", "bounce", "karaoke", "typewriter"].map(
      (a) => `text.anim=${a}`,
    );
    const many = aggregatePreferenceSignals(
      Array.from({ length: 50 }, () => accept(anims)),
      { nowMs: NOW },
    );
    const p = buildPreferences({ brand: many, owner: null, nowMs: NOW });
    expect(scoreCandidate(anims, p).multiplier).toBe(16);
  });

  it("expectedMultiplier mezcla la exploración", () => {
    const s = scoreCandidate(["clip.kind=reaction"], prefs, { exploration: 0.5 });
    expect(s.expectedMultiplier).toBeCloseTo(0.5 * s.multiplier + 0.5, 6);
  });
});

describe("pickWithExploration con Rng fijo", () => {
  const brand = aggregatePreferenceSignals(
    Array.from({ length: 10 }, () => accept(["format=slideshow"])),
    { nowMs: NOW },
  );
  const prefs = buildPreferences({ brand, owner: null, nowMs: NOW });
  const candidates = ["slideshow", "wall-of-text"] as const;
  const draw = (seed: number, exploration: number) => {
    const rng = seeded(seed);
    return Array.from({ length: 2000 }, () =>
      pickWithExploration({
        candidates,
        featuresOf: (c) => [`format=${c}`],
        prefs,
        rng,
        exploration,
      }),
    );
  };

  it("es determinista con la misma semilla", () => {
    expect(draw(7, 0.15)).toEqual(draw(7, 0.15));
  });

  it("explora con la probabilidad pedida (15 % ± 2,5)", () => {
    const explored = draw(11, 0.15).filter((r) => r.explored).length / 2000;
    expect(explored).toBeGreaterThan(0.125);
    expect(explored).toBeLessThan(0.175);
  });

  it("con exploración 0 sigue las preferencias; con 0,5 (el tope) mezcla", () => {
    const share = (e: number) =>
      draw(3, e).filter((r) => r.picked === "slideshow").length / 2000;
    const greedy = share(0);
    const mixed = share(0.5);
    const capped = share(1); // se acota a 0,5
    expect(greedy).toBeGreaterThan(0.6);
    expect(mixed).toBeLessThan(greedy);
    expect(capped).toBeCloseTo(mixed, 1);
  });
});

describe("persistencia y carga", () => {
  it("parsePreferenceStats vuelve de jsonb y descarta lo que no tiene forma", () => {
    const stats = aggregatePreferenceSignals([accept(["format=slideshow"])], {
      nowMs: NOW,
    });
    const round = parsePreferenceStats(JSON.parse(JSON.stringify(stats)));
    expect(round).toEqual(stats);
    expect(parsePreferenceStats("nope")).toBeNull();
    expect(
      parsePreferenceStats({
        computedAtMs: NOW,
        halfLifeDays: 30,
        features: { x: { pos: "a" } },
      })?.features,
    ).toEqual({});
  });

  it("mergePreferenceStats suma marcas llevadas al mismo instante", () => {
    const a = aggregatePreferenceSignals([accept(["format=slideshow"])], {
      nowMs: NOW - 30 * DAY,
    });
    const b = aggregatePreferenceSignals([accept(["format=slideshow"])], { nowMs: NOW });
    const m = mergePreferenceStats([a, b], NOW, 30);
    expect(m.features["format=slideshow"]?.pos).toBeCloseTo(1.5, 6);
    expect(m.features["format=slideshow"]?.total).toBe(2);
  });

  it("loadPreferences: configuración de la marca, o la del dueño, y el dueño sin la marca", async () => {
    const own = aggregatePreferenceSignals(
      Array.from({ length: 6 }, () => accept(["bg.tone=dark"])),
      { nowMs: NOW },
    );
    const other = aggregatePreferenceSignals(
      Array.from({ length: 6 }, () => discard(["format=slideshow"])),
      { nowMs: NOW },
    );
    const snapshot: PreferenceSnapshot = {
      brand: { enabled: true, exploration: null, halfLifeDays: null, stats: own },
      owner: {
        exploration: 0.3,
        halfLifeDays: 14,
        brandStats: { [BRAND]: own, [OTHER]: other },
      },
    };
    const prefs = await loadPreferences(
      { load: () => Promise.resolve(snapshot) },
      BRAND,
      {
        nowMs: NOW,
      },
    );
    expect(prefs.settings.exploration).toBe(0.3);
    expect(prefs.settings.halfLifeDays).toBe(14);
    // `bg.tone=dark`: la evidencia del dueño es sólo la de OTHER (no la cuenta dos veces).
    expect(prefs.features.get("bg.tone=dark")?.owner).toBeNull();
    expect(prefs.features.get("format=slideshow")?.score).toBeLessThan(0);
  });

  it("describeLearnedPreferences ordena por fuerza y trae la evidencia", () => {
    const brand = aggregatePreferenceSignals(
      [
        ...Array.from({ length: 12 }, () => accept(["clip.kind=reaction"])),
        ...Array.from({ length: 2 }, () => discard(["clip.kind=reaction"])),
        ...Array.from({ length: 3 }, () => discard(["bg.tone=dark"])),
      ],
      { nowMs: NOW },
    );
    const insights = describeLearnedPreferences(
      buildPreferences({ brand, owner: null, nowMs: NOW }),
    );
    expect(insights[0]).toMatchObject({
      feature: "clip.kind=reaction",
      direction: "likes",
      accepts: 12,
      total: 14,
      source: "brand",
    });
    expect(insights[1]).toMatchObject({ feature: "bg.tone=dark", direction: "avoids" });
  });
});
