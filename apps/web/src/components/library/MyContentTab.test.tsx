/**
 * `Library → My Content` · los cuatro estados de PRD §19, el cursor y el
 * polling de ADR-014.
 *
 * ## Qué se mockea, y por qué ahí
 *
 * El corte está en **`apiList`**, el cliente tipado, no en el `fetch` global.
 * Mockear `fetch` obligaría a construir sobres `{data, pagination}` a mano en
 * cada test, y lo que se estaría probando sería el parser de `client.ts` —que
 * ya tiene su propio archivo de tests— una vez por cada estado de la pantalla.
 * Con el corte en `apiList` lo que queda bajo test es lo que esta tarea
 * construyó: `useContentList` (filtros, cadencia, aplanado) y `MyContentTab`
 * (qué estado se dibuja y cuál no).
 *
 * ## La razón de que este archivo exista
 *
 * Un fallo de red que se dibuja como estado vacío es el bug clásico de esta
 * pantalla: las dos cosas son "una grid sin tarjetas", y el usuario que ve
 * `No content yet` después de un timeout cree que perdió su trabajo. Por eso
 * casi todas las aserciones son sobre `statesOnScreen`, que mira los cuatro
 * estados a la vez: un test que sólo comprobara "hay un error" pasaría igual
 * con el vacío pintado debajo.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTES } from "@/lib/nav/routes";
import { ApiRequestError } from "@/lib/api/errors";
import {
  BUILD_POLL_INTERVAL_MS,
  libraryContentSchema,
  type LibraryContent,
} from "@/lib/library/content";
import { MyContentTab } from "./MyContentTab";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  // Sólo `apiList` se reemplaza: `hooks.ts` también importa `apiRequest` de
  // este módulo, y una fábrica que devolviera un objeto pelado lo dejaría en
  // `undefined` para cualquier test futuro que monte una pantalla de recurso.
  ...(await importOriginal<typeof ApiClient>()),
  apiList: vi.fn(),
}));

// El import va después del `vi.mock` sólo para leerse en orden: `vi.mock` se
// iza por encima de todos los imports del archivo.
import { apiList, type CursorPage } from "@/lib/api/client";

const listMock = vi.mocked(apiList);

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as const;

/**
 * Una pieza **validada contra el contrato**, no un objeto literal con un
 * `as LibraryContent` encima. El id va marcado (`z.string().brand<…>()`), así
 * que el cast sería obligatorio — y un cast convierte un fixture inválido en
 * un test verde que prueba algo que el servidor nunca devolvería.
 */
function piece(overrides: Readonly<Record<string, unknown>> = {}): LibraryContent {
  return libraryContentSchema.parse({
    _id: IDS[0],
    type: "wall-of-text",
    status: "CREATED",
    files: ["https://cdn.example.test/a.mp4"],
    thumbnailUrl: "https://cdn.example.test/a.jpg",
    revision: 1,
    ...overrides,
  });
}

function page(
  items: readonly LibraryContent[],
  next: { cursor?: string | null; hasMore?: boolean } = {},
): CursorPage<LibraryContent> {
  return { items, cursor: next.cursor ?? null, hasMore: next.hasMore ?? false };
}

/**
 * `retry: false` contra el default del proyecto (`shouldRetry`, hasta 2
 * reintentos para 5xx y red). No es para que el test sea más fácil: con los
 * reintentos puestos, un test del **estado de error** mide el backoff de
 * TanStack Query —que no es de esta pantalla y ya tiene sus tests en
 * `query-client`— y se vuelve lento y dependiente del reloj. Lo que esta
 * pantalla decide es qué dibuja cuando el hook ya falló.
 */
function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<MyContentTab />, { wrapper: Wrapper });
}

/**
 * Los cuatro estados de §19, mirados a la vez.
 *
 * Cada uno por la señal que el usuario —o su lector de pantalla— percibe:
 *
 * · `loading` — el `aria-busy` del contenedor. Los `Skeleton` son
 *   `aria-hidden`, así que el `aria-busy` es literalmente lo único que anuncia
 *   que está cargando.
 * · `empty` — el copy del estado vacío.
 * · `error` — el `role="alert"` que pone `ErrorState`.
 * · `data` — que haya al menos un enlace a la ficha de una pieza. Sirve para
 *   distinguirlo del vacío, que también tiene un enlace (`Create content`)
 *   pero apunta a `/content`, no a `/library/<id>`.
 */
function statesOnScreen(container: HTMLElement): Record<string, boolean> {
  const cardLinks = screen
    .queryAllByRole("link")
    .filter(
      (link) => link.getAttribute("href")?.startsWith(`${ROUTES.library}/`) === true,
    );
  return {
    loading: container.querySelector('[aria-busy="true"]') !== null,
    empty: screen.queryByText("No content yet") !== null,
    error: screen.queryByRole("alert") !== null,
    data: cardLinks.length > 0,
  };
}

const ONLY = {
  loading: { loading: true, empty: false, error: false, data: false },
  empty: { loading: false, empty: true, error: false, data: false },
  error: { loading: false, empty: false, error: true, data: false },
  data: { loading: false, empty: false, error: false, data: true },
} as const;

/** Un fallo de red, que es el que de verdad le pasa a esta pantalla. */
function networkFailure(): ApiRequestError {
  return new ApiRequestError({ code: "network_error", status: 0 });
}

beforeEach(() => {
  listMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("los cuatro estados de §19, y uno solo por vez", () => {
  it("mientras la primera página está en vuelo: skeleton, y nada más", () => {
    listMock.mockReturnValue(new Promise(() => {}));
    const { container } = renderTab();

    expect(statesOnScreen(container)).toEqual(ONLY.loading);
    // Ocho tarjetas fantasma con la forma de la grid, todas invisibles para un
    // lector de pantalla: quien anuncia es el `aria-busy`, no la forma gris.
    expect(container.querySelectorAll(".fgw-content-card")).toHaveLength(8);
    for (const skeleton of container.querySelectorAll(
      ".fg-skeleton, [class*=skeleton]",
    )) {
      expect(skeleton).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("un workspace sin piezas es el estado vacío, con su salida", async () => {
    listMock.mockResolvedValue(page([]));
    const { container } = renderTab();

    await screen.findByText("No content yet");
    expect(statesOnScreen(container)).toEqual(ONLY.empty);
    // Un vacío sin salida es una pantalla muerta.
    expect(screen.getByRole("link", { name: "Create content" })).toHaveAttribute(
      "href",
      ROUTES.content,
    );
  });

  it("con piezas, la grid — y el contador dice cuántas", async () => {
    listMock.mockResolvedValue(page([piece(), piece({ _id: IDS[1] })]));
    const { container } = renderTab();

    await waitFor(() => {
      expect(statesOnScreen(container)).toEqual(ONLY.data);
    });
    expect(screen.getByText("2 items")).toBeInTheDocument();
  });

  it("un fallo de la API es un error, NO un estado vacío", async () => {
    listMock.mockRejectedValue(networkFailure());
    const { container } = renderTab();

    await screen.findByRole("alert");

    // Esto es todo el test. Una lista vacía por error de red y un workspace
    // sin contenido se dibujan igual —una grid sin tarjetas— y significan lo
    // contrario: "no se pudo pedir" contra "no hay nada". Quien vea el copy
    // del vacío después de un timeout cree que perdió sus datos.
    expect(statesOnScreen(container)).toEqual(ONLY.error);
    expect(
      screen.getByText("We couldn't reach the server. Check your connection."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("un error sin salida no ofrece un botón que no sirve", async () => {
    // ERR-U01: reintentar un 403 da otro 403. §19 le asigna `none`.
    listMock.mockRejectedValue(new ApiRequestError({ code: "forbidden", status: 403 }));
    renderTab();

    await screen.findByRole("alert");
    expect(screen.getByText("Access Denied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("desde el error se vuelve a pedir, y la grid aparece", async () => {
    const user = userEvent.setup();
    listMock.mockRejectedValueOnce(networkFailure());
    listMock.mockResolvedValue(page([piece()]));
    const { container } = renderTab();

    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(statesOnScreen(container)).toEqual(ONLY.data);
    });
  });
});

/**
 * Filtros de §12 (PRD:2730).
 *
 * Lo que se prueba no es que el `<select>` cambie de valor —eso es del
 * navegador— sino las dos consecuencias que sí son de esta pantalla: que el
 * filtro **viaje en la petición** (si se quedara en el estado local, la grid
 * enseñaría todo y el usuario creería que el filtro no funciona) y que el
 * vacío resultante ofrezca una salida distinta.
 */
describe("filtrar, y el vacío que eso produce", () => {
  it("un vacío CON filtros ofrece quitarlos, no ir a crear contenido", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce(page([piece()]));
    listMock.mockResolvedValue(page([]));

    renderTab();
    await screen.findByText("1 item");

    await user.selectOptions(screen.getByLabelText("Type"), "slideshow");
    await screen.findByText("No content yet");

    // El filtro sale en la query: §12 lo documenta como parámetro del listado.
    expect(listMock.mock.calls[1]?.[1]?.query).toMatchObject({ type: "slideshow" });

    // Y la salida es la que sirve acá. `Create content` mandaría a crear una
    // pieza a alguien que ya tiene treinta y sólo puso mal un filtro.
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Create content" })).toBeNull();
  });

  it("`Clear filters` vuelve a pedir sin filtro y devuelve la grid", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce(page([piece()]));
    listMock.mockResolvedValueOnce(page([]));
    listMock.mockResolvedValue(page([piece()]));

    const { container } = renderTab();
    await screen.findByText("1 item");
    await user.selectOptions(screen.getByLabelText("Type"), "slideshow");
    await screen.findByText("No content yet");

    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => {
      expect(statesOnScreen(container)).toEqual(ONLY.data);
    });
    expect(listMock.mock.calls.at(-1)?.[1]?.query).toEqual({});
  });
});

describe("paginación por cursor (PRD:2345)", () => {
  it("`Load more` pide la página siguiente con el cursor y la añade a la de arriba", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce(
      page([piece(), piece({ _id: IDS[1] })], { cursor: "cursor-1", hasMore: true }),
    );
    listMock.mockResolvedValueOnce(page([piece({ _id: IDS[2] })]));

    renderTab();

    await screen.findByText("2 items loaded");
    await user.click(screen.getByRole("button", { name: "Load more" }));

    // Las dos páginas en pantalla, no la segunda reemplazando a la primera.
    await waitFor(() => {
      expect(screen.getByText("3 items")).toBeInTheDocument();
    });
    expect(
      screen
        .getAllByRole("link")
        .filter((l) => l.getAttribute("href")?.startsWith(`${ROUTES.library}/`) === true),
    ).toHaveLength(3);

    // El cursor es **opaco** y se reenvía tal cual: si se interpretara o se
    // perdiera, la segunda petición traería otra vez la primera página y el
    // usuario vería duplicados en vez de contenido nuevo.
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(listMock.mock.calls[0]?.[1]?.cursor).toBeNull();
    expect(listMock.mock.calls[1]?.[1]?.cursor).toBe("cursor-1");

    // `hasMore: false` en la última página: el control desaparece. Dejarlo
    // puesto es una petición tirada contra el rate limit de §9.6.
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("el control no aparece cuando el API dice que no hay más, aunque mande cursor", async () => {
    // El API puede devolver cursor con `hasMore: false`. Quien pagine tiene
    // que mirar `hasMore`, no la nulidad del cursor.
    listMock.mockResolvedValue(page([piece()], { cursor: "cursor-1", hasMore: false }));
    renderTab();

    await screen.findByText("1 item");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("si falla la página siguiente, NO se borra lo que ya estaba en pantalla", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce(
      page([piece(), piece({ _id: IDS[1] })], { cursor: "cursor-1", hasMore: true }),
    );
    listMock.mockRejectedValueOnce(networkFailure());

    const { container } = renderTab();
    await screen.findByText("2 items loaded");
    await user.click(screen.getByRole("button", { name: "Load more" }));

    await screen.findByRole("alert");
    // Error **y** datos a la vez, que es la única combinación legítima de dos
    // estados: borrar la grid castiga al usuario por un fallo de la página que
    // pidió de más.
    expect(statesOnScreen(container)).toEqual({
      loading: false,
      empty: false,
      error: true,
      data: true,
    });
  });
});

/**
 * Polling de ADR-014 / NFR-002 (PRD:2961) · 10 s mientras haya un build.
 *
 * ## Temporizadores falsos, y una trampa que cuesta una tarde
 *
 * `waitFor` de `@testing-library/dom` **no sabe avanzar los temporizadores
 * falsos de vitest**: su detección (`jestFakeTimersAreEnabled`, en
 * `dist/helpers.js` de la 10.4.2) arranca con `typeof jest !== "undefined"` y
 * en vitest eso es `undefined`. O sea que `waitFor` se queda esperando con un
 * reloj parado y el test muere por timeout, no por el componente.
 *
 * Por eso acá no hay `waitFor`: se avanza el reloj a mano con
 * `vi.advanceTimersByTimeAsync` dentro de `act` —que además vacía la cola de
 * microtareas, o sea la promesa del refetch— y se afirma en seco.
 */
describe("polling mientras algo se construye (ADR-014)", () => {
  /**
   * Avanza el reloj falso `ms` y deja que React llegue a pintar.
   *
   * ## El milisegundo de más, que costó el rato
   *
   * No es un margen supersticioso. TanStack Query no notifica al observador en
   * cuanto resuelve la petición: agenda el aviso con `setTimeout(cb, 0)`
   * (`notifyManager` → `systemSetTimeoutZero`) **durante** el mismo tick que lo
   * disparó. Y ese temporizador no lo corre `advanceTimersByTimeAsync(0)`:
   * medido, cinco ticks de 0 seguidos dejan la **caché ya actualizada** y la
   * pantalla todavía con los datos viejos. Con avanzar 1 ms, sale.
   *
   * El síntoma sin esto es de los caros: el mock cuenta la segunda petición,
   * así que el test parece estar midiendo el polling —lo mide— y falla en la
   * aserción de pantalla como si el componente no reaccionara al dato nuevo.
   * Se pierde la tarde en `MyContentTab.tsx`, que no tiene nada roto.
   */
  async function tick(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
      await vi.advanceTimersByTimeAsync(1);
    });
  }

  /** Monta y deja resuelta la primera página, con el reloj ya congelado. */
  async function mountWithFakeTimers() {
    vi.useFakeTimers();
    const rendered = renderTab();
    await tick(0);
    return rendered;
  }

  /** Los enlaces a fichas de pieza que hay en pantalla. */
  function cardLinks(): readonly HTMLElement[] {
    return screen
      .queryAllByRole("link")
      .filter((l) => l.getAttribute("href")?.startsWith(`${ROUTES.library}/`) === true);
  }

  it("una pieza en BUILDING se vuelve a pedir a los 10 s, y la pantalla se entera sola", async () => {
    listMock.mockResolvedValueOnce(page([piece({ status: "BUILDING" })]));
    listMock.mockResolvedValue(page([piece({ status: "CREATED" })]));

    await mountWithFakeTimers();
    expect(screen.getByText("Building…")).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledTimes(1);

    // A los 9 s todavía no: la cadencia es del contrato público (§9.6 cuenta
    // estas peticiones contra el rate limit), no "cuanto antes".
    await tick(BUILD_POLL_INTERVAL_MS - 1_000);
    expect(listMock).toHaveBeenCalledTimes(1);

    await tick(1_000);
    expect(listMock).toHaveBeenCalledTimes(2);
    // Sin recargar ni tocar nada: el build terminó y la tarjeta lo refleja.
    expect(screen.queryByText("Building…")).toBeNull();
  });

  it("la lista que cambia sola se anuncia (`aria-live`) sólo mientras haya un build", async () => {
    listMock.mockResolvedValueOnce(page([piece({ status: "BUILDING" })]));
    listMock.mockResolvedValue(page([piece({ status: "CREATED" })]));

    const { container } = await mountWithFakeTimers();
    expect(container.querySelector(".fgw-content-grid")).toHaveAttribute(
      "aria-live",
      "polite",
    );

    await tick(BUILD_POLL_INTERVAL_MS);
    // Ya no cambia solo: anunciarlo sería ruido en cada refetch.
    expect(container.querySelector(".fgw-content-grid")).toHaveAttribute(
      "aria-live",
      "off",
    );
  });

  it("sin nada construyéndose, el reloj no vuelve a pedir nada", async () => {
    listMock.mockResolvedValueOnce(page([piece({ status: "CREATED" })]));
    // Si el polling siguiera, esta segunda pieza aparecería sola en pantalla.
    listMock.mockResolvedValue(
      page([piece({ status: "CREATED" }), piece({ _id: IDS[1], type: "slideshow" })]),
    );

    await mountWithFakeTimers();
    expect(screen.getByText("1 item")).toBeInTheDocument();

    await tick(BUILD_POLL_INTERVAL_MS * 3);

    // Primero lo que se ve —si el reloj hubiera seguido pidiendo, la segunda
    // pieza estaría en pantalla— y sólo después el contador de peticiones.
    //
    // Ojo con afirmar por el copy del tipo (`Slideshow`): ese texto también
    // está en los `<option>` del filtro, así que un `queryByText` lo
    // encontraría siempre y el test daría verde pasara lo que pasara. La
    // señal es la tarjeta, o sea el enlace a la ficha de la pieza.
    expect(cardLinks()).toHaveLength(1);
    expect(screen.getByText("1 item")).toBeInTheDocument();
    // Una Library abierta en una pestaña de fondo no gasta el rate limit de
    // §9.6 preguntando por piezas que ya están terminadas.
    expect(listMock).toHaveBeenCalledTimes(1);
  });
});
