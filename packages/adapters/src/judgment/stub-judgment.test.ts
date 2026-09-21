import { describe, expect, it } from "vitest";
import { describeJudgmentContract, isPortError } from "@fastgram/ports";
import { StubJudgmentAdapter } from "./stub-judgment.js";

/**
 * Primera ejecución de la suite de contrato de `Judgment`.
 *
 * El estado de ejemplo es el de `JV-1` (clasificación del catálogo), que es el
 * único `DP` validable sin producto según §25.4. Va ya sanitizado y filtrado,
 * como exige §9.15.3: el puerto no puede verificarlo por el consumidor.
 */
const SAMPLE_STATE = {
  caption: "3 destinos baratos para mochilear en marzo",
  ocrText: "GUIA RAPIDA — SUDESTE ASIATICO",
  hashtags: ["viajes", "mochilero", "presupuesto"],
  durationSeconds: 34,
} as const;

describeJudgmentContract({ describe, it }, "stub", {
  makeAdapter: () => new StubJudgmentAdapter(),
  sampleState: SAMPLE_STATE,
});

describe("StubJudgmentAdapter — comportamiento propio del adaptador", () => {
  it("es determinista entre instancias: misma pregunta, misma respuesta", async () => {
    const a = new StubJudgmentAdapter();
    const b = new StubJudgmentAdapter();
    const question = {
      id: "niche",
      kind: "choice",
      instructions: "Nicho principal.",
      criteria: { travel: "Viajes.", study: "Estudio.", none: "Ninguno." },
    } as const;

    const first = await a.choice({
      decisionPoint: "DP-001",
      state: SAMPLE_STATE,
      question,
    });
    const second = await b.choice({
      decisionPoint: "DP-001",
      state: SAMPLE_STATE,
      question,
    });

    expect(second.answer.value).toBe(first.answer.value);
    expect(second.answer.probabilities).toEqual(first.answer.probabilities);
  });

  it("el orden de las claves del estado no cambia la respuesta", async () => {
    // Si el hash dependiera del orden de inserción, el stub sería determinista
    // por corrida pero no entre llamadas — el peor modo de fallar, porque los
    // tests pasarían casi siempre.
    const adapter = new StubJudgmentAdapter();
    const question = {
      id: "remixable",
      kind: "noul",
      instructions: "¿Se recrea con otra marca?",
      criteria: { true: "Sí.", false: "No." },
    } as const;

    const forward = await adapter.noul({
      decisionPoint: "DP-001",
      state: { a: 1, b: 2 },
      question,
    });
    const backward = await adapter.noul({
      decisionPoint: "DP-001",
      state: { b: 2, a: 1 },
      question,
    });

    expect(backward.answer.probability).toBe(forward.answer.probability);
  });

  it("una respuesta guionada gana y sigue siendo el argmax", async () => {
    const adapter = new StubJudgmentAdapter({
      answers: { niche: { kind: "choice", value: "study" } },
    });
    const { answer } = await adapter.choice({
      decisionPoint: "DP-001",
      state: SAMPLE_STATE,
      question: {
        id: "niche",
        kind: "choice",
        instructions: "Nicho principal.",
        criteria: { travel: "Viajes.", study: "Estudio.", none: "Ninguno." },
      },
    });

    expect(answer.value).toBe("study");
    for (const probability of Object.values(answer.probabilities)) {
      expect(answer.probabilities.study).toBeGreaterThanOrEqual(probability);
    }
  });

  it("un score guionado cae sobre el nivel pedido", async () => {
    const adapter = new StubJudgmentAdapter({
      answers: { buyingSignal: { kind: "score", level: 3 } },
    });
    const { answer } = await adapter.score({
      decisionPoint: "DP-002",
      state: SAMPLE_STATE,
      question: {
        id: "buyingSignal",
        kind: "score",
        instructions: "Qué tan cerca está de comprar.",
        levels: ["sólo comenta", "frustrado", "evaluando", "pide recomendación"],
      },
    });

    // Es un valor continuo ponderado: cae cerca de 3, no exactamente en 3.
    expect(answer.value).toBeGreaterThan(2.5);
    expect(answer.value).toBeLessThan(3.5);
  });

  it("un guion que nombra una opción inexistente es bad_request, no un value inválido", async () => {
    const adapter = new StubJudgmentAdapter({
      answers: { niche: { kind: "choice", value: "cooking" } },
    });
    const error = await adapter
      .choice({
        decisionPoint: "DP-001",
        state: SAMPLE_STATE,
        question: {
          id: "niche",
          kind: "choice",
          instructions: "Nicho principal.",
          criteria: { travel: "Viajes.", study: "Estudio." },
        },
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(isPortError(error)).toBe(true);
    if (isPortError(error)) expect(error.code).toBe("bad_request");
  });

  it("con latencia simulada mayor al timeout devuelve `timeout` (§9.15.3.7)", async () => {
    const adapter = new StubJudgmentAdapter({ latencyMs: 60 });
    const error = await adapter
      .noul({
        decisionPoint: "DP-007",
        state: SAMPLE_STATE,
        timeoutMs: 20,
        question: {
          id: "brandSafe",
          kind: "noul",
          instructions: "¿Es seguro para la marca?",
          criteria: { true: "Sí.", false: "No." },
        },
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(isPortError(error)).toBe(true);
    if (isPortError(error)) expect(error.code).toBe("timeout");
  });
});
