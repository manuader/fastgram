/**
 * AI Studio (`PU-LATER-005`) contra un `apiRequest` falso: los estados
 * (cargando, sin modelos, error, galería vacía), el costo estimado **visible
 * antes de generar**, el tope que apaga el botón, y el pedido que se manda.
 */
import {
  aiStudioOptionsSchema,
  generationSchema,
  type AiStudioOptions,
  type Generation,
} from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { AiStudioScreen } from "./AiStudioScreen";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

import { apiRequest, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

const FLUX = {
  id: "fal-ai/flux/schnell",
  label: "FLUX.1 [schnell]",
  kind: "image",
  aspectRatios: ["1:1", "4:5", "3:4", "4:3", "9:16", "16:9"],
  aspectFromImage: false,
  counts: [1, 2, 3, 4],
  durationsSeconds: [],
  promptRequired: true,
  imageInput: "none",
  maxReferenceImages: 0,
  docsUrl: "https://fal.ai/models/fal-ai/flux/schnell/llms.txt",
  listPrice: {
    summary: "$0.003 per megapixel",
    sourceUrl: "https://fal.ai/models/fal-ai/flux/schnell/llms.txt",
  },
} as const;

const BUDGET = {
  month: "2026-09",
  budgetUsd: 30,
  budgetSource: "default",
  chargedUsd: 1.5,
  reservedUsd: 0.25,
  remainingUsd: 28.25,
  generations: 3,
} as const;

function optionsWith(over: Partial<AiStudioOptions> = {}): AiStudioOptions {
  return aiStudioOptionsSchema.parse({
    image: {
      kind: "image",
      configured: true,
      provider: "fal",
      defaultModel: FLUX.id,
      models: [FLUX],
    },
    video: {
      kind: "video",
      configured: false,
      provider: null,
      defaultModel: null,
      models: [],
    },
    budget: BUDGET,
    ...over,
  });
}

function generation(over: Partial<Generation>): Generation {
  return generationSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    kind: "image",
    provider: "fal",
    model: FLUX.id,
    prompt: "neon skyline",
    aspectRatio: "9:16",
    count: 1,
    durationSeconds: null,
    imageUrl: null,
    status: "ready",
    estimate: { usd: 0.0028, source: "price_list", basis: "x", sourceUrl: null },
    media: [],
    error: null,
    createdAt: "2026-09-24T12:00:00.000Z",
    updatedAt: "2026-09-24T12:00:00.000Z",
    ...over,
  });
}

const GALLERY: Generation[] = [
  generation({
    id: "11111111-1111-4111-8111-111111111111",
    media: [
      {
        mediaId: "22222222-2222-4222-8222-222222222222",
        mediaType: "image",
        url: "https://bucket.test/media/a/ai-studio/1.png",
      },
    ],
  }),
  generation({
    id: "33333333-3333-4333-8333-333333333333",
    status: "generating",
    prompt: "waves",
  }),
  generation({
    id: "44444444-4444-4444-8444-444444444444",
    status: "nsfw",
    prompt: "blocked one",
    error: { code: "nsfw_rejected", message: "flagged" },
  }),
];

type Call = { path: string; options: ApiRequestOptions<unknown> };

function server(
  opts: {
    options?: AiStudioOptions | Error;
    gallery?: Generation[];
    estimateUsd?: number;
    create?: Generation | Error;
  } = {},
): Call[] {
  const calls: Call[] = [];
  requestMock.mockImplementation(
    (path: string, options: ApiRequestOptions<unknown> = {}) => {
      calls.push({ path, options });
      if (path === "/ai-studio/options") {
        const o = opts.options ?? optionsWith();
        return o instanceof Error ? Promise.reject(o) : Promise.resolve(o);
      }
      if (path === "/ai-studio/generations" && options.method === "POST") {
        const c =
          opts.create ??
          generation({ status: "queued", id: "55555555-5555-4555-8555-555555555555" });
        return c instanceof Error ? Promise.reject(c) : Promise.resolve(c);
      }
      if (path === "/ai-studio/generations")
        return Promise.resolve(opts.gallery ?? GALLERY);
      if (path === "/ai-studio/estimate") {
        return Promise.resolve({
          provider: "fal",
          model: FLUX.id,
          estimate: {
            usd: opts.estimateUsd ?? 0.0028,
            source: "price_list",
            basis: "1 × 0.92 MP × $0.003 per MP (list price)",
            sourceUrl: FLUX.docsUrl,
          },
          budget: BUDGET,
          fits: true,
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

describe("AiStudioScreen", () => {
  it("cargando → galería con estados: listo con su media, generando, bloqueado", async () => {
    server();
    render(<AiStudioScreen />, { wrapper });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();

    const cards = await screen.findAllByTestId("generation-card");
    expect(cards.map((c) => c.dataset["status"])).toEqual([
      "ready",
      "generating",
      "nsfw",
    ]);
    const ready = within(cards[0] as HTMLElement);
    expect(ready.getByText("Ready")).toBeInTheDocument();
    expect((cards[0] as HTMLElement).querySelector("img")?.getAttribute("src")).toBe(
      "https://bucket.test/media/a/ai-studio/1.png",
    );
    expect(ready.getByRole("link", { name: /Use in Blitz/ })).toHaveAttribute(
      "href",
      "/blitz#create",
    );
    expect(ready.getByRole("link", { name: /In Media Bank/ })).toHaveAttribute(
      "href",
      "/library",
    );
    expect(within(cards[1] as HTMLElement).getByText("Generating")).toBeInTheDocument();
    expect(
      within(cards[2] as HTMLElement).getByText(/content filter blocked/),
    ).toBeInTheDocument();
  });

  it("el costo estimado se ve antes de generar, con el presupuesto del mes", async () => {
    const calls = server();
    render(<AiStudioScreen />, { wrapper });
    const prompt = await screen.findByLabelText("Prompt");
    expect(screen.getByText("Write a prompt to see the cost.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();

    fireEvent.change(prompt, { target: { value: "a neon skyline" } });
    const box = within(screen.getByTestId("ai-studio-estimate"));
    await box.findByText("$0.0028", undefined, { timeout: 3000 });
    expect(box.getByText(/List price estimate/)).toBeInTheDocument();
    expect(box.getByText("$1.75 of $30.00")).toBeInTheDocument();

    const estimate = calls.find((c) => c.path === "/ai-studio/estimate");
    expect(estimate?.options.body).toEqual({
      kind: "image",
      model: FLUX.id,
      prompt: "a neon skyline",
      aspectRatio: "9:16",
      count: 1,
    });
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
  });

  it("si pasaría el tope, el botón se apaga y dice cuánto queda", async () => {
    server({ estimateUsd: 40 });
    render(<AiStudioScreen />, { wrapper });
    fireEvent.change(await screen.findByLabelText("Prompt"), { target: { value: "x" } });
    await screen.findByText(/Over this month's budget: \$28\.25 left/, undefined, {
      timeout: 3000,
    });
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("Generate manda el pedido con la cantidad elegida y avisa", async () => {
    const calls = server();
    render(<AiStudioScreen />, { wrapper });
    fireEvent.change(await screen.findByLabelText("Prompt"), {
      target: { value: "a neon skyline" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "4" }));
    fireEvent.click(screen.getByRole("radio", { name: "1:1" }));
    await within(screen.getByTestId("ai-studio-estimate")).findByText(
      "$0.0028",
      undefined,
      {
        timeout: 3000,
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByText(/Generation started/);
    const post = calls.find(
      (c) => c.path === "/ai-studio/generations" && c.options.method === "POST",
    );
    expect(post?.options.body).toEqual({
      kind: "image",
      model: FLUX.id,
      prompt: "a neon skyline",
      aspectRatio: "1:1",
      count: 4,
    });
  });

  it("402 budget_exceeded del servidor se explica", async () => {
    server({
      create: new ApiRequestError({
        code: "payment_required",
        status: 402,
        details: { reason: "budget_exceeded" },
      }),
    });
    render(<AiStudioScreen />, { wrapper });
    fireEvent.change(await screen.findByLabelText("Prompt"), { target: { value: "x" } });
    await within(screen.getByTestId("ai-studio-estimate")).findByText(
      "$0.0028",
      undefined,
      {
        timeout: 3000,
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /over this month's AI budget/,
    );
  });

  it("sin imagen ni video configurados: lleva a Settings → Models", async () => {
    server({
      options: optionsWith({
        image: {
          kind: "image",
          configured: false,
          provider: null,
          defaultModel: null,
          models: [],
        },
      }),
    });
    render(<AiStudioScreen />, { wrapper });
    expect(
      await screen.findByText("Connect an image or video model"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Settings → Models" })).toHaveAttribute(
      "href",
      "/settings/models",
    );
  });

  it("galería vacía: ERR-E01", async () => {
    server({ gallery: [] });
    render(<AiStudioScreen />, { wrapper });
    expect(
      await screen.findByText(
        "No generations yet. Start generating with a prompt below.",
      ),
    ).toBeInTheDocument();
  });

  it("error al cargar: estado de error con reintento", async () => {
    server({
      options: new ApiRequestError({ code: "service_unavailable", status: 503 }),
    });
    render(<AiStudioScreen />, { wrapper });
    expect(
      await screen.findByRole("button", { name: /try again|reload/i }),
    ).toBeInTheDocument();
  });

  it("el video no configurado se dice dentro del panel", async () => {
    server();
    render(<AiStudioScreen />, { wrapper });
    fireEvent.click(await screen.findByRole("radio", { name: "Video" }));
    await waitFor(() => {
      expect(screen.getByText("No video model is set up yet.")).toBeInTheDocument();
    });
  });
});
