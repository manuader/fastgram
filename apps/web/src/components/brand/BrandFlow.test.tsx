/**
 * Sprint 7, segunda tanda (H): los sub-pasos reales del análisis
 * (`P1-ONB-005`) y la oferta post-análisis (`P1-ONB-007`).
 */
import { brandSourceSchema, type BrandSource } from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { analysisSteps, phasesFor } from "./analysis-steps";
import { AnalysisSteps } from "./AnalysisSteps";
import { offerBody } from "./post-analysis-offer";
import { PostAnalysisOfferCard } from "./PostAnalysisOfferCard";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiSend: vi.fn(),
  apiList: vi.fn(),
}));

import { apiList, apiRequest, apiSend } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);
const sendMock = vi.mocked(apiSend);
const listMock = vi.mocked(apiList);

function source(overrides: Record<string, unknown> = {}): BrandSource {
  return brandSourceSchema.parse({
    _id: "src_1",
    sourceType: "instagram",
    handle: "mimarca",
    canonicalUrl: "https://www.instagram.com/mimarca",
    displayName: null,
    avatarUrl: null,
    isPrimary: true,
    acquisitionTier: "B_public_api",
    status: "analyzing",
    lastAnalysedAt: null,
    analysisCount: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
}

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  requestMock.mockReset();
  sendMock.mockReset();
  listMock.mockReset();
});

describe("analysisSteps — la fase real, sin inventar", () => {
  it("una web no tiene paso de link-in-bio; una red sí", () => {
    expect(phasesFor("website")).toEqual(["collecting", "synthesizing", "verifying"]);
    expect(phasesFor("instagram")).toEqual([
      "collecting",
      "reading_links",
      "synthesizing",
      "verifying",
    ]);
  });

  it("marca lo anterior hecho, la fase actual en curso y lo que sigue pendiente", () => {
    const steps = analysisSteps(source({ analysisPhase: "synthesizing" }));
    expect(steps?.map((s) => s.state)).toEqual(["done", "done", "current", "pending"]);
  });

  it("analizando sin fase: nada tildado (el worker no empezó)", () => {
    const steps = analysisSteps(source({ analysisPhase: null }));
    expect(steps?.every((s) => s.state === "pending")).toBe(true);
  });

  it("fuera de `analyzing` no hay lista", () => {
    expect(analysisSteps(source({ status: "ready" }))).toBeNull();
    expect(analysisSteps(source({ status: "pending" }))).toBeNull();
  });

  it("una fase que el tipo no recorre no tilda nada", () => {
    const steps = analysisSteps(
      source({ sourceType: "website", handle: null, analysisPhase: "reading_links" }),
    );
    expect(steps?.every((s) => s.state === "pending")).toBe(true);
  });
});

describe("AnalysisSteps", () => {
  it("dibuja los pasos con el actual marcado como `step`", () => {
    render(<AnalysisSteps source={source({ analysisPhase: "reading_links" })} />);
    const current = screen.getByText("Following the links in the bio").closest("li");
    expect(current?.getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("Reading the profile and recent posts")).toBeTruthy();
    expect(screen.queryByText("Starting the analysis…")).toBeNull();
  });

  it("sin fase dice que arranca", () => {
    render(<AnalysisSteps source={source({ analysisPhase: null })} />);
    expect(screen.getByText("Starting the analysis…")).toBeTruthy();
  });

  it("no dibuja nada con la fuente lista", () => {
    const { container } = render(<AnalysisSteps source={source({ status: "ready" })} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("PostAnalysisOfferCard — después del análisis, nunca antes", () => {
  it("el copy nombra el @handle de una red, y es genérico para una web", () => {
    expect(offerBody({ sourceType: "instagram", handle: "@mimarca" })).toBe(
      "Connect @mimarca to publish from it — and bring your photos and videos with you.",
    );
    expect(offerBody({ sourceType: "website", handle: "mimarca.com" })).toMatch(
      /^Connect your accounts/,
    );
  });

  it("con `show: false` (análisis sin terminar) no dibuja nada", async () => {
    requestMock.mockResolvedValue({ show: false, dismissed: false, source: null });
    const { container } = wrap(<PostAnalysisOfferCard />);
    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    expect(container.querySelector("[data-testid=post-analysis-offer]")).toBeNull();
  });

  it("ofrece conectar e importar; el import es opt-in (casilla desmarcada)", async () => {
    requestMock.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/connections/accounts"
          ? []
          : {
              show: true,
              dismissed: false,
              source: { sourceType: "instagram", handle: "mimarca" },
            },
      ),
    );
    wrap(<PostAnalysisOfferCard />);
    expect(await screen.findByText("Your brand profile is ready")).toBeTruthy();
    const connect = screen.getByRole("link", { name: "Connect accounts" });
    expect(connect.getAttribute("href")).toBe("/settings/connections");

    await userEvent.click(screen.getByRole("button", { name: "Import my posts" }));
    const consent = await screen.findByRole("checkbox");
    expect((consent as HTMLInputElement).checked).toBe(false);
  });

  it("`Not now` la descarta en el servidor y la esconde", async () => {
    requestMock.mockResolvedValue({
      show: true,
      dismissed: false,
      source: { sourceType: "website", handle: null },
    });
    sendMock.mockResolvedValue(undefined);
    wrap(<PostAnalysisOfferCard />);
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith("/brand/post-analysis-offer/dismiss", {
        method: "POST",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Your brand profile is ready")).toBeNull(),
    );
  });
});
