/**
 * Settings → Models (`PU-MODEL-002`) de punta a punta contra un `apiRequest`
 * falso: los tres estados, y el camino feliz con Ollama (cargar la lista,
 * elegir, probar, guardar).
 *
 * Lo que más importa fijar: **la key tipeada nunca vuelve a aparecer** y un
 * guardado sin key nueva no manda `apiKey` (queda la guardada).
 */
import {
  modelsOverviewSchema,
  type ModelsOverview,
  type ModelTaskConfig,
} from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { ModelsSettings } from "./ModelsSettings";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

import { apiRequest, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

const TASKS = [
  "text",
  "judgment",
  "vision",
  "image",
  "video",
  "background_removal",
] as const;

function unset(task: (typeof TASKS)[number]): ModelTaskConfig {
  const llm = task === "text" || task === "judgment" || task === "vision";
  return {
    task,
    kind: llm ? "llm" : "reserved",
    wired: task === "text" || task === "judgment",
    status: "unset",
    source: "none",
    inheritsFrom: null,
    provider: null,
    baseUrl: null,
    model: null,
    contextWindowTokens: null,
    apiKey: { hasKey: false, last4: null, source: null, envVar: null },
    apiKeyEnv: null,
    missing: [],
    providers: llm ? ["openrouter", "ollama", "custom"] : ["custom"],
    updatedAt: null,
  };
}

const OVERVIEW: ModelsOverview = modelsOverviewSchema.parse({
  tasks: TASKS.map(unset),
  providers: [
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
  ],
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

type Call = { path: string; options: ApiRequestOptions<unknown> };

function server(overview: ModelsOverview = OVERVIEW): Call[] {
  const calls: Call[] = [];
  requestMock.mockImplementation(
    (path: string, options: ApiRequestOptions<unknown> = {}) => {
      calls.push({ path, options });
      if (path === "/models") return Promise.resolve(overview);
      if (path === "/models/providers/ollama/models") {
        return Promise.resolve({
          provider: "ollama",
          baseUrl: "http://localhost:11434/v1",
          keySource: "none",
          result: { ok: true, models: [{ id: "qwen2.5:7b-instruct" }] },
        });
      }
      if (path === "/models/test") {
        return Promise.resolve({
          ok: true,
          keySource: "provided",
          models: { ok: true, models: [{ id: "vendor/m", contextWindowTokens: 131072 }] },
          completion:
            (options.body as { model?: string }).model === undefined
              ? null
              : {
                  ok: true,
                  model: (options.body as { model: string }).model,
                  latencyMs: 42,
                },
        });
      }
      if (path === "/models/text") {
        return Promise.resolve({ ...unset("text"), status: "ready", source: "registry" });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    },
  );
  return calls;
}

afterEach(() => {
  requestMock.mockReset();
});

function textCard(): HTMLElement {
  const heading = screen.getByRole("heading", { name: "Text", level: 3 });
  const card = heading.closest(".fg-card");
  if (!(card instanceof HTMLElement)) throw new Error("no card");
  return card;
}

describe("ModelsSettings", () => {
  it("loading → vacío: sin nada configurado lo dice", async () => {
    server();
    render(<ModelsSettings />, { wrapper });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(await screen.findByText("No model configured yet")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "In use" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Coming next" })).toBeInTheDocument();
  });

  it("error: el estado de error con salida", async () => {
    requestMock.mockRejectedValue(
      new ApiRequestError({ code: "service_unavailable", status: 503 }),
    );
    render(<ModelsSettings />, { wrapper });
    expect(
      await screen.findByRole("button", { name: /try again|reload/i }),
    ).toBeInTheDocument();
  });

  it("Ollama: cargar la lista, elegir, probar y guardar", async () => {
    const calls = server();
    render(<ModelsSettings />, { wrapper });
    await screen.findByText("No model configured yet");
    const card = within(textCard());

    fireEvent.change(card.getByLabelText("Provider"), { target: { value: "ollama" } });
    expect(card.getByLabelText("Base URL")).toHaveValue("http://localhost:11434/v1");

    fireEvent.click(card.getByRole("button", { name: "Load models" }));
    await card.findByText("1 model available");
    fireEvent.change(card.getByLabelText("Model"), {
      target: { value: "qwen2.5:7b-instruct" },
    });
    fireEvent.change(card.getByLabelText("Context window (tokens)"), {
      target: { value: "32768" },
    });

    fireEvent.click(card.getByRole("button", { name: "Test connection" }));
    await card.findByText(/Connected — qwen2.5:7b-instruct answered in 42 ms/);

    fireEvent.click(card.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === "/models/text")).toBe(true);
    });
    const put = calls.find((c) => c.path === "/models/text");
    expect(put?.options.method).toBe("PUT");
    expect(put?.options.body).toEqual({
      provider: "ollama",
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5:7b-instruct",
      contextWindowTokens: 32768,
    });
  });

  it("una key tipeada va sólo por el cuerpo del POST y se lista con ella", async () => {
    const calls = server();
    render(<ModelsSettings />, { wrapper });
    await screen.findByText("No model configured yet");
    const card = within(textCard());

    fireEvent.change(card.getByLabelText("Provider"), {
      target: { value: "openrouter" },
    });
    const key = card.getByLabelText("API key");
    expect(key).toHaveAttribute("type", "password");
    fireEvent.change(key, { target: { value: "sk-typed-secret-123456" } });

    fireEvent.click(card.getByRole("button", { name: "Load models" }));
    await card.findByText("1 model available");
    const post = calls.find((c) => c.path === "/models/test");
    expect(post?.options.method).toBe("POST");
    expect(post?.options.body).toMatchObject({ apiKey: "sk-typed-secret-123456" });
    expect(post?.options.body).not.toHaveProperty("model");
    // Ninguna petición lleva la key en la query.
    expect(JSON.stringify(calls.map((c) => c.options.query ?? {}))).not.toContain(
      "sk-typed",
    );

    // Elegir el modelo completa la ventana que publica el proveedor.
    fireEvent.change(card.getByLabelText("Model"), { target: { value: "vendor/m" } });
    expect(card.getByLabelText("Context window (tokens)")).toHaveValue("131072");
  });

  it("una key guardada se anuncia por sus últimos cuatro y el campo arranca vacío", async () => {
    const saved: ModelTaskConfig = {
      ...unset("text"),
      status: "ready",
      source: "registry",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "vendor/m",
      contextWindowTokens: 8192,
      apiKey: { hasKey: true, last4: "wxyz", source: "file", envVar: null },
    };
    server({ ...OVERVIEW, tasks: [saved, ...OVERVIEW.tasks.slice(1)] });
    render(<ModelsSettings />, { wrapper });
    const card = within(
      await screen
        .findByRole("heading", { name: "Text", level: 3 })
        .then(() => textCard()),
    );
    expect(card.getByLabelText("API key")).toHaveValue("");
    expect(card.getByText(/Saved key ••••wxyz/)).toBeInTheDocument();
    expect(card.getByText("Ready")).toBeInTheDocument();

    fireEvent.change(card.getByLabelText("Base URL"), {
      target: { value: "https://elsewhere.example/v1" },
    });
    expect(card.getByText(/saved key won't be sent there/)).toBeInTheDocument();
  });
});
