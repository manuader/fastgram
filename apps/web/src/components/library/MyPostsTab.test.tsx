/**
 * `Library → My Posts` · los cuatro estados de PRD §19, el filtro de estado,
 * el cursor y el polling.
 *
 * ## Qué se mockea, y por qué ahí
 *
 * El corte está en **`apiList`**, igual que en `MyContentTab.test.tsx` y
 * `MyMediaBankTab.test.tsx`. Mockear `fetch` obligaría a construir sobres
 * `{data, pagination}` a mano y lo que quedaría bajo test sería el parser de
 * `client.ts`, que tiene sus propios tests. Con el corte acá lo que se prueba
 * es `usePostsList` y esta pantalla.
 *
 * ## La razón de que este archivo exista
 *
 * **Un fallo de la API no se puede ver igual que un workspace vacío.** Las dos
 * cosas son "una grid sin tarjetas" y significan lo contrario. En esta tab el
 * malentendido es peor que en las otras dos: `No posts` después de un timeout
 * le dice a alguien que perdió sus publicaciones **programadas**, o sea trabajo
 * futuro que creía resuelto. Por eso casi todas las aserciones son sobre
 * `statesOnScreen`, que mira los cuatro estados a la vez: un test que sólo
 * comprobara "hay un error" pasaría igual con el vacío pintado debajo.
 */
import { postSchema, type Post } from "@fastgram/contracts";
import { ToastProvider } from "@fastgram/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTES } from "@/lib/nav/routes";
import { ApiRequestError } from "@/lib/api/errors";
import { BUILD_POLL_INTERVAL_MS } from "@/lib/library/content";
import { MyPostsTab } from "./MyPostsTab";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiList: vi.fn(),
  apiRequest: vi.fn(),
}));

// El import va después del `vi.mock` sólo para leerse en orden.
import { apiList, apiRequest, type CursorPage } from "@/lib/api/client";

const listMock = vi.mocked(apiList);

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as const;

const CONTENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** 2026-09-22T09:05:00Z — fijo, para que la fecha y la hora sean comprobables. */
const SCHEDULED_AT = Date.UTC(2026, 8, 22, 9, 5);

/**
 * Un post **validado contra el contrato**, no un literal con un `as Post`
 * encima. Los ids van marcados, así que el cast sería obligatorio — y un cast
 * convierte un fixture inválido en un test verde sobre algo que el servidor
 * nunca devolvería. `postSchema` es además `.strict()`: una clave de más acá
 * revienta el fixture en vez de pasar inadvertida.
 */
function post(overrides: Readonly<Record<string, unknown>> = {}): Post {
  return postSchema.parse({
    _id: IDS[0],
    contentId: CONTENT_ID,
    platform: "tiktok",
    accountType: "oauth",
    connectionUsername: "seefutureba",
    scheduledAtUtc: SCHEDULED_AT,
    caption: "hola",
    description: "",
    status: "SCHEDULED",
    views: 0,
    likes: 0,
    comments: 0,
    ...overrides,
  });
}

function page(
  items: readonly Post[],
  next: { cursor?: string | null; hasMore?: boolean } = {},
): CursorPage<Post> {
  return { items, cursor: next.cursor ?? null, hasMore: next.hasMore ?? false };
}

/**
 * `retry: false` contra el default del proyecto. No es para que el test sea
 * más fácil: con los reintentos puestos, un test del estado de error mide el
 * backoff de TanStack Query —que no es de esta pantalla— y se vuelve lento y
 * dependiente del reloj.
 */
function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        {/* Sprint 7: My Posts avisa con toasts (retry, cancel, refresh). */}
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    );
  }
  return render(<MyPostsTab />, { wrapper: Wrapper });
}

/**
 * Los cuatro estados de §19, mirados a la vez.
 *
 * · `loading` — el `aria-busy` del contenedor. Los `Skeleton` son
 *   `aria-hidden`, así que es lo único que anuncia la carga.
 * · `empty`   — el copy literal de §12 (PRD:2729).
 * · `error`   — el `role="alert"` que pone `ErrorState`.
 * · `data`    — que haya al menos una tarjeta de post. La forma gris del
 *   skeleton lleva **otra clase** a propósito, así que acá no se confunden.
 */
function statesOnScreen(container: HTMLElement): Record<string, boolean> {
  return {
    loading: container.querySelector('[aria-busy="true"]') !== null,
    empty: screen.queryByText("No posts") !== null,
    error: screen.queryByRole("alert") !== null,
    data: container.querySelectorAll(".fgw-post-card").length > 0,
  };
}

/**
 * Los estados **de las tarjetas**, no los del filtro.
 *
 * Hace falta porque el mismo texto está dos veces en la pantalla: en el badge
 * de la tarjeta y en los `<option>` del `<select>` de estado. Un
 * `findByText("Scheduled")` encuentra el `<option>` —que ya existe mientras la
 * petición está en vuelo— y **resuelve antes de que haya ninguna tarjeta**: el
 * test da verde sin haber mirado nunca lo que dice que mira. Pasó acá con dos
 * tests de este archivo antes de escribir este helper, y es la misma trampa que
 * `MyContentTab.test.tsx` documenta para el badge de tipo.
 */
function cardStatuses(container: HTMLElement): readonly string[] {
  return Array.from(
    container.querySelectorAll(".fgw-post-card__status"),
    (badge) => badge.textContent ?? "",
  );
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
    listMock.mockReturnValue(new Promise(() => undefined));
    const { container } = renderTab();

    expect(statesOnScreen(container)).toEqual(ONLY.loading);
    expect(container.querySelectorAll(".fgw-post-skeleton")).toHaveLength(8);
    // La grid fantasma no se anuncia: si lo hiciera, un lector de pantalla
    // leería "lista, 8 elementos" y ninguno diría nada. Quien anuncia es el
    // `aria-busy` de arriba.
    expect(container.querySelector(".fgw-post-grid")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("un workspace sin posts es el estado vacío, con su salida", async () => {
    listMock.mockResolvedValue(page([]));
    const { container } = renderTab();

    await screen.findByText("No posts");
    expect(statesOnScreen(container)).toEqual(ONLY.empty);
    // Un post nace al programar contenido: la salida es ir a crearlo, no una
    // pantalla de "nuevo post" que no existe.
    expect(screen.getByRole("link", { name: "Create content" })).toHaveAttribute(
      "href",
      ROUTES.content,
    );
  });

  it("un fallo de la API es un error, NO un workspace sin posts", async () => {
    listMock.mockRejectedValue(networkFailure());
    const { container } = renderTab();

    // Se espera a que **termine la carga**, no a que aparezca el error. La
    // diferencia es todo el valor del test: con `findByRole("alert")` delante,
    // un fallo dice "no encontré el alert" —y quien lo lea va a buscar por qué
    // no se dibuja el error— en vez de "encontré `No posts`", que es la mentira
    // concreta que este test existe para cazar. Medido: con la rama de vacío
    // puesta antes que la de error, así falla en la línea correcta.
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });

    // `No posts` después de un timeout le dice a alguien que perdió lo que
    // tenía programado, y lo que pasó fue que no se pudo pedir.
    expect(screen.queryByText("No posts")).toBeNull();
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
    listMock.mockResolvedValue(page([post()]));
    const { container } = renderTab();

    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(statesOnScreen(container)).toEqual(ONLY.data);
    });
  });

  it("con posts, la grid — y el contador dice cuántos", async () => {
    listMock.mockResolvedValue(page([post(), post({ _id: IDS[1] })]));
    const { container } = renderTab();

    await waitFor(() => {
      expect(statesOnScreen(container)).toEqual(ONLY.data);
    });
    expect(screen.getByText("2 posts")).toBeInTheDocument();
  });
});

describe("lo que dice cada tarjeta (PRD:1607-1610)", () => {
  it("plataforma, cuenta, estado, la hora programada y las tres métricas", async () => {
    listMock.mockResolvedValue(page([post({ views: 12_345, likes: 678, comments: 9 })]));
    const { container } = renderTab();

    expect(await screen.findByText("TikTok")).toBeInTheDocument();
    expect(screen.getByText("@seefutureba")).toBeInTheDocument();
    expect(cardStatuses(container)).toEqual(["Scheduled"]);
    // La zona va escrita: una hora sin zona en la pantalla que dice cuándo sale
    // un post es el ticket "lo programé para las 9 y dice las 14".
    expect(screen.getByText("Scheduled: 9:05 am UTC, 22/09/26")).toBeInTheDocument();
    // Separador de miles con locale fijo: `1.234` y `1,234` son dos números
    // distintos para el mismo dato.
    expect(screen.getByText("views 12,345")).toBeInTheDocument();
    expect(screen.getByText("likes 678")).toBeInTheDocument();
    expect(screen.getByText("comments 9")).toBeInTheDocument();
  });

  it("un post publicado enseña su fecha de publicación, no la programada", async () => {
    listMock.mockResolvedValue(
      page([
        post({
          status: "POSTED",
          postedAt: Date.UTC(2026, 8, 23, 18, 30),
          postUrl: "https://www.tiktok.com/@seefutureba/video/1",
        }),
      ]),
    );
    renderTab();

    expect(await screen.findByText("Posted: 23/09/26")).toBeInTheDocument();
    // `scheduledAtUtc` sigue en el objeto y es historia: enseñarlo haría creer
    // que el post todavía no salió.
    expect(screen.queryByText(/^Scheduled:/)).toBeNull();
    expect(screen.getByRole("link", { name: "View on TikTok" })).toHaveAttribute(
      "href",
      "https://www.tiktok.com/@seefutureba/video/1",
    );
  });

  it("un post que todavía no salió no ofrece un enlace a la plataforma", async () => {
    listMock.mockResolvedValue(page([post({ status: "SCHEDULED" })]));
    const { container } = renderTab();

    await waitFor(() => {
      expect(cardStatuses(container)).toEqual(["Scheduled"]);
    });
    // `postUrl` no existe hasta que el post sale. Un enlace muerto es peor que
    // ningún enlace.
    expect(screen.queryByRole("link", { name: /^View on/ })).toBeNull();
  });

  it("una cuenta warmed sin username dice de qué tipo es, no deja el hueco", async () => {
    // El camino warmed no rellena `connectionUsername`: el username vive en
    // `GET /warmed-accounts`. Un hueco en blanco se lee como "no hay cuenta".
    listMock.mockResolvedValue(
      page([
        post({
          accountType: "warmed",
          connectionUsername: undefined,
          warmedAccountId: "wa_1",
        }),
      ]),
    );
    renderTab();

    expect(await screen.findByText("Warmed account")).toBeInTheDocument();
  });

  it("un post fallido enseña el motivo que el servidor declara seguro", async () => {
    // FR-060 (PRD:1394): `errorMessage` es "siempre seguro de mostrar". Sin él,
    // un post fallido no dice por qué y sólo se puede reintentar a ciegas.
    listMock.mockResolvedValue(
      page([
        post({
          status: "FAILED",
          errorCode: "instagram_repeated_mention",
          errorMessage: "Instagram rejected the caption: repeated mention.",
        }),
      ]),
    );
    const { container } = renderTab();

    expect(
      await screen.findByText("Instagram rejected the caption: repeated mention."),
    ).toBeInTheDocument();
    expect(cardStatuses(container)).toEqual(["Failed"]);
  });
});

/**
 * Los tres estados de FR-060 que tienen consecuencia si no se dicen. No son
 * adornos: dos de ellos llevan a que alguien haga algo que duplica o rompe un
 * post.
 */
describe("los avisos que FR-060 documenta con consecuencia", () => {
  it("`IN_USER_INBOX` es pendiente de acción del usuario, NO un error (PRD:1414)", async () => {
    listMock.mockResolvedValue(page([post({ status: "IN_USER_INBOX" })]));
    const { container } = renderTab();

    await screen.findByText(/isn't live until you open the app/);

    // La aserción negativa primero, que es la que importa: pintarlo de rojo
    // haría que alguien republicara un post que TikTok ya aceptó, y eso sí es
    // un duplicado.
    expect(container.querySelector(".fgw-post-card__status.fg-badge--danger")).toBeNull();
    expect(
      container.querySelector(".fgw-post-card__status.fg-badge--warning"),
    ).not.toBeNull();
    expect(cardStatuses(container)).toEqual(["Waiting in your TikTok inbox"]);
  });

  it("el carril lento de TikTok avisa de NO reprogramar (PRD:1392)", async () => {
    listMock.mockResolvedValue(
      page([post({ status: "UPLOADING_TO_TIKTOK", tiktokProcessingDelayed: true })]),
    );
    const { container } = renderTab();

    // Es el aviso más caro de la pantalla: reprogramar con el flag puesto
    // publica el post dos veces.
    expect(await screen.findByText(/Don't reschedule it/)).toBeInTheDocument();
    expect(cardStatuses(container)).toEqual(["Uploading to TikTok"]);
  });

  it("un post normal no lleva ningún aviso", async () => {
    listMock.mockResolvedValue(page([post({ status: "SCHEDULED" })]));
    const { container } = renderTab();

    // Se espera a que la **tarjeta** exista: esperar por el texto `Scheduled`
    // resolvería contra el `<option>` del filtro, que ya está ahí durante la
    // carga, y entonces esto comprobaría que una pantalla vacía no tiene avisos.
    await waitFor(() => {
      expect(cardStatuses(container)).toEqual(["Scheduled"]);
    });
    expect(container.querySelector(".fgw-post-card__notice")).toBeNull();
  });
});

describe("el filtro de estado, que es el único que el contrato tiene", () => {
  it("el estado viaja en la query, no se queda en el estado local", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce(page([post()]));
    listMock.mockResolvedValue(page([]));

    renderTab();
    await screen.findByText("1 post");

    await user.selectOptions(screen.getByLabelText("Status"), "POSTED");
    await screen.findByText("No posts");

    // Si el filtro no saliera en la petición, la grid enseñaría todo y el
    // usuario creería que el filtro no funciona.
    expect(listMock.mock.calls[1]?.[1]?.query).toMatchObject({ status: "POSTED" });
  });

  it("`CANCELLED` no es una opción: el contrato no lo acepta como filtro", async () => {
    listMock.mockResolvedValue(page([]));
    renderTab();

    await screen.findByText("No posts");
    const options = Array.from(
      screen.getByLabelText("Status").querySelectorAll("option"),
      (option) => option.value,
    );
    // §12 (PRD:2729) omite `CANCELLED` de la lista filtrable aunque FR-060 lo
    // declare estado válido, y `listPostsQuerySchema` es `.strict()`: mandarlo
    // sería un 400. Dibujar la opción prometería un filtro que devuelve error.
    expect(options).not.toContain("CANCELLED");
    expect(options).toContain("POSTED");
    expect(options).toHaveLength(10); // los nueve filtrables + "All statuses"
  });

  it("un vacío CON filtro ofrece quitarlo, no ir a crear contenido", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce(page([post()]));
    listMock.mockResolvedValueOnce(page([]));
    listMock.mockResolvedValue(page([post()]));

    const { container } = renderTab();
    await screen.findByText("1 post");
    await user.selectOptions(screen.getByLabelText("Status"), "POSTED");
    await screen.findByText("No posts");

    // `Create content` mandaría a crear una pieza a alguien que tiene cien
    // posts y sólo puso mal un filtro.
    expect(screen.queryByRole("link", { name: "Create content" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear filter" }));

    await waitFor(() => {
      expect(statesOnScreen(container)).toEqual(ONLY.data);
    });
    expect(listMock.mock.calls.at(-1)?.[1]?.query).toEqual({});
  });
});

describe("paginación por cursor (PRD:2345)", () => {
  it("`Load more` pide la siguiente con el cursor y la añade a la de arriba", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce(
      page([post(), post({ _id: IDS[1] })], { cursor: "cursor-1", hasMore: true }),
    );
    listMock.mockResolvedValueOnce(page([post({ _id: IDS[2] })]));

    const { container } = renderTab();

    await screen.findByText("2 posts loaded");
    await user.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() => {
      expect(screen.getByText("3 posts")).toBeInTheDocument();
    });
    expect(container.querySelectorAll(".fgw-post-card")).toHaveLength(3);

    // El cursor es **opaco** y se reenvía tal cual: interpretarlo o perderlo
    // traería otra vez la primera página y el usuario vería duplicados.
    expect(listMock.mock.calls[0]?.[1]?.cursor).toBeNull();
    expect(listMock.mock.calls[1]?.[1]?.cursor).toBe("cursor-1");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("si falla la página siguiente, NO se borra lo que ya estaba en pantalla", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce(
      page([post(), post({ _id: IDS[1] })], { cursor: "cursor-1", hasMore: true }),
    );
    listMock.mockRejectedValueOnce(networkFailure());

    const { container } = renderTab();
    await screen.findByText("2 posts loaded");
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
 * Polling · la misma cadencia de ADR-014 / NFR-002 (PRD:2961), y **sólo** para
 * `BUILDING`.
 *
 * ## Temporizadores falsos, y la trampa que ya costó una tarde
 *
 * `waitFor` de `@testing-library/dom` **no sabe avanzar los temporizadores
 * falsos de vitest**: su detección arranca con `typeof jest !== "undefined"` y
 * en vitest eso es `undefined`, así que espera con el reloj parado y el test
 * muere por timeout. Por eso acá no hay `waitFor`: se avanza a mano con
 * `vi.advanceTimersByTimeAsync` dentro de `act`.
 */
describe("polling: sólo mientras un post se está construyendo", () => {
  /**
   * Avanza el reloj falso `ms` y deja que React llegue a pintar.
   *
   * El milisegundo de más no es superstición: TanStack Query agenda la
   * notificación al observador con `setTimeout(cb, 0)` **durante** el mismo
   * tick, y `advanceTimersByTimeAsync(0)` no lo corre. Sin él, la caché queda
   * actualizada y la pantalla con los datos viejos, y el test falla como si el
   * componente no reaccionara.
   */
  async function tick(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
      await vi.advanceTimersByTimeAsync(1);
    });
  }

  async function mountWithFakeTimers() {
    vi.useFakeTimers();
    const rendered = renderTab();
    await tick(0);
    return rendered;
  }

  it("un post en BUILDING se vuelve a pedir a los 10 s y la pantalla se entera sola", async () => {
    listMock.mockResolvedValueOnce(page([post({ status: "BUILDING" })]));
    listMock.mockResolvedValue(page([post({ status: "SCHEDULED" })]));

    const { container } = await mountWithFakeTimers();
    expect(cardStatuses(container)).toEqual(["Building"]);
    expect(listMock).toHaveBeenCalledTimes(1);

    // A los 9 s todavía no: la cadencia es del contrato público (§9.6 cuenta
    // estas peticiones contra el rate limit), no "cuanto antes".
    await tick(BUILD_POLL_INTERVAL_MS - 1_000);
    expect(listMock).toHaveBeenCalledTimes(1);

    await tick(1_000);
    expect(listMock).toHaveBeenCalledTimes(2);
    // Sin recargar ni tocar nada: el build terminó y la tarjeta lo refleja.
    expect(cardStatuses(container)).toEqual(["Scheduled"]);
  });

  it("un post en UPLOADING_TO_TIKTOK NO genera peticiones: el carril lento dura 72 h", async () => {
    listMock.mockResolvedValue(
      page([post({ status: "UPLOADING_TO_TIKTOK", tiktokProcessingDelayed: true })]),
    );

    await mountWithFakeTimers();
    expect(listMock).toHaveBeenCalledTimes(1);

    // Treinta segundos, tres intervalos. NFR-015 (PRD:1392) da hasta 72 h de
    // carril lento: un intervalo de 10 s contra eso son ~26 000 peticiones sin
    // ver cambiar nada, que es la trampa que `lib/media/media.ts` documenta
    // para `processing`.
    await tick(30_000);
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("un post SCHEDULED a días vista tampoco despierta el reloj", async () => {
    listMock.mockResolvedValue(page([post({ status: "SCHEDULED" })]));

    await mountWithFakeTimers();
    expect(screen.getByText("1 post")).toBeInTheDocument();

    await tick(BUILD_POLL_INTERVAL_MS * 3);
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("la lista que cambia sola se anuncia (`aria-live`) sólo mientras haya un build", async () => {
    listMock.mockResolvedValueOnce(page([post({ status: "BUILDING" })]));
    listMock.mockResolvedValue(page([post({ status: "SCHEDULED" })]));

    const { container } = await mountWithFakeTimers();
    expect(container.querySelector(".fgw-post-grid")).toHaveAttribute(
      "aria-live",
      "polite",
    );

    await tick(BUILD_POLL_INTERVAL_MS);
    // Ya no cambia solo: anunciarlo sería ruido en cada refetch.
    expect(container.querySelector(".fgw-post-grid")).toHaveAttribute("aria-live", "off");
  });
});

// ── Sprint 7 (publish-flow): acciones por tarjeta y modo Select ─────────────

describe("acciones sobre posts (sprint 7)", () => {
  it("un fallido ofrece Retry, que re-encola con POST /posts/:id/retry", async () => {
    const user = userEvent.setup();
    const requestMock = vi.mocked(apiRequest);
    requestMock.mockReset();
    requestMock.mockResolvedValue(post({ status: "SCHEDULED" }) as never);
    listMock.mockResolvedValue(
      page([post({ status: "FAILED", errorCode: "unknown", errorMessage: "No salió." })]),
    );
    renderTab();
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalled();
    });
    expect(requestMock.mock.calls[0]?.[0]).toBe(`posts/${IDS[0]}/retry`);
  });

  it("un programado ofrece Edit y Cancel; uno publicado, ninguno", async () => {
    listMock.mockResolvedValue(
      page([
        post({ _id: IDS[0], status: "SCHEDULED" }),
        post({ _id: IDS[1], status: "POSTED", postedAt: SCHEDULED_AT }),
      ]),
    );
    renderTab();
    expect(await screen.findAllByRole("button", { name: "Edit" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
  });

  it("Select muestra casillas y la barra de lote; Delete pide confirmar", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue(page([post({ _id: IDS[0] }), post({ _id: IDS[1] })]));
    renderTab();
    await user.click(await screen.findByRole("button", { name: "Select" }));
    const boxes = screen.getAllByRole("checkbox", { name: "Select this post" });
    expect(boxes).toHaveLength(2);
    await user.click(boxes[0] as HTMLElement);
    expect(screen.getByText("1 selected")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Delete 1 post(s)?")).toBeTruthy();
  });
});
