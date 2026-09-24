/**
 * Sección Judgment de Settings → Models — `P1-JUDGE-004`.
 */
import type { ModelTaskConfig } from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

import { apiRequest } from "@/lib/api/client";
import { JudgmentOverrides } from "./JudgmentOverrides";

const requestMock = vi.mocked(apiRequest);

function config(task: ModelTaskConfig["task"], own: boolean): ModelTaskConfig {
  return {
    task,
    kind: "llm",
    wired: true,
    status: "ready",
    source: "registry",
    inheritsFrom: own ? null : "judgment",
    provider: "ollama",
    baseUrl: "http://localhost:11434/v1",
    model: own ? "big-model" : "judge-model",
    contextWindowTokens: 32000,
    apiKey: { hasKey: false, last4: null, source: null, envVar: null },
    apiKeyEnv: null,
    missing: [],
    providers: ["ollama", "custom"],
    updatedAt: null,
  };
}

function mount(overrides: ModelTaskConfig[]) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <JudgmentOverrides overrides={overrides} presets={[]} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("JudgmentOverrides", () => {
  it("sin override: destildado, sin tarjeta; tildarlo abre la tarjeta", () => {
    mount([config("judgment.autopilot", false)]);
    const box = screen.getByRole("checkbox", {
      name: /Autopilot pre-check/,
    }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.queryByText("Not set — uses the Judgment model.")).toBeNull();
    fireEvent.click(box);
    expect(screen.getByText("Not set — uses the Judgment model.")).toBeTruthy();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("con override guardado: tildado; destildarlo lo borra (DELETE)", async () => {
    requestMock.mockResolvedValue(config("judgment.brand", false));
    mount([config("judgment.brand", true)]);
    const box = screen.getByRole("checkbox", {
      name: /Brand field check/,
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "/models/judgment.brand",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});
