/**
 * `/analytics` (`P3-ANALYT-001/002`, `PU-AUTO-004`): estados de carga, vacío y
 * error, `NFR-016` en pantalla (lo desconocido es «—» y los pre-sync se
 * dicen), el selector de rango, y el auto-tune del mix con su historial.
 *
 * El corte está en el cliente tipado (`apiRequest`), por path, como en los
 * otros tests de pantalla. `useWorkspace` se reemplaza: esta pantalla sólo
 * necesita saber si hay más de una marca.
 */
import type {
  AnalyticsMix,
  AnalyticsSummary,
  AnalyticsTotals,
} from "@fastgram/contracts";
import { ToastProvider } from "@fastgram/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import type * as ApiClient from "@/lib/api/client";
import { AnalyticsScreen } from "./AnalyticsScreen";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

vi.mock("@/components/brands/WorkspaceProvider", () => ({
  useWorkspace: () => ({
    isPersonal: true,
    mode: "personal",
    workspaces: { data: [{ id: "a" }, { id: "b" }] },
    active: { id: "a", name: "Acme" },
    selectedId: null,
    switchTo: () => {},
    forget: () => {},
  }),
}));

import { apiRequest, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

const totals = (over: Partial<AnalyticsTotals> = {}): AnalyticsTotals => ({
  posts: 3,
  syncedPosts: 2,
  pendingSync: 1,
  views: 1200,
  likes: 30,
  comments: 6,
  shares: 0,
  metricCoverage: { views: 2, likes: 2, comments: 2, shares: 0 },
  engagementRate: 0.03,
  ...over,
});

const BRAND = "11111111-1111-4111-8111-111111111111";

function summary(over: Partial<AnalyticsSummary> = {}): AnalyticsSummary {
  return {
    range: { from: 0, to: 1, days: 30 },
    brands: [{ id: BRAND, name: "Acme" }],
    totals: totals(),
    byNetwork: [
      { key: "instagram", ...totals({ posts: 2, pendingSync: 0 }) },
      { key: "tiktok", ...totals({ posts: 1, syncedPosts: 0, pendingSync: 1 }) },
    ],
    byFormat: [{ key: "slideshow", ...totals() }],
    topPosts: [
      {
        _id: "22222222-2222-4222-8222-222222222222",
        brandId: BRAND,
        network: "instagram",
        format: "slideshow",
        postedAt: Date.parse("2026-09-20T10:00:00Z"),
        views: 1000,
        likes: 25,
        comments: 5,
        shares: null,
        engagementRate: 0.03,
        postUrl: "https://instagram.test/p/1",
        caption: "Our best post",
      },
    ],
    lastSyncedAt: Date.now() - 5 * 60_000,
    syncIssues: [{ code: "metrics_permission_missing", count: 2 }],
    unsupportedNetworks: ["tiktok"],
    truncated: false,
    ...over,
  };
}

const MIX: AnalyticsMix = {
  weights: { slideshow: 60, "wall-of-text": 40, "green-screen": 0, "video-hook": 0 },
  autotune: { enabled: false, lastRunAt: null, lastOutcome: null },
  adjustments: [
    {
      _id: "33333333-3333-4333-8333-333333333333",
      actor: "autotune",
      from: { slideshow: 50, "wall-of-text": 50, "green-screen": 0, "video-hook": 0 },
      to: { slideshow: 60, "wall-of-text": 40, "green-screen": 0, "video-hook": 0 },
      createdAt: Date.parse("2026-09-18T07:00:00Z"),
      samples: { slideshow: 5, "wall-of-text": 5 },
    },
  ],
};

function route(
  handlers: Partial<Record<string, (options: ApiRequestOptions<unknown>) => unknown>>,
) {
  requestMock.mockImplementation(async (path, options) => {
    const handler = handlers[path];
    if (handler === undefined) throw new Error(`path sin doble: ${path}`);
    const out = handler(options ?? {});
    if (out instanceof Error) throw out;
    return out;
  });
}

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    );
  }
  return render(<AnalyticsScreen />, { wrapper: Wrapper });
}

beforeEach(() => {
  requestMock.mockReset();
});

/** Espera a que las tarjetas tengan datos (mientras carga, el mismo testid es un skeleton). */
async function loaded(): Promise<void> {
  await waitFor(() => {
    expect(
      within(screen.getByTestId("analytics-total-views")).getByText("1,200"),
    ).toBeInTheDocument();
  });
}

describe("/analytics", () => {
  it("totales con '—' para lo que ninguna red reporta y los avisos de sync", async () => {
    route({ "analytics/summary": () => summary(), "analytics/mix": () => MIX });
    renderScreen();

    await loaded();
    const shares = screen.getByTestId("analytics-total-shares");
    expect(within(shares).getByText("—")).toBeInTheDocument();
    expect(
      within(shares).getByText("Not reported by these networks"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("analytics-total-engagement")).getByText("3.00%"),
    ).toBeInTheDocument();

    const notes = screen.getByTestId("analytics-sync-notes");
    expect(
      within(notes).getByText(/1 published posts are waiting for their first sync/),
    ).toBeInTheDocument();
    expect(
      within(notes).getByText(/didn't grant permission to read insights/),
    ).toBeInTheDocument();
    expect(
      within(notes).getByText(/TikTok: posts published as drafts/),
    ).toBeInTheDocument();
    expect(within(notes).getByRole("link", { name: "Open Connections" })).toHaveAttribute(
      "href",
      "/settings/connections",
    );
    expect(screen.getByTestId("analytics-last-sync")).toHaveTextContent(
      "Numbers as of the last sync, 5 min ago.",
    );
  });

  it("F-171 / F-172: tarjeta por red (TikTok sin métricas) y fila por tipo", async () => {
    route({ "analytics/summary": () => summary(), "analytics/mix": () => MIX });
    renderScreen();
    const ig = await screen.findByTestId("analytics-network-instagram");
    expect(within(ig).getByText("Instagram posts")).toBeInTheDocument();
    const tt = screen.getByTestId("analytics-network-tiktok");
    expect(within(tt).getByText("No metrics via API")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("analytics-format-slideshow")).getByText("Slideshow"),
    ).toBeInTheDocument();
    expect(screen.getByText("Our best post")).toBeInTheDocument();
  });

  it("empty state honesto sin posts publicados", async () => {
    route({
      "analytics/summary": () =>
        summary({
          totals: totals({
            posts: 0,
            syncedPosts: 0,
            pendingSync: 0,
            views: 0,
            likes: 0,
            comments: 0,
            metricCoverage: { views: 0, likes: 0, comments: 0, shares: 0 },
            engagementRate: null,
          }),
          byNetwork: [],
          byFormat: [],
          topPosts: [],
          lastSyncedAt: null,
          syncIssues: [],
          unsupportedNetworks: [],
        }),
      "analytics/mix": () => MIX,
    });
    renderScreen();
    expect(await screen.findByText("No metrics yet")).toBeInTheDocument();
    expect(screen.getByText(/connect accounts and publish/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect accounts" })).toBeInTheDocument();
    expect(screen.getByTestId("analytics-last-sync")).toHaveTextContent(
      "No metrics have been synced for this range yet.",
    );
  });

  it("error: ofrece reintentar", async () => {
    route({
      "analytics/summary": () =>
        new ApiRequestError({ code: "network_error", status: 0 }),
      "analytics/mix": () => MIX,
    });
    renderScreen();
    expect(await screen.findByText("Couldn't load analytics.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("cambiar el rango y el alcance vuelve a pedir con days y brands", async () => {
    route({ "analytics/summary": () => summary(), "analytics/mix": () => MIX });
    const user = userEvent.setup();
    renderScreen();
    await loaded();

    await user.click(screen.getByRole("radio", { name: "7 days" }));
    await user.click(screen.getByRole("radio", { name: "All brands" }));
    await waitFor(() => {
      const queries = requestMock.mock.calls
        .filter(([path]) => path === "analytics/summary")
        .map(([, o]) => o?.query);
      expect(queries).toContainEqual({ days: 7, brands: "all" });
    });
  });

  it("mix: pesos, historial de qué a qué, y el switch prende el auto-tune", async () => {
    let enabled = false;
    route({
      "analytics/summary": () => summary(),
      "analytics/mix": () => ({ ...MIX, autotune: { ...MIX.autotune, enabled } }),
      "analytics/mix/autotune": (o) => {
        enabled = (o.body as { enabled: boolean }).enabled;
        return { enabled, lastRunAt: null, lastOutcome: null };
      },
    });
    const user = userEvent.setup();
    renderScreen();

    const history = await screen.findByTestId("mix-history");
    expect(within(history).getByText(/Slideshow 50 → 60/)).toBeInTheDocument();
    expect(within(history).getByText(/10 measured posts/)).toBeInTheDocument();

    const toggle = screen.getByRole("switch", { name: "Auto-tune content mix" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-checked", "true");
    });
    const put = requestMock.mock.calls.find(
      ([path]) => path === "analytics/mix/autotune",
    );
    expect(put?.[1]).toMatchObject({ method: "PUT", body: { enabled: true } });
    expect(await screen.findByText(/Not checked yet/)).toBeInTheDocument();
  });

  it("Sync now encola y avisa", async () => {
    route({
      "analytics/summary": () => summary(),
      "analytics/mix": () => MIX,
      "analytics/sync": () => ({ queued: true }),
    });
    const user = userEvent.setup();
    renderScreen();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText(/Sync requested/)).toBeInTheDocument();
  });
});
