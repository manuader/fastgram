/**
 * `ApiErrorState` · PRD §19.
 *
 * **Qué NO se prueba acá.** La decisión —qué salida le toca a cada código— es
 * de `lib/api/error-presentation.ts` y tiene sus tests. Repetirla desde el
 * componente daría cobertura doble de lo mismo y ninguna de lo que este
 * archivo añade, que es la traducción de esa decisión a un control concreto:
 *
 * · `retry` → un **botón**, porque vuelve a pedir en la misma pantalla.
 * · `upgrade`/`profile` → un **enlace**, porque lleva a otra. Un botón no se
 *   abre en otra pestaña y no se anuncia como enlace.
 * · `none` → **nada**, aunque le pasen un `onRetry`. Un `Try again` sobre un
 *   403 es una mentira con forma de botón: el usuario lo aprieta, falla igual,
 *   y a partir de ahí no se cree ningún botón de la app.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { ROUTES } from "@/lib/nav/routes";
import { ApiErrorState } from "./ApiErrorState";

function failure(
  code: ConstructorParameters<typeof ApiRequestError>[0]["code"],
  status: number,
  extra: { details?: Record<string, unknown>; serverMessage?: string } = {},
): ApiRequestError {
  return new ApiRequestError({ code, status, ...extra });
}

describe("la salida que se dibuja es la que corresponde al código", () => {
  it("un fallo transitorio es un botón, y reintenta de verdad", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <ApiErrorState error={failure("service_unavailable", 503)} onRetry={onRetry} />,
    );

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("un 402 de cuota manda a Upgrade y dice cuándo vuelve — no a reintentar", () => {
    // ERR-R03 (PRD:3213). `resetAt` en ms de epoch, UTC (§16.2).
    const error = failure("content_quota_exceeded", 402, {
      details: { resetAt: Date.UTC(2026, 9, 15) },
    });
    render(<ApiErrorState error={error} onRetry={vi.fn()} />);

    expect(screen.getByRole("link", { name: "Upgrade to unlock" })).toHaveAttribute(
      "href",
      ROUTES.upgrade,
    );
    // Reintentar no devuelve cuota: el botón no puede estar, ni siquiera
    // aunque se le haya pasado un `onRetry`.
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByText("Your quota resets on Oct 15.")).toBeInTheDocument();
  });

  it("`Reload` no se rotula `Try again` (ERR-P04)", () => {
    // Las dos salidas son un botón y llaman a lo mismo, pero no dicen lo
    // mismo: una es "el servidor falló", la otra "lo tuyo está viejo".
    render(<ApiErrorState error={failure("stale_revision", 409)} onRetry={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("un error sin salida no dibuja ningún control, aunque haya `onRetry`", () => {
    render(<ApiErrorState error={failure("forbidden", 403)} onRetry={vi.fn()} />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("el mensaje crudo del servidor no llega nunca a la pantalla", () => {
    // Regla dura del repo: ningún error crudo sale hacia afuera. Un `message`
    // de servidor es texto sin traducir, sin control de producto y a veces con
    // topología dentro — exactamente lo que no se enseña.
    const error = failure("service_unavailable", 503, {
      serverMessage: "upstream connect error to 10.0.3.17:5432",
    });
    render(<ApiErrorState error={error} onRetry={vi.fn()} />);

    expect(screen.queryByText(/10\.0\.3\.17/)).toBeNull();
    expect(
      screen.getByText("That service isn't responding. Try again shortly."),
    ).toBeInTheDocument();
  });
});
