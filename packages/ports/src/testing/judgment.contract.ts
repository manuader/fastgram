/**
 * Contrato del puerto `Judgment` — PRD §9.15.1, §25.
 *
 * Lo que esta suite fija es la parte del contrato de la que dependen **todos**
 * los umbrales de §25.3. Si las probabilidades no suman 1, si `value` no está
 * en el espacio declarado o si `confidence` no está en [0, 1], entonces
 * `brandSafe < 0,8`, `leadScore > 0.75` y `supported > 0.85` no significan
 * nada. §25.4 lo dice del adaptador no-LLM —«la calibración se sostiene … es
 * el criterio más importante»—; esto es el piso estructural sin el cual ni
 * siquiera se puede medir calibración.
 *
 * Lo que **no** puede verificar, y hay que decirlo: que el juicio sea
 * *correcto*. Eso se mide contra etiquetado humano (§25.4), no en una suite de
 * contrato. Acá sólo se comprueba que la respuesta tenga la forma prometida.
 */

import type {
  ChoiceQuestion,
  DecisionPoint,
  Judgment,
  JudgmentState,
  NoulQuestion,
  ScoreQuestion,
} from "../judgment.js";
import { MAX_SCORE_LEVELS, MIN_SCORE_LEVELS } from "../judgment.js";
import {
  check,
  checkEqual,
  checkInRange,
  checkNonEmpty,
  checkRejectsWithCode,
  checkSumsToOne,
  type AdapterFactory,
  type ContractHarness,
} from "./harness.js";

export interface JudgmentContractSetup {
  readonly makeAdapter: AdapterFactory<Judgment>;
  /**
   * Estado de ejemplo, ya sanitizado. El adaptador lo provee porque el estado
   * realista depende del `DP` con el que se quiera ejercitar.
   */
  readonly sampleState: JudgmentState;
  /** Default `DP-001`: es el único validable sin producto (§25.4). */
  readonly decisionPoint?: DecisionPoint;
}

const NICHE: ChoiceQuestion<"niche", "travel" | "study" | "none"> = {
  id: "niche",
  kind: "choice",
  instructions: "Nicho principal del contenido.",
  criteria: {
    travel: "Viajes, destinos, itinerarios.",
    study: "Estudio, productividad académica.",
    none: "Ninguno de los anteriores encaja con claridad.",
  },
};

const BUYING_SIGNAL: ScoreQuestion<"buyingSignal"> = {
  id: "buyingSignal",
  kind: "score",
  instructions: "Qué tan cerca está de comprar.",
  levels: [
    "sólo comenta",
    "frustrado con su solución actual",
    "evaluando alternativas",
    "pide recomendación explícita",
  ],
};

const REMIXABLE: NoulQuestion<"remixable"> = {
  id: "remixable",
  kind: "noul",
  instructions: "¿Se puede recrear el formato con otra marca?",
  criteria: {
    true: "El formato funciona sin depender de la persona o el producto original.",
    false: "El contenido depende de quién lo hizo o de qué producto muestra.",
  },
};

export function describeJudgmentContract(
  harness: ContractHarness,
  name: string,
  setup: JudgmentContractSetup,
): void {
  const { describe, it } = harness;
  const dp: DecisionPoint = setup.decisionPoint ?? "DP-001";
  const state = setup.sampleState;

  describe(`Judgment contract · ${name}`, () => {
    it("declara procedencia con adaptador y modelo (DATA-033)", async () => {
      const judgment = await setup.makeAdapter();
      checkNonEmpty(judgment.provenance.adapter, "provenance.adapter");
      checkNonEmpty(judgment.provenance.model, "provenance.model");
    });

    it("choice: value es una opción declarada y la distribución cubre criteria", async () => {
      const judgment = await setup.makeAdapter();
      const { answer, usage } = await judgment.choice({
        decisionPoint: dp,
        state,
        question: NICHE,
      });

      checkEqual(answer.kind, "choice", "kind de la respuesta");
      const options = Object.keys(NICHE.criteria);
      check(
        options.includes(answer.value),
        `value "${answer.value}" no está en criteria (§9.15.1: el espacio de salida se declara de antemano)`,
      );
      checkEqual(
        Object.keys(answer.probabilities).length,
        options.length,
        "probabilities tiene que cubrir todas las opciones",
      );
      checkSumsToOne(Object.values(answer.probabilities), "choice.probabilities");
      checkInRange(answer.confidence, 0, 1, "choice.confidence");
      check(usage.latencyMs >= 0, "usage.latencyMs negativo");
    });

    it("choice: value es la opción de mayor probabilidad", async () => {
      const judgment = await setup.makeAdapter();
      const { answer } = await judgment.choice({
        decisionPoint: dp,
        state,
        question: NICHE,
      });
      const chosen = answer.probabilities[answer.value];
      for (const probability of Object.values(answer.probabilities)) {
        check(
          chosen >= probability,
          "value no es el argmax de probabilities: los umbrales de §25.3 asumen que lo es",
        );
      }
    });

    it("score: value cae en [1, levels.length] y hay una probabilidad por nivel", async () => {
      const judgment = await setup.makeAdapter();
      const { answer } = await judgment.score({
        decisionPoint: dp,
        state,
        question: BUYING_SIGNAL,
      });

      checkEqual(answer.kind, "score", "kind de la respuesta");
      checkEqual(
        answer.probabilities.length,
        BUYING_SIGNAL.levels.length,
        "una probabilidad por nivel",
      );
      checkInRange(answer.value, 1, BUYING_SIGNAL.levels.length, "score.value");
      checkSumsToOne(answer.probabilities, "score.probabilities");
      checkInRange(answer.confidence, 0, 1, "score.confidence");
    });

    it("noul: devuelve probabilidad y nada más", async () => {
      const judgment = await setup.makeAdapter();
      const { answer } = await judgment.noul({
        decisionPoint: dp,
        state,
        question: REMIXABLE,
      });

      checkEqual(answer.kind, "noul", "kind de la respuesta");
      checkInRange(answer.probability, 0, 1, "noul.probability");
      check(
        !("confidence" in answer),
        "noul no lleva confidence (§9.15.1); incluirla haría detectable el adaptador",
      );
    });

    it("ask: responde todas las preguntas del lote, cada una con su tipo", async () => {
      const judgment = await setup.makeAdapter();
      const { answers, usage } = await judgment.ask({
        decisionPoint: dp,
        state,
        questions: [NICHE, BUYING_SIGNAL, REMIXABLE],
      });

      // El tipo de cada entrada lo deriva `AnswersFor` del id de la pregunta:
      // si esto compila, el mapeo de ids a respuestas está bien.
      checkEqual(answers.niche.kind, "choice", "answers.niche");
      checkEqual(answers.buyingSignal.kind, "score", "answers.buyingSignal");
      checkEqual(answers.remixable.kind, "noul", "answers.remixable");
      checkInRange(answers.remixable.probability, 0, 1, "answers.remixable.probability");
      check(usage.latencyMs >= 0, "usage del lote");
    });

    it("ask: preguntas independientes — el orden del lote no cambia la respuesta", async () => {
      const judgment = await setup.makeAdapter();
      const forward = await judgment.ask({
        decisionPoint: dp,
        state,
        questions: [NICHE, REMIXABLE],
      });
      const reversed = await judgment.ask({
        decisionPoint: dp,
        state,
        questions: [REMIXABLE, NICHE],
      });
      checkEqual(
        forward.answers.niche.value,
        reversed.answers.niche.value,
        "el orden del lote no puede condicionar una respuesta: §9.15.1 las define independientes",
      );
    });

    it("rechaza un score con menos niveles del mínimo", async () => {
      const judgment = await setup.makeAdapter();
      const tooFew = {
        id: "tooFew",
        kind: "score",
        instructions: "Inválida a propósito.",
        levels: Array.from({ length: MIN_SCORE_LEVELS - 1 }, (_, i) => `n${String(i)}`),
      } as unknown as ScoreQuestion;

      await checkRejectsWithCode(
        () => judgment.score({ decisionPoint: dp, state, question: tooFew }),
        ["bad_request"],
        `score con menos de ${String(MIN_SCORE_LEVELS)} niveles`,
      );
    });

    it("rechaza un score con más niveles del máximo", async () => {
      const judgment = await setup.makeAdapter();
      const tooMany: ScoreQuestion = {
        id: "tooMany",
        kind: "score",
        instructions: "Inválida a propósito.",
        levels: [
          "bajo",
          "alto",
          ...Array.from({ length: MAX_SCORE_LEVELS }, (_, i) => `n${String(i)}`),
        ],
      };

      await checkRejectsWithCode(
        () => judgment.score({ decisionPoint: dp, state, question: tooMany }),
        ["bad_request"],
        `score con más de ${String(MAX_SCORE_LEVELS)} niveles`,
      );
    });

    it("rechaza un choice sin opciones", async () => {
      const judgment = await setup.makeAdapter();
      const empty = {
        id: "empty",
        kind: "choice",
        instructions: "Inválida a propósito.",
        criteria: {},
      } as unknown as ChoiceQuestion;

      await checkRejectsWithCode(
        () => judgment.choice({ decisionPoint: dp, state, question: empty }),
        ["bad_request"],
        "choice sin criteria",
      );
    });

    it("rechaza un lote con ids repetidos", async () => {
      const judgment = await setup.makeAdapter();
      await checkRejectsWithCode(
        () =>
          judgment.ask({
            decisionPoint: dp,
            state,
            questions: [NICHE, NICHE],
          }),
        ["bad_request"],
        "ids repetidos en el lote: la respuesta se pisaría a sí misma",
      );
    });

    it("respeta timeoutMs y lo traduce a `timeout` (§9.15.3.7)", async () => {
      const judgment = await setup.makeAdapter();
      await checkRejectsWithCode(
        () =>
          judgment.noul({
            decisionPoint: dp,
            state,
            question: REMIXABLE,
            timeoutMs: 1,
          }),
        ["timeout", "bad_request"],
        "timeoutMs de 1 ms: o vence, o el adaptador lo rechaza por absurdo",
      );
    });
  });
}
