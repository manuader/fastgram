/**
 * Biblioteca de modelos (sprint 8, K) contra un `apiRequest` falso: los
 * estados de la lista (sin Higgsfield, vacía, con modelos y sus marcas), el
 * detalle (asignar marcas, voz, UGC con la marca explícita) y los pedidos que
 * arman las funciones puras.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as ApiClient from "@/lib/api/client";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/models",
}));
vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiSend: vi.fn(),
}));

const BRAND_A = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Acme" };
const BRAND_B = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Bolt" };
vi.mock("@/components/brands/WorkspaceProvider", () => ({
  useWorkspace: () => ({
    mode: "personal",
    isPersonal: true,
    workspaces: { data: [BRAND_A, BRAND_B], isPending: false },
    active: BRAND_A,
    selectedId: BRAND_A.id,
    switchTo: () => {},
    forget: () => {},
  }),
}));

import { apiRequest, type ApiRequestOptions } from "@/lib/api/client";
import { importRequest } from "./ImportModelDialog";
import { detailsPatch } from "./ModelSettings";
import { ModelDetailScreen } from "./ModelDetailScreen";
import { ModelsScreen, brandNames } from "./ModelsScreen";
import { slideCount, ugcImageRequest } from "./UgcPanel";

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
const SETUP = {
  configured: true,
  canTrain: true,
  references: { min: 4, max: 20 },
  budget: BUDGET,
};
const ID = "0b7f3c1a-2c4e-4f5a-8b6d-9e0f1a2b3c4d";
const model = (over: Record<string, unknown> = {}) => ({
  id: ID,
  name: "Mia",
  portraitUrl: "http://localhost:9000/fastgram/models/o/m/portrait.png",
  status: "ready",
  voice: null,
  brandIds: [BRAND_A.id],
  progress: 100,
  source: "soul_id",
  notes: null,
  age: null,
  style: null,
  failure: null,
  createdAt: "2026-09-24T12:00:00.000Z",
  updatedAt: "2026-09-24T12:00:00.000Z",
  ...over,
});

type Call = { path: string; options: ApiRequestOptions<unknown> };

function server(opts: { setup?: unknown; list?: unknown[]; one?: unknown } = {}): Call[] {
  const calls: Call[] = [];
  requestMock.mockImplementation((path: string, options = {}) => {
    calls.push({ path, options });
    const parse = <T,>(v: T): Promise<T> =>
      Promise.resolve(options.schema === undefined ? v : (options.schema.parse(v) as T));
    if (path === "/character-models/setup") return parse(opts.setup ?? SETUP);
    if (path === "/character-models") return parse(opts.list ?? []);
    if (path === `/character-models/${ID}` && options.method === "PATCH") {
      return parse(model({ voice: (options.body as { voice?: unknown }).voice ?? null }));
    }
    if (path === `/character-models/${ID}`) return parse(opts.one ?? model());
    if (path === `/character-models/${ID}/brands`) {
      return parse(
        model({ brandIds: (options.body as { brandIds: string[] }).brandIds }),
      );
    }
    if (path === `/character-models/${ID}/ugc`) return parse([]);
    if (path === `/character-models/${ID}/ugc/estimate`) {
      return parse({
        model: "higgsfield-ai/soul/v2/standard",
        estimate: { usd: 0.03, source: "provider", basis: "x", sourceUrl: null },
        budget: BUDGET,
        fits: true,
      });
    }
    return Promise.reject(new Error(`sin doble para ${path}`));
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
  push.mockReset();
});

describe("funciones puras", () => {
  it("importRequest arma cada camino y devuelve null si falta algo", () => {
    const base = {
      name: " Mia ",
      brandId: BRAND_A.id,
      photos: ["1", "2", "3", "4"],
      soulId: "",
      portrait: null,
      influencerId: null,
    };
    expect(importRequest("photos", base)).toEqual({
      source: "photos",
      name: "Mia",
      fromBrandId: BRAND_A.id,
      referenceMediaIds: ["1", "2", "3", "4"],
    });
    expect(importRequest("photos", { ...base, photos: ["1"] })).toBeNull();
    expect(
      importRequest("soul_id", { ...base, soulId: "not-a-uuid", portrait: "p" }),
    ).toBeNull();
    expect(
      importRequest("soul_id", { ...base, soulId: ID, portrait: "p" }),
    ).toMatchObject({
      source: "soul_id",
      soulId: ID,
      portraitMediaId: "p",
    });
    expect(importRequest("influencer", { ...base, name: "", influencerId: "i" })).toEqual(
      {
        source: "influencer",
        fromBrandId: BRAND_A.id,
        influencerId: "i",
      },
    );
    expect(importRequest("photos", { ...base, brandId: null })).toBeNull();
  });

  it("detailsPatch manda sólo lo que cambió y rechaza una edad fuera de rango", () => {
    const m = { name: "Mia", age: null, style: null, notes: null };
    expect(detailsPatch(m, { name: "Mia", age: "", style: "", notes: "" })).toBeNull();
    expect(
      detailsPatch(m, { name: "Mia", age: "27", style: " street ", notes: "" }),
    ).toEqual({
      age: 27,
      style: "street",
    });
    expect(detailsPatch(m, { name: "Mia", age: "12", style: "", notes: "" })).toBeNull();
  });

  it("ugcImageRequest y slideCount", () => {
    expect(ugcImageRequest(null, "x", 1)).toBeNull();
    expect(ugcImageRequest(BRAND_A.id, "  ", 1)).toBeNull();
    expect(ugcImageRequest(BRAND_A.id, " selfie ", 4)).toEqual({
      brandId: BRAND_A.id,
      prompt: "selfie",
      aspectRatio: "9:16",
      count: 4,
    });
    expect(slideCount("image", 2)).toBe(3);
    expect(slideCount("video", 2)).toBe(1);
  });

  it("brandNames respeta el orden del selector", () => {
    expect(brandNames([BRAND_B.id, BRAND_A.id], [BRAND_A, BRAND_B])).toEqual([
      "Acme",
      "Bolt",
    ]);
  });
});

describe("ModelsScreen", () => {
  it("sin Higgsfield: lleva a Settings → Models y no ofrece importar", async () => {
    server({ setup: { ...SETUP, configured: false, canTrain: false } });
    render(<ModelsScreen />, { wrapper });
    expect(await screen.findByText("Set up Higgsfield first")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Import model" })).toBeNull();
  });

  it("vacía: dice cómo importar", async () => {
    server();
    render(<ModelsScreen />, { wrapper });
    expect(await screen.findByText("No models yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import model" })).toBeTruthy();
  });

  it("con modelos: retrato, estado y marcas asignadas", async () => {
    server({ list: [model({ brandIds: [BRAND_A.id, BRAND_B.id] })] });
    render(<ModelsScreen />, { wrapper });
    const card = await screen.findByTestId("model-card");
    expect(card.textContent).toContain("Mia");
    expect(card.textContent).toContain("In Acme, Bolt");
  });
});

describe("ModelDetailScreen", () => {
  it("asignar marcas manda la lista completa", async () => {
    const calls = server();
    render(<ModelDetailScreen modelId={ID} />, { wrapper });
    fireEvent.click(await screen.findByLabelText("Bolt"));
    fireEvent.click(screen.getByRole("button", { name: "Save brands" }));
    await waitFor(() => {
      const put = calls.find((c) => c.path === `/character-models/${ID}/brands`);
      expect(put?.options.body).toEqual({ brandIds: [BRAND_A.id, BRAND_B.id] });
    });
  });

  it("guardar la voz manda proveedor fal, modelo y voz", async () => {
    const calls = server();
    render(<ModelDetailScreen modelId={ID} />, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Save voice" }));
    await waitFor(() => {
      const patch = calls.find(
        (c) => c.path === `/character-models/${ID}` && c.options.method === "PATCH",
      );
      expect(patch?.options.body).toEqual({
        voice: {
          provider: "fal",
          model: "fal-ai/elevenlabs/tts/eleven-v3",
          voiceId: "Rachel",
        },
      });
    });
  });

  it("UGC: el pedido lleva la marca explícita (no la activa del header)", async () => {
    const calls = server({ one: model({ brandIds: [BRAND_B.id] }) });
    render(<ModelDetailScreen modelId={ID} />, { wrapper });
    expect(await screen.findByText("Generate UGC for Bolt")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Scene"), {
      target: { value: "selfie with the bottle" },
    });
    await waitFor(() => {
      const est = calls.find((c) => c.path === `/character-models/${ID}/ugc/estimate`);
      expect(est?.options.body).toMatchObject({
        brandId: BRAND_B.id,
        prompt: "selfie with the bottle",
      });
    });
  });

  it("entrenando: muestra el avance y no deja asignar", async () => {
    server({ one: model({ status: "training", progress: 50, brandIds: [] }) });
    render(<ModelDetailScreen modelId={ID} />, { wrapper });
    expect(await screen.findByText(/Training the model on Higgsfield… 50%/)).toBeTruthy();
    expect(
      screen.getByText("You can assign the model once training is done."),
    ).toBeTruthy();
  });
});
