/**
 * `GenerativeFormatStudio` (sprint 7, `P4-FORMAT-001`) contra un `apiRequest`
 * falso: formato bloqueado (con el motivo), sin modelo de video, el costo
 * **antes** de generar, el pedido que sale y la corrida hasta «Open in editor».
 */
import {
  formatRunSchema,
  generativeFormatsViewSchema,
  type FormatRun,
  type GenerativeFormatsView,
} from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerativeFormatStudio } from "./GenerativeFormatStudio";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
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
  aspectRatios: ["16:9", "9:16", "1:1"],
  aspectFromImage: false,
  counts: [1],
  durationsSeconds: [5, 10],
  promptRequired: true,
  imageInput: "none",
  maxReferenceImages: 0,
  docsUrl: "https://docs.higgsfield.ai/docs/models/kling-2-6/pro-text-to-video",
  listPrice: null,
} as const;

function view(configured = true): GenerativeFormatsView {
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
        description:
          "A news anchor breaks your customer's problem as tonight's top story",
        status: "blocked",
        reason: "needs_voice",
        why: "Needs a person speaking a script with a synced voice.",
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
    overlayText: "Stop scrolling",
    videoPrompt: "Vertical handheld selfie video…",
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

function server(opts: { configured?: boolean; runs?: FormatRun[] } = {}): Call[] {
  const calls: Call[] = [];
  const runs = [...(opts.runs ?? [run({ status: "ready", contentId: CONTENT_ID })])];
  requestMock.mockImplementation(
    (path: string, options: ApiRequestOptions<unknown> = {}) => {
      calls.push({ path, options });
      if (path === "/ai-studio/formats") return Promise.resolve(view(opts.configured));
      if (path.endsWith("/estimate")) {
        return Promise.resolve({
          provider: "higgsfield",
          model: T2V.id,
          durationSeconds: 5,
          videoPrompt: "…",
          estimate: { usd: 0.35, source: "provider", basis: "5 s", sourceUrl: null },
          budget: BUDGET,
          fits: true,
        });
      }
      if (path.endsWith("/runs")) return Promise.resolve(run({}));
      if (path.startsWith("/ai-studio/format-runs/")) {
        return Promise.resolve(runs.length > 1 ? runs.shift() : runs[0]);
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

describe("GenerativeFormatStudio", () => {
  it("un formato bloqueado explica por qué, sin formulario", async () => {
    server();
    render(<GenerativeFormatStudio formatId="news-anchor" />, { wrapper });
    expect(await screen.findByText("Not available yet")).toBeTruthy();
    expect(screen.getByText(/synced voice/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /generate/i })).toBeNull();
  });

  it("sin modelo de texto a video manda a Settings → Models", async () => {
    server({ configured: false });
    render(<GenerativeFormatStudio formatId="on-a-walk" />, { wrapper });
    expect(await screen.findByText("Set up a video model first")).toBeTruthy();
  });

  it("costo antes de generar, el pedido con el texto, y la corrida hasta el editor", async () => {
    const calls = server();
    render(<GenerativeFormatStudio formatId="on-a-walk" />, { wrapper });
    const text = await screen.findByLabelText("Text on the video");
    fireEvent.change(text, { target: { value: "Stop scrolling" } });
    await waitFor(
      () => {
        expect(screen.getByTestId("format-estimate").textContent).toContain("$0.35");
      },
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === "/ai-studio/formats/on-a-walk/runs")).toBe(
        true,
      );
    });
    const post = calls.find((c) => c.path === "/ai-studio/formats/on-a-walk/runs");
    expect(post?.options.body).toMatchObject({
      overlayText: "Stop scrolling",
      model: T2V.id,
      durationSeconds: 5,
      includeBrand: true,
    });
    const link = await screen.findByRole("link", { name: "Open in editor" });
    expect(link.getAttribute("href")).toBe(`/library/${CONTENT_ID}/edit`);
  });
});
