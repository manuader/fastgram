/**
 * `SystemOneJudgmentAdapter` (D-18) contra un SystemOne falso.
 *
 * Las respuestas «reales» de abajo son copia literal de lo que devolvió
 * `laya-serve` 0.3.21 en la Mac del dueño el 2026-09-28; el falso de la suite de contrato arma respuestas con la misma forma
 * a partir de un hash del pedido, así que es sensible al orden como un modelo
 * de verdad y el caso «el orden del lote no cambia la respuesta» prueba que el
 * adaptador ordena.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeJudgmentContract, isPortError, type PortError } from "@fastgram/ports";

import {
  probeSystemOne,
  SYSTEMONE_MODELS,
  systemOneOptions,
} from "./systemone-catalog.js";
import {
  SystemOneJudgmentAdapter,
  parseRetryAfter,
  systemOneEndpoint,
  type SystemOneFetch,
  type SystemOneWarning,
} from "./systemone-judgment.js";

/* ------------------------------------------------------------------------ *
 * El falso
 * ------------------------------------------------------------------------ */

interface Captured {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Pseudo-probabilidades estables a partir del pedido entero. */
function fakeDistribution(seed: string, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const h = createHash("sha256")
      .update(`${seed}:${String(i)}`)
      .digest();
    out.push((h[0] ?? 0) + 1);
  }
  const total = out.reduce((a, b) => a + b, 0);
  return out.map((v) => Math.round((v / total) * 10_000) / 10_000);
}

/** Un SystemOne que contesta con la forma de Laya. */
function fakeLaya(): { fetch: SystemOneFetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl: SystemOneFetch = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    const seed = String(init.body);
    const questions = body["questions"] as Record<
      string,
      { type: string; criteria: unknown }
    >;
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === "choice") {
        const keys = Object.keys(q.criteria as Record<string, string>);
        const p = fakeDistribution(`${seed}:${id}`, keys.length);
        const best = p.indexOf(Math.max(...p));
        answers[id] = {
          type: "choice",
          choice: keys[best],
          probabilities: Object.fromEntries(keys.map((k, i) => [k, p[i]])),
          confidence: 0.1,
          answer_confidence: p[best],
        };
      } else if (q.type === "score") {
        const levels = q.criteria as string[];
        const p = fakeDistribution(`${seed}:${id}`, levels.length);
        answers[id] = {
          type: "score",
          score: p.reduce((a, v, i) => a + i * v, 0),
          legend: Object.fromEntries(levels.map((l, i) => [String(i), l])),
          probabilities: Object.fromEntries(p.map((v, i) => [String(i), v])),
          confidence: 0.1,
          answer_confidence: Math.max(...p),
        };
      } else {
        const p = fakeDistribution(`${seed}:${id}`, 2);
        answers[id] = {
          type: "noul",
          noul: p[1],
          confidence: 0.9,
          answer_confidence: 0.9,
        };
      }
    }
    // Un poco de latencia real para que `timeoutMs: 1` pueda vencer.
    await new Promise((r) => setTimeout(r, 5));
    if (init.signal?.aborted === true) throw new DOMException("aborted", "AbortError");
    return json({
      model: "laya-rl-agent",
      answers,
      usage: { input_tokens: 120, output_tokens: 0 },
      routing: { model: "english" },
    });
  };
  return { fetch: fetchImpl, calls };
}

const SAMPLE_STATE = {
  idea: "a meme about hating mondays",
  candidate: "a cat falling off a table in slow motion",
} as const;

describeJudgmentContract({ describe, it }, "systemone (fake laya)", {
  makeAdapter: () =>
    new SystemOneJudgmentAdapter({
      baseUrl: "http://127.0.0.1:3006",
      model: "auto",
      adapter: "laya",
      fetch: fakeLaya().fetch,
    }),
  sampleState: SAMPLE_STATE,
});

/* ------------------------------------------------------------------------ *
 * Respuestas reales de Laya (2026-09-28)
 * ------------------------------------------------------------------------ */

/** Idea y clip en inglés: ruteó a `english`. */
const REAL_FIT_SAFE = {
  model: "laya-rl-agent",
  answers: {
    fit: {
      type: "score",
      score: 2.1089,
      legend: { "0": "unrelated", "1": "weak", "2": "good", "3": "perfect" },
      probabilities: { "0": 0.0295, "1": 0.1406, "2": 0.5214, "3": 0.3085 },
      confidence: 0.2194,
      answer_confidence: 0.5214,
      action: { act_probability: 1.0 },
    },
    safe: {
      type: "noul",
      noul: 0.1669,
      confidence: 0.8331,
      answer_confidence: 0.8331,
      action: { act_probability: 1.0 },
    },
  },
  usage: { input_tokens: 126, output_tokens: 0 },
  routing: { model: "english", reason: "English Latin text" },
};

/** La que midió este agente (idea en castellano: ruteó a `multilingual`). */
const REAL_WITH_CHOICE = {
  model: "laya-rl-agent",
  answers: {
    fit: {
      type: "score",
      score: 0.428,
      legend: { "0": "unrelated", "1": "weak", "2": "good", "3": "perfect" },
      probabilities: { "0": 0.7362, "1": 0.1453, "2": 0.0728, "3": 0.0457 },
      confidence: 0.3959,
      answer_confidence: 0.7362,
      action: { act_probability: 1.0 },
    },
    safe: {
      type: "noul",
      noul: 0.7365,
      confidence: 0.7365,
      answer_confidence: 0.7365,
      action: { act_probability: 1.0 },
    },
    pick: {
      type: "choice",
      choice: "a",
      probabilities: { a: 0.9993, b: 0.0007 },
      confidence: 0.9914,
      answer_confidence: 0.9993,
      action: { act_probability: 1.0 },
    },
  },
  usage: { input_tokens: 153, output_tokens: 0 },
  routing: { model: "multilingual", reason: "…" },
};

const FIT = {
  id: "fit",
  kind: "score",
  instructions: "How well does the candidate clip fit the idea?",
  levels: ["unrelated", "weak", "good", "perfect"],
} as const;
const SAFE = {
  id: "safe",
  kind: "noul",
  instructions: "Is it brand safe?",
  criteria: { true: "safe", false: "unsafe" },
} as const;
const PICK = {
  id: "pick",
  kind: "choice",
  instructions: "which",
  criteria: { a: "cat", b: "dog" },
} as const;

function replying(response: Response | (() => Response)): {
  fetch: SystemOneFetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return typeof response === "function" ? response() : response.clone();
    },
  };
}

function adapter(
  fetchImpl: SystemOneFetch,
  extra: Partial<ConstructorParameters<typeof SystemOneJudgmentAdapter>[0]> = {},
) {
  return new SystemOneJudgmentAdapter({
    baseUrl: "http://127.0.0.1:3006",
    model: "auto",
    adapter: "laya",
    fetch: fetchImpl,
    ...extra,
  });
}

async function portError(p: Promise<unknown>): Promise<PortError> {
  try {
    await p;
  } catch (error) {
    if (isPortError(error)) return error;
    throw error;
  }
  throw new Error("se esperaba un PortError");
}

describe("SystemOneJudgmentAdapter — mapeo de respuestas reales", () => {
  it("score 0-based → value en [1, n]: 2.1089 (0-based) es 3.1089", async () => {
    const { fetch } = replying(json(REAL_FIT_SAFE));
    const { answers } = await adapter(fetch).ask({
      decisionPoint: "DP-005",
      state: SAMPLE_STATE,
      questions: [FIT, SAFE],
    });
    expect(answers.fit.value).toBeCloseTo(3.1089, 3);
    expect(answers.fit.probabilities).toHaveLength(4);
    expect(answers.fit.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // `confidence` = `answer_confidence` (max p), no el 1 − entropía de Laya.
    expect(answers.fit.confidence).toBe(0.5214);
    // `noul` = p(true); el `confidence` 0.8331 de Laya es max(p, 1 − p) y no viaja.
    expect(answers.safe).toEqual({ kind: "noul", probability: 0.1669 });
  });

  it("choice: value, distribución completa y confianza = max(p)", async () => {
    const { fetch } = replying(json(REAL_WITH_CHOICE));
    const { answers, usage } = await adapter(fetch).ask({
      decisionPoint: "DP-005",
      state: SAMPLE_STATE,
      questions: [FIT, SAFE, PICK],
    });
    expect(answers.pick.value).toBe("a");
    expect(answers.pick.probabilities.a).toBe(0.9993);
    expect(answers.pick.probabilities.b).toBeCloseTo(0.0007, 12);
    expect(answers.pick.confidence).toBe(0.9993);
    expect(answers.fit.value).toBeCloseTo(1.428, 3);
    expect(usage.inputTokens).toBe(153);
    expect(usage.outputTokens).toBe(0);
  });

  it("Jev (sin answer_confidence): confianza = max(p) calculada acá", async () => {
    const jev = {
      model: "jev-1.13.0",
      answers: {
        pick: {
          type: "choice",
          choice: "b",
          probabilities: { a: 0.2, b: 0.8 },
          confidence: 0.6, // (n·pmax − 1)/(n − 1): no es la del puerto
        },
      },
      usage: { input_tokens: 296, output_tokens: 20 },
    };
    const { fetch } = replying(json(jev));
    const { answer } = await adapter(fetch, {
      adapter: "jev",
      model: "jev-latest",
    }).choice({
      decisionPoint: "DP-005",
      state: SAMPLE_STATE,
      question: PICK,
    });
    expect(answer.value).toBe("b");
    expect(answer.confidence).toBeCloseTo(0.8, 9);
  });

  it("onRawResponse lleva el cuerpo y el checkpoint que ruteó, nunca el pedido", async () => {
    const { fetch } = replying(json(REAL_FIT_SAFE));
    const seen: string[] = [];
    await adapter(fetch, {
      apiKey: "secret-key-1234567890",
      onRawResponse: (r) => {
        seen.push(r.model, r.raw);
      },
    }).ask({ decisionPoint: "DP-005", state: SAMPLE_STATE, questions: [FIT, SAFE] });
    expect(seen[0]).toBe("laya-rl-agent/english");
    expect(seen[1]).not.toContain("secret-key");
  });
});

describe("SystemOneJudgmentAdapter — el pedido", () => {
  it("wire: criteria de score es un array, noul {true,false}; `auto` no manda model", async () => {
    const { fetch, calls } = replying(json(REAL_WITH_CHOICE));
    await adapter(fetch).ask({
      decisionPoint: "DP-005",
      state: SAMPLE_STATE,
      questions: [SAFE, PICK, FIT],
    });
    const call = calls[0];
    expect(call?.url).toBe("http://127.0.0.1:3006/v1/systemone");
    expect(call?.body["model"]).toBeUndefined();
    expect(call?.headers["authorization"]).toBeUndefined();
    const qs = call?.body["questions"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(qs)).toEqual(["fit", "pick", "safe"]);
    expect(qs["fit"]).toEqual({
      type: "score",
      instructions: FIT.instructions,
      criteria: [...FIT.levels],
    });
    expect(qs["safe"]?.["criteria"]).toEqual({ true: "safe", false: "unsafe" });
    expect(call?.body["state"]).toEqual(SAMPLE_STATE);
  });

  it("Jev: manda model y la key como Bearer", async () => {
    const { fetch, calls } = replying(
      json({ model: "jev", answers: { safe: { type: "noul", noul: 0.3 } } }),
    );
    await new SystemOneJudgmentAdapter({
      ...systemOneOptions({
        provider: "typesafe",
        baseUrl: "https://api.typesafe.ai",
        apiKey: "ts-key",
        model: "jev-latest",
      }),
      fetch,
    }).noul({ decisionPoint: "DP-007", state: SAMPLE_STATE, question: SAFE });
    expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]?.body["model"]).toBe("jev-latest");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer ts-key");
  });

  it("más de 100 opciones: bad_request sin viajar; más de 20: aviso", async () => {
    const { fetch, calls } = replying(json(REAL_WITH_CHOICE));
    const criteria = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`o${String(i)}`, `opt ${String(i)}`]),
      );
    const err = await portError(
      adapter(fetch).choice({
        decisionPoint: "DP-005",
        state: SAMPLE_STATE,
        question: {
          id: "pick",
          kind: "choice",
          instructions: "x",
          criteria: criteria(101),
        },
      }),
    );
    expect(err.code).toBe("bad_request");
    expect(calls).toHaveLength(0);

    const warnings: SystemOneWarning[] = [];
    const big = fakeLaya();
    await adapter(big.fetch, { onWarning: (w) => warnings.push(w) }).choice({
      decisionPoint: "DP-005",
      state: SAMPLE_STATE,
      question: { id: "pick", kind: "choice", instructions: "x", criteria: criteria(21) },
    });
    expect(warnings).toEqual([
      {
        code: "choice_options_over_soft_limit",
        questionId: "pick",
        options: 21,
        softLimit: 20,
      },
    ]);
  });

  it("endpoint: base con o sin /v1", () => {
    expect(systemOneEndpoint("http://h:1/")).toBe("http://h:1/v1/systemone");
    expect(systemOneEndpoint("http://h:1/v1")).toBe("http://h:1/v1/systemone");
  });
});

describe("SystemOneJudgmentAdapter — errores estables", () => {
  const ask = (fetchImpl: SystemOneFetch) =>
    adapter(fetchImpl).noul({
      decisionPoint: "DP-005",
      state: SAMPLE_STATE,
      question: SAFE,
    });

  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [402, "quota_exceeded"],
    [404, "not_found"],
    [400, "bad_request"],
    [413, "bad_request"],
    [422, "bad_request"],
    [500, "provider_unavailable"],
    [503, "provider_unavailable"],
    [504, "timeout"],
  ] as const)("HTTP %i → %s", async (status, code) => {
    const err = await portError(ask(replying(json({ detail: "x" }, status)).fetch));
    expect(err.code).toBe(code);
    // El cuerpo del proveedor no va en el mensaje (puede cruzar a la web).
    expect(err.message).not.toContain("detail");
  });

  it("429 y 529 → rate_limited; 503 con Retry-After (Laya ocupado) también", async () => {
    for (const status of [429, 529, 503]) {
      const err = await portError(
        ask(replying(json({ detail: "busy" }, status, { "retry-after": "1" })).fetch),
      );
      expect(err.code).toBe("rate_limited");
      expect(err.retryAfterSeconds).toBe(1);
    }
  });

  it("red caída → provider_unavailable; plazo vencido → timeout", async () => {
    const down = await portError(
      ask(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(down.code).toBe("provider_unavailable");

    const slow = await portError(
      adapter(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      ).noul({
        decisionPoint: "DP-005",
        state: SAMPLE_STATE,
        question: SAFE,
        timeoutMs: 20,
      }),
    );
    expect(slow.code).toBe("timeout");
  });

  it("la key nunca aparece en un error", async () => {
    const err = await portError(
      adapter(replying(json({ detail: "bad key secret-key-1234567890" }, 401)).fetch, {
        apiKey: "secret-key-1234567890",
      }).noul({ decisionPoint: "DP-005", state: SAMPLE_STATE, question: SAFE }),
    );
    expect(err.message).not.toContain("secret-key");
    expect(JSON.stringify(err.toPublic())).not.toContain("secret-key");
  });
});

describe("SystemOneJudgmentAdapter — contrato de salida", () => {
  const withAnswer = (answer: unknown) =>
    replying(
      json({
        model: "laya-rl-agent",
        answers: { pick: answer, fit: answer, safe: answer },
      }),
    ).fetch;

  it.each([
    ["no es JSON", () => new Response("<html>", { status: 200 })],
    ["sin answers", () => json({ model: "x" })],
  ])("%s → provider_contract_violation", async (_name, make) => {
    const err = await portError(
      adapter(replying(make).fetch).noul({
        decisionPoint: "DP-005",
        state: SAMPLE_STATE,
        question: SAFE,
      }),
    );
    expect(err.code).toBe("provider_contract_violation");
  });

  it("choice con una opción no declarada", async () => {
    const err = await portError(
      adapter(
        withAnswer({ type: "choice", choice: "z", probabilities: { a: 0.5, b: 0.5 } }),
      ).choice({ decisionPoint: "DP-005", state: SAMPLE_STATE, question: PICK }),
    );
    expect(err.code).toBe("provider_contract_violation");
  });

  it("choice con probabilidad de una opción que no existe", async () => {
    const err = await portError(
      adapter(
        withAnswer({
          type: "choice",
          choice: "a",
          probabilities: { a: 0.5, b: 0.4, c: 0.1 },
        }),
      ).choice({ decisionPoint: "DP-005", state: SAMPLE_STATE, question: PICK }),
    );
    expect(err.code).toBe("provider_contract_violation");
  });

  it("score con otra cantidad de niveles", async () => {
    const err = await portError(
      adapter(
        withAnswer({ type: "score", score: 1, probabilities: { "0": 0.5, "1": 0.5 } }),
      ).score({ decisionPoint: "DP-005", state: SAMPLE_STATE, question: FIT }),
    );
    expect(err.code).toBe("provider_contract_violation");
  });

  it("score que no corresponde a su distribución (no es 0-based)", async () => {
    const err = await portError(
      adapter(
        withAnswer({
          type: "score",
          score: 3.9,
          probabilities: { "0": 0.7, "1": 0.1, "2": 0.1, "3": 0.1 },
        }),
      ).score({ decisionPoint: "DP-005", state: SAMPLE_STATE, question: FIT }),
    );
    expect(err.code).toBe("provider_contract_violation");
  });

  it("tipo cambiado y noul fuera de [0,1]", async () => {
    const e1 = await portError(
      adapter(
        withAnswer({ type: "choice", choice: "a", probabilities: { a: 1, b: 0 } }),
      ).noul({
        decisionPoint: "DP-005",
        state: SAMPLE_STATE,
        question: SAFE,
      }),
    );
    expect(e1.code).toBe("provider_contract_violation");
    const e2 = await portError(
      adapter(withAnswer({ type: "noul", noul: 1.5 })).noul({
        decisionPoint: "DP-005",
        state: SAMPLE_STATE,
        question: SAFE,
      }),
    );
    expect(e2.code).toBe("provider_contract_violation");
  });

  it("distribución toda en cero", async () => {
    const err = await portError(
      adapter(
        withAnswer({ type: "choice", choice: "a", probabilities: { a: 0, b: 0 } }),
      ).choice({
        decisionPoint: "DP-005",
        state: SAMPLE_STATE,
        question: PICK,
      }),
    );
    expect(err.code).toBe("provider_contract_violation");
  });
});

describe("catálogo y prueba de conexión", () => {
  it("Laya: health + una pregunta; devuelve el checkpoint", async () => {
    const urls: string[] = [];
    const fake = fakeLaya();
    const result = await probeSystemOne({
      provider: "laya",
      baseUrl: "http://127.0.0.1:3006",
      apiKey: "",
      model: "auto",
      timeoutMs: 2_000,
      fetch: async (url, init) => {
        urls.push(url);
        if (url.endsWith("/health")) return json({ status: "ok", device: "mps" });
        return fake.fetch(url, init);
      },
    });
    expect(urls).toEqual([
      "http://127.0.0.1:3006/health",
      "http://127.0.0.1:3006/v1/systemone",
    ]);
    expect(result.model).toBe("laya-rl-agent/english");
  });

  it("Laya caído → provider_unavailable", async () => {
    const err = await portError(
      probeSystemOne({
        provider: "laya",
        baseUrl: "http://127.0.0.1:3006",
        apiKey: "",
        model: "auto",
        timeoutMs: 500,
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    );
    expect(err.code).toBe("provider_unavailable");
  });

  it("los ids del catálogo", () => {
    expect(SYSTEMONE_MODELS.laya.map((m) => m.id)).toEqual([
      "auto",
      "english",
      "multilingual",
      "typed-decisions",
    ]);
    expect(SYSTEMONE_MODELS.typesafe.map((m) => m.id)).toEqual(["jev-latest"]);
  });

  it("Retry-After en segundos o fecha", () => {
    expect(parseRetryAfter("3")).toBe(3);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 5_000)).toBe(5);
  });
});
