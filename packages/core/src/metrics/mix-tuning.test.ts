import { describe, expect, it } from "vitest";

import { DomainError } from "../errors.js";
import {
  MIX_FORMATS,
  MIX_TUNING_DEFAULTS,
  formatStats,
  isMixTuningDue,
  proposeFormatWeights,
  selectMixSamples,
  type FormatWeights,
  type MixFormat,
  type MixSample,
} from "./mix-tuning.js";

const W = (
  slideshow: number,
  wall: number,
  green: number,
  hook: number,
): FormatWeights => ({
  slideshow,
  "wall-of-text": wall,
  "green-screen": green,
  "video-hook": hook,
});

/** `n` posts de `format` en `network` con tasa `rate` (views 1000). */
const posts = (
  format: MixFormat,
  n: number,
  rate: number,
  network = "instagram",
): MixSample[] =>
  Array.from({ length: n }, () => ({
    format,
    network,
    views: 1000,
    likes: Math.round(rate * 1000),
    comments: 0,
    shares: 0,
  }));

const sum = (w: FormatWeights): number => MIX_FORMATS.reduce((a, f) => a + w[f], 0);

describe("proposeFormatWeights", () => {
  it("sube al que rinde y baja al que no, con suma exacta 100", () => {
    const out = proposeFormatWeights(W(25, 25, 25, 25), [
      ...posts("slideshow", 5, 0.1),
      ...posts("wall-of-text", 5, 0.02),
      ...posts("green-screen", 5, 0.05),
      ...posts("video-hook", 5, 0.05),
    ]);
    expect(out.kind).toBe("changed");
    if (out.kind !== "changed") return;
    expect(sum(out.to)).toBe(100);
    expect(out.to.slideshow).toBeGreaterThan(25);
    expect(out.to["wall-of-text"]).toBeLessThan(25);
  });

  it("acota el cambio a ±10 puntos por ciclo", () => {
    const out = proposeFormatWeights(W(40, 40, 10, 10), [
      ...posts("slideshow", 10, 0.5),
      ...posts("wall-of-text", 10, 0.001),
      ...posts("green-screen", 10, 0.001),
      ...posts("video-hook", 10, 0.001),
    ]);
    expect(out.kind).toBe("changed");
    if (out.kind !== "changed") return;
    for (const f of MIX_FORMATS) {
      expect(Math.abs(out.to[f] - out.from[f]), f).toBeLessThanOrEqual(10);
    }
    expect(sum(out.to)).toBe(100);
  });

  it("AI-012: un formato con peso 0 queda en 0 aunque sus posts viejos rindan mucho", () => {
    const out = proposeFormatWeights(W(50, 50, 0, 0), [
      ...posts("slideshow", 5, 0.1),
      ...posts("wall-of-text", 5, 0.02),
      ...posts("green-screen", 20, 0.9),
      ...posts("video-hook", 20, 0.9),
    ]);
    expect(out.kind).toBe("changed");
    if (out.kind !== "changed") return;
    expect(out.to["green-screen"]).toBe(0);
    expect(out.to["video-hook"]).toBe(0);
    expect(out.to.slideshow + out.to["wall-of-text"]).toBe(100);
  });

  it("exploración mínima: nunca baja un formato activo de 5", () => {
    const out = proposeFormatWeights(W(80, 8, 6, 6), [
      ...posts("slideshow", 10, 0.3),
      ...posts("wall-of-text", 10, 0.0001),
      ...posts("green-screen", 10, 0.0001),
      ...posts("video-hook", 10, 0.0001),
    ]);
    expect(out.kind).toBe("changed");
    if (out.kind !== "changed") return;
    for (const f of MIX_FORMATS) expect(out.to[f], f).toBeGreaterThanOrEqual(5);
    expect(sum(out.to)).toBe(100);
  });

  it("uno que el usuario dejó por debajo del piso no baja más (ni se lo sube a la fuerza)", () => {
    const out = proposeFormatWeights(W(60, 37, 3, 0), [
      ...posts("slideshow", 5, 0.1),
      ...posts("wall-of-text", 5, 0.05),
      ...posts("green-screen", 5, 0.0),
    ]);
    if (out.kind === "changed") {
      expect(out.to["green-screen"]).toBeGreaterThanOrEqual(3);
      expect(out.to["video-hook"]).toBe(0);
      expect(sum(out.to)).toBe(100);
    }
  });

  it("sin evidencia en al menos dos formatos, no toca nada", () => {
    const out = proposeFormatWeights(W(25, 25, 25, 25), [
      ...posts("slideshow", 10, 0.1),
      ...posts("wall-of-text", 2, 0.01),
    ]);
    expect(out).toMatchObject({ kind: "unchanged", reason: "insufficient_data" });
  });

  it("con un solo formato activo, no hay mix que ajustar", () => {
    const out = proposeFormatWeights(W(100, 0, 0, 0), posts("slideshow", 10, 0.1));
    expect(out).toMatchObject({ kind: "unchanged", reason: "single_active_format" });
  });

  it("si todos rinden igual, no cambia", () => {
    const out = proposeFormatWeights(W(25, 25, 25, 25), [
      ...posts("slideshow", 5, 0.05),
      ...posts("wall-of-text", 5, 0.05),
      ...posts("green-screen", 5, 0.05),
      ...posts("video-hook", 5, 0.05),
    ]);
    expect(out).toMatchObject({ kind: "unchanged", reason: "no_significant_difference" });
  });

  it("normaliza por red: un formato sólo en X (tasas bajas) no pierde contra uno sólo en IG", () => {
    const out = proposeFormatWeights(W(50, 50, 0, 0), [
      // Igual de bueno **en su red**: el mix no debería moverse.
      ...posts("slideshow", 5, 0.2, "instagram"),
      ...posts("wall-of-text", 5, 0.01, "x"),
    ]);
    expect(out).toMatchObject({ kind: "unchanged", reason: "no_significant_difference" });
  });

  it("rechaza pesos que no suman 100", () => {
    expect(() => proposeFormatWeights(W(30, 30, 30, 30), [])).toThrow(DomainError);
  });

  it("propiedad: en 500 casos al azar, suma 100, ±10, 0 queda 0, piso respetado", () => {
    let seed = 42;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 500; i++) {
      // Pesos al azar que suman 100, con ceros de vez en cuando.
      const raw: number[] = MIX_FORMATS.map(() =>
        rnd() < 0.2 ? 0 : 1 + Math.floor(rnd() * 50),
      );
      if (!raw.some((v) => v > 0)) raw[0] = 1;
      const total = raw.reduce((a, b) => a + b, 0);
      const ints = raw.map((v) => Math.floor((v * 100) / total));
      const firstActive = ints.findIndex((v, k) => v > 0 || (raw[k] ?? 0) > 0);
      ints[firstActive] =
        (ints[firstActive] ?? 0) + 100 - ints.reduce((a, b) => a + b, 0);
      const current = W(ints[0] ?? 0, ints[1] ?? 0, ints[2] ?? 0, ints[3] ?? 0);
      const samples = MIX_FORMATS.flatMap((f) =>
        posts(f, Math.floor(rnd() * 8), rnd() * 0.3, rnd() < 0.5 ? "instagram" : "x"),
      );
      const out = proposeFormatWeights(current, samples);
      const to = out.kind === "changed" ? out.to : out.from;
      expect(sum(to)).toBe(100);
      for (const f of MIX_FORMATS) {
        expect(Number.isInteger(to[f])).toBe(true);
        expect(Math.abs(to[f] - current[f])).toBeLessThanOrEqual(
          MIX_TUNING_DEFAULTS.maxStepPoints,
        );
        if (current[f] === 0) expect(to[f]).toBe(0);
        if (to[f] < current[f]) {
          expect(to[f]).toBeGreaterThanOrEqual(MIX_TUNING_DEFAULTS.minExplorationPoints);
        }
      }
    }
  });
});

describe("formatStats", () => {
  it("un post sin views no tiene tasa y no entra", () => {
    const stats = formatStats([
      {
        format: "slideshow",
        network: "x",
        views: null,
        likes: 5,
        comments: 0,
        shares: 0,
      },
      { format: "slideshow", network: "x", views: 0, likes: 5, comments: 0, shares: 0 },
    ]);
    expect(stats.find((s) => s.format === "slideshow")).toEqual({
      format: "slideshow",
      samples: 0,
      score: null,
    });
  });
});

describe("selectMixSamples", () => {
  const NOW = Date.parse("2026-09-24T12:00:00Z");
  const H = 3_600_000;
  const base = {
    network: "instagram",
    views: 100,
    likes: 1,
    comments: 0,
    shares: 0,
  };

  it("deja afuera lo pre-sync, lo de menos de 48 h y lo que no es de los cuatro formatos", () => {
    const out = selectMixSamples(
      [
        { ...base, format: "slideshow", postedAtMs: NOW - 72 * H, syncedAtMs: NOW },
        { ...base, format: "slideshow", postedAtMs: NOW - 10 * H, syncedAtMs: NOW },
        { ...base, format: "slideshow", postedAtMs: NOW - 72 * H, syncedAtMs: null },
        { ...base, format: "custom", postedAtMs: NOW - 72 * H, syncedAtMs: NOW },
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
  });

  it("toma los N más recientes por formato", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...base,
      format: "wall-of-text",
      postedAtMs: NOW - (50 + i) * H,
      syncedAtMs: NOW,
      likes: i,
    }));
    const out = selectMixSamples(many, NOW, { samplesPerFormat: 20 });
    expect(out).toHaveLength(20);
    expect(out[0]?.likes).toBe(0);
  });
});

describe("isMixTuningDue", () => {
  it("semanal, con 5 min de holgura", () => {
    const NOW = 1_000_000_000_000;
    expect(isMixTuningDue(null, NOW)).toBe(true);
    expect(isMixTuningDue(NOW - 6 * 86_400_000, NOW)).toBe(false);
    expect(isMixTuningDue(NOW - 7 * 86_400_000 + 60_000, NOW)).toBe(true);
  });
});
