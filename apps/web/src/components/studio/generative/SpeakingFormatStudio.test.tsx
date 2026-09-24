/**
 * Formatos con voz (sprint 8, agente L) contra un `apiRequest` falso: sin fal
 * configurado, la guía de largo de `AI-010` (mensaje literal), el costo antes
 * de generar, el pedido que sale, «Generate script», el talking head del
 * detalle del modelo (`P4-INFL-011`) y el cuerpo del character swap.
 */
import {
  generativeFormatsViewSchema,
  speakingOptionsSchema,
  speakingRunSchema,
  type SpeakingOptions,
  type SpeakingRun,
} from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerativeFormatStudio } from "./GenerativeFormatStudio";
import { toSwapRequest } from "./CharacterSwapStudio";
import { scriptHint, toSpeakingRequest } from "./SpeakingFormatStudio";
import { TalkingHeadPanel } from "./TalkingHeadPanel";

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

const CHARACTER = "cm-ana";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const CONTENT_ID = "22222222-2222-4222-8222-222222222222";

function formatsView() {
  return generativeFormatsViewSchema.parse({
    formats: [
      {
        id: "news-anchor",
        label: "AI News Anchor",
        description:
          "A news anchor breaks your customer's problem as tonight's top story",
        status: "speaking",
        reason: null,
        why: null,
        narrationMissing: false,
        preferredDurationSeconds: 15,
      },
    ],
    video: {
      kind: "video",
      configured: false,
      provider: null,
      defaultModel: null,
      models: [],
    },
    budget: BUDGET,
  });
}

function options(configured = true): SpeakingOptions {
  const task = (models: unknown[], defaultModel: string) =>
    configured
      ? { configured: true, provider: "fal", defaultModel, models }
      : { configured: false, provider: null, defaultModel: null, models: [] };
  return speakingOptionsSchema.parse({
    speech: task(
      [
        {
          id: "fal-ai/elevenlabs/tts/eleven-v3",
          label: "ElevenLabs Eleven v3",
          maxChars: 5000,
          voices: ["Rachel", "Aria"],
          defaultVoice: "Rachel",
          languageCode: true,
          docsUrl: "https://fal.ai",
          listPrice: null,
        },
      ],
      "fal-ai/elevenlabs/tts/eleven-v3",
    ),
    avatar: task(
      [
        {
          id: "fal-ai/bytedance/omnihuman/v1.5",
          label: "OmniHuman v1.5",
          resolutions: [{ id: "720p", maxAudioSeconds: 60 }],
          promptSupported: true,
          docsUrl: "https://fal.ai",
          listPrice: null,
        },
      ],
      "fal-ai/bytedance/omnihuman/v1.5",
    ),
    swap: task([], "x"),
    characters: [
      {
        id: CHARACTER,
        name: "Ana",
        portraitUrl: "http://localhost:9000/fastgram/ana.png",
        status: "ready",
        voice: {
          provider: "fal",
          model: "fal-ai/elevenlabs/tts/eleven-v3",
          voiceId: "Aria",
        },
      },
    ],
    formats: [
      {
        id: "news-anchor",
        layout: "full",
        portraitHint: null,
        demoHint: null,
        preferredDurationSeconds: 15,
      },
      {
        id: "talking-head-ugc",
        layout: "full",
        portraitHint: null,
        demoHint: null,
        preferredDurationSeconds: 15,
      },
    ],
    durations: [5, 10, 15, 20, 30, 45, 60],
    wordsPerSecond: { min: 2, max: 3 },
    swapMaxSourceSeconds: 30,
    scriptWriter: true,
    budget: BUDGET,
  });
}

function run(over: Partial<SpeakingRun> = {}): SpeakingRun {
  return speakingRunSchema.parse({
    id: RUN_ID,
    kind: "speaking",
    formatId: "news-anchor",
    stage: "ready",
    source: "studio",
    characterModelId: CHARACTER,
    script: "x",
    caption: "x",
    languageCode: "en",
    durationSeconds: 5,
    voice: { model: "m", voiceId: "Aria" },
    videoModel: "v",
    resolution: "720p",
    estimate: { voiceUsd: 0.01, videoUsd: 0.96, usd: 0.97, basis: "b" },
    voiceUrl: null,
    video: null,
    contentId: CONTENT_ID,
    error: null,
    createdAt: "2026-09-24T12:00:00.000Z",
    updatedAt: "2026-09-24T12:00:00.000Z",
    ...over,
  });
}

type Call = { path: string; options: ApiRequestOptions<unknown> };

function server(opts: { configured?: boolean } = {}): Call[] {
  const calls: Call[] = [];
  requestMock.mockImplementation((path: string, o: ApiRequestOptions<unknown> = {}) => {
    calls.push({ path, options: o });
    if (path === "/ai-studio/formats") return Promise.resolve(formatsView());
    if (path === "/ai-studio/speaking/options") {
      return Promise.resolve(options(opts.configured ?? true));
    }
    if (path.endsWith("/estimate")) {
      return Promise.resolve({
        provider: "fal",
        speechModel: "fal-ai/elevenlabs/tts/eleven-v3",
        videoModel: "fal-ai/bytedance/omnihuman/v1.5",
        resolution: "720p",
        voice: {
          model: "tts",
          estimate: { usd: 0.01, source: "price_list", basis: "chars", sourceUrl: null },
        },
        video: {
          model: "avatar",
          estimate: { usd: 0.96, source: "price_list", basis: "6 s", sourceUrl: null },
        },
        usd: 0.97,
        videoSeconds: 6,
        guidance: null,
        budget: BUDGET,
        fits: true,
      });
    }
    if (path.endsWith("/script")) {
      return Promise.resolve({
        script: "Breaking news: invoices are late again.",
        guidance: { words: 6, min: 10, max: 15, level: "short", message: null },
      });
    }
    if (path.includes("/runs"))
      return Promise.resolve(run({ stage: "queued", contentId: null }));
    if (path.startsWith("/ai-studio/speaking-runs/")) return Promise.resolve(run());
    if (path === "/ai-studio/speaking-runs") return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected ${path}`));
  });
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

describe("guía de largo (AI-010)", () => {
  it("el mensaje literal del PRD para un guion vacío de 5 s", () => {
    expect(scriptHint("", 5).message).toBe(
      "0 words may be too short for 5s - Target 10-15 words",
    );
  });

  it("el cuerpo: modelo de la biblioteca o retrato, y caption apagado = null", () => {
    const base = {
      characterId: null,
      portrait: null,
      demo: null,
      script: "Hi there",
      durationSeconds: 5,
      languageCode: "en",
      voiceId: "",
      caption: true,
    };
    expect(toSpeakingRequest(base)).toBeNull();
    expect(
      toSpeakingRequest({
        ...base,
        portrait: { mediaId: "m1", url: "u" },
        caption: false,
      }),
    ).toEqual({
      script: "Hi there",
      durationSeconds: 5,
      languageCode: "en",
      caption: null,
      portraitMediaId: "m1",
    });
  });

  it("swap: hace falta el video y quién", () => {
    expect(toSwapRequest({ characterId: "c", portrait: null, source: null })).toBeNull();
    expect(
      toSwapRequest({
        characterId: "c",
        portrait: null,
        source: { mediaId: "v", url: "u" },
      }),
    ).toEqual({ sourceMediaId: "v", characterModelId: "c", caption: null });
  });
});

describe("formato con voz en /content/<id>", () => {
  it("sin fal configurado manda a Settings → Models", async () => {
    server({ configured: false });
    render(<GenerativeFormatStudio formatId="news-anchor" />, { wrapper });
    expect(await screen.findByText("Set up fal in Settings → Models")).toBeTruthy();
  });

  it("guion → costo → Generate con el modelo de la biblioteca → editor", async () => {
    const calls = server();
    render(<GenerativeFormatStudio formatId="news-anchor" />, { wrapper });
    const script = await screen.findByLabelText("Script");
    expect(screen.getByTestId("script-hint").textContent).toBe(
      "0 words may be too short for 15s - Target 30-45 words",
    );
    fireEvent.change(script, {
      target: { value: "Tonight's top story: late invoices." },
    });
    await waitFor(
      () => {
        expect(screen.getByTestId("speaking-estimate").textContent).toContain("$0.97");
      },
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === "/ai-studio/speaking/news-anchor/runs")).toBe(
        true,
      );
    });
    const post = calls.find((c) => c.path === "/ai-studio/speaking/news-anchor/runs");
    expect(post?.options.body).toEqual({
      script: "Tonight's top story: late invoices.",
      durationSeconds: 15,
      languageCode: "en",
      characterModelId: CHARACTER,
    });
    const link = await screen.findByRole("link", { name: "Open in editor" });
    expect(link.getAttribute("href")).toBe(`/library/${CONTENT_ID}/edit`);
  });

  it("«Generate script» llena el guion", async () => {
    const calls = server();
    render(<GenerativeFormatStudio formatId="news-anchor" />, { wrapper });
    await screen.findByLabelText("Script");
    fireEvent.change(screen.getByLabelText("Topic for a generated script (optional)"), {
      target: { value: "late invoices" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate script" }));
    await waitFor(() => {
      expect((screen.getByLabelText("Script") as HTMLTextAreaElement).value).toBe(
        "Breaking news: invoices are late again.",
      );
    });
    expect(calls.find((c) => c.path.endsWith("/script"))?.options.body).toEqual({
      durationSeconds: 15,
      languageCode: "en",
      topic: "late invoices",
    });
  });
});

describe("TalkingHeadPanel (P4-INFL-011)", () => {
  it("usa el modelo fijo y marca la corrida como del detalle del modelo", async () => {
    const calls = server();
    render(<TalkingHeadPanel characterModelId={CHARACTER} />, { wrapper });
    const script = await screen.findByLabelText("Script");
    expect(screen.queryByText("Who speaks")).toBeNull();
    fireEvent.change(script, {
      target: { value: "Hi, I'm Ana and this changed my mornings." },
    });
    await waitFor(
      () => {
        expect(screen.getByTestId("speaking-estimate").textContent).toContain("$0.97");
      },
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.path === "/ai-studio/speaking/talking-head-ugc/runs?source=influencer",
        ),
      ).toBe(true);
    });
    const post = calls.find((c) => c.path.includes("talking-head-ugc/runs"));
    expect(post?.options.body).toMatchObject({ characterModelId: CHARACTER });
    expect(
      await screen.findByText("No talking head videos with this model yet."),
    ).toBeTruthy();
  });
});
