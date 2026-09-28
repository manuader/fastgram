/**
 * Sprint 9 (O, D-18): elegir «Laya (local)» para el juicio en Settings →
 * Models. Lo que fija: el modelo se propone solo (`auto`), no hay ventana de
 * contexto que pedir, «Test connection» muestra lo que respondió Laya y
 * «Save» no manda ventana.
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
import { ModelsSettings } from "./ModelsSettings";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

import { apiRequest, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

const JUDGMENT_PROVIDERS = ["laya", "typesafe", "ollama"] as const;

function unset(task: "text" | "judgment"): ModelTaskConfig {
  return {
    task,
    kind: "llm",
    wired: true,
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
    providers: task === "judgment" ? [...JUDGMENT_PROVIDERS] : ["ollama"],
    updatedAt: null,
  };
}

const OVERVIEW: ModelsOverview = modelsOverviewSchema.parse({
  tasks: [unset("text"), unset("judgment")],
  providers: [
    {
      id: "laya",
      label: "Laya",
      baseUrl: "http://127.0.0.1:3006",
      requiresKey: false,
      local: true,
      note: "Runs on this Mac.",
      defaultModel: "auto",
    },
    {
      id: "typesafe",
      label: "TypeSafe Jev",
      baseUrl: "https://api.typesafe.ai",
      requiresKey: true,
      local: false,
      note: null,
      defaultModel: "jev-latest",
    },
    {
      id: "ollama",
      label: "Ollama",
      baseUrl: "http://localhost:11434/v1",
      requiresKey: false,
      local: true,
      note: null,
      defaultModel: null,
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

function server(layaUp: boolean): Call[] {
  const calls: Call[] = [];
  requestMock.mockImplementation(
    (path: string, options: ApiRequestOptions<unknown> = {}) => {
      calls.push({ path, options });
      if (path === "/models") return Promise.resolve(OVERVIEW);
      if (path === "/models/test") {
        return Promise.resolve({
          ok: layaUp,
          keySource: "none",
          models: { ok: true, models: [{ id: "auto", ownedBy: "Automatic" }] },
          completion: layaUp
            ? { ok: true, model: "laya-rl-agent/english", latencyMs: 57 }
            : {
                ok: false,
                error: { code: "provider_unavailable", message: "Laya is not answering" },
              },
        });
      }
      if (path === "/models/judgment") {
        return Promise.resolve({
          ...unset("judgment"),
          status: "ready",
          source: "registry",
          provider: "laya",
          baseUrl: "http://127.0.0.1:3006",
          model: "auto",
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    },
  );
  return calls;
}

afterEach(() => {
  requestMock.mockReset();
});

function judgmentCard(): HTMLElement {
  const heading = screen.getByRole("heading", { name: "Judgment", level: 3 });
  const card = heading.closest(".fg-card");
  if (!(card instanceof HTMLElement)) throw new Error("no card");
  return card;
}

describe("Laya en la tarjeta de Judgment", () => {
  it("elegir Laya: modelo propuesto, sin ventana, probar y guardar", async () => {
    const calls = server(true);
    render(<ModelsSettings />, { wrapper });
    await screen.findByText("No model configured yet");
    const card = within(judgmentCard());

    fireEvent.change(card.getByLabelText("Provider"), { target: { value: "laya" } });
    expect(card.getByLabelText("Base URL")).toHaveValue("http://127.0.0.1:3006");
    expect(card.getByLabelText("Model")).toHaveValue("auto");
    expect(card.queryByLabelText("Context window (tokens)")).toBeNull();
    expect(card.getByText("Runs on this Mac.")).toBeInTheDocument();

    fireEvent.click(card.getByRole("button", { name: "Test connection" }));
    await card.findByText(/Connected — laya-rl-agent\/english answered in 57 ms/);

    fireEvent.click(card.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === "/models/judgment")).toBe(true);
    });
    const put = calls.find((c) => c.path === "/models/judgment");
    expect(put?.options.body).toEqual({
      provider: "laya",
      baseUrl: "http://127.0.0.1:3006",
      model: "auto",
    });
  });

  it("Laya apagado: el error dice que no se alcanza el servidor", async () => {
    server(false);
    render(<ModelsSettings />, { wrapper });
    await screen.findByText("No model configured yet");
    const card = within(judgmentCard());
    fireEvent.change(card.getByLabelText("Provider"), { target: { value: "laya" } });
    fireEvent.click(card.getByRole("button", { name: "Test connection" }));
    await card.findByText(/Couldn't reach the provider/);
  });
});
