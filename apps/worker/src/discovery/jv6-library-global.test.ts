/**
 * Sprint 9 (T, `PU-S9-015`): la biblioteca global en `applyJv6`, con un
 * `LibrarySource` falso. Con el decisor (SystemOne) los candidatos de la
 * biblioteca compiten con la marca y el ganador se materializa; con JV-6
 * (LLM) entran al pool que se rankea por texto. Sin candidatos de la
 * biblioteca, todo como antes.
 */
import {
  buildMediaBank,
  planPromptSuggestion,
  type AssetCandidate,
  type AssetDecision,
  type AssetDecisionInput,
  type BlitzPlanningContext,
  type BlitzPreferences,
  type PlanningMedia,
} from "@fastgram/core";
import type { ChoiceRequest, Judgment, Rng } from "@fastgram/ports";
import { describe, expect, it } from "vitest";

import type { BuildLogger } from "../content/build-handler.js";
import type { AssetJudge } from "../judgment/asset-decider.js";
import type { LibrarySource } from "../judgment/library-source.js";
import { applyJv6 } from "./jv6.js";

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

function planned() {
  return planPromptSuggestion(rng, prefs, context, {
    topic: "a meme about mondays",
    contentType: "green-screen",
  });
}

const LIB = "11111111-2222-4333-8444-555555555555";
const libCandidate: AssetCandidate = {
  id: LIB,
  kind: "meme_clip",
  source: "library",
  description: "green screen video: tired office worker on a monday",
  tags: ["monday", "tired"],
  license: "cc0",
  mediaSource: "library",
  relevance: { title: "Tired on a monday", tags: ["monday", "tired", "office"] },
};
const copy: PlanningMedia = {
  id: "copy-of-lib",
  mediaType: "video",
  url: "https://bucket.test/media/co/library/copy-of-lib.mp4",
  categories: ["green-screen-video"],
  title: "Tired on a monday",
};

function fakeLibrary(candidates: AssetCandidate[]) {
  const materialized: string[] = [];
  const asked: string[] = [];
  const library: LibrarySource = {
    candidates: ({ role }) => {
      asked.push(role);
      return Promise.resolve(role === "meme" ? candidates : []);
    },
    materialize: (id) => {
      materialized.push(id);
      return Promise.resolve(id === LIB ? copy : null);
    },
  };
  return { library, materialized, asked };
}

describe("applyJv6 + biblioteca global, con el decisor", () => {
  it("la biblioteca compite con la marca; si gana, la sugerencia apunta a la copia y lo dice", async () => {
    const seen: AssetDecisionInput[] = [];
    const judge: AssetJudge = {
      decide: (input) => {
        seen.push(input);
        const decision: AssetDecision = {
          role: input.role,
          chosenId: input.role === "meme" ? LIB : "bg1",
          mode: "judged",
          reason: "Picked by AI among 4 candidates.",
          scored: [],
          excluded: [],
          weights: {},
          weightsVersion: "test",
        };
        return Promise.resolve(decision);
      },
    };
    const { library, materialized } = fakeLibrary([libCandidate]);
    const recentIds = new Set<string>();
    const out = await applyJv6(planned(), {
      judgment: null,
      rng,
      context,
      brandName: "Acme",
      profile: {},
      logger: silent,
      assets: judge,
      recentIds,
      library,
      mediaSources: new Map([["monday", "upload"]]),
    });
    const meme = seen.find((i) => i.role === "meme");
    expect(meme?.candidates.map((c) => `${c.source}:${c.id}`)).toEqual([
      "brand:monday",
      "brand:oficinista",
      "brand:party",
      `library:${LIB}`,
    ]);
    expect(meme?.candidates[0]?.mediaSource).toBe("upload");
    expect(materialized).toEqual([LIB]);
    expect(out.media.format === "green-screen" && out.media.video).toEqual({
      mediaId: "copy-of-lib",
      url: copy.url,
    });
    expect(out.derivedExplanation).toContain("From the global library.");
    expect(recentIds.has(LIB) && recentIds.has("copy-of-lib")).toBe(true);
  });

  it("si la copia falla, queda lo que había (no rompe la sugerencia)", async () => {
    const judge: AssetJudge = {
      decide: (input) =>
        Promise.resolve({
          role: input.role,
          chosenId: input.role === "meme" ? "not-materializable" : null,
          mode: "judged",
          reason: "x",
          scored: [],
          excluded: [],
          weights: {},
          weightsVersion: "test",
        }),
    };
    const { library } = fakeLibrary([{ ...libCandidate, id: "not-materializable" }]);
    const before = planned();
    const out = await applyJv6(before, {
      judgment: null,
      rng,
      context,
      brandName: "Acme",
      profile: {},
      logger: silent,
      assets: judge,
      library,
    });
    expect(out.media).toEqual(before.media);
  });
});

describe("applyJv6 + biblioteca global, con JV-6 (LLM)", () => {
  function choosing(pickOption: number) {
    const requests: ChoiceRequest[] = [];
    const judgment: Judgment = {
      provenance: { adapter: "llm", model: "fake" },
      choice: (req) => {
        requests.push(req);
        const answer = {
          kind: "choice",
          value: `option_${String(pickOption)}`,
          probabilities: {},
          confidence: 0.9,
        };
        // `choice` es genérico en `TOption`: un doble con opciones fijas no
        // puede tiparlo sin un cast (el valor es el que el puerto promete).
        return Promise.resolve({ answer, usage: { latencyMs: 1 } } as never);
      },
      score: () => Promise.reject(new Error("no")),
      noul: () => Promise.reject(new Error("no")),
      ask: () => Promise.reject(new Error("no")),
    };
    return { judgment, requests };
  }

  it("el clip de la biblioteca entra al pool por texto y, si el juicio lo elige, se copia", async () => {
    const { judgment, requests } = choosing(1);
    const { library, materialized } = fakeLibrary([libCandidate]);
    const out = await applyJv6(planned(), {
      judgment,
      rng,
      context,
      brandName: "Acme",
      profile: {},
      logger: silent,
      library,
    });
    // El pool: sólo lo que comparte algo con «mondays», del más al menos relevante.
    const state = JSON.stringify(requests[0]?.state ?? {});
    expect(state).toContain("Tired on a monday");
    expect(state).toContain("monday cat");
    expect(state).not.toContain("party");
    // `option_1` es el primero del pool: el de la biblioteca (etiqueta «monday»
    // pesa 3; el título «monday cat» de la marca, 1).
    expect(materialized).toEqual([LIB]);
    expect(out.media.format === "green-screen" && out.media.video.mediaId).toBe(
      "copy-of-lib",
    );
    expect(out.derivedExplanation).toContain("(from the global library)");
  });

  it("sin candidatos de la biblioteca, el pool y la pregunta son los de antes", async () => {
    const a = choosing(1);
    const b = choosing(1);
    const { library } = fakeLibrary([]);
    await applyJv6(planned(), {
      judgment: a.judgment,
      rng,
      context,
      brandName: "Acme",
      profile: {},
      logger: silent,
      library,
    });
    await applyJv6(planned(), {
      judgment: b.judgment,
      rng,
      context,
      brandName: "Acme",
      profile: {},
      logger: silent,
    });
    expect(a.requests).toEqual(b.requests);
  });
});
