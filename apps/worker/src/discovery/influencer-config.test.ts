/**
 * La Configuration del influencer en el refill: el ángulo sale de los
 * asociados al personaje, y sin asociación no cambia nada (ni el `Rng`).
 */
import { SeededRng } from "@fastgram/adapters";
import {
  DEFAULT_BLITZ_PREFERENCES,
  buildMediaBank,
  planBlitzSuggestion,
  type BlitzPlanningContext,
  type BlitzPreferences,
  type PlanningMedia,
} from "@fastgram/core";
import { describe, expect, it } from "vitest";

import { restrictToInfluencerAngles } from "./influencer-config.js";

const INF = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GONE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const clips: PlanningMedia[] = [
  {
    id: "v1",
    mediaType: "video",
    url: "https://x.test/v1.mp4",
    categories: ["background-video"],
  },
  {
    id: "v2",
    mediaType: "video",
    url: "https://x.test/v2.mp4",
    categories: ["background-video"],
  },
];

const context: BlitzPlanningContext = {
  activeAngleIds: [A, B, C],
  influencers: [{ id: INF, isActive: true, isTrained: true, gender: null }],
  bank: buildMediaBank(clips, [
    { influencerId: INF, kind: "VIDEO", mediaIds: ["v1", "v2"] },
  ]),
  angleTitles: new Map([
    [A, "Angle A"],
    [B, "Angle B"],
    [C, "Angle C"],
  ]),
  influencerNames: new Map([[INF, "Luna"]]),
};

// Sólo wall-of-text (el único formato con media: los clips del personaje) y
// siempre con influencer. El peso de A es enorme: sin restricción sale A.
const preferences: BlitzPreferences = {
  ...DEFAULT_BLITZ_PREFERENCES,
  slideshowWeight: 0,
  greenScreenWeight: 0,
  videoHookWeight: 0,
  wallOfTextWeight: 100,
  influencerChance: 100,
  angleWeights: { [A]: 98, [B]: 1, [C]: 1 },
  textStyleWeights: {},
};

function plannedWith(seed: number) {
  const rng = new SeededRng(seed);
  const planned = planBlitzSuggestion(rng, preferences, context);
  expect(planned.influencerId).toBe(INF);
  return { rng, planned };
}

describe("restrictToInfluencerAngles", () => {
  it("con ángulos asociados, el ángulo sale de ésos (y la explicación lo nombra)", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { rng, planned } = plannedWith(seed);
      const out = restrictToInfluencerAngles(
        rng,
        preferences,
        context,
        new Map([[INF, [B, C]]]),
        planned,
      );
      expect([B, C]).toContain(out.plan.angleId);
      expect(out.topic).toBe(context.angleTitles.get(out.plan.angleId as string));
      expect(out.derivedExplanation).toContain(out.topic as string);
      expect(out.influencerId).toBe(INF);
      expect(out.media.format).toBe("wall-of-text");
    }
  });

  it("respeta los pesos dentro de los asociados", () => {
    const heavyC = { ...preferences, angleWeights: { [A]: 50, [B]: 0, [C]: 50 } };
    for (let seed = 1; seed <= 20; seed++) {
      const { rng, planned } = plannedWith(seed);
      const out = restrictToInfluencerAngles(
        rng,
        heavyC,
        context,
        new Map([[INF, [B, C]]]),
        planned,
      );
      // B pesa 0: nunca sale mientras C pese algo.
      if (planned.plan.angleId !== C) expect(out.plan.angleId).toBe(C);
    }
  });

  it("si el ángulo ya es uno asociado, devuelve lo mismo y no consume el Rng", () => {
    const { rng, planned } = plannedWith(3);
    const angle = planned.plan.angleId as string;
    const out = restrictToInfluencerAngles(
      rng,
      preferences,
      context,
      new Map([[INF, [angle]]]),
      planned,
    );
    expect(out).toBe(planned);
    // El `rng` del plan sigue en el mismo punto que una copia que no se tocó.
    const twin = plannedWith(3).rng;
    expect(rng.next()).toBe(twin.next());
  });

  it("sin Configuration, o con ángulos que ya no están activos, no restringe", () => {
    const { rng, planned } = plannedWith(5);
    expect(
      restrictToInfluencerAngles(rng, preferences, context, new Map(), planned),
    ).toBe(planned);
    expect(
      restrictToInfluencerAngles(
        rng,
        preferences,
        context,
        new Map([[INF, [GONE]]]),
        planned,
      ),
    ).toBe(planned);
    expect(
      restrictToInfluencerAngles(rng, preferences, context, undefined, planned),
    ).toBe(planned);
  });

  it("una pieza sin influencer no se toca", () => {
    const rng = new SeededRng(7);
    const planned = planBlitzSuggestion(
      rng,
      { ...preferences, influencerChance: 0 },
      {
        ...context,
        bank: buildMediaBank(clips, []),
      },
    );
    expect(planned.influencerId).toBeNull();
    expect(
      restrictToInfluencerAngles(
        rng,
        preferences,
        context,
        new Map([[INF, [C]]]),
        planned,
      ),
    ).toBe(planned);
  });
});
