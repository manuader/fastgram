import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sampleReel } from "../__fixtures__/spec.js";
import { reelSpecSchema, type ReelSpec } from "../spec.js";
import { automationFor, envelopePoints, mergeIntervals, segmentsOf } from "./audio.js";
import { chunkCaptions } from "./captions.js";
import { cssString } from "./html.js";
import { compileReel, requiredFonts, type CompileAssets } from "./index.js";
import { backgroundWindows } from "./transitions.js";

function assets(overrides: Partial<CompileAssets> = {}): CompileAssets {
  return {
    visual: new Map([
      ["bg", { src: "assets/bg.jpg", durationSec: null, hasAudio: false }],
      ["clip", { src: "assets/clip.keyed.webm", durationSec: 4, hasAudio: false }],
    ]),
    sound: new Map([
      ["clip", { src: "assets/clip.mp4", durationSec: 4, hasAudio: true }],
      ["music", { src: "assets/music.mp3", durationSec: 30, hasAudio: true }],
    ]),
    fonts: new Map([
      ["anton-400", "fonts/anton-400.ttf"],
      ["montserrat-700", "https://cdn.example/f.ttf?sig=a&exp=1"],
    ]),
    captions: new Map(),
    ...overrides,
  };
}

describe("compileReel", () => {
  it("fija el HTML de un spec (snapshot)", () => {
    const spec = reelSpecSchema.parse(sampleReel());
    const { html, warnings } = compileReel(spec, assets());
    expect(warnings).toEqual([]);
    expect(html).toMatchSnapshot();
  });

  it("es determinístico: mismo spec → mismo HTML byte a byte", () => {
    const spec = reelSpecSchema.parse(sampleReel());
    const a = compileReel(spec, assets()).html;
    const b = compileReel(reelSpecSchema.parse(sampleReel()), assets()).html;
    const hash = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(hash(a)).toBe(hash(b));
  });

  it("cumple el contrato de HyperFrames", () => {
    const { html } = compileReel(reelSpecSchema.parse(sampleReel()), assets());
    expect(html).toContain('data-composition-id="fastgram-reel" data-no-timeline');
    expect(html).toContain('data-width="1080" data-height="1920" data-duration="15"');
    // Todo <audio> lleva id (si no, el mezclador no lo toma y el render sale mudo).
    for (const tag of html.match(/<audio [^>]*>/g) ?? []) expect(tag).toMatch(/ id="A-/);
    // Ningún <video> con tiempo adentro de un nodo con tiempo.
    for (const wrap of html.match(/<div id="L-[^"]+" class="vwrap"[^>]*>/g) ?? []) {
      expect(wrap).not.toContain("data-start");
    }
    // Los <video> van mudos; el sonido del clip es un <audio> aparte.
    for (const tag of html.match(/<video [^>]*>/g) ?? [])
      expect(tag).toContain(" muted ");
    expect(html).not.toContain("crossorigin");
    expect(html).not.toMatch(/<br/);
  });

  it("escapa el texto del usuario", () => {
    const { html } = compileReel(reelSpecSchema.parse(sampleReel()), assets());
    expect(html).toContain('Reels that &lt;look&gt; good &amp; "fast"');
    expect(html).not.toContain("<look>");
  });

  it("escapa URLs dentro de <style> como CSS, no como HTML", () => {
    const { html } = compileReel(reelSpecSchema.parse(sampleReel()), assets());
    expect(html).toContain('url("https://cdn.example/f.ttf?sig=a&exp=1")');
    expect(cssString('a"b</style>')).toBe("a\\22 b\\3c /style\\3e ");
  });

  it("repite un clip corto con `loop` y parte su audio en los mismos tramos", () => {
    const { html } = compileReel(reelSpecSchema.parse(sampleReel()), assets());
    // Capa de 10 s con un clip de 4 s: 3 tramos (4 + 4 + 2).
    expect(html.match(/<video id="L-clip-v\d"/g)).toHaveLength(3);
    expect(html.match(/<audio id="A-clip-\d"/g)).toHaveLength(3);
  });

  it("baja la música mientras habla el clip (ducking) con fades", () => {
    const { html } = compileReel(reelSpecSchema.parse(sampleReel()), assets());
    const music = html.match(/<audio id="A-music-0"[^>]*>/)?.[0] ?? "";
    expect(music).toContain('data-volume="1"');
    const lane = JSON.parse(/data-automation='([^']+)'/.exec(music)?.[1] ?? "{}") as {
      lanes: { points: { t: number; v: number }[] }[];
    };
    const points = lane.lanes[0]?.points ?? [];
    expect(points[0]).toEqual({ t: 0, v: 0 });
    // En medio del habla: 0,6 × 0,3.
    expect(points.find((p) => p.t === 1)?.v).toBeCloseTo(0.18, 3);
    expect(points[points.length - 1]).toEqual({ t: 15, v: 0 });
  });

  it("sin palabras no hay subtítulos; un fondo sin media se saltea con aviso", () => {
    const spec = reelSpecSchema.parse(sampleReel());
    const noWords = {
      ...spec,
      layers: spec.layers.map((l) => (l.kind === "captions" ? { ...l, words: [] } : l)),
    };
    const { html, warnings } = compileReel(noWords, assets({ visual: new Map() }));
    expect(html).not.toContain("L-subs-k0");
    expect(warnings).toContain("background bg: missing media, skipped");
  });

  it("pide sólo las fuentes que usa", () => {
    expect(requiredFonts(sampleReel())).toEqual(["anton-400", "montserrat-700"]);
  });

  it("cada animación del catálogo compila", () => {
    const base = reelSpecSchema.parse(sampleReel());
    const all = [
      "none",
      "fade-up",
      "pop",
      "typewriter",
      "word-by-word",
      "slide-left",
      "highlight-sweep",
      "kinetic-bounce",
      "zoom-blur",
      "wipe-reveal",
    ] as const;
    for (const animation of all) {
      const spec: ReelSpec = {
        ...base,
        layers: base.layers.map((l) => (l.kind === "text" ? { ...l, animation } : l)),
      };
      const motion =
        /<script type="application\/json" id="fg-motion">(.*)<\/script>/.exec(
          compileReel(spec, assets()).html,
        )?.[1];
      expect(() => JSON.parse(motion ?? "")).not.toThrow();
    }
  });
});

describe("captions", () => {
  const w = (text: string, start: number, end: number) => ({ text, start, end });

  it("corta por tope de palabras, fin de oración y pausa larga", () => {
    const chunks = chunkCaptions(
      [
        w("a", 0, 0.2),
        w("b.", 0.2, 0.4),
        w("c", 0.5, 0.7),
        w("d", 0.7, 0.9),
        w("e", 0.9, 1),
        w("f", 2, 2.2),
      ],
      3,
      0,
      10,
    );
    expect(chunks.map((c) => c.words.map((x) => x.text).join(" "))).toEqual([
      "a b.",
      "c d e",
      "f",
    ]);
    // Un renglón se queda hasta que arranca el siguiente si el hueco es corto…
    expect(chunks[0]?.end).toBe(0.5);
    // …y si no, un poco después de su última palabra.
    expect(chunks[1]?.end).toBeCloseTo(1.3, 5);
  });

  it("descarta palabras fuera de la ventana de la capa", () => {
    const chunks = chunkCaptions([w("a", 0, 0.2), w("b", 5, 5.2)], 3, 1, 4);
    expect(chunks).toEqual([]);
  });
});

describe("audio", () => {
  it("une tramos cercanos", () => {
    expect(
      mergeIntervals([
        { start: 5, end: 6 },
        { start: 1, end: 2 },
        { start: 2.3, end: 3 },
      ]),
    ).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 6 },
    ]);
  });

  it("sin fades ni ducking no hay envolvente", () => {
    expect(
      envelopePoints({
        start: 0,
        end: 5,
        volume: 0.5,
        fadeInSec: 0,
        fadeOutSec: 0,
        ducks: [],
        duckLevel: 0.3,
      }),
    ).toEqual([]);
  });

  it("corta la envolvente en tramos de loop con tiempos locales", () => {
    const points = envelopePoints({
      start: 0,
      end: 10,
      volume: 1,
      fadeInSec: 0,
      fadeOutSec: 2,
      ducks: [],
      duckLevel: 1,
    });
    const lane = JSON.parse(automationFor(points, 5, 10) ?? "{}") as {
      lanes: { points: { t: number; v: number }[] }[];
    };
    expect(lane.lanes[0]?.points).toEqual([
      { t: 0, v: 1 },
      { t: 3, v: 1 },
      { t: 5, v: 0 },
    ]);
  });

  it("segmenta loops y no segmenta sin loop", () => {
    expect(segmentsOf(0, 10, 0, 4, true)).toHaveLength(3);
    expect(segmentsOf(0, 10, 0, 4, false)).toHaveLength(1);
    expect(segmentsOf(0, 10, 0, null, true)).toHaveLength(1);
  });
});

describe("transiciones", () => {
  it("mantiene visible el fondo que sale hasta que termina la entrada del nuevo", () => {
    const spec = sampleReel();
    const bgs = spec.layers.filter((l) => l.kind === "background");
    const windows = backgroundWindows(bgs as never, spec.durationSec);
    expect(windows.get("bg")).toEqual({ start: 0, end: 8.5 });
    expect(windows.get("bg2")).toEqual({ start: 8, end: 15 });
  });
});
