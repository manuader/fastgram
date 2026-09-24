/**
 * "How autopilot decides" (`PU-AUTO-002`): los umbrales salen de la API, y una
 * respuesta que no es la política no rompe la pantalla de Strategy.
 */
import { autopilotPolicySchema } from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutopilotPolicyPanel } from "./AutopilotPolicy";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

import { apiRequest } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

function renderPanel(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AutopilotPolicyPanel />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  requestMock.mockReset();
});

describe("AutopilotPolicyPanel", () => {
  it("muestra el horizonte y los umbrales que sirve la API, en porcentaje", async () => {
    requestMock.mockResolvedValue(
      autopilotPolicySchema.parse({
        horizonDays: 2,
        queueTargetMin: 5,
        queueTargetMax: 30,
        maxDecisionsPerRun: 6,
        runEveryMinutes: 15,
        precheckTimeoutMs: 30_000,
        precheckVersion: "v",
        thresholds: {
          onBrandMin: 0.6,
          riskyClaimMaxMass: 0.3,
          thirdPartyMax: 0.5,
          coherentMin: 0.6,
          inLanguageMin: 0.6,
        },
      }),
    );
    renderPanel();
    const list = await screen.findByTestId("autopilot-thresholds");
    expect(list).toHaveTextContent("On-topic for the brand: at least 60%");
    expect(list).toHaveTextContent(
      "Health, money or legal claims: rejected from 30% likely",
    );
    expect(screen.getByText("Horizon: 2 days")).toBeInTheDocument();
  });

  it("una respuesta que no es la política: mensaje, no una pantalla rota", async () => {
    requestMock.mockResolvedValue({ networks: [] });
    renderPanel();
    expect(
      await screen.findByText("Couldn't load how autopilot decides."),
    ).toBeInTheDocument();
  });
});
