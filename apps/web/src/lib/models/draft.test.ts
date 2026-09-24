import { describe, expect, it } from "vitest";
import {
  modelTaskConfigSchema,
  type ModelProviderPreset,
  type ModelTaskConfig,
} from "@fastgram/contracts";
import {
  draftErrors,
  draftFrom,
  isDirty,
  keyWillBeDropped,
  toTestRequest,
  toUpdateRequest,
  withModel,
  withProvider,
} from "./draft";

const PRESETS: ModelProviderPreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
    local: false,
    note: null,
  },
  {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    requiresKey: false,
    local: true,
    note: null,
  },
  {
    id: "custom",
    label: "Custom",
    baseUrl: null,
    requiresKey: false,
    local: false,
    note: null,
  },
];

function config(over: Partial<ModelTaskConfig> = {}): ModelTaskConfig {
  return modelTaskConfigSchema.parse({
    task: "text",
    kind: "llm",
    wired: true,
    status: "ready",
    source: "registry",
    inheritsFrom: null,
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "vendor/model",
    contextWindowTokens: 32000,
    apiKey: { hasKey: true, last4: "abcd", source: "file", envVar: null },
    apiKeyEnv: null,
    missing: [],
    providers: ["openrouter", "ollama", "custom"],
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...over,
  });
}

const UNSET = config({
  status: "unset",
  source: "none",
  provider: null,
  baseUrl: null,
  model: null,
  contextWindowTokens: null,
  apiKey: { hasKey: false, last4: null, source: null, envVar: null },
  updatedAt: null,
});

describe("draftFrom", () => {
  it("siembra lo guardado, sin key", () => {
    expect(draftFrom(config())).toMatchObject({
      provider: "openrouter",
      model: "vendor/model",
      apiKey: "",
      contextWindow: "32000",
    });
  });

  it("lo que corre con LLM_* o hereda de text arranca vacío: no se copia al archivo", () => {
    expect(draftFrom(config({ source: "env", provider: null })).model).toBe("");
    expect(draftFrom(config({ task: "judgment", inheritsFrom: "text" })).model).toBe("");
  });
});

describe("withProvider / withModel", () => {
  it("cambiar de proveedor pone su base URL y vacía el modelo", () => {
    const next = withProvider(draftFrom(config()), "ollama", PRESETS);
    expect(next).toMatchObject({
      provider: "ollama",
      baseUrl: "http://localhost:11434/v1",
      model: "",
      contextWindow: "",
    });
    expect(withProvider(draftFrom(UNSET), "custom", PRESETS).baseUrl).toBe("");
  });

  it("la ventana se completa sola si el proveedor la publica, sin pisar la del usuario", () => {
    const listed = [{ id: "a", contextWindowTokens: 8192 }, { id: "b" }];
    const empty = { ...draftFrom(UNSET), provider: "openrouter" as const };
    expect(withModel(empty, "a", listed).contextWindow).toBe("8192");
    const typed = { ...empty, contextWindow: "4096" };
    expect(withModel(typed, "a", listed).contextWindow).toBe("4096");
    const auto = withModel(empty, "a", listed);
    expect(withModel(auto, "b", listed).contextWindow).toBe("8192");
  });
});

describe("toUpdateRequest", () => {
  it("sin key escrita no manda apiKey (queda la guardada)", () => {
    const req = toUpdateRequest({ ...draftFrom(config()), model: "other" }, config());
    expect(req).not.toHaveProperty("apiKey");
    expect(req).toMatchObject({ model: "other", contextWindowTokens: 32000 });
  });

  it("borrar la key es explícito: null", () => {
    const req = toUpdateRequest({ ...draftFrom(config()), clearKey: true }, config());
    expect(req?.apiKey).toBeNull();
  });

  it("vaciar la ventana guardada la borra", () => {
    const req = toUpdateRequest({ ...draftFrom(config()), contextWindow: "" }, config());
    expect(req?.contextWindowTokens).toBeNull();
  });
});

describe("toTestRequest", () => {
  it("sin key escrita pide probar con la guardada (task), y la key nunca va vacía", () => {
    expect(toTestRequest("text", draftFrom(config()))).toEqual({
      task: "text",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "vendor/model",
    });
  });
});

describe("keyWillBeDropped", () => {
  it("avisa si el host cambia y no hay key nueva", () => {
    const draft = { ...draftFrom(config()), baseUrl: "https://other.example/v1" };
    expect(keyWillBeDropped(draft, config())).toBe(true);
    expect(keyWillBeDropped({ ...draft, apiKey: "new" }, config())).toBe(false);
    expect(
      keyWillBeDropped(
        { ...draftFrom(config()), baseUrl: "https://openrouter.ai/api/v1/" },
        config(),
      ),
    ).toBe(false);
  });
});

describe("draftErrors / isDirty", () => {
  it("un LLM exige ventana; una tarea reservada no", () => {
    const d = {
      ...draftFrom(UNSET),
      provider: "custom" as const,
      baseUrl: "https://x.example",
      model: "m",
    };
    expect(draftErrors(d, "llm").contextWindow).toBeDefined();
    expect(draftErrors(d, "reserved").contextWindow).toBeUndefined();
    expect(draftErrors({ ...d, baseUrl: "x.example" }, "reserved").baseUrl).toBeDefined();
  });

  it("recién sembrado no está sucio; escribir una key sí", () => {
    expect(isDirty(draftFrom(config()), config())).toBe(false);
    expect(isDirty({ ...draftFrom(config()), apiKey: "k" }, config())).toBe(true);
  });
});
