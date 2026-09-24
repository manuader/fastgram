/**
 * La tarjeta "Autopilot" de Today y el banner de Blitz · `PU-AUTO-003`.
 *
 * El corte está en el cliente tipado (`apiRequest`), como en
 * `TodayScreen.test.tsx`. Las respuestas pasan por el schema del contrato
 * antes de llegar al doble: una forma que la API no puede devolver no entra.
 */
import {
  autopilotDigestSchema,
  type AutopilotBrandDigest,
  type AutopilotDigest,
} from "@fastgram/contracts";
import { ToastProvider } from "@fastgram/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutopilotBanner } from "@/components/blitz/deck/AutopilotBanner";
import { WorkspaceProvider } from "@/components/brands/WorkspaceProvider";
import { ApiRequestError } from "@/lib/api/errors";
import { clearWorkspaceCookie } from "@/lib/brands/workspace-cookie";
import { AutopilotCard } from "./AutopilotCard";
import { autopilotKeys } from "./autopilot-data";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiList: vi.fn(),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/home",
}));

import { apiRequest } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

const ACME = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AT = Date.parse("2026-09-24T12:30:00.000Z");

function brand(over: Partial<AutopilotBrandDigest>): AutopilotBrandDigest {
  return {
    brandId: ACME,
    brandName: "Acme",
    timezone: "UTC",
    date: "2026-09-24",
    autonomy: "autopilot",
    lastRun: {
      at: AT,
      outcome: "ran",
      queueTarget: 12,
      queued: 9,
      approved: 2,
      rejected: 2,
      held: 0,
    },
    generated: 7,
    approved: [],
    rejected: [],
    held: [],
    published: 3,
    failed: [],
    truncated: false,
    ...over,
  };
}

const item = (
  n: number,
  reasons: AutopilotBrandDigest["rejected"][number]["reasons"],
) => ({
  suggestionId: uuid(n),
  excerpt: `Pieza ${String(n)}`,
  at: AT,
  reasons,
  scheduled: [],
});

function install(digest: AutopilotDigest | ApiRequestError): void {
  requestMock.mockImplementation(async (path: string) => {
    if (path === "mode") return { mode: "personal" };
    if (path === "workspaces") {
      return [
        {
          id: ACME,
          name: "Acme",
          profileStatus: "ready",
          createdAt: "2026-09-01T00:00:00.000Z",
        },
        {
          id: BETA,
          name: "Beta",
          profileStatus: "ready",
          createdAt: "2026-09-02T00:00:00.000Z",
        },
      ];
    }
    if (path === "autopilot/digest") {
      if (digest instanceof ApiRequestError) throw digest;
      return autopilotDigestSchema.parse(digest);
    }
    throw new Error(`ruta inesperada: ${path}`);
  });
}

function renderWith(node: ReactNode): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <WorkspaceProvider>{node}</WorkspaceProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return client;
}

/**
 * Para afirmar una **ausencia** hay que esperar a que el dato haya llegado y
 * se haya dibujado (trampa 38): antes de eso la tarjeta tampoco está, y el
 * test pasaría por la razón equivocada. Verificado rompiendo la guarda.
 */
async function settled(client: QueryClient, brands: "current" | "all"): Promise<void> {
  await vi.waitFor(() => {
    expect(client.getQueryState(autopilotKeys.digest(brands))?.status).toBe("success");
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
  requestMock.mockReset();
  push.mockReset();
  clearWorkspaceCookie();
});

describe("AutopilotCard", () => {
  it("por marca en piloto: aprobadas, rechazadas con motivo legible y lo generado/publicado", async () => {
    install({
      brands: [
        brand({
          approved: [
            { ...item(1, []), scheduled: [{ network: "instagram", at: AT }] },
            item(2, []),
          ],
          rejected: [
            item(3, ["third_party_brand"]),
            item(4, ["third_party_brand", "off_brand"]),
          ],
        }),
        // Manual y sin decisiones: no aparece.
        brand({ brandId: BETA, brandName: "Beta", autonomy: "manual", lastRun: null }),
      ],
    });
    renderWith(<AutopilotCard timeZone="UTC" />);

    const rows = await screen.findAllByTestId("today-autopilot-brand");
    expect(rows).toHaveLength(1);
    const row = rows[0] as HTMLElement;
    expect(within(row).getByText("Acme")).toBeInTheDocument();
    expect(within(row).getByTestId("today-autopilot-counts")).toHaveTextContent(
      "2 approved · 2 rejected",
    );
    expect(
      within(row).getByText("7 generated · 3 published · 0 failed"),
    ).toBeInTheDocument();
    // Motivos legibles, contados: el más frecuente primero.
    expect(within(row).getByText("Mentions another brand · 2")).toBeInTheDocument();
    expect(within(row).getByText("Off-topic for the brand")).toBeInTheDocument();
    expect(within(row).getByText("Last run 12:30 PM")).toBeInTheDocument();
  });

  it("'Review rejected' abre la lista con la copy y el motivo de cada una", async () => {
    install({ brands: [brand({ rejected: [item(3, ["health_claim"])] })] });
    renderWith(<AutopilotCard timeZone="UTC" />);
    const user = userEvent.setup();

    // La negativa primero (trampa 35): cerrada, la lista no está.
    await screen.findByTestId("today-autopilot-brand");
    expect(screen.queryByTestId("today-autopilot-rejected")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Review rejected (1)" }));
    const list = screen.getByTestId("today-autopilot-rejected");
    expect(within(list).getByText("Pieza 3")).toBeInTheDocument();
    expect(within(list).getByText("Health claim")).toBeInTheDocument();
  });

  it("las que esperan al humano llevan a Blitz; un piloto pausado dice por qué", async () => {
    install({
      brands: [
        brand({
          held: [item(5, ["judgment_timeout"])],
          lastRun: {
            at: AT,
            outcome: "no_judgment",
            queueTarget: 5,
            queued: 5,
            approved: 0,
            rejected: 0,
            held: 0,
          },
        }),
      ],
    });
    renderWith(<AutopilotCard timeZone="UTC" />);
    const user = userEvent.setup();

    expect(await screen.findByTestId("today-autopilot-status")).toHaveTextContent(
      "Paused: no model for the pre-check",
    );
    expect(screen.getByTestId("today-autopilot-counts")).toHaveTextContent(
      "1 waiting for you",
    );
    await user.click(screen.getByRole("button", { name: "Review in Blitz" }));
    expect(push).toHaveBeenCalledWith("/blitz");
  });

  it("sin marcas en piloto no dibuja nada", async () => {
    install({ brands: [brand({ autonomy: "manual" })] });
    const client = renderWith(<AutopilotCard timeZone="UTC" />);
    await settled(client, "all");
    expect(screen.queryByTestId("today-autopilot")).toBeNull();
  });

  it("error: mensaje y reintento", async () => {
    install(new ApiRequestError({ code: "service_unavailable", status: 503 }));
    renderWith(<AutopilotCard timeZone="UTC" />);
    expect(
      await screen.findByText("Couldn't load the autopilot summary."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("AutopilotBanner (Blitz)", () => {
  it("con la marca en piloto: cuántas se aprobaron hoy", async () => {
    install({ brands: [brand({ approved: [item(1, []), item(2, []), item(3, [])] })] });
    renderWith(<AutopilotBanner />);
    expect(await screen.findByTestId("blitz-autopilot-banner")).toHaveTextContent(
      "Autopilot is on for this brand — 3 approved today",
    );
  });

  it("marca manual: no hay banner", async () => {
    install({ brands: [brand({ autonomy: "manual" })] });
    const client = renderWith(<AutopilotBanner />);
    await settled(client, "current");
    expect(screen.queryByTestId("blitz-autopilot-banner")).toBeNull();
  });
});
