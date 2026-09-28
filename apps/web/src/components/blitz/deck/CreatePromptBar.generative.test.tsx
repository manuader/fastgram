/**
 * «Create from prompt» con un formato IA (sprint 7, segunda tanda).
 *
 * El selector suma los formatos `available` de `GET /ai-studio/formats`;
 * elegir uno estima, pide confirmar con el precio, arranca la corrida con
 * `?source=blitz` y la sigue hasta `ready`, cuando un toast ofrece abrir la
 * pieza en el editor. Sin modelo de video, las opciones salen deshabilitadas.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@fastgram/ui";
import {
  formatRunEstimateSchema,
  formatRunSchema,
  generativeFormatsViewSchema,
  type FormatRun,
} from "@fastgram/contracts";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RUN_POLL_MS } from "@/components/studio/generative/api";
import { CreatePromptBar } from "./CreatePromptBar";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));

import { apiRequest, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

const BUDGET = {
  month: "2026-09",
  budgetUsd: 30,
  budgetSource: "default",
  chargedUsd: 1,
  reservedUsd: 0,
  remainingUsd: 29,
  generations: 1,
} as const;

const T2V = {
  id: "kling-video/v2.6/pro/text-to-video",
  label: "Kling 2.6 Pro · text to video",
  kind: "video",
  aspectRatios: ["9:16"],
  aspectFromImage: false,
  counts: [1],
  durationsSeconds: [5],
  promptRequired: true,
  imageInput: "none",
  maxReferenceImages: 0,
  docsUrl: "https://docs.higgsfield.ai/",
  listPrice: null,
} as const;

function view(configured: boolean) {
  return generativeFormatsViewSchema.parse({
    formats: [
      {
        id: "on-a-walk",
        label: "On a Walk",
        description: "Your text over a generated walking selfie",
        status: "available",
        reason: null,
        why: null,
        narrationMissing: false,
        preferredDurationSeconds: 5,
      },
      {
        id: "news-anchor",
        label: "AI News Anchor",
        description: "A news anchor",
        status: "blocked",
        reason: "needs_voice",
        why: "Needs a voice.",
        narrationMissing: false,
        preferredDurationSeconds: null,
      },
    ],
    video: {
      kind: "video",
      configured,
      provider: configured ? "higgsfield" : null,
      defaultModel: configured ? T2V.id : null,
      models: configured ? [T2V] : [],
    },
    budget: BUDGET,
  });
}

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const CONTENT_ID = "22222222-2222-4222-8222-222222222222";

function run(over: Partial<FormatRun>): FormatRun {
  return formatRunSchema.parse({
    id: RUN_ID,
    formatId: "on-a-walk",
    status: "queued",
    topic: null,
    overlayText: "x",
    videoPrompt: "x",
    model: T2V.id,
    durationSeconds: 5,
    estimate: { usd: 0.35, source: "provider", basis: "x", sourceUrl: null },
    contentId: null,
    clip: null,
    error: null,
    createdAt: "2026-09-24T12:00:00.000Z",
    updatedAt: "2026-09-24T12:00:00.000Z",
    ...over,
  });
}

type Call = { path: string; options: ApiRequestOptions<unknown> };

function server(opts: { configured?: boolean; fits?: boolean } = {}) {
  const calls: Call[] = [];
  const state = { run: run({ status: "generating" }) };
  requestMock.mockImplementation(((
    path: string,
    options: ApiRequestOptions<unknown> = {},
  ) => {
    calls.push({ path, options });
    if (path === "/ai-studio/formats") {
      return Promise.resolve(view(opts.configured ?? true));
    }
    if (path === "/ai-studio/formats/on-a-walk/estimate") {
      return Promise.resolve(
        formatRunEstimateSchema.parse({
          provider: "higgsfield",
          model: T2V.id,
          durationSeconds: 5,
          videoPrompt: "x",
          estimate: { usd: 0.35, source: "provider", basis: "x", sourceUrl: null },
          budget: BUDGET,
          fits: opts.fits ?? true,
        }),
      );
    }
    if (path === "/ai-studio/formats/on-a-walk/runs") return Promise.resolve(state.run);
    if (path === `/ai-studio/format-runs/${RUN_ID}`) return Promise.resolve(state.run);
    if (path === "/budget") return Promise.resolve(BUDGET);
    return Promise.reject(new Error(`ruta no esperada en el test: ${path}`));
  }) as typeof apiRequest);
  return { calls, state };
}

function renderBar() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  return {
    user: userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) }),
    ...render(<CreatePromptBar />, { wrapper }),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  requestMock.mockReset();
  push.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function formatOptions(): Promise<{ text: string | null; disabled: boolean }[]> {
  const format = screen.getByRole("combobox", { name: "Format" });
  await within(format).findByText(/On a Walk/);
  return within(format)
    .getAllByRole("option")
    .map((o) => ({ text: o.textContent, disabled: (o as HTMLOptionElement).disabled }));
}

describe("Create from prompt · formatos IA", () => {
  it("suma sólo los disponibles; sin modelo de video, deshabilitados con el motivo", async () => {
    server({ configured: false });
    renderBar();
    const options = await formatOptions();
    // Sprint 9 (P): «Reel» ocupa el lugar 6; los formatos IA vienen después.
    expect(options.slice(6)).toEqual([
      { text: "On a Walk · needs a video model", disabled: true },
    ]);
    expect(options.some((o) => o.text?.includes("News Anchor"))).toBe(false);
  });

  it("estima, confirma con el precio, arranca con source=blitz y al terminar ofrece el editor", async () => {
    const { calls, state } = server();
    const { user } = renderBar();
    await formatOptions();

    await user.type(
      screen.getByRole("textbox", { name: "What should it be about?" }),
      "POV: your coffee is finally hot",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Format" }),
      "gen:on-a-walk",
    );
    expect(screen.getByRole("combobox", { name: "How many" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Create" }));

    // Primero el precio; nada arrancó todavía.
    expect(await screen.findByText(/This clip costs about \$0\.35/)).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith("/runs"))).toHaveLength(0);
    expect(calls.filter((c) => c.path.startsWith("/blitz"))).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Generate video" }));
    const start = calls.find((c) => c.path === "/ai-studio/formats/on-a-walk/runs");
    expect(start?.options).toMatchObject({
      method: "POST",
      query: { source: "blitz" },
      body: {
        overlayText: "POV: your coffee is finally hot",
        topic: "POV: your coffee is finally hot",
      },
    });
    expect(await screen.findByTestId("prompt-progress")).toHaveTextContent(
      "Generating the clip",
    );

    state.run = run({ status: "ready", contentId: CONTENT_ID });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
    });

    const ready = await screen.findAllByText("Your video is ready in your Library.");
    expect(ready.length).toBeGreaterThanOrEqual(1);
    const link = screen.getByRole("link", { name: "Open in editor" });
    expect(link.getAttribute("href")).toContain(CONTENT_ID);
    // El toast lleva la misma acción.
    const toastAction = screen.getAllByRole("button", { name: "Open in editor" }).at(0);
    await user.click(toastAction as HTMLElement);
    expect(push).toHaveBeenCalledWith(expect.stringContaining(CONTENT_ID));
  });

  it("si no entra en el presupuesto, no ofrece generar", async () => {
    const { calls } = server({ fits: false });
    const { user } = renderBar();
    await formatOptions();
    await user.type(
      screen.getByRole("textbox", { name: "What should it be about?" }),
      "too expensive",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Format" }),
      "gen:on-a-walk",
    );
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText(/Over this month's budget/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate video" })).toBeNull();
    expect(calls.filter((c) => c.path.endsWith("/runs"))).toHaveLength(0);
  });

  it("si el catálogo no carga, el selector queda con los cuatro de siempre", async () => {
    requestMock.mockRejectedValue(new Error("caído"));
    renderBar();
    const format = screen.getByRole("combobox", { name: "Format" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    // Los cuatro de siempre + «Any» + «Reel» (sprint 9).
    expect(within(format).getAllByRole("option")).toHaveLength(6);
  });
});
