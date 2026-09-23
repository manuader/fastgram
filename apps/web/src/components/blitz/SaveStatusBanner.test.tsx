/**
 * `SaveStatusBanner` · el fallo del auto-guardado (FR-055).
 *
 * Lo único que se prueba acá es el `onRetry` que el banner decide pasar: un
 * `429` puede ser rate limit (ERR-R01, se reintenta) o cuota agotada (ERR-R03,
 * no). Los dos tienen el mismo status; el banner tiene que decidir por el `code`.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { SaveStatusBanner } from "./SaveStatusBanner";

describe("SaveStatusBanner en error", () => {
  it("un 429 de rate limit ofrece `Try again`", () => {
    render(
      <SaveStatusBanner
        status="error"
        error={new ApiRequestError({ code: "rate_limited", status: 429 })}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("un 429 de cuota NO ofrece `Try again`: ofrece Upgrade y la fecha", () => {
    render(
      <SaveStatusBanner
        status="error"
        error={
          new ApiRequestError({
            code: "content_quota_exceeded",
            status: 429,
            details: { count: 20, limit: 20, resetAt: Date.UTC(2026, 9, 15) },
          })
        }
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("link", { name: "Upgrade to unlock" })).toBeInTheDocument();
    expect(screen.getByText("Your quota resets on Oct 15.")).toBeInTheDocument();
  });
});
