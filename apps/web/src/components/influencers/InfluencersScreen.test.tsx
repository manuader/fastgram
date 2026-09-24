/**
 * Influencers (`PU-LATER-004`) contra un `apiRequest`/`apiList` falso: los
 * estados de la lista (cargando, sin Higgsfield, vacía, con personajes y su
 * avance), el wizard de 3 pasos con el pedido que manda, y la galería del
 * detalle con el costo visible antes de generar.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfluencersScreen } from "./InfluencersScreen";
import { InfluencerDetailScreen } from "./InfluencerDetailScreen";

import type * as ApiClient from "@/lib/api/client";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/influencers",
}));
vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiList: vi.fn(),
}));

import { apiList, apiRequest, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);
const listMock = vi.mocked(apiList);

const BUDGET = {
  month: "2026-09",
  budgetUsd: 30,
  budgetSource: "default",
  chargedUsd: 1,
  reservedUsd: 0,
  remainingUsd: 29,
  generations: 1,
} as const;

const SETUP = {
  configured: true,
  provider: "higgsfield",
  references: { min: 4, max: 20 },
  trainingCost: null,
  canCreate: true,
  budget: BUDGET,
};

const ID = "0b7f3c1a-2c4e-4f5a-8b6d-9e0f1a2b3c4d";
const influencer = (over: Record<string, unknown> = {}) => ({
  _id: ID,
  name: "Emily",
  gender: "female",
  baseImageUrl: "http://localhost:9000/fastgram/media/a/ref-0.png",
  status: "ready",
  progress: 100,
  isActive: true,
  referenceMediaIds: [],
  createdAt: 1_790_000_000_000,
  updatedAt: 1_790_000_000_000,
  ...over,
});

const photo = (i: number) => ({
  mediaId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  mediaType: "image",
  filename: `ref-${String(i)}.png`,
  r2Url: `http://localhost:9000/fastgram/media/a/ref-${String(i)}.png`,
  status: "ready",
  sizeMb: 0.1,
  categories: [],
  origin: "manual_upload",
  uploadedAt: 1_790_000_000_000,
});

type Call = { path: string; options: ApiRequestOptions<unknown> };

function server(
  opts: {
    setup?: typeof SETUP | Error;
    list?: unknown[];
    one?: unknown;
    generations?: unknown[];
  } = {},
): Call[] {
  const calls: Call[] = [];
  requestMock.mockImplementation((path: string, options = {}) => {
    calls.push({ path, options });
    const parse = <T,>(v: T): Promise<T> =>
      Promise.resolve(options.schema === undefined ? v : (options.schema.parse(v) as T));
    if (path === "/influencers/setup") {
      const s = opts.setup ?? SETUP;
      return s instanceof Error ? Promise.reject(s) : parse(s);
    }
    if (path === "/influencers" && options.method === "POST") {
      return parse(influencer({ status: "generating_variations", progress: 0 }));
    }
    if (path === "/influencers") return parse(opts.list ?? []);
    if (path === `/influencers/${ID}`) return parse(opts.one ?? influencer());
    if (path === `/influencers/${ID}/generations`) return parse(opts.generations ?? []);
    if (path === `/influencers/${ID}/images/estimate`) {
      return parse({
        model: "higgsfield-ai/soul/v2/standard",
        estimate: {
          usd: 0.03,
          source: "provider",
          basis: "Higgsfield estimate: 0.48 credits",
          sourceUrl: null,
        },
        budget: BUDGET,
        fits: true,
      });
    }
    if (path === `/influencers/${ID}/images`) {
      return parse({
        id: "55555555-5555-4555-8555-555555555555",
        influencerId: ID,
        status: "queued",
        model: "higgsfield-ai/soul/v2/standard",
        prompt: "at the gym",
        aspectRatio: "9:16",
        count: 1,
        estimate: { usd: 0.03, source: "provider", basis: "x", sourceUrl: null },
        media: [],
        error: null,
        createdAt: "2026-09-24T12:00:00.000Z",
        updatedAt: "2026-09-24T12:00:00.000Z",
      });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
  listMock.mockResolvedValue({
    items: Array.from({ length: 5 }, (_, i) => photo(i)) as never,
    cursor: null,
    hasMore: false,
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
  listMock.mockReset();
  push.mockReset();
});

describe("InfluencersScreen", () => {
  it("sin Higgsfield: explica y lleva a Settings → Models, sin botón de crear", async () => {
    server({
      setup: { ...SETUP, configured: false, provider: null, canCreate: false } as never,
    });
    render(<InfluencersScreen />, { wrapper });
    expect(await screen.findByText("Influencers need Higgsfield")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Settings → Models" })).toHaveAttribute(
      "href",
      "/settings/models",
    );
    expect(screen.queryByRole("button", { name: /New influencer/ })).toBeNull();
  });

  it("vacía, y con personajes: estado, avance y rasgos", async () => {
    server({
      list: [
        influencer(),
        influencer({
          _id: "11111111-1111-4111-8111-111111111111",
          name: "Tom",
          gender: undefined,
          status: "training",
          progress: 75,
        }),
      ],
    });
    render(<InfluencersScreen />, { wrapper });
    const cards = await screen.findAllByTestId("influencer-card");
    expect(cards).toHaveLength(2);
    expect(within(cards[0] as HTMLElement).getByText("Active")).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "75",
    );
  });

  it("wizard: nombre → 4 fotos → confirmar manda el pedido con Idempotency-Key", async () => {
    const calls = server();
    render(<InfluencersScreen />, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: /New influencer/ }));
    expect(screen.getByText("New influencer (1/3)")).toBeInTheDocument();
    const next = () => screen.getByRole("button", { name: "Next" });
    expect(next()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Emily" } });
    fireEvent.click(next());

    expect(await screen.findByText("0 selected")).toBeInTheDocument();
    const photos = await screen.findAllByRole("button", { pressed: false });
    for (const b of photos.slice(0, 3)) fireEvent.click(b);
    expect(next()).toBeDisabled();
    fireEvent.click(photos[3] as HTMLElement);
    expect(screen.getByText("4 selected")).toBeInTheDocument();
    fireEvent.click(next());

    expect(screen.getByText(/Not published by Higgsfield/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create influencer" }));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/influencers/${ID}`);
    });
    const post = calls.find(
      (c) => c.path === "/influencers" && c.options.method === "POST",
    );
    expect(post?.options.body).toEqual({
      name: "Emily",
      referenceMediaIds: [0, 1, 2, 3].map((i) => photo(i).mediaId),
    });
    expect(typeof post?.options.idempotencyKey).toBe("string");
  });
});

describe("InfluencerDetailScreen", () => {
  it("entrenando: muestra el avance y no la barra de generación", async () => {
    server({ one: influencer({ status: "training", progress: 50 }) });
    render(<InfluencerDetailScreen influencerId={ID} />, { wrapper });
    expect(await screen.findByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
  });

  it("fallido: el motivo con su código estable", async () => {
    server({
      one: influencer({
        status: "failed",
        failure: { code: "training_failed", message: "No face detected" },
      }),
    });
    render(<InfluencerDetailScreen influencerId={ID} />, { wrapper });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Higgsfield couldn't train this character. No face detected",
    );
  });

  it("activo: el costo se ve antes de generar y el pedido sale con el prompt", async () => {
    const calls = server();
    render(<InfluencerDetailScreen influencerId={ID} />, { wrapper });
    expect(
      await screen.findByText(
        "No images yet. Describe a scene below to generate the first ones.",
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("e.g. her at the beach"), {
      target: { value: "at the gym" },
    });
    await waitFor(
      () => {
        expect(screen.getByTestId("influencer-estimate")).toHaveTextContent("$0.03");
      },
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByText("Generating. The images show up here when they're ready.");
    const post = calls.find((c) => c.path === `/influencers/${ID}/images`);
    expect(post?.options.body).toEqual({
      prompt: "at the gym",
      aspectRatio: "9:16",
      count: 1,
    });
  });
});
