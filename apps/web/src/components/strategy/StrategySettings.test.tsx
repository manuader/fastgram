/**
 * Settings → Strategy (`PU-BRAND-002`): carga, defaults, grilla de horarios,
 * advertencia del tope anti-bot, validación perDay ≤ dailyCap y guardado.
 */
import { strategySchema, type Strategy } from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import type * as ApiClient from "@/lib/api/client";
import { StrategySettings } from "./StrategySettings";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

import { apiRequest, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

const empty = { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };

function strategy(over: Partial<Strategy> = {}): Strategy {
  return strategySchema.parse({
    networks: [
      { network: "instagram", enabled: true, perDay: 1, dailyCap: 3 },
      { network: "tiktok", enabled: true, perDay: 1, dailyCap: 3 },
    ],
    windows: { ...empty, mon: ["09:00"] },
    timezone: "UTC",
    language: "en",
    autonomy: "manual",
    jitterMinutes: 7,
    brandGapMinutes: 10,
    formatMix: {},
    isDefault: true,
    updatedAt: null,
    ...over,
  });
}

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<StrategySettings />, { wrapper: Wrapper });
}

beforeEach(() => {
  requestMock.mockReset();
});

describe("Settings → Strategy", () => {
  it("error de carga: ofrece reintentar", async () => {
    requestMock.mockRejectedValue(
      new ApiRequestError({ code: "network_error", status: 0 }),
    );
    renderView();
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("muestra las siete redes, ninguna como Later (PU-LATER-001/002) y dice que son defaults", async () => {
    requestMock.mockResolvedValue(strategy());
    renderView();
    expect(await screen.findByText(/These are the defaults/)).toBeInTheDocument();
    for (const name of [
      "Instagram",
      "TikTok",
      "X",
      "Threads",
      "Facebook",
      "YouTube",
      "LinkedIn",
    ]) {
      expect(screen.getByLabelText(name)).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Instagram")).toBeChecked();
    expect(screen.getByLabelText("X")).not.toBeChecked();
    // YouTube y LinkedIn ya publican: sin la marca "Later".
    expect(screen.queryAllByText("Later")).toHaveLength(0);
  });

  it("advierte al subir el tope y bloquea perDay > dailyCap", async () => {
    requestMock.mockResolvedValue(strategy());
    const { container } = renderView();
    await screen.findByText(/These are the defaults/);

    const row = container.querySelector<HTMLElement>('[data-network="instagram"]');
    if (row === null) throw new Error("sin fila");
    // `fireEvent.change` y no `user.type`: el campo es controlado y se sujeta al
    // rango en cada tecla, así que vaciarlo lo deja en el mínimo y tipear suma
    // dígitos ("1" + "5" = 15).
    fireEvent.change(within(row).getByLabelText("Daily cap"), { target: { value: "5" } });
    expect(within(row).getByRole("note")).toHaveTextContent("anti-bot default of 3");

    fireEvent.change(within(row).getByLabelText("Pieces per day"), {
      target: { value: "6" },
    });
    expect(within(row).getByRole("alert")).toHaveTextContent(
      "can't be more than the daily cap",
    );
    expect(screen.getByRole("button", { name: "Save strategy" })).toBeDisabled();
  });

  it("agrega y saca horas, y guarda la estrategia entera con PUT", async () => {
    const user = userEvent.setup();
    requestMock.mockImplementation(((
      _path: string,
      options: ApiRequestOptions<unknown> = {},
    ) =>
      Promise.resolve(
        options.method === "PUT"
          ? {
              ...(options.body as object),
              isDefault: false,
              updatedAt: "2026-09-24T00:00:00.000Z",
            }
          : strategy(),
      )) as typeof apiRequest);
    renderView();
    await screen.findByText(/These are the defaults/);

    const tuesday = screen.getByLabelText("Add a time on Tuesday", { selector: "input" });
    await user.clear(tuesday);
    await user.type(tuesday, "18:30");
    await user.click(screen.getByRole("button", { name: "Add a time on Tuesday" }));
    expect(
      screen.getByRole("button", { name: "Remove 18:30 on Tuesday" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove 09:00 on Monday" }));
    await user.click(screen.getByLabelText(/Autopilot/));
    await user.click(screen.getByRole("button", { name: "Save strategy" }));

    await waitFor(() => {
      expect(requestMock.mock.calls.some(([, o]) => o?.method === "PUT")).toBe(true);
    });
    const put = requestMock.mock.calls.find(([, o]) => o?.method === "PUT");
    expect(put?.[0]).toBe("strategy");
    const body = put?.[1]?.body as {
      windows: Record<string, string[]>;
      autonomy: string;
      networks: unknown[];
    };
    expect(body.windows["tue"]).toEqual(["18:30"]);
    expect(body.windows["mon"]).toEqual([]);
    expect(body.autonomy).toBe("autopilot");
    expect(body.networks).toHaveLength(7);
    expect(await screen.findByText("Strategy saved.")).toBeInTheDocument();
  });
});
