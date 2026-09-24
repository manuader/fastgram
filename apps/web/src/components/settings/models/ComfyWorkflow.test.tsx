/**
 * Settings → Models con ComfyUI (`PU-LATER-003`), contra un `apiRequest`
 * falso: elegir ComfyUI en Image, pegar un workflow en formato API, ver lo
 * detectado, probar la conexión y guardar. Sin campo de key.
 */
import {
  modelsOverviewSchema,
  type ModelTaskConfig,
  type ModelsOverview,
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
  const gen = task === "image" || task === "video";
  return {
    task,
    kind: llm ? "llm" : gen ? "genai" : "reserved",
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
    providers: llm ? ["ollama"] : gen ? ["fal", "comfyui"] : ["custom"],
    comfyWorkflow: null,
    updatedAt: null,
  };
}

const OVERVIEW: ModelsOverview = modelsOverviewSchema.parse({
  tasks: TASKS.map(unset),
  providers: [
    {
      id: "ollama",
      label: "Ollama",
      baseUrl: "http://localhost:11434/v1",
      requiresKey: false,
      local: true,
      note: null,
    },
    {
      id: "fal",
      label: "fal",
      baseUrl: "https://queue.fal.run",
      requiresKey: true,
      local: false,
      note: null,
    },
    {
      id: "comfyui",
      label: "ComfyUI",
      baseUrl: "http://127.0.0.1:8188",
      requiresKey: false,
      local: true,
      note: "Runs on your own ComfyUI: no cost, no budget used.",
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

const WORKFLOW = {
  "9": { class_type: "CLIPTextEncode", inputs: { text: "bad", clip: ["4", 1] } },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "m.safetensors" } },
  "31": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["4", 1] } },
  "5": {
    class_type: "EmptyLatentImage",
    inputs: { width: 512, height: 512, batch_size: 1 },
  },
  "3": {
    class_type: "KSampler",
    inputs: { seed: 8, positive: ["31", 0], negative: ["9", 0], latent_image: ["5", 0] },
  },
};

type Call = { path: string; options: ApiRequestOptions<unknown> };

function server(): Call[] {
  const calls: Call[] = [];
  requestMock.mockImplementation(
    (path: string, options: ApiRequestOptions<unknown> = {}) => {
      calls.push({ path, options });
      if (path === "/models") return Promise.resolve(OVERVIEW);
      if (path === "/models/test") {
        return Promise.resolve({
          ok: true,
          keySource: "none",
          models: { ok: true, models: [] },
          completion: { ok: true, model: "sd15", latencyMs: 7 },
        });
      }
      if (path === "/models/image") {
        return Promise.resolve({
          ...unset("image"),
          status: "ready",
          source: "registry",
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    },
  );
  return calls;
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  requestMock.mockReset();
});

function imageCard(): HTMLElement {
  const card = screen
    .getByRole("heading", { name: "Image", level: 3 })
    .closest(".fg-card");
  if (!(card instanceof HTMLElement)) throw new Error("no card");
  return card;
}

describe("Settings → Models con ComfyUI", () => {
  it("pegar un workflow, confirmar lo detectado, probar y guardar", async () => {
    const calls = server();
    render(<ModelsSettings />, { wrapper });
    await screen.findByRole("heading", { name: "Image", level: 3 });
    const card = within(imageCard());

    fireEvent.change(card.getByLabelText("Provider"), { target: { value: "comfyui" } });
    expect(card.getByLabelText("Base URL")).toHaveValue("http://127.0.0.1:8188");
    // Local y sin key: ni campo de key ni «Load models».
    expect(card.queryByLabelText("API key")).toBeNull();
    expect(card.queryByRole("button", { name: "Load models" })).toBeNull();

    // Vacío: dice cómo exportarlo.
    expect(card.getByText(/export the workflow in API format/i)).toBeInTheDocument();

    // Formato del editor: error legible.
    const textarea = card.getByLabelText("Workflow (API format)");
    fireEvent.change(textarea, { target: { value: '{"nodes": [], "links": []}' } });
    expect(card.getByText(/This is the editor format/)).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: JSON.stringify(WORKFLOW) } });
    expect(card.getByText(/Detected automatically/)).toBeInTheDocument();
    expect(card.getByLabelText("Prompt")).toHaveValue(JSON.stringify(["31", "text"]));
    expect(card.getByLabelText("Width")).toHaveValue(JSON.stringify(["5", "width"]));
    expect(card.getByLabelText("Seed")).toHaveValue(JSON.stringify(["3", "seed"]));
    // Imagen no ofrece imagen de entrada.
    expect(card.queryByLabelText("Start image")).toBeNull();

    fireEvent.change(card.getByLabelText("Workflow name"), { target: { value: "sd15" } });

    fireEvent.click(card.getByRole("button", { name: "Test connection" }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === "/models/test")).toBe(true);
    });
    const test = calls.find((c) => c.path === "/models/test");
    expect(test?.options.body).toMatchObject({
      provider: "comfyui",
      baseUrl: "http://127.0.0.1:8188",
    });
    expect(test?.options.body).not.toHaveProperty("apiKey");

    fireEvent.click(card.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === "/models/image")).toBe(true);
    });
    const put = calls.find((c) => c.path === "/models/image");
    expect(put?.options.method).toBe("PUT");
    expect(put?.options.body).toEqual({
      provider: "comfyui",
      baseUrl: "http://127.0.0.1:8188",
      model: "sd15",
      comfyWorkflow: {
        workflow: WORKFLOW,
        prompt: { nodeId: "31", input: "text" },
        width: { nodeId: "5", input: "width" },
        height: { nodeId: "5", input: "height" },
        seed: { nodeId: "3", input: "seed" },
      },
    });
  });

  it("sin prompt marcado no se puede guardar", async () => {
    const calls = server();
    render(<ModelsSettings />, { wrapper });
    await screen.findByRole("heading", { name: "Image", level: 3 });
    const card = within(imageCard());
    fireEvent.change(card.getByLabelText("Provider"), { target: { value: "comfyui" } });
    fireEvent.change(card.getByLabelText("Workflow (API format)"), {
      target: { value: JSON.stringify(WORKFLOW) },
    });
    fireEvent.change(card.getByLabelText("Prompt"), { target: { value: "" } });
    fireEvent.change(card.getByLabelText("Workflow name"), { target: { value: "sd15" } });
    fireEvent.click(card.getByRole("button", { name: "Save" }));
    expect(card.getByText("Pick the input that takes the prompt.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/models/image")).toBe(false);
  });
});
