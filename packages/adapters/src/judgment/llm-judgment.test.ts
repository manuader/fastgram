import { describe, expect, it } from "vitest";
import { describeJudgmentContract, isPortError, type Llm } from "@fastgram/ports";
import { OpenAiCompatibleLlm } from "../llm/openai-compatible.js";
import { FakeGateway } from "../llm/__tests__/fake-gateway.js";
import { LlmJudgmentAdapter, type RawJudgmentResponse } from "./llm-judgment.js";

/**
 * Suite de contrato de `Judgment` contra el adaptador por defecto (§9.15.2),
 * montado sobre el adaptador `Llm` real y un gateway falso.
 *
 * **Qué prueba y qué no.** Prueba la pila entera del lado nuestro: armado del
 * esquema, `response_format` strict, contención del estado, decodificación,
 * normalización y traducción de errores. **No prueba calidad de juicio**: eso
 * se mide contra etiquetado humano (§25.4) y es `P1-JUDGE-006`.
 *
 * El fake devuelve probabilidades derivadas de un hash del request completo,
 * o sea que **es sensible al orden** igual que un modelo autorregresivo. Eso
 * hace que el caso «el orden del lote no cambia la respuesta» verifique de
 * verdad que el adaptador ordena las preguntas antes de armar el prompt.
 */
const SAMPLE_STATE = {
  caption: "3 destinos baratos para mochilear en marzo",
  ocrText: "GUIA RAPIDA — SUDESTE ASIATICO",
  hashtags: ["viajes", "mochilero", "presupuesto"],
} as const;

function makeLlm(gateway = new FakeGateway()): Llm {
  return new OpenAiCompatibleLlm({
    baseUrl: "https://gateway.invalid/v1",
    apiKey: "test-key",
    model: "fake-model",
    contextWindowTokens: 32_000,
    fetch: gateway.fetch,
  });
}

describeJudgmentContract({ describe, it }, "llm (fake gateway)", {
  makeAdapter: () => new LlmJudgmentAdapter(makeLlm(), { model: "fake-model" }),
  sampleState: SAMPLE_STATE,
});

describe("LlmJudgmentAdapter — reglas de §9.15.3", () => {
  const NICHE = {
    id: "niche",
    kind: "choice",
    instructions: "Nicho principal del contenido.",
    criteria: { travel: "Viajes.", study: "Estudio.", none: "Ninguno." },
  } as const;

  it("regla 2 · ningún umbral ni peso viaja en el prompt", async () => {
    const gateway = new FakeGateway();
    await new LlmJudgmentAdapter(makeLlm(gateway), { model: "m" }).choice({
      decisionPoint: "DP-001",
      state: SAMPLE_STATE,
      question: NICHE,
    });

    const messages = gateway.last?.body["messages"] as { content: string }[];
    const prompt = messages.map((m) => m.content).join("\n");
    // Los umbrales de §25.3. Ninguno puede estar acá: cambiarlos no puede
    // requerir reinferir.
    for (const threshold of ["0.8", "0,8", "0.75", "0,75", "0.85", "0,85"]) {
      expect(prompt).not.toContain(threshold);
    }
  });

  it("regla 3 · entrega la respuesta cruda para que DATA-033 la persista", async () => {
    const seen: RawJudgmentResponse[] = [];
    const adapter = new LlmJudgmentAdapter(makeLlm(), {
      model: "fake-model",
      onRawResponse: (r) => seen.push(r),
    });

    await adapter.ask({
      decisionPoint: "DP-001",
      state: SAMPLE_STATE,
      questions: [NICHE],
    });

    expect(seen).toHaveLength(1);
    const record = seen[0];
    expect(record?.decisionPoint).toBe("DP-001");
    expect(record?.questionIds).toEqual(["niche"]);
    expect(() => JSON.parse(record?.raw ?? "")).not.toThrow();
    // El modelo que respondió de verdad, no el configurado: es lo que
    // `DATA-033.model` necesita para que §25.4 compare cosas conocidas.
    expect(record?.model).toBe("fake-model");
  });

  it("regla 4 · el estado viaja contenido, no concatenado en la instrucción", async () => {
    const gateway = new FakeGateway();
    await new LlmJudgmentAdapter(makeLlm(gateway), { model: "m" }).choice({
      decisionPoint: "DP-001",
      state: { bio: "Café de especialidad." },
      question: NICHE,
    });

    const messages = gateway.last?.body["messages"] as {
      role: string;
      content: string;
    }[];
    const contained = messages.find((m) => m.content.includes("<untrusted"));
    expect(contained?.content).toContain("Café de especialidad.");
    // Y no está suelto en ningún otro mensaje.
    const loose = messages.filter(
      (m) =>
        m.content.includes("Café de especialidad.") && !m.content.includes("<untrusted"),
    );
    expect(loose).toHaveLength(0);
  });

  it("pide decodificación restringida con el espacio de salida en el enum (ADR-009)", async () => {
    const gateway = new FakeGateway();
    await new LlmJudgmentAdapter(makeLlm(gateway), { model: "m" }).choice({
      decisionPoint: "DP-001",
      state: SAMPLE_STATE,
      question: NICHE,
    });

    const format = gateway.last?.body["response_format"] as {
      json_schema: { strict: boolean; schema: Record<string, unknown> };
    };
    expect(format.json_schema.strict).toBe(true);

    const root = format.json_schema.schema;
    expect(root["additionalProperties"]).toBe(false);
    const properties = root["properties"] as Record<string, Record<string, unknown>>;
    const nicheSchema = properties["niche"] as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(nicheSchema.properties["value"]?.["enum"]).toEqual([
      "travel",
      "study",
      "none",
    ]);
  });

  it("recalcula `value` como argmax en vez de creerle al modelo", async () => {
    // El esquema garantiza que `value` está en el enum, no que sea el máximo
    // de su propia distribución. Los umbrales de §25.3 asumen que lo es.
    const adapter = new LlmJudgmentAdapter(makeLlm(), { model: "m" });
    const { answer } = await adapter.choice({
      decisionPoint: "DP-001",
      state: SAMPLE_STATE,
      question: NICHE,
    });

    const best = Math.max(...Object.values(answer.probabilities));
    expect(answer.probabilities[answer.value]).toBe(best);
  });

  it("normaliza: el modelo no puede sumar 1 y el esquema no puede exigirlo", async () => {
    const adapter = new LlmJudgmentAdapter(makeLlm(), { model: "m" });
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

    const total = answer.probabilities.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});

describe("LlmJudgmentAdapter — cuando el modelo rompe el contrato", () => {
  const REMIXABLE = {
    id: "remixable",
    kind: "noul",
    instructions: "¿Se recrea con otra marca?",
    criteria: { true: "Sí.", false: "No." },
  } as const;

  async function failsWith(gateway: FakeGateway): Promise<unknown> {
    return new LlmJudgmentAdapter(makeLlm(gateway), { model: "m" })
      .noul({ decisionPoint: "DP-001", state: SAMPLE_STATE, question: REMIXABLE })
      .then(
        () => null,
        (e: unknown) => e,
      );
  }

  it("una salida que no parsea sale como provider_contract_violation", async () => {
    const error = await failsWith(new FakeGateway({ breakJsonSchema: true }));
    expect(isPortError(error) && error.code).toBe("provider_contract_violation");
  });

  it("el gateway caído sale como provider_unavailable, no como un juicio inventado", async () => {
    // Importa que **lance**: §9.15.3.7 dice que el fallback lo aplica el
    // consumidor. Un adaptador que devolviera 0,5 «por las dudas» le sacaría
    // al `DP` la posibilidad de decidir qué hacer sin respuesta.
    const error = await failsWith(new FakeGateway({ status: 503 }));
    expect(isPortError(error) && error.code).toBe("provider_unavailable");
  });

  it("el nombre del proveedor no cruza hacia el cliente", async () => {
    const error = await failsWith(
      new FakeGateway({ status: 500, statusBody: '{"error":"together.ai node down"}' }),
    );
    expect(isPortError(error)).toBe(true);
    if (isPortError(error)) {
      expect(JSON.stringify(error.toPublic())).not.toContain("together");
    }
  });
});
