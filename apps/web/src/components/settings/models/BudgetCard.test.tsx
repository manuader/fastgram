/**
 * Settings → Models → «Monthly AI budget» (`PU-MODEL-005`): muestra gasto /
 * tope y guarda uno nuevo; estados de carga y error.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { BudgetCard } from "./BudgetCard";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

import { apiRequest, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

const SUMMARY = {
  month: "2026-09",
  budgetUsd: 30,
  budgetSource: "default",
  chargedUsd: 4.2,
  reservedUsd: 0.8,
  remainingUsd: 25,
  generations: 7,
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  requestMock.mockReset();
});

describe("BudgetCard", () => {
  it("muestra gasto del mes / tope y guarda uno nuevo", async () => {
    const calls: { path: string; options: ApiRequestOptions<unknown> }[] = [];
    requestMock.mockImplementation(
      (path: string, options: ApiRequestOptions<unknown> = {}) => {
        calls.push({ path, options });
        if (options.method === "PUT") {
          return Promise.resolve({
            ...SUMMARY,
            budgetUsd: 45,
            budgetSource: "settings",
            remainingUsd: 40,
          });
        }
        return Promise.resolve(SUMMARY);
      },
    );
    render(<BudgetCard />, { wrapper });
    expect(await screen.findByText("$5.00 of $30.00")).toBeInTheDocument();
    expect(screen.getByText("$0.80 in progress")).toBeInTheDocument();
    expect(screen.getByText(/Default \(\$30\)/)).toBeInTheDocument();

    const input = screen.getByLabelText("Budget (USD per month)");
    fireEvent.change(input, { target: { value: "abc" } });
    expect(
      screen.getByText("Enter an amount between $0 and $100,000."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save budget" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    await waitFor(() => {
      expect(calls.some((c) => c.options.method === "PUT")).toBe(true);
    });
    expect(calls.find((c) => c.options.method === "PUT")?.options.body).toEqual({
      budgetUsd: 45,
    });
    expect(await screen.findByText("$5.00 of $45.00")).toBeInTheDocument();
  });

  it("error: estado de error con reintento", async () => {
    requestMock.mockRejectedValue(
      new ApiRequestError({ code: "service_unavailable", status: 503 }),
    );
    render(<BudgetCard />, { wrapper });
    expect(
      await screen.findByRole("button", { name: /try again|reload/i }),
    ).toBeInTheDocument();
  });
});
