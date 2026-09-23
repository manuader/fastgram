/**
 * `/calendar` · F-140..F-143: los estados de FR-110, los chips, los contadores,
 * la navegación y el tope de paginación.
 *
 * ## Qué se mockea
 *
 * `apiList`, como en las tabs de la Library: lo que queda bajo test es
 * `lib/calendar/data.ts` y esta pantalla, no el parser de `client.ts`. El mock
 * **despacha por ruta**, porque la vista pide dos listados (`/posts` y
 * `/content`) y un mock que devolviera lo mismo a los dos haría pasar el join
 * de tipos por casualidad.
 *
 * ## El reloj y la zona van por prop, no con `vi.useFakeTimers`
 *
 * Con los timers falsos, `waitFor`/`findBy*` —que esperan con `setTimeout`— no
 * avanzan y el test se cuelga o expira. `now` y `timeZone` son props de la
 * vista justo para esto: cada test fija las dos y ninguno depende de la zona
 * ni del día de la máquina.
 *
 * ## Cómo se espera
 *
 * La señal neutral es que la sección deje de estar `aria-busy` (trampa 38 del
 * HANDOFF): es verdadera tanto si se dibuja el dato como el vacío o el error,
 * así que las negativas que vienen después miden lo que dicen medir.
 */
import {
  contentSchema,
  postSchema,
  type Content,
  type ContentType,
  type Post,
} from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { CALENDAR_MAX_PAGES } from "@/lib/calendar/data";
import { CalendarView } from "./CalendarView";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiList: vi.fn(),
}));

import { apiList, type ApiListOptions, type CursorPage } from "@/lib/api/client";

const listMock = vi.mocked(apiList);

const BA = "America/Argentina/Buenos_Aires";
/** "Ahora": martes 22 de septiembre de 2026, 15:00 en Buenos Aires. */
const NOW = Date.UTC(2026, 8, 22, 18, 0);

let seq = 0;
function uuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

function post(overrides: Readonly<Record<string, unknown>> = {}): Post {
  return postSchema.parse({
    _id: uuid(),
    contentId: uuid(),
    platform: "tiktok",
    accountType: "oauth",
    scheduledAtUtc: Date.UTC(2026, 8, 22, 14, 56), // 11:56 AM en BA
    caption: "",
    description: "",
    status: "SCHEDULED",
    views: 0,
    likes: 0,
    comments: 0,
    ...overrides,
  });
}

function content(id: string, type: ContentType): Content {
  return contentSchema.parse({
    _id: id,
    type,
    status: "CREATED",
    files: [],
    revision: 0,
  });
}

function contentFor(posts: readonly Post[], type: ContentType = "slideshow"): Content[] {
  return posts.map((p) => content(p.contentId, type));
}

type Pages<T> = readonly (readonly T[])[];

/**
 * Un servidor de mentira con cursor: la página `n` se pide con cursor `"n"`.
 * Un `Error` en lugar de páginas hace fallar todas las de esa ruta.
 */
function serve(
  postPages: Pages<Post> | Error,
  contentPages: Pages<Content> | Error = [[]],
  options: { endless?: boolean } = {},
): void {
  listMock.mockImplementation((path: string, opts?: ApiListOptions<unknown>) => {
    const pages = path === "/posts" ? postPages : contentPages;
    if (pages instanceof Error) return Promise.reject(pages);
    const index =
      opts?.cursor === undefined || opts.cursor === null ? 0 : Number(opts.cursor);
    const items = pages[index] ?? [];
    const hasMore = options.endless === true || index < pages.length - 1;
    const page: CursorPage<unknown> = {
      items,
      cursor: hasMore ? String(index + 1) : null,
      hasMore,
    };
    return Promise.resolve(page);
  });
}

function renderView(props: { timeZone?: string; now?: number } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<CalendarView timeZone={props.timeZone ?? BA} now={props.now ?? NOW} />, {
    wrapper: Wrapper,
  });
}

function section(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".fgw-calendar");
  if (el === null) throw new Error("no .fgw-calendar");
  return el;
}

async function settled(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    expect(section(container)).toHaveAttribute("aria-busy", "false");
  });
}

function cell(container: HTMLElement, key: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`td[data-day="${key}"]`);
  if (el === null) throw new Error(`no hay celda ${key}`);
  return el;
}

function chipTitles(el: HTMLElement): string[] {
  return Array.from(
    el.querySelectorAll(".fgw-cal-chip__title"),
    (n) => n.textContent ?? "",
  );
}

function postCalls(): number {
  return listMock.mock.calls.filter(([path]) => path === "/posts").length;
}

beforeEach(() => {
  listMock.mockReset();
});

describe("los estados de FR-110 (PRD:1664)", () => {
  it("loading: la cuadrícula sin chips ni contadores, y `aria-busy`", () => {
    listMock.mockReturnValue(new Promise(() => undefined));
    const { container } = renderView();

    expect(section(container)).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("heading", { name: "September 2026" })).toBeInTheDocument();
    expect(container.querySelectorAll(".fgw-cal-chip")).toHaveLength(0);
    expect(screen.queryByRole("list", { name: "Post totals" })).toBeNull();
    expect(screen.queryByText("No posts")).toBeNull();
  });

  it("un fallo de la API es un error, NO un mes vacío", async () => {
    serve(new ApiRequestError({ code: "network_error", status: 0 }));
    const { container } = renderView();

    await settled(container);
    // Negativas primero: `No posts` tras un timeout le dice a alguien que no
    // tiene nada programado.
    expect(screen.queryByText("No posts")).toBeNull();
    expect(screen.queryByRole("list", { name: "Post totals" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("desde el error se vuelve a pedir y aparece el mes", async () => {
    const user = userEvent.setup();
    const p = post();
    serve(new ApiRequestError({ code: "network_error", status: 0 }), [contentFor([p])]);
    const { container } = renderView();
    await screen.findByRole("alert");

    serve([[p]], [contentFor([p])]);
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(chipTitles(cell(container, "2026-09-22"))).toEqual(["TikTok: Slideshow"]);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("empty: un mes sin posts dice `No posts`, aunque otros meses tengan", async () => {
    const october = post({ scheduledAtUtc: Date.UTC(2026, 9, 10, 15, 0) });
    serve([[october]], [contentFor([october])]);
    const { container } = renderView();

    await settled(container);
    expect(screen.getByText("No posts")).toBeInTheDocument();
    expect(
      screen.getByText("Nothing is scheduled or posted in September 2026."),
    ).toBeInTheDocument();
    // La cuadrícula sigue: desde un mes vacío se navega al que tiene posts.
    expect(screen.getByRole("table")).toBeInTheDocument();
    // Y los contadores son globales: el post de octubre cuenta.
    expect(screen.getByText("1 scheduled")).toBeInTheDocument();
  });
});

describe("chips (F-141) y contador por día (F-142)", () => {
  it("cada chip: `Plataforma: Tipo`, la hora y el tono de la plataforma, ordenados por hora", async () => {
    const late = post({
      platform: "instagram",
      scheduledAtUtc: Date.UTC(2026, 8, 23, 2, 56),
    });
    const early = post({
      platform: "youtube",
      scheduledAtUtc: Date.UTC(2026, 8, 22, 12, 5),
    });
    const posts = [late, early]; // el API los da por creación, no por hora
    serve(
      [posts],
      [
        [
          content(late.contentId, "wall-of-text"),
          content(early.contentId, "green-screen"),
        ],
      ],
    );
    const { container } = renderView();
    await settled(container);

    // 02:56Z del 23 es 11:56 PM del 22 en Buenos Aires: mismo día, último.
    const day = cell(container, "2026-09-22");
    expect(chipTitles(day)).toEqual(["YouTube: Green Screen", "Instagram: Wall of Text"]);
    expect(
      Array.from(day.querySelectorAll(".fgw-cal-chip__time"), (n) => n.textContent),
    ).toEqual(["9:05 AM", "11:56 PM"]);
    expect(
      Array.from(day.querySelectorAll(".fgw-cal-chip"), (n) =>
        n.getAttribute("data-tone"),
      ),
    ).toEqual(["youtube", "instagram"]);
    expect(cell(container, "2026-09-23").querySelectorAll(".fgw-cal-chip")).toHaveLength(
      0,
    );
  });

  it("`(N posts)` junto al número, y la celda se nombra con la cantidad", async () => {
    const posts = [post(), post(), post({ scheduledAtUtc: Date.UTC(2026, 8, 5, 15) })];
    serve([posts], [contentFor(posts)]);
    const { container } = renderView();
    await settled(container);

    const day22 = cell(container, "2026-09-22");
    expect(within(day22).getByText("(2 posts)")).toBeInTheDocument();
    // Hoy (22) lo dice la etiqueta y `aria-current`.
    expect(day22).toHaveAttribute("aria-current", "date");
    expect(
      within(day22).getByText("Today, Tuesday, September 22, 2 posts"),
    ).toBeInTheDocument();

    const day5 = cell(container, "2026-09-05");
    expect(within(day5).getByText("(1 post)")).toBeInTheDocument();
    expect(within(day5).getByText("Saturday, September 5, 1 post")).toBeInTheDocument();
    expect(day5).not.toHaveAttribute("aria-current");

    const day6 = cell(container, "2026-09-06");
    expect(day6.querySelector(".fgw-calendar__day-count")).toBeNull();
    expect(within(day6).getByText("Sunday, September 6, no posts")).toBeInTheDocument();
  });

  it("borde de mes: 23:30 del 30/09 en Buenos Aires es septiembre acá y octubre en UTC", async () => {
    const edge = post({ scheduledAtUtc: Date.UTC(2026, 9, 1, 2, 30) });
    serve([[edge]], [contentFor([edge])]);

    const ba = renderView({ timeZone: BA });
    await settled(ba.container);
    expect(chipTitles(cell(ba.container, "2026-09-30"))).toEqual(["TikTok: Slideshow"]);
    expect(screen.queryByText("No posts")).toBeNull();
    ba.unmount();

    const utc = renderView({ timeZone: "UTC" });
    await settled(utc.container);
    expect(chipTitles(cell(utc.container, "2026-09-30"))).toEqual([]);
    expect(screen.getByText("No posts")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(chipTitles(cell(utc.container, "2026-10-01"))).toEqual(["TikTok: Slideshow"]);
  });

  it("sin la pieza en `GET /content`, el chip dice sólo la plataforma y la pantalla lo avisa", async () => {
    const known = post({ platform: "instagram" });
    const orphan = post();
    serve([[known, orphan]], [[content(known.contentId, "video-hook")]]);
    const { container } = renderView();
    await settled(container);

    expect(chipTitles(cell(container, "2026-09-22")).sort()).toEqual([
      "Instagram: Video Hook",
      "TikTok",
    ]);
    expect(
      screen.getByText(
        "Some posts don't show their content type because it couldn't be loaded.",
      ),
    ).toBeInTheDocument();
  });

  it("si `GET /content` falla, el calendario sigue en pie sin tipos", async () => {
    const p = post();
    serve([[p]], new ApiRequestError({ code: "network_error", status: 0 }));
    const { container } = renderView();
    await settled(container);

    expect(chipTitles(cell(container, "2026-09-22"))).toEqual(["TikTok"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("contadores de cabecera (F-143)", () => {
  it("✓ publicados, 📥 inbox, 📅 programados — contra los estados reales", async () => {
    const posts = [
      post({ status: "POSTED", postedAt: Date.UTC(2026, 8, 1, 15) }),
      post({ status: "POSTED", postedAt: Date.UTC(2026, 7, 1, 15) }),
      post({ status: "IN_USER_INBOX" }),
      post({ status: "SCHEDULED" }),
      post({ status: "BUILDING" }),
      post({ status: "FAILED" }),
      post({ status: "CANCELLED" }),
    ];
    serve([posts], [contentFor(posts)]);
    const { container } = renderView();
    await settled(container);

    const counters = screen.getByRole("list", { name: "Post totals" });
    expect(within(counters).getByText("2 posted")).toBeInTheDocument();
    expect(within(counters).getByText("1 in inbox")).toBeInTheDocument();
    expect(within(counters).getByText("2 scheduled")).toBeInTheDocument();
    expect(
      Array.from(
        counters.querySelectorAll(".fgw-calendar__counter-value"),
        (n) => n.textContent,
      ),
    ).toEqual(["2", "1", "2"]);
  });
});

describe("navegación ‹ › (F-140)", () => {
  it("el título `MMMM YYYY` sigue a los botones, y sin pedir otra vez a la API", async () => {
    const user = userEvent.setup();
    serve([[]]);
    const { container } = renderView();
    await settled(container);
    const calls = listMock.mock.calls.length;

    expect(screen.getByRole("heading", { name: "September 2026" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByRole("heading", { name: "October 2026" })).toBeInTheDocument();
    expect(container.querySelector('td[data-day="2026-10-31"]')).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByRole("heading", { name: "August 2026" })).toBeInTheDocument();
    // "Navegación mensual sin recarga" (PRD:1662): los datos ya están.
    expect(listMock.mock.calls.length).toBe(calls);
  });

  it("cruza el año en los dos sentidos", async () => {
    const user = userEvent.setup();
    serve([[]]);
    const { container } = renderView({ now: Date.UTC(2026, 11, 15, 15) });
    await settled(container);

    expect(screen.getByRole("heading", { name: "December 2026" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByRole("heading", { name: "January 2027" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByRole("heading", { name: "November 2026" })).toBeInTheDocument();
  });

  it("abre en el mes de hoy **en la zona de la vista**: 1/10 02:00Z es septiembre en Buenos Aires", async () => {
    serve([[]]);
    const { container } = renderView({ now: Date.UTC(2026, 9, 1, 2, 0) });
    await settled(container);
    expect(screen.getByRole("heading", { name: "September 2026" })).toBeInTheDocument();
    expect(cell(container, "2026-09-30")).toHaveAttribute("aria-current", "date");
  });
});

describe("el tope de paginación (GET /posts no filtra por fecha)", () => {
  it("pide páginas solas hasta el final cuando el final llega antes del tope", async () => {
    const first = [post()];
    const second = [post({ scheduledAtUtc: Date.UTC(2026, 8, 3, 15) })];
    serve([first, second], [contentFor([...first, ...second])]);
    const { container } = renderView();
    await settled(container);

    expect(postCalls()).toBe(2);
    expect(chipTitles(cell(container, "2026-09-03"))).toEqual(["TikTok: Slideshow"]);
    expect(screen.getByText("2 scheduled")).toBeInTheDocument();
    expect(screen.queryByText(/most recently created posts/)).toBeNull();
  });

  it("se detiene en el tope, lo dice, y los contadores pasan a ser un mínimo", async () => {
    const pages = Array.from({ length: CALENDAR_MAX_PAGES }, () => [
      post({ status: "POSTED", postedAt: Date.UTC(2026, 8, 10, 15) }),
    ]);
    serve(pages, [[]], { endless: true });
    const { container } = renderView();
    await settled(container);

    expect(postCalls()).toBe(CALENDAR_MAX_PAGES);
    expect(
      screen.getByText(/Showing the 500 most recently created posts/),
    ).toBeInTheDocument();
    const counters = screen.getByRole("list", { name: "Post totals" });
    expect(within(counters).getByText("At least 5 posted")).toBeInTheDocument();
    expect(
      Array.from(
        counters.querySelectorAll(".fgw-calendar__counter-value"),
        (n) => n.textContent,
      ),
    ).toEqual(["5+", "0+", "0+"]);
  });

  it("un mes vacío con la lista cortada no se afirma vacío", async () => {
    serve([[post({ scheduledAtUtc: Date.UTC(2026, 9, 3, 15) })]], [[]], {
      endless: true,
    });
    const { container } = renderView();
    await settled(container);
    expect(
      screen.getByText(
        "Nothing loaded for September 2026. Older posts aren't loaded, so this month may not be empty.",
      ),
    ).toBeInTheDocument();
  });

  it("si falla una página que no es la primera, lo cargado se queda y el error se ve", async () => {
    const p = post();
    let postCall = 0;
    listMock.mockImplementation((path: string) => {
      if (path !== "/posts")
        return Promise.resolve({ items: [], cursor: null, hasMore: false });
      postCall += 1;
      if (postCall === 1)
        return Promise.resolve({ items: [p], cursor: "1", hasMore: true });
      return Promise.reject(new ApiRequestError({ code: "network_error", status: 0 }));
    });
    const { container } = renderView();
    await settled(container);

    expect(container.querySelectorAll(".fgw-cal-chip")).toHaveLength(1);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("No posts")).toBeNull();
    expect(screen.getByText("At least 1 scheduled")).toBeInTheDocument();
    expect(postCall).toBe(2);
  });

  it("reintentar una página que sigue fallando pide UNA vez, no entra en bucle", async () => {
    // La guarda `!isError` de `useCollectedList` es lo único que impide que el
    // efecto vuelva a pedir la página que acaba de fallar. Con un rechazo
    // **inmediato** del mock (como en el test anterior) el bucle no se ve ni
    // quitándola: TanStack resuelve dentro del mismo lote, no hay render con
    // `isFetching: true` y el efecto no ve el flanco (medido: 2 peticiones con
    // y sin guarda). Con el fallo llegando tarde, como en la red, sin la guarda
    // ya el primer error dispara otra petición: `expected 3 to be 2`.
    const user = userEvent.setup();
    let postCall = 0;
    listMock.mockImplementation((path: string) => {
      if (path !== "/posts")
        return Promise.resolve({ items: [], cursor: null, hasMore: false });
      postCall += 1;
      if (postCall === 1)
        return Promise.resolve({ items: [post()], cursor: "1", hasMore: true });
      // El fallo llega **tarde**, como en la red. Con un rechazo inmediato,
      // TanStack resuelve la petición dentro del mismo lote y el render con
      // `isFetching: true` no llega a existir: sin ese render el efecto no ve
      // ningún flanco y el bucle no se reproduce ni con la guarda quitada.
      return new Promise((_, reject) => {
        setTimeout(() => {
          reject(new ApiRequestError({ code: "network_error", status: 0 }));
        }, 10);
      });
    });
    renderView();
    await screen.findByRole("alert");
    const afterFirstError = postCall;

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(postCall).toBeGreaterThan(afterFirstError);
    });
    // Espera real: un bucle arrancaría después del segundo error, no antes.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(afterFirstError).toBe(2);
    expect(postCall).toBe(3);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
