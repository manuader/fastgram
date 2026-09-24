/**
 * Sprint 7 — la búsqueda del meme y el juicio de `JV-6`, sin base.
 *
 *  - la búsqueda intenta como mucho dos resultados, en el orden de `core`, y
 *    se queda con el primero que el import confirma verde; los que no son
 *    verdes vuelven como «rechazados» para que el handler los borre;
 *  - el import va **sin** etiquetado y **sin** recorte pago;
 *  - el juicio nunca bloquea: timeout, error, poca confianza → `null`.
 */
import type { MediaImportJob, MediaImportStatus } from "@fastgram/core";
import type {
  ChoiceAnswer,
  ChoiceRequest,
  Judgment,
  JudgmentOutcome,
} from "@fastgram/ports";
import { describe, expect, it } from "vitest";

import type { BuildLogger } from "../content/build-handler.js";
import type { ImportOptions, ImportRun } from "../media-import/handler.js";
import { judgeBest } from "./jv6.js";
import { createMemeFinder, type MemeSearcher } from "./meme-finder.js";

const silent: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

const results = [
  {
    id: "aaaaaaaaaa1",
    url: "https://www.youtube.com/watch?v=aaaaaaaaaa1",
    title: "Monday cat (green screen)",
    durationSeconds: 10,
  },
  {
    id: "bbbbbbbbbb2",
    url: "https://www.youtube.com/watch?v=bbbbbbbbbb2",
    title: "Monday green screen",
    durationSeconds: 12,
  },
  {
    id: "ccccccccccc",
    url: "https://www.youtube.com/watch?v=ccccccccccc",
    title: "Monday meme",
    durationSeconds: 8,
  },
];

type Background = NonNullable<MediaImportStatus["background"]>;

function finderWith(backgrounds: readonly Background[]) {
  const calls: { job: MediaImportJob; run: ImportRun; options?: ImportOptions }[] = [];
  const queries: string[] = [];
  const searcher: MemeSearcher = {
    search: (q) => {
      queries.push(q);
      return Promise.resolve(results);
    },
  };
  const finder = createMemeFinder({
    searcher,
    runImport: (job, run, options) => {
      calls.push({ job, run, ...(options === undefined ? {} : { options }) });
      const background: Background = backgrounds[calls.length - 1] ?? "not_requested";
      const status: MediaImportStatus = {
        importId: job.importId,
        kind: "video",
        state: "imported",
        sourceUrl: job.url,
        mediaId: job.mediaId,
        background,
        updatedAt: 0,
      };
      return Promise.resolve(status);
    },
    logger: silent,
  });
  return { finder, calls, queries };
}

describe("createMemeFinder", () => {
  it("se queda con el primero verde; el no verde vuelve como rechazado", async () => {
    const { finder, calls, queries } = finderWith(["not_requested", "green_screen"]);
    const out = await finder.find({ companyId: "c", topic: "los lunes", requestId: "r" });
    expect(queries).toEqual(["ytsearch8:los lunes green screen meme"]);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.job.url)).toEqual([results[0]!.url, results[1]!.url]);
    expect(calls[0]?.options).toEqual({ tagging: false, paidCutout: false });
    expect(calls[0]?.job.categories).toEqual(["green-screen-video"]);
    expect(calls[0]?.run.maxAttempts).toBe(1);
    expect(out.found?.mediaId).toBe(calls[1]?.job.mediaId);
    expect(out.found?.sourceUrl).toBe(results[1]!.url);
    expect(out.rejectedMediaIds).toEqual([calls[0]?.job.mediaId]);
  });

  it("nunca más de dos imports por búsqueda", async () => {
    const { finder, calls } = finderWith([
      "not_requested",
      "not_requested",
      "green_screen",
    ]);
    const out = await finder.find({ companyId: "c", topic: "lunes", requestId: "r" });
    expect(calls).toHaveLength(2);
    expect(out.found).toBeNull();
    expect(out.rejectedMediaIds).toHaveLength(2);
  });

  it("sin resultados no importa nada", async () => {
    const finder = createMemeFinder({
      searcher: { search: () => Promise.resolve([]) },
      runImport: () => Promise.reject(new Error("no debería importar")),
      logger: silent,
    });
    expect(await finder.find({ companyId: "c", topic: "x", requestId: "r" })).toEqual({
      found: null,
      rejectedMediaIds: [],
      results: 0,
    });
  });
});

class FakeJudgment implements Judgment {
  readonly provenance = { adapter: "stub", model: "fake" };
  readonly requests: ChoiceRequest<string>[] = [];
  constructor(private readonly reply: () => Promise<ChoiceAnswer>) {}
  async choice<T extends string>(
    request: ChoiceRequest<T>,
  ): Promise<JudgmentOutcome<ChoiceAnswer<T>>> {
    this.requests.push(request as unknown as ChoiceRequest<string>);
    return { answer: (await this.reply()) as ChoiceAnswer<T>, usage: { latencyMs: 1 } };
  }
  score(): never {
    throw new Error("no");
  }
  noul(): never {
    throw new Error("no");
  }
  ask(): never {
    throw new Error("no");
  }
}

const input = {
  topic: "lunes",
  brandName: "Café",
  profile: {},
  candidates: [
    { id: "m1", description: "a" },
    { id: "m2", description: "b" },
  ],
};

const answer = (value: string, confidence: number): ChoiceAnswer => ({
  kind: "choice",
  value,
  probabilities: { [value]: confidence },
  confidence,
});

describe("judgeBest (JV-6)", () => {
  it("pregunta por DP-005 y devuelve el id elegido", async () => {
    const j = new FakeJudgment(() => Promise.resolve(answer("option_2", 0.9)));
    expect(await judgeBest(j, "meme", input, silent)).toBe("m2");
    expect(j.requests[0]?.decisionPoint).toBe("DP-005");
  });

  it("poca confianza, error o timeout → null (manda el ranking)", async () => {
    expect(
      await judgeBest(
        new FakeJudgment(() => Promise.resolve(answer("option_2", 0.1))),
        "meme",
        input,
        silent,
      ),
    ).toBeNull();
    expect(
      await judgeBest(
        new FakeJudgment(() => Promise.reject(new Error("down"))),
        "meme",
        input,
        silent,
      ),
    ).toBeNull();
    expect(
      await judgeBest(
        new FakeJudgment(() => new Promise(() => {})),
        "meme",
        input,
        silent,
        20,
      ),
    ).toBeNull();
  });

  it("sin juicio o con un solo candidato no pregunta", async () => {
    const j = new FakeJudgment(() => Promise.resolve(answer("option_1", 1)));
    expect(await judgeBest(null, "meme", input, silent)).toBeNull();
    expect(
      await judgeBest(
        j,
        "meme",
        { ...input, candidates: [input.candidates[0]!] },
        silent,
      ),
    ).toBeNull();
    expect(j.requests).toHaveLength(0);
  });
});
