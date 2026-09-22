/**
 * `/status` · F-255 — lo que un visitante lee, y lo que no.
 *
 * ## Qué se mockea, y por qué ahí
 *
 * El corte es **`fetch`**, no `fetchServiceStatus`. Es distinto del resto de
 * las pantallas de esta app —que cortan en el cliente tipado— y es a propósito:
 * la decisión que esta tarea tiene que garantizar es *"el cuerpo manda, no el
 * status HTTP"*, y esa decisión vive justo entre la respuesta HTTP y la
 * pantalla. Cortando más arriba, el test diría "si le doy `degraded`, dibuja
 * degraded", que es una tautología: nunca vería el `200` que acompaña a
 * `degraded` ni el `503` que acompaña a `unavailable`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceStatus } from "./ServiceStatus";

/**
 * Lo que responde nuestro route handler: el cuerpo **ya redactado**, con el
 * status HTTP que le corresponde a cada caso.
 */
function answers(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

function renderStatus() {
  const client = new QueryClient({
    // Sin reintentos: lo que se prueba es qué dibuja la pantalla cuando el
    // fetch ya falló, no el backoff de TanStack Query.
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<ServiceStatus />, { wrapper: Wrapper });
}

/** El estado que la tarjeta declara, que es lo que el CSS pinta. */
function cardState(container: HTMLElement): string | null {
  return container.querySelector(".fgw-status__card")?.getAttribute("data-state") ?? null;
}

/**
 * Espera a que la comprobación **termine**, sea cual sea el resultado.
 *
 * Es la señal que hay que esperar en un test que afirma que algo NO se dibuja:
 * esperar por el texto correcto haría que el fallo se reportara como "no
 * encontré lo que buscaba" en vez de "encontré lo que no puede estar".
 */
async function waitForCheck(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("el cuerpo manda, no el código HTTP", () => {
  it("200 con `degraded` NO se dibuja como `todo bien`", async () => {
    // El caso que motiva la pantalla entera: `apps/api` responde **200** con
    // storage o cola caídos, a propósito, para no sacar la réplica de rotación.
    // Una página que lea el `200` dirá que todo está perfecto con el storage
    // muerto — y quien lo lea no entenderá por qué no puede subir un archivo.
    answers({ state: "degraded" }, 200);
    const { container } = renderStatus();

    // Se espera a que **termine la comprobación**, no a que aparezca el texto
    // correcto. Con `findByText("Partial degradation")` delante, un fallo dice
    // "no encontré Partial degradation" y manda a buscar por qué no se dibuja;
    // así dice "encontré `All systems operational`", que es la mentira concreta.
    // Medido leyendo el status HTTP en vez del cuerpo: falla en la línea de abajo.
    await waitForCheck(container);

    expect(screen.queryByText("All systems operational")).toBeNull();
    expect(cardState(container)).toBe("degraded");
    expect(screen.getByText("Partial degradation")).toBeInTheDocument();
    expect(
      screen.getByText(/Some features may be unavailable or slower than usual/),
    ).toBeInTheDocument();
  });

  it("503 con `unavailable` es un informe, no un error de conexión", async () => {
    // El error simétrico: tratar `!response.ok` como "no se pudo contactar"
    // cambiaría "FastGram está caído" por "revisá tu conexión", que manda al
    // usuario a mirar su wifi durante una caída nuestra.
    answers({ state: "unavailable" }, 503);
    const { container } = renderStatus();

    await waitForCheck(container);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByText("We couldn't reach the server. Check your connection."),
    ).toBeNull();
    expect(cardState(container)).toBe("unavailable");
    expect(screen.getByText("Major outage")).toBeInTheDocument();
  });

  it("200 con `ok` es `ok`", async () => {
    answers({ state: "ok" }, 200);
    const { container } = renderStatus();

    await screen.findByText("All systems operational");
    expect(cardState(container)).toBe("ok");
    expect(screen.getByText("FastGram is running normally.")).toBeInTheDocument();
  });
});

describe("lo que la página NO enseña, y dice que no enseña", () => {
  it("ningún nombre de dependencia llega al DOM", async () => {
    answers({ state: "degraded" }, 200);
    const { container } = renderStatus();

    await waitForCheck(container);

    // Segunda línea de defensa: la primera es el route handler, que no manda
    // `checks`. Ésta fija que el copy tampoco los nombre — un texto tipo
    // "el almacenamiento está caído" sería la misma filtración por otra puerta.
    const text = container.textContent ?? "";
    for (const word of ["storage", "database", "queue", "Postgres", "R2"]) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it("declara que no hay desglose, en vez de parecer una página a medio hacer", async () => {
    answers({ state: "ok" }, 200);
    renderStatus();

    await screen.findByText("All systems operational");
    expect(screen.getByText(/doesn't break it down by component/)).toBeInTheDocument();
  });
});

describe("los estados de la propia pantalla (§19)", () => {
  it("mientras la primera comprobación está en vuelo se anuncia la carga", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const { container } = renderStatus();

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    // Ni "todo bien" ni "caído": no se sabe todavía, y una página de estado que
    // adivina mientras carga es peor que una que espera.
    expect(screen.queryByText("All systems operational")).toBeNull();
    expect(screen.queryByText("Major outage")).toBeNull();
  });

  it("si nuestro propio endpoint falla, se dice — no se inventa un estado", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );
    renderStatus();

    await screen.findByRole("alert");

    // Lo importante es lo que NO dice: sin respuesta no hay estado, y fingir
    // uno —del lado que sea— es exactamente lo que esta página no puede hacer.
    expect(screen.queryByText("All systems operational")).toBeNull();
    expect(screen.queryByText("Major outage")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("desde el fallo se vuelve a comprobar", async () => {
    const user = userEvent.setup();
    // El tipo de retorno va escrito: inferido de un `Promise.reject` sale
    // `Promise<never>` y el `mockImplementation` de más abajo —que sí devuelve
    // una `Response`— no compila.
    const mock = vi.fn(async (): Promise<Response> =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    vi.stubGlobal("fetch", mock);
    const { container } = renderStatus();

    await screen.findByRole("alert");

    mock.mockImplementation(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ state: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(cardState(container)).toBe("ok");
    });
  });

  it("la región se anuncia sola: el contenido cambia sin que nadie toque nada", async () => {
    answers({ state: "ok" }, 200);
    const { container } = renderStatus();

    await screen.findByText("All systems operational");
    expect(container.querySelector(".fgw-status")).toHaveAttribute("aria-live", "polite");
  });
});

describe("la hora del último chequeo", () => {
  it("se enseña en UTC, para que dos personas en un incidente lean el mismo reloj", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 22, 14, 7, 3)));
    try {
      answers({ state: "ok" }, 200);
      renderStatus();

      // `waitFor` no sabe avanzar los temporizadores falsos de vitest, así que
      // se avanza a mano. El milisegundo de más es el `setTimeout(cb, 0)` con
      // el que TanStack Query notifica al observador.
      await vi.advanceTimersByTimeAsync(1);

      // Sin hora, un "All systems operational" pintado hace cuarenta minutos se
      // lee igual que uno de hace dos segundos.
      expect(screen.getByText("Last checked at 14:07:03 UTC")).toBeInTheDocument();
      expect(screen.getByText("All systems operational")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
