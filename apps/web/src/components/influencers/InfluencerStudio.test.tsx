/**
 * Sprint 7 (agente G) — influencers: Configuration con auto-guardado,
 * «Animate this image», el cuerpo de crear con base generada / regenerar, y
 * los templates. Contra un `apiRequest` falso.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INITIAL_WIZARD } from "@/lib/influencers/form";
import { requestWithPicked } from "@/components/ai-studio/Composer";
import { AnimateDialog } from "./AnimateDialog";
import { ConfigurationPanel, toggleAccount } from "./ConfigurationPanel";
import { createBody } from "./NewInfluencerWizard";
import { fillTemplate, templateId } from "./TemplatesDialog";

import type * as ApiClient from "@/lib/api/client";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
  usePathname: () => "/influencers",
}));
vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

import { apiRequest, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

const INF = "0b7f3c1a-2c4e-4f5a-8b6d-9e0f1a2b3c4d";
const ANGLE = "5d6e7f80-91a2-4b3c-8d4e-5f6a7b8c9d0e";
const CONN = "7f0c7d2e-7a52-4a38-9d0f-2d4a3b6f1c11";
const MEDIA = "3eb3ad49-775d-40bd-b5e5-38b105108780";
const BUDGET = {
  month: "2026-09",
  budgetUsd: 30,
  budgetSource: "default",
  chargedUsd: 1,
  reservedUsd: 0,
  remainingUsd: 29,
  generations: 1,
} as const;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  requestMock.mockReset();
});

type Call = { path: string; options: ApiRequestOptions<unknown> };

describe("ConfigurationPanel (FR-083)", () => {
  it("marcar un ángulo guarda solo y dice «All changes saved»", async () => {
    const calls: Call[] = [];
    let angleIds: string[] = [];
    requestMock.mockImplementation(
      (path: string, options: ApiRequestOptions<unknown> = {}) => {
        calls.push({ path, options });
        if (options.method === "PUT") {
          angleIds = (options.body as { angleIds: string[] }).angleIds;
        }
        return Promise.resolve({
          config: {
            angleIds,
            publishingAccounts: [],
            slideshowSetIds: [],
            videoSetIds: [],
          },
          options: {
            angles: [{ id: ANGLE, title: "Freelancers who hate invoices" }],
            accounts: [
              {
                connectionId: CONN,
                platform: "tiktok",
                username: "@acme",
                displayName: null,
              },
            ],
            sets: [],
          },
          updatedAt: null,
        });
      },
    );
    render(<ConfigurationPanel influencerId={INF} />, { wrapper });
    fireEvent.click(await screen.findByLabelText("Freelancers who hate invoices"));
    await waitFor(() => {
      expect(calls.some((c) => c.options.method === "PUT")).toBe(true);
    });
    const put = calls.find((c) => c.options.method === "PUT");
    expect(put?.path).toBe(`/influencers/${INF}/config`);
    expect(put?.options.body).toEqual({ angleIds: [ANGLE] });
    expect(await screen.findByText("All changes saved")).toBeTruthy();
    expect(
      screen.getAllByText("No sets yet. Generating images or videos creates one."),
    ).toHaveLength(2);
  });

  it("una cuenta nueva entra activa; otra vez, se apaga", () => {
    const a = { connectionId: CONN, platform: "tiktok" };
    const on = toggleAccount([], a);
    expect(on).toEqual([{ ...a, enabled: true }]);
    expect(toggleAccount(on, a)).toEqual([{ ...a, enabled: false }]);
  });
});

describe("AnimateDialog (F-099)", () => {
  it("estima y manda el video con la imagen, el modelo y la duración", async () => {
    const calls: Call[] = [];
    requestMock.mockImplementation(
      (path: string, options: ApiRequestOptions<unknown> = {}) => {
        calls.push({ path, options });
        if (path.endsWith("/videos/estimate")) {
          return Promise.resolve({
            model: "kling-video/v2.6/pro/image-to-video",
            estimate: { usd: 0.7, source: "provider", basis: "5 s", sourceUrl: null },
            budget: BUDGET,
            fits: true,
          });
        }
        return Promise.resolve({
          id: "11111111-1111-4111-8111-111111111111",
          influencerId: INF,
          kind: "video",
          durationSeconds: 5,
          sourceMediaId: MEDIA,
          status: "queued",
          model: "kling-video/v2.6/pro/image-to-video",
          prompt: "",
          aspectRatio: "9:16",
          count: 1,
          estimate: { usd: 0.7, source: "provider", basis: "5 s", sourceUrl: null },
          media: [],
          error: null,
          createdAt: "2026-09-24T12:00:00.000Z",
          updatedAt: "2026-09-24T12:00:00.000Z",
        });
      },
    );
    const started = vi.fn();
    render(
      <AnimateDialog
        influencerId={INF}
        source={{ mediaId: MEDIA, url: "http://localhost/x.png" }}
        models={[
          {
            id: "kling-video/v2.6/pro/image-to-video",
            label: "Kling 2.6 Pro · image to video",
            kind: "video",
            aspectRatios: ["9:16"],
            aspectFromImage: false,
            counts: [1],
            durationsSeconds: [5, 10],
            promptRequired: true,
            imageInput: "required",
            maxReferenceImages: 0,
            docsUrl: "https://docs.higgsfield.ai",
            listPrice: null,
          },
        ]}
        onClose={vi.fn()}
        onStarted={started}
      />,
      { wrapper },
    );
    await waitFor(() => {
      expect(screen.getByTestId("influencer-video-estimate").textContent).toContain(
        "$0.70",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));
    await waitFor(() => {
      expect(started).toHaveBeenCalled();
    });
    const post = calls.find((c) => c.path === `/influencers/${INF}/videos`);
    expect(post?.options.body).toEqual({
      sourceMediaId: MEDIA,
      model: "kling-video/v2.6/pro/image-to-video",
      durationSeconds: 5,
      prompt: "",
    });
  });
});

describe("crear: base generada y regenerar (F-091, F-093)", () => {
  const form = { ...INITIAL_WIZARD, name: "Ella", gender: "female" as const, age: 27 };
  it("con la base generada no viajan fotos y sí la base; regenerar agrega de quién", () => {
    expect(createBody(form, "describe", MEDIA, INF)).toEqual({
      name: "Ella",
      gender: "female",
      age: 27,
      generatedBaseMediaId: MEDIA,
      regeneratedFromId: INF,
    });
  });
  it("con fotos, el cuerpo de siempre", () => {
    expect(
      createBody({ ...form, referenceMediaIds: [MEDIA] }, "photos", null, undefined),
    ).toEqual({
      name: "Ella",
      gender: "female",
      age: 27,
      referenceMediaIds: [MEDIA],
    });
  });
});

describe("templates y AI Studio", () => {
  it("{subject} según el género; ids únicos", () => {
    expect(fillTemplate("{subject} at the gym", "female")).toBe("her at the gym");
    expect(fillTemplate("{subject} at the gym", undefined)).toBe("them at the gym");
    expect(templateId("Beach Day!", new Set(["beach-day"]))).toBe("beach-day-2");
  });

  it("una imagen del Media Bank viaja como imageMediaId, no como URL", () => {
    const spec = {
      id: "i2v",
      label: "i2v",
      kind: "video" as const,
      aspectRatios: ["9:16" as const],
      aspectFromImage: false,
      counts: [1],
      durationsSeconds: [5],
      promptRequired: true,
      imageInput: "required" as const,
      maxReferenceImages: 0,
      docsUrl: "https://x",
      listPrice: null,
    };
    const form = {
      kind: "video" as const,
      model: "i2v",
      prompt: "zoom",
      aspectRatio: "9:16" as const,
      count: 1,
      durationSeconds: 5,
      imageUrl: "",
    };
    expect(requestWithPicked(form, spec, null)).toBeNull();
    const body = requestWithPicked(form, spec, {
      mediaId: MEDIA,
      url: "http://minio/x.png",
    });
    expect(body).toMatchObject({ imageMediaId: MEDIA, prompt: "zoom" });
    expect(body).not.toHaveProperty("imageUrl");
  });
});
