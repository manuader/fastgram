import { describe, expect, it } from "vitest";
import {
  REEL_PLAN_LIMITS,
  chooseReelTemplate,
  planReel,
  reelCopyFromPrompt,
  reelSpecFromPlan,
  type ReelPlanAssets,
} from "./plan.js";
import type { ReelLayer, ReelSpec } from "./types.js";

const assets: ReelPlanAssets = {
  backgrounds: [{ url: "https://m.test/bg.jpg", kind: "image" }],
  clip: {
    url: "https://m.test/gs.mp4",
    chroma: "green",
    durationSec: 9.5,
    hasSpeech: true,
  },
  music: { url: "https://lib.test/music.mp3" },
};

const byId = (spec: ReelSpec, id: string): ReelLayer | undefined =>
  spec.layers.find((l) => l.id === id);

/** Las reglas que cruzan capas del contrato, repetidas en chico: ids, tiempos. */
function assertCoherent(spec: ReelSpec): void {
  const ids = spec.layers.map((l) => l.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const l of spec.layers) {
    expect(l.id).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
    expect(l.end).toBeGreaterThan(l.start + 0.19);
    expect(l.end).toBeLessThanOrEqual(spec.durationSec);
  }
  expect(spec.durationSec).toBeGreaterThanOrEqual(5);
  expect(spec.durationSec).toBeLessThanOrEqual(60);
}

describe("reelCopyFromPrompt", () => {
  it("gancho, beats y remate por oración", () => {
    expect(
      reelCopyFromPrompt("Stop scrolling. Tip one; tip two\nTip three. Follow for more!"),
    ).toEqual({
      hook: "Stop scrolling.",
      beats: ["Tip one", "tip two", "Tip three."],
      punchline: "Follow for more!",
    });
  });

  it("una sola oración queda como gancho, sin remate inventado", () => {
    expect(reelCopyFromPrompt("  the best coffee in town  ")).toEqual({
      hook: "the best coffee in town",
      beats: [],
      punchline: null,
    });
  });

  it("recorta textos largos y limita los beats", () => {
    const long = "x".repeat(400);
    const copy = reelCopyFromPrompt(`${long}. a. b. c. d. e. f. g. end.`);
    expect(copy.hook.length).toBe(REEL_PLAN_LIMITS.textMaxChars);
    expect(copy.beats).toHaveLength(REEL_PLAN_LIMITS.maxBeats);
  });
});

describe("chooseReelTemplate", () => {
  it("con clip, reacción; con dos fondos y sin lista, antes/después; si no, lista", () => {
    const copy = reelCopyFromPrompt("a. b. c. d.");
    expect(chooseReelTemplate(assets, copy)).toBe("hook-reaction-punchline");
    const two = {
      ...assets,
      clip: null,
      backgrounds: [...assets.backgrounds, assets.backgrounds[0]!],
    };
    expect(chooseReelTemplate(two, reelCopyFromPrompt("a. b."))).toBe("before-after");
    expect(chooseReelTemplate(two, copy)).toBe("list-beats");
  });
});

describe("reelSpecFromPlan", () => {
  it("hook → reacción → remate: clip con croma abajo, subtítulos, música que se agacha", () => {
    const spec = reelSpecFromPlan(
      planReel({
        prompt: "Stop scrolling. This changes everything.",
        assets,
        language: "es",
      }),
    );
    assertCoherent(spec);
    expect(spec.durationSec).toBe(13.5);
    expect(spec.language).toBe("es");
    expect(byId(spec, "clip")).toMatchObject({
      kind: "clip",
      chroma: "green",
      fit: "contain",
      start: 1.2,
      end: 10.7,
      loop: false,
    });
    expect(byId(spec, "captions")).toMatchObject({
      kind: "captions",
      sourceLayerId: "clip",
    });
    expect(byId(spec, "hook")).toMatchObject({
      kind: "text",
      animation: "kinetic-bounce",
      start: 0.2,
    });
    expect(byId(spec, "punchline")).toMatchObject({
      text: "This changes everything.",
      start: 10.7,
      end: 13.5,
    });
    expect(byId(spec, "music")).toMatchObject({
      kind: "audio",
      role: "music",
      end: 13.5,
      loop: true,
    });
    expect(spec.mix.duckMusic).toBe(true);
  });

  it("un clip corto se repite y uno mudo no lleva subtítulos", () => {
    const spec = reelSpecFromPlan(
      planReel({
        prompt: "Hook.",
        assets: {
          ...assets,
          clip: {
            url: "https://m.test/c.mp4",
            chroma: "alpha",
            durationSec: 2.2,
            hasSpeech: false,
          },
        },
      }),
    );
    assertCoherent(spec);
    expect(byId(spec, "clip")).toMatchObject({ loop: true, end: 5.2 });
    expect(byId(spec, "captions")).toBeUndefined();
  });

  it("lista con beats: un fondo por beat con transición, textos numerados", () => {
    const spec = reelSpecFromPlan(
      planReel({
        prompt: "Three tips. Drink water. Sleep more. Walk daily. Save this.",
        template: "list-beats",
        assets: {
          backgrounds: [
            { url: "https://m.test/a.jpg", kind: "image" },
            { url: "https://m.test/b.mp4", kind: "video" },
          ],
          clip: null,
          music: null,
        },
      }),
    );
    assertCoherent(spec);
    expect(spec.durationSec).toBe(11.8);
    expect(spec.layers.filter((l) => l.kind === "background")).toHaveLength(4);
    expect(byId(spec, "bg-1")).toMatchObject({ transitionIn: { kind: "slide-left" } });
    expect(byId(spec, "beat-2")).toMatchObject({
      text: "2. Sleep more.",
      animation: "slide-left",
    });
    expect(spec.layers.some((l) => l.kind === "audio")).toBe(false);
  });

  it("antes/después: dos escenas y un whip en el medio", () => {
    const spec = reelSpecFromPlan(
      planReel({
        prompt: "Messy desk. Clean desk in 5 minutes.",
        template: "before-after",
        assets: { backgrounds: [], clip: null, music: assets.music },
      }),
    );
    assertCoherent(spec);
    expect(byId(spec, "after")).toMatchObject({
      start: 5,
      transitionIn: { kind: "whip" },
      fill: { type: "gradient" },
    });
    expect(byId(spec, "after-text")).toMatchObject({ animation: "typewriter" });
  });

  it("es determinístico y no construye sin gancho", () => {
    const plan = planReel({ prompt: "A. B.", assets });
    expect(reelSpecFromPlan(plan)).toEqual(reelSpecFromPlan(plan));
    expect(() => reelSpecFromPlan(planReel({ prompt: "   ", assets }))).toThrow();
  });
});

describe("reelLanguageOf", () => {
  it("ISO, variantes regionales y nombres; lo demás, autodetección", async () => {
    const { reelLanguageOf } = await import("./plan.js");
    expect(reelLanguageOf("es")).toBe("es");
    expect(reelLanguageOf("es-AR")).toBe("es");
    expect(reelLanguageOf("Spanish")).toBe("es");
    expect(reelLanguageOf("klingon")).toBeNull();
    expect(reelLanguageOf(null)).toBeNull();
  });
});
