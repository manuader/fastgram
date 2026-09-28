/**
 * Sprint 9 (O): con `judgment.assets` en un SystemOne, el meme y el fondo los
 * elige el decisor sobre el pool **entero** (no sólo lo que matchea por
 * palabras), y sin decisor queda JV-6 como antes.
 */
import {
  buildMediaBank,
  planPromptSuggestion,
  type AssetDecision,
  type AssetDecisionInput,
  type BlitzPlanningContext,
  type BlitzPreferences,
  type PlanningMedia,
} from "@fastgram/core";
import type { Rng } from "@fastgram/ports";
import { describe, expect, it } from "vitest";

import type { BuildLogger } from "../content/build-handler.js";
import type { AssetJudge } from "../judgment/asset-decider.js";
import { applyJv6 } from "./jv6.js";
import { musicDecider } from "./refill-handler.js";

const silent: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

const rng: Rng = {
  next: () => 0.1,
  nextInt: (min) => min,
  // Determinístico: el primero con peso (el mix es 100 % green-screen).
  weightedPick: (items) => (items.find((i) => i.weight > 0) ?? items[0]!).value,
};

const clip = (id: string, title: string): PlanningMedia => ({
  id,
  mediaType: "video",
  url: `https://bucket.test/${id}.mp4`,
  categories: ["green-screen-video"],
  title,
});
const bg = (id: string): PlanningMedia => ({
  id,
  mediaType: "image",
  url: `https://bucket.test/${id}.png`,
  categories: ["green-screen-background"],
  title: `${id}.png`,
});

const prefs: BlitzPreferences = {
  slideshowWeight: 0,
  wallOfTextWeight: 0,
  greenScreenWeight: 100,
  videoHookWeight: 0,
  remixPercentage: 0,
  ownMediaPercentage: 100,
  mentionBusinessPercentage: 0,
  influencerChance: 0,
  smartTextPositioning: true,
  genderFilter: null,
  angleWeights: {},
  textStyleWeights: {},
};

const media = [
  clip("monday", "monday cat.mp4"),
  // Sin ninguna palabra del tema: JV-6 no lo vería; el decisor sí.
  clip("oficinista", "oficinista agotado un lunes.mp4"),
  clip("party", "party.mp4"),
  bg("bg1"),
  bg("bg2"),
];
const context: BlitzPlanningContext = {
  activeAngleIds: [],
  influencers: [],
  bank: buildMediaBank(media, []),
  angleTitles: new Map(),
  influencerNames: new Map(),
};

/** Un decisor falso que elige por id y anota qué le llegó. */
function fakeAssets(pick: Record<string, string | null>) {
  const seen: AssetDecisionInput[] = [];
  const judge: AssetJudge = {
    decide: (input) => {
      seen.push(input);
      const chosenId = pick[input.role] ?? null;
      const decision: AssetDecision = {
        role: input.role,
        chosenId,
        mode: chosenId === null ? "all_unsafe" : "judged",
        reason: "Picked by AI among 3 candidates.",
        scored: [],
        excluded: [],
        weights: {},
        weightsVersion: "test",
      };
      return Promise.resolve(decision);
    },
  };
  return { judge, seen };
}

function planned() {
  return planPromptSuggestion(rng, prefs, context, {
    topic: "a meme about mondays",
    contentType: "green-screen",
  });
}

describe("applyJv6 con el decisor de assets", () => {
  it("meme y fondo del decisor, con el pool entero y el formato", async () => {
    const { judge, seen } = fakeAssets({ meme: "oficinista", background: "bg2" });
    const recentIds = new Set<string>();
    const out = await applyJv6(planned(), {
      judgment: null,
      rng,
      context,
      brandName: "Café Lunes",
      profile: {
        coreIdentity: "coffee",
        targetAudience: "office workers",
        toneOfVoice: "playful",
      } as never,
      logger: silent,
      assets: judge,
      recentIds,
    });
    expect(out.media.format === "green-screen" && out.media.video.mediaId).toBe(
      "oficinista",
    );
    expect(out.media.format === "green-screen" && out.media.image.mediaId).toBe("bg2");
    const meme = seen.find((s) => s.role === "meme");
    expect(meme?.format).toBe("green-screen");
    expect(meme?.idea).toBe("a meme about mondays");
    expect(meme?.brand).toMatchObject({ name: "Café Lunes", audience: "office workers" });
    expect(meme?.candidates.map((c) => c.id).sort()).toEqual([
      "monday",
      "oficinista",
      "party",
    ]);
    expect(meme?.candidates.every((c) => c.kind === "meme_clip")).toBe(true);
    expect(seen.find((s) => s.role === "background")?.candidates[0]?.kind).toBe(
      "background_image",
    );
    // Lo elegido no se repite en las piezas siguientes del mismo job.
    expect([...recentIds].sort()).toEqual(["bg2", "oficinista"]);
    expect(out.derivedExplanation).toContain("picked by AI");
  });

  it("si el decisor no elige (todos inseguros), queda el plan como estaba", async () => {
    const before = planned();
    const { judge } = fakeAssets({ meme: null, background: null });
    const out = await applyJv6(before, {
      judgment: null,
      rng,
      context,
      brandName: "B",
      profile: {} as never,
      logger: silent,
      assets: judge,
    });
    expect(out.media).toEqual(before.media);
  });

  it("sin decisor ni juicio: nada cambia (JV-6 de siempre)", async () => {
    const before = planned();
    const out = await applyJv6(before, {
      judgment: null,
      rng,
      context,
      brandName: "B",
      profile: {} as never,
      logger: silent,
    });
    expect(out).toBe(before);
  });
});

describe("musicDecider (música con el decisor)", () => {
  const draft = { contentType: "green-screen" } as never;
  const tracks = [
    { id: "t1", title: "Lofi mornings", durationSec: 30 },
    { id: "t2", title: "Heavy metal", durationSec: 40 },
  ];

  it("con tema: la pista del decisor, y no se repite", async () => {
    const { judge, seen } = fakeAssets({ music: "t1" });
    const recent = new Set<string>();
    const decide = musicDecider(
      judge,
      { businessName: "B", profile: {} as never },
      new Map([[draft, "mondays"]]),
      recent,
    );
    expect(await decide(draft, tracks)).toBe("t1");
    expect(seen[0]?.role).toBe("music");
    expect(seen[0]?.candidates.map((c) => c.kind)).toEqual(["audio", "audio"]);
    expect([...recent]).toEqual(["t1"]);
  });

  it("sin tema, o si el decisor no juzgó: sorteo (null)", async () => {
    const { judge } = fakeAssets({ music: null });
    const decide = musicDecider(
      judge,
      { businessName: "B", profile: {} as never },
      new Map([[draft, null]]),
      new Set(),
    );
    expect(await decide(draft, tracks)).toBeNull();
  });
});
