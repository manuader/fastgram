/**
 * Ads en la web — sprint 9 (R), `D-21`. El corte del mock es `apiRequest` /
 * `apiSend`. Lo que persigue:
 *
 *  - sin cuenta publicitaria, el estado vacío explica qué conectar (con la URL
 *    de redirect) y ofrece el modo demo;
 *  - la lista muestra estado y gasto contra tope;
 *  - la confirmación pide el preview al abrir, muestra el **máximo** y manda
 *    el token recién ahí;
 *  - el formulario no arma un pedido inválido (topes, A/B, destino);
 *  - el callback no deja pasar texto libre a la URL.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  ActivationPreview,
  AdCampaignSummary,
  AdConnection,
} from "@fastgram/contracts";
import { ToastProvider } from "@fastgram/ui";
import type * as ApiClient from "@/lib/api/client";
import { adsOutcomeFromApi, adsReturnPath } from "./callback";
import { CampaignList } from "./CampaignList";
import { ConfirmSpendDialog } from "./ConfirmSpendDialog";
import { ConnectAds } from "./ConnectionPanel";
import { draftToRequest, type WizardDraft } from "./CampaignWizard";
import { formatMinor, parseMajorToMinor } from "./money";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiList: vi.fn(),
  apiSend: vi.fn(),
}));

import { apiRequest } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

const ID = "0b8f3c1e-5d7a-4f2b-9c61-1a2b3c4d5e6f";

describe("sin cuenta publicitaria", () => {
  it("explica qué conectar, muestra el redirect y ofrece demo", () => {
    const connection: AdConnection = {
      status: "none",
      demo: false,
      adAccount: null,
      page: null,
      instagram: null,
      tokenExpiresAt: null,
      redirectUri: "https://tunnel.example/ads/connect/callback",
      appConfigured: false,
    };
    wrap(<ConnectAds connection={connection} />);
    expect(screen.getByText("Connect a Meta ad account")).toBeTruthy();
    expect(screen.getByText("https://tunnel.example/ads/connect/callback")).toBeTruthy();
    // Sin credenciales de la app de Meta no se puede empezar el login…
    expect(
      (
        screen.getByRole("button", {
          name: /Connect with Facebook/u,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    // …pero el modo demo sí.
    expect(
      (screen.getByRole("button", { name: "Try demo mode" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe("lista de campañas", () => {
  it("vacía → invita a crear", async () => {
    requestMock.mockResolvedValueOnce([]);
    wrap(<CampaignList />);
    expect(await screen.findByText("No campaigns yet")).toBeTruthy();
  });

  it("error → reintento", async () => {
    requestMock.mockRejectedValueOnce(new Error("boom"));
    wrap(<CampaignList />);
    expect(await screen.findByText("Couldn't load your campaigns.")).toBeTruthy();
  });

  it("muestra estado y gasto contra tope", async () => {
    const c: AdCampaignSummary = {
      id: ID,
      name: "Reel test",
      objective: "OUTCOME_TRAFFIC",
      status: "PAUSED",
      pausedReason: "daily_cap",
      isTest: true,
      currency: "USD",
      dailyCapMinor: 1_000,
      totalCapMinor: 3_000,
      spentTodayMinor: 1_050,
      spentTotalMinor: 1_050,
      endTime: null,
      hasExperiment: true,
      lastSyncedAt: null,
      lastSyncError: null,
      createdAt: 1,
    };
    requestMock.mockResolvedValueOnce([c]);
    wrap(<CampaignList />);
    expect(await screen.findByText("Reel test")).toBeTruthy();
    expect(screen.getByText("Paused · daily cap reached")).toBeTruthy();
    expect(screen.getByText("$10.50 / $10.00")).toBeTruthy();
    expect(screen.getByText("A/B")).toBeTruthy();
  });
});

describe("confirmación con el gasto máximo (D-21)", () => {
  const preview: ActivationPreview = {
    token: "tok-123",
    action: "activate",
    currency: "USD",
    dailyCapMinor: 1_000,
    totalCapMinor: 3_000,
    spentTotalMinor: 0,
    maxSpendMinor: 3_000,
    remainingTotalMinor: 3_000,
    daysLeft: null,
    bindingCap: "total",
    expiresAt: 2,
    guardIntervalMinutes: 30,
    demo: false,
  };

  it("pide el preview al abrir, muestra el máximo y confirma con su token", async () => {
    requestMock.mockResolvedValueOnce(preview);
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    wrap(
      <ConfirmSpendDialog
        campaignId={ID}
        open
        onClose={onClose}
        action="activate"
        onConfirm={onConfirm}
      />,
    );
    expect((await screen.findByTestId("max-spend")).textContent).toBe("$30.00");
    expect(requestMock).toHaveBeenCalledWith(
      `/ads/campaigns/${ID}/activation-preview`,
      expect.objectContaining({ method: "POST", body: { action: "activate" } }),
    );
    // Negativo primero: nada se confirmó sólo por abrir.
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirm up to $30.00" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("tok-123"));
    expect(onClose).toHaveBeenCalled();
  });

  it("si la API rechaza (preview vencido), lo dice y no cierra", async () => {
    requestMock.mockResolvedValueOnce(preview);
    const onConfirm = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("x"), { details: { reason: "preview_expired" } }),
      );
    const onClose = vi.fn();
    wrap(
      <ConfirmSpendDialog
        campaignId={ID}
        open
        onClose={onClose}
        action="activate"
        onConfirm={onConfirm}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /Confirm up to/u }));
    expect(
      await screen.findByText("The confirmation expired. Open it again."),
    ).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("formulario → pedido", () => {
  const base: WizardDraft = {
    name: "Reel test",
    objective: "OUTCOME_TRAFFIC",
    contentIds: ["a", "b"],
    message: "Hi",
    destinationUrl: "https://acme.test",
    countries: "ar, uy",
    ageMin: "18",
    ageMax: "34",
    daily: "10",
    total: "30.5",
    endDate: "",
    abTest: true,
    abMetric: "ctr",
    isTest: true,
  };

  it("arma el pedido en unidades mínimas", () => {
    const out = draftToRequest(base, "USD");
    expect(out).toEqual({
      ok: true,
      body: expect.objectContaining({
        dailyCapMinor: 1_000,
        totalCapMinor: 3_050,
        targeting: { countries: ["AR", "UY"], ageMin: 18, ageMax: 34 },
        abTest: { metric: "ctr" },
      }) as unknown,
    });
  });

  it("rechaza diario > total, A/B de una pieza y tráfico sin destino", () => {
    expect(draftToRequest({ ...base, daily: "40" }, "USD")).toEqual({
      ok: false,
      problem: "daily_exceeds_total",
    });
    expect(draftToRequest({ ...base, contentIds: ["a"] }, "USD")).toEqual({
      ok: false,
      problem: "ab_two_pieces",
    });
    expect(draftToRequest({ ...base, destinationUrl: "" }, "USD")).toEqual({
      ok: false,
      problem: "destination",
    });
    expect(draftToRequest({ ...base, countries: "Argentina" }, "USD")).toEqual({
      ok: false,
      problem: "countries",
    });
  });
});

describe("plata y callback", () => {
  it("JPY no tiene decimales; USD sí", () => {
    expect(parseMajorToMinor("1500", "JPY")).toBe(1500);
    expect(parseMajorToMinor("12.34", "USD")).toBe(1234);
    expect(parseMajorToMinor("0", "USD")).toBeNull();
    expect(formatMinor(1500, "JPY")).toBe("¥1,500");
  });

  it("el callback sólo lleva códigos a la URL", () => {
    expect(adsReturnPath(adsOutcomeFromApi(200, {}))).toBe("/ads?connect=pending");
    expect(
      adsReturnPath(
        adsOutcomeFromApi(400, {
          error: { code: "bad_request", details: { reason: "oauth_denied" } },
        }),
      ),
    ).toBe("/ads?connect=error&reason=oauth_denied");
    expect(adsReturnPath(adsOutcomeFromApi(400, { error: { code: "<script>" } }))).toBe(
      "/ads?connect=error&reason=unknown",
    );
  });
});
