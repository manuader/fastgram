/**
 * «El test del pedido» (`PU-S9-011`): 30 decisiones con un patrón claro →
 * sobre un pool fijo de 200 candidatos, la proporción elegida con el patrón
 * sube de forma medible frente a elegir sin preferencias.
 *
 * El patrón del dueño: **acepta memes de reacción cortos sobre fondo claro y
 * descarta todo fondo oscuro**. Las 30 decisiones: acepta las 10 tarjetas que
 * cumplen y descarta las otras 20 (de las cuales 10 tienen fondo oscuro).
 *
 * Todo con `Rng` sembrado: los números de abajo son exactos para estas
 * semillas, y los umbrales tienen margen para que un cambio chico del modelo
 * no los rompa pero uno que lo desarme sí.
 */
import { describe, expect, it } from "vitest";
import type { Rng } from "@fastgram/ports";

import { extractPreferenceFeatures, type PreferenceSubject } from "./features.js";
import {
  aggregatePreferenceSignals,
  buildPreferences,
  pickWithExploration,
  type PreferenceSignal,
} from "./model.js";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const HOUR = 3_600_000;

/** Mínimos que fija el pedido. */
const EXPLORATION = 0.15;
const DRAWS = 2000;
/**
 * La proporción con el patrón tiene que al menos cuadruplicarse y subir al
 * menos 8 puntos. Medido con estas semillas: 2,15 % → 14,05 % (6,5×, +11,9).
 */
const MIN_LIFT_RATIO = 4;
const MIN_LIFT_POINTS = 0.08;
/**
 * Los fondos oscuros tienen que bajar al menos un 20 %. Medido: 50,9 % →
 * 36 % (0,71×). No baja más porque el dueño también descartó 10 fondos claros
 * (`bg.tone=light` queda ~0) y porque el 15 % de exploración no mira nada.
 */
const MAX_DARK_RATIO = 0.8;

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

const FORMATS = ["green-screen", "video-hook", "wall-of-text", "slideshow"] as const;
const KINDS = ["reaction", "laugh", "shocked", "dance", "sad"] as const;
const TEXTS = {
  short: "POV: monday",
  medium: "When the client asks for one tiny change and it rewrites the whole brief",
  long: "x".repeat(200),
} as const;
type Len = keyof typeof TEXTS;

interface Candidate {
  readonly id: number;
  readonly subject: PreferenceSubject;
  readonly features: readonly string[];
  readonly pattern: boolean;
  readonly dark: boolean;
}

function candidate(
  id: number,
  format: (typeof FORMATS)[number],
  kind: (typeof KINDS)[number],
  len: Len,
  dark: boolean,
  withMusic: boolean,
): Candidate {
  const hasClip = format === "green-screen" || format === "video-hook";
  const subject: PreferenceSubject = {
    format,
    origin: "refill",
    background: {
      mediaType: format === "wall-of-text" ? "video" : "image",
      source: "upload",
      tags: [dark ? "dark" : "bright"],
    },
    clip: hasClip ? { mediaType: "video", source: "imported", tags: [kind] } : null,
    music: withMusic ? { source: "upload" } : null,
    texts: [TEXTS[len]],
  };
  return {
    id,
    subject,
    features: extractPreferenceFeatures(subject),
    pattern: hasClip && kind === "reaction" && len === "short" && !dark,
    dark,
  };
}

function pick<T>(rng: Rng, xs: readonly T[]): T {
  const x = xs[rng.nextInt(0, xs.length)];
  if (x === undefined) throw new Error("vacío");
  return x;
}

/** El pool fijo de 200 candidatos, al azar con semilla. */
function pool(): Candidate[] {
  const rng = seeded(2026);
  return Array.from({ length: 200 }, (_, i) =>
    candidate(
      i,
      pick(rng, FORMATS),
      pick(rng, KINDS),
      pick(rng, ["short", "medium", "long"] as const),
      rng.next() < 0.5,
      rng.next() < 0.5,
    ),
  );
}

/** Las 30 decisiones: 10 aceptadas con el patrón, 20 descartadas (10 oscuras). */
function decisions(): PreferenceSignal[] {
  const rng = seeded(99);
  const out: PreferenceSignal[] = [];
  for (let i = 0; i < 10; i += 1) {
    const c = candidate(
      1000 + i,
      pick(rng, ["green-screen", "video-hook"] as const),
      "reaction",
      "short",
      false,
      rng.next() < 0.5,
    );
    out.push({ kind: "accept", features: c.features, occurredAtMs: NOW - i * HOUR });
  }
  for (let i = 0; i < 20; i += 1) {
    // No cumplen: la mitad por el fondo oscuro, la otra mitad por tipo o largo.
    const dark = i < 10;
    let c: Candidate;
    do {
      c = candidate(
        2000 + i,
        pick(rng, FORMATS),
        pick(rng, KINDS),
        pick(rng, ["short", "medium", "long"] as const),
        dark,
        rng.next() < 0.5,
      );
    } while (c.pattern);
    out.push({
      kind: "discard",
      features: c.features,
      occurredAtMs: NOW - (10 + i) * HOUR,
    });
  }
  return out;
}

function share(picks: readonly Candidate[], pred: (c: Candidate) => boolean): number {
  return picks.filter(pred).length / picks.length;
}

describe("30 decisiones con patrón → el pool se inclina hacia el patrón", () => {
  const candidates = pool();
  const signals = decisions();
  const learned = buildPreferences({
    brand: aggregatePreferenceSignals(signals, { nowMs: NOW }),
    owner: null,
    nowMs: NOW,
    settings: { exploration: EXPLORATION },
  });
  const none = buildPreferences({ brand: null, owner: null, nowMs: NOW });

  const run = (prefs: typeof learned, seed: number) => {
    const rng = seeded(seed);
    const picks: Candidate[] = [];
    let explored = 0;
    for (let i = 0; i < DRAWS; i += 1) {
      const r = pickWithExploration({
        candidates,
        featuresOf: (c) => c.features,
        prefs,
        rng,
      });
      picks.push(r.picked);
      if (r.explored) explored += 1;
    }
    return { picks, explored: explored / DRAWS };
  };

  const base = run(none, 5);
  const withPrefs = run(learned, 5);

  it("el pool tiene el patrón, pero es raro", () => {
    const inPool = candidates.filter((c) => c.pattern).length;
    expect(inPool).toBeGreaterThanOrEqual(3);
    expect(inPool / candidates.length).toBeLessThan(0.1);
  });

  it(`la proporción con el patrón sube ≥ ${String(MIN_LIFT_RATIO)}× y ≥ ${String(MIN_LIFT_POINTS * 100)} puntos`, () => {
    const before = share(base.picks, (c) => c.pattern);
    const after = share(withPrefs.picks, (c) => c.pattern);
    expect(after).toBeGreaterThanOrEqual(before * MIN_LIFT_RATIO);
    expect(after - before).toBeGreaterThanOrEqual(MIN_LIFT_POINTS);
  });

  it(`los fondos oscuros bajan (≤ ${String(MAX_DARK_RATIO)}×)`, () => {
    const before = share(base.picks, (c) => c.dark);
    const after = share(withPrefs.picks, (c) => c.dark);
    expect(after).toBeLessThanOrEqual(before * MAX_DARK_RATIO);
  });

  it(`no se encierra: explora ~${String(EXPLORATION * 100)} % y sigue mostrando oscuros`, () => {
    expect(withPrefs.explored).toBeGreaterThan(EXPLORATION - 0.025);
    expect(withPrefs.explored).toBeLessThan(EXPLORATION + 0.025);
    // Con 15 % de exploración sobre un pool mitad oscuro, al menos ~7 % sale oscuro.
    expect(share(withPrefs.picks, (c) => c.dark)).toBeGreaterThan(0.07);
  });

  it("sin preferencias, elegir es uniforme (no hay sesgo escondido)", () => {
    expect(share(base.picks, (c) => c.dark)).toBeCloseTo(
      share(candidates, (c) => c.dark),
      1,
    );
  });
});
