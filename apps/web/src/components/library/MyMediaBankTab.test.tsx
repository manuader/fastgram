/**
 * `Library → My Media Bank` · FR-100 (PRD:1618-1626) — los cuatro estados de
 * §19, el filtro que el contrato sí tiene, y el cursor.
 *
 * ## La razón de que este archivo exista
 *
 * **Un fallo de la API no se puede ver igual que un workspace vacío.** Las dos
 * cosas son "una grid sin tarjetas", y en un Media Bank el malentendido es el
 * más caro del producto: quien lea `No images uploaded yet` después de un
 * timeout cree que perdió sus archivos. El mismo bug ya apareció en la Library
 * y tiene test allí; éste es su equivalente.
 *
 * Por eso casi todas las aserciones son sobre `statesOnScreen`, que mira los
 * cuatro estados a la vez: un test que sólo comprobara "hay un error" pasaría
 * igual con el vacío pintado debajo.
 *
 * El corte del mock es **`apiList`**, igual que en `MyContentTab.test.tsx`: lo
 * que queda bajo test es `useMediaList` y esta pantalla, no el parser de
 * `client.ts` — que tiene sus propios tests.
 */
import { mediaSchema, type Media } from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { MyMediaBankTab } from "./MyMediaBankTab";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiList: vi.fn(),
}));

// El import va después del `vi.mock` sólo para leerse en orden.
import { apiList, type CursorPage } from "@/lib/api/client";

const listMock = vi.mocked(apiList);

/** 2026-09-22T00:00:00Z — fijo, para que la fecha del pie sea comprobable. */
const UPLOADED_AT = Date.UTC(2026, 8, 22);

/**
 * Un asset **validado contra el contrato**, no un literal con un `as Media`
 * encima. El `mediaId` va marcado, así que el cast sería obligatorio — y un
 * cast convierte un fixture inválido en un test verde sobre algo que el
 * servidor nunca devolvería.
 */
function asset(overrides: Readonly<Record<string, unknown>> = {}): Media {
  return mediaSchema.parse({
    mediaId: "media-1",
    mediaType: "image",
    filename: "beach.jpg",
    r2Url: "https://cdn.example.test/beach.jpg",
    status: "ready",
    sizeMb: 2.5,
    categories: [],
    origin: "manual_upload",
    uploadedAt: UPLOADED_AT,
    ...overrides,
  });
}

function page(
  items: readonly Media[],
  next: { cursor?: string | null; hasMore?: boolean } = {},
): CursorPage<Media> {
  return { items, cursor: next.cursor ?? null, hasMore: next.hasMore ?? false };
}

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<MyMediaBankTab />, { wrapper: Wrapper });
}

/**
 * Los cuatro estados de §19, mirados a la vez.
 *
 * · `loading` — el `aria-busy` del contenedor. Los `Skeleton` son
 *   `aria-hidden`, así que es literalmente lo único que anuncia la carga.
 * · `empty`   — el copy de ERR-E04.
 * · `error`   — el `role="alert"` que pone `ErrorState`.
 * · `data`    — que haya al menos una tarjeta de asset. La forma gris del
 *   skeleton lleva **otra clase** a propósito, así que acá no se confunden.
 */
function statesOnScreen(container: HTMLElement): Record<string, boolean> {
  return {
    loading: container.querySelector('[aria-busy="true"]') !== null,
    empty: screen.queryByText("No images uploaded yet") !== null,
    error: screen.queryByRole("alert") !== null,
    data: container.querySelectorAll(".fgw-media-card").length > 0,
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

describe("los cuatro estados de §19, y uno solo por vez", () => {
  it("mientras la primera página está en vuelo: skeleton, y nada más", () => {
    listMock.mockReturnValue(new Promise(() => undefined));
    const { container } = renderTab();

    expect(statesOnScreen(container)).toEqual(ONLY.loading);
    expect(container.querySelectorAll(".fgw-media-skeleton")).toHaveLength(8);
    // La grid fantasma no se anuncia: si lo hiciera, un lector de pantalla
    // leería "lista, 8 elementos" y ninguno diría nada. Quien anuncia es el
    // `aria-busy` de arriba.
    expect(container.querySelector(".fgw-media-grid")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("un bank sin archivos es el estado vacío (ERR-E04)", async () => {
    listMock.mockResolvedValue(page([]));
    const { container } = renderTab();

    await screen.findByText("No images uploaded yet");
    expect(statesOnScreen(container)).toEqual(ONLY.empty);
  });

  it("un fallo de la API es un error, NO un bank vacío", async () => {
    listMock.mockRejectedValue(networkFailure());
    const { container } = renderTab();

    await screen.findByRole("alert");

    // Esto es todo el test. `No images uploaded yet` después de un timeout le
    // dice a alguien que perdió sus archivos, y lo que pasó fue que no se
    // pudieron pedir.
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
    listMock.mockResolvedValue(page([asset()]));
    const { container } = renderTab();

    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(statesOnScreen(container)).toEqual(ONLY.data);
    });
  });

  it("con archivos, la grid — y el contador dice cuántos", async () => {
    listMock.mockResolvedValue(
      page([asset(), asset({ mediaId: "media-2", filename: "clip.mp4" })]),
    );
    const { container } = renderTab();

    await waitFor(() => {
      expect(statesOnScreen(container)).toEqual(ONLY.data);
    });
    expect(screen.getByText("2 items")).toBeInTheDocument();
  });
});

describe("lo que dice cada tarjeta (PRD:1626)", () => {
  it("nombre, tamaño y fecha; y la categoría cuando la hay", async () => {
    listMock.mockResolvedValue(
      page([
        asset({ filename: "beach.jpg", sizeMb: 2.53, categories: ["slideshow-image"] }),
      ]),
    );
    renderTab();

    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    // Un decimal: `12 MB` esconde que un asset de 400 KB pesa algo, y
    // `2.5312 MB` es ruido. La fecha va en UTC para que dos personas del mismo
    // workspace vean lo mismo.
    expect(screen.getByText("2.5 MB · 22/09/26")).toBeInTheDocument();
    expect(screen.getByText("slide")).toBeInTheDocument();
  });

  it("un asset sin categorías se dice `Uncategorized`, no se deja en blanco", async () => {
    // FR-100: lista vacía = el asset sale de todos los pools automáticos de
    // Blitz. Es una condición con consecuencia, no la ausencia de un adorno.
    listMock.mockResolvedValue(page([asset({ categories: [] })]));
    renderTab();

    expect(await screen.findByText("Uncategorized")).toBeInTheDocument();
  });

  it("un video enseña su duración y no finge una miniatura que no existe", async () => {
    listMock.mockResolvedValue(
      page([
        asset({
          mediaId: "media-2",
          mediaType: "video",
          filename: "clip.mp4",
          categories: ["hook-video"],
          videoDurationSec: 5,
          status: "processing",
        }),
      ]),
    );
    const { container } = renderTab();

    expect(await screen.findByText("clip.mp4")).toBeInTheDocument();
    expect(screen.getByText("0:05")).toBeInTheDocument();
    // El contrato no publica poster de video: sin imagen, hueco honesto.
    expect(container.querySelector(".fgw-media-card__image")).toBeNull();
    // Y `processing` se dice: un video recién subido todavía no sirve para
    // nada, y hoy además no hay quien lo normalice.
    expect(screen.getByText("Processing")).toBeInTheDocument();
  });

  it("un asset listo no lleva cartel de estado", async () => {
    listMock.mockResolvedValue(page([asset({ status: "ready" })]));
    renderTab();

    await screen.findByText("beach.jpg");
    expect(screen.queryByText("Processing")).toBeNull();
    expect(screen.queryByText("Ready")).toBeNull();
  });
});

describe("el filtro de tipo, que es el único que el contrato tiene", () => {
  it("el tipo viaja en la query, no se queda en el estado local", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce(page([asset()]));
    listMock.mockResolvedValue(page([]));

    renderTab();
    await screen.findByText("1 item");

    await user.selectOptions(screen.getByLabelText("Type"), "video");
    await screen.findByText("No images uploaded yet");

    // Si el filtro no saliera en la petición, la grid enseñaría todo y el
    // usuario creería que el filtro no funciona.
    expect(listMock.mock.calls[1]?.[1]?.query).toMatchObject({ type: "video" });
  });

  it("un vacío CON filtro ofrece quitarlo", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce(page([asset()]));
    listMock.mockResolvedValueOnce(page([]));
    listMock.mockResolvedValue(page([asset()]));

    const { container } = renderTab();
    await screen.findByText("1 item");
    await user.selectOptions(screen.getByLabelText("Type"), "video");
    await screen.findByText("No images uploaded yet");

    await user.click(screen.getByRole("button", { name: "Clear filter" }));

    await waitFor(() => {
      expect(statesOnScreen(container)).toEqual(ONLY.data);
    });
    expect(listMock.mock.calls.at(-1)?.[1]?.query).toEqual({});
  });

  it("un bank vacío SIN filtro no ofrece quitar un filtro que no hay", async () => {
    listMock.mockResolvedValue(page([]));
    renderTab();

    await screen.findByText("No images uploaded yet");
    expect(screen.queryByRole("button", { name: "Clear filter" })).toBeNull();
  });
});

describe("paginación por cursor (PRD:2345)", () => {
  it("`Load more` pide la siguiente con el cursor y la añade a la de arriba", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce(
      page([asset(), asset({ mediaId: "media-2" })], {
        cursor: "cursor-1",
        hasMore: true,
      }),
    );
    listMock.mockResolvedValueOnce(page([asset({ mediaId: "media-3" })]));

    const { container } = renderTab();

    await screen.findByText("2 items loaded");
    await user.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() => {
      expect(screen.getByText("3 items")).toBeInTheDocument();
    });
    expect(container.querySelectorAll(".fgw-media-card")).toHaveLength(3);

    // El cursor es **opaco** y se reenvía tal cual: interpretarlo o perderlo
    // traería otra vez la primera página y el usuario vería duplicados.
    expect(listMock.mock.calls[0]?.[1]?.cursor).toBeNull();
    expect(listMock.mock.calls[1]?.[1]?.cursor).toBe("cursor-1");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("el control no aparece si el API dice que no hay más, aunque mande cursor", async () => {
    listMock.mockResolvedValue(page([asset()], { cursor: "cursor-1", hasMore: false }));
    renderTab();

    await screen.findByText("1 item");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("si falla la página siguiente, NO se borra lo que ya estaba en pantalla", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce(
      page([asset(), asset({ mediaId: "media-2" })], {
        cursor: "cursor-1",
        hasMore: true,
      }),
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

describe("sin polling (ADR-014 NO aplica acá)", () => {
  it("un asset en `processing` no genera peticiones nuevas", async () => {
    vi.useFakeTimers();
    try {
      listMock.mockResolvedValue(
        page([asset({ mediaType: "video", filename: "clip.mp4", status: "processing" })]),
      );
      renderTab();
      await vi.advanceTimersByTimeAsync(1);

      expect(listMock).toHaveBeenCalledTimes(1);
      // Treinta segundos, tres intervalos de la Library. Hoy no hay handler de
      // normalización en `apps/worker`, así que un asset en `processing` se
      // queda ahí: un intervalo sería una petición cada diez segundos, sin
      // fin, contra el límite de §9.6, y no vería cambiar nada nunca.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(listMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
