/**
 * `/calendar` · FR-110 + `PU-CAL-002`: estados, chips por red, semana/mes,
 * filtro de marcas y arrastrar para mover.
 *
 * ## Qué se mockea
 *
 * `apiRequest`: lo que queda bajo test es la pantalla, `lib/calendar/data.ts` y
 * `lib/calendar/board.ts`. El mock despacha por método y ruta.
 *
 * ## El arrastre, sin puntero
 *
 * jsdom no tiene layout: `getBoundingClientRect` da ceros y los sensores de
 * dnd-kit no pueden calcular sobre qué celda se soltó. Así que el test envuelve
 * el `DndContext` real para quedarse con su `onDragEnd` y lo llama con el
 * evento que dnd-kit entregaría (`active.id` del chip, `over.id` de la celda).
 * Lo que se mide es lo nuestro: qué se le pide a la API al soltar, el salto
 * optimista y que lo que no se mueve no dispare nada. Que dnd-kit detecte la
 * celda bajo el puntero es de dnd-kit.
 *
 * ## El reloj y la zona van por prop
 *
 * Con timers falsos `waitFor` no avanza. `now` y `timeZone` son props.
 */
import type { Calendar, CalendarItem } from "@fastgram/contracts";
import { calendarSchema } from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import type * as ApiClient from "@/lib/api/client";
import type * as Dnd from "@dnd-kit/core";
import { CalendarView } from "./CalendarView";

let lastDragEnd: ((event: Dnd.DragEndEvent) => void) | undefined;

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof Dnd>();
  function DndContext(props: ComponentProps<typeof actual.DndContext>) {
    lastDragEnd = props.onDragEnd;
    return <actual.DndContext {...props} />;
  }
  return { ...actual, DndContext };
});

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

import { apiRequest, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

const BA = "America/Argentina/Buenos_Aires";
/** Martes 22 de septiembre de 2026, 15:00 en Buenos Aires. */
const NOW = Date.UTC(2026, 8, 22, 18, 0);
const BRAND_A = "00000000-0000-4000-8000-00000000000a";
const BRAND_B = "00000000-0000-4000-8000-00000000000b";

let seq = 0;
function uuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

function item(over: Partial<CalendarItem> = {}): CalendarItem {
  return {
    kind: "post",
    id: uuid(),
    brandId: BRAND_A,
    brandName: "Acme",
    contentId: uuid() as CalendarItem["contentId"],
    contentType: "slideshow",
    network: "tiktok",
    status: "SCHEDULED",
    at: Date.UTC(2026, 8, 23, 12, 7), // miércoles 09:07 en BA
    movable: true,
    ...over,
  };
}

function calendar(
  items: readonly CalendarItem[],
  over: Partial<Calendar> = {},
): Calendar {
  return calendarSchema.parse({
    items,
    brands: [{ id: BRAND_A, name: "Acme", timezone: BA }],
    counts: { posted: 3, inbox: 1, scheduled: items.length },
    truncated: false,
    ...over,
  });
}

type Handler = (path: string, options: ApiRequestOptions<unknown>) => Promise<unknown>;

function serve(handler: Handler): void {
  requestMock.mockImplementation(((
    path: string,
    options: ApiRequestOptions<unknown> = {},
  ) => handler(path, options)) as typeof apiRequest);
}

function getCalls(): ApiRequestOptions<unknown>[] {
  return requestMock.mock.calls
    .filter(
      ([path, options]) => path === "calendar" && (options?.method ?? "GET") === "GET",
    )
    .map(([, options]) => options ?? {});
}

function renderView(props: { initialView?: "week" | "month" } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<CalendarView timeZone={BA} now={NOW} {...props} />, {
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

function chips(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(".fgw-cal-chip"));
}

beforeEach(() => {
  requestMock.mockReset();
  lastDragEnd = undefined;
});

describe("los estados de FR-110", () => {
  it("loading: la grilla sin chips y `aria-busy`", () => {
    requestMock.mockReturnValue(new Promise(() => undefined));
    const { container } = renderView();
    expect(section(container)).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("heading", { name: "September 2026" })).toBeInTheDocument();
    expect(chips(container)).toHaveLength(0);
    expect(screen.queryByText("No posts")).toBeNull();
  });

  it("un fallo de la API es un error, NO un mes vacío", async () => {
    serve(() =>
      Promise.reject(new ApiRequestError({ code: "network_error", status: 0 })),
    );
    const { container } = renderView();
    await settled(container);
    expect(screen.queryByText("No posts")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("vacío: la grilla y el estado vacío", async () => {
    serve(() => Promise.resolve(calendar([])));
    const { container } = renderView();
    await settled(container);
    expect(screen.getByText("No posts")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});

describe("la vista mes", () => {
  it("pide el rango del mes con un día de margen y dibuja cada ítem en su día y hora", async () => {
    const post = item();
    const slot = item({
      kind: "slot",
      network: "x",
      status: "PLANNED",
      at: Date.UTC(2026, 8, 25, 22, 0),
    });
    serve(() => Promise.resolve(calendar([post, slot])));
    const { container } = renderView();
    await settled(container);

    const query = getCalls()[0]?.query ?? {};
    // 31-ago 00:00 BA → 2-oct 00:00 BA.
    expect(query["from"]).toBe(Date.UTC(2026, 7, 31, 3, 0));
    expect(query["to"]).toBe(Date.UTC(2026, 9, 2, 3, 0));
    expect(query["brands"]).toBe("current");

    const wed = chips(cell(container, "2026-09-23"));
    expect(wed).toHaveLength(1);
    expect(wed[0]).toHaveTextContent("TikTok: Slideshow");
    expect(wed[0]).toHaveTextContent("9:07 AM");
    expect(wed[0]).toHaveAttribute("data-network", "tiktok");

    const fri = chips(cell(container, "2026-09-25"));
    expect(fri[0]).toHaveTextContent("(Planned)");
    expect(fri[0]).toHaveAttribute("data-kind", "slot");
    expect(fri[0]).toHaveTextContent("7:00 PM");

    expect(
      screen.getByText(
        "Days and times are in Acme's time zone (America/Argentina/Buenos_Aires).",
        { exact: false },
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Post totals" })).getByText("3"),
    ).toBeInTheDocument();
  });

  it("la navegación pide el mes siguiente", async () => {
    const user = userEvent.setup();
    serve(() => Promise.resolve(calendar([])));
    const { container } = renderView();
    await settled(container);
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(
      await screen.findByRole("heading", { name: "October 2026" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(getCalls().at(-1)?.query?.["from"]).toBe(Date.UTC(2026, 8, 30, 3, 0));
    });
  });
});

describe("la vista semana", () => {
  it("pide sólo la semana y muestra la miniatura", async () => {
    const user = userEvent.setup();
    const withThumb = item({ thumbnailUrl: "https://cdn.example.test/t.jpg" });
    serve(() => Promise.resolve(calendar([withThumb])));
    const { container } = renderView();
    await settled(container);

    await user.click(screen.getByRole("button", { name: "Week" }));
    await waitFor(() => {
      // Semana del domingo 20 al sábado 26, con un día de margen.
      expect(getCalls().at(-1)?.query?.["from"]).toBe(Date.UTC(2026, 8, 19, 3, 0));
    });
    expect(getCalls().at(-1)?.query?.["to"]).toBe(Date.UTC(2026, 8, 28, 3, 0));
    expect(screen.getByRole("heading", { name: "Sep 20 – Sep 26" })).toBeInTheDocument();
    await waitFor(() => {
      expect(cell(container, "2026-09-23").querySelector("img")).toHaveAttribute(
        "src",
        "https://cdn.example.test/t.jpg",
      );
    });
  });
});

describe("el filtro de marcas", () => {
  it("'All brands' pide todas y cada chip dice de qué marca es", async () => {
    const user = userEvent.setup();
    const a = item();
    const b = item({ brandId: BRAND_B, brandName: "Globex", network: "instagram" });
    serve((_path, options) =>
      Promise.resolve(
        options.query?.["brands"] === "all"
          ? calendar([a, b], {
              brands: [
                { id: BRAND_A, name: "Acme", timezone: BA },
                { id: BRAND_B, name: "Globex", timezone: "UTC" },
              ],
            })
          : calendar([a]),
      ),
    );
    const { container } = renderView();
    await settled(container);
    expect(chips(cell(container, "2026-09-23"))).toHaveLength(1);
    expect(screen.getByRole("button", { name: "This brand" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "All brands" }));
    await waitFor(() => {
      expect(chips(cell(container, "2026-09-23"))).toHaveLength(2);
    });
    expect(getCalls().at(-1)?.query?.["brands"]).toBe("all");
    const texts = chips(cell(container, "2026-09-23")).map((c) => c.textContent ?? "");
    expect(texts.some((t) => t.includes("Globex"))).toBe(true);
    expect(texts.some((t) => t.includes("Acme"))).toBe(true);
    // Con varias marcas, la zona es la del navegador y se dice.
    expect(
      screen.getByText("your browser's time zone", { exact: false }),
    ).toBeInTheDocument();
  });
});

describe("arrastrar para mover", () => {
  it("soltar en otro día pide el PATCH con la misma hora local y la marca del ítem", async () => {
    const slot = item({ kind: "slot", network: "x", status: "PLANNED" });
    // El "servidor": guarda la hora, y el PATCH queda colgado hasta que el test
    // lo suelte, para ver el salto optimista **antes** de la respuesta.
    let stored = slot;
    let release: () => void = () => undefined;
    let calls = 0;
    serve((_path, options) => {
      if (options.method === "PATCH") {
        return new Promise((resolve) => {
          release = () => {
            stored = {
              ...slot,
              at: (options.body as { scheduledAtUtc: number }).scheduledAtUtc,
            };
            resolve(stored);
          };
        });
      }
      calls += 1;
      return Promise.resolve(calendar([stored]));
    });
    const { container } = renderView();
    await settled(container);
    expect(chips(cell(container, "2026-09-23"))).toHaveLength(1);
    expect(lastDragEnd).toBeDefined();

    act(() => {
      lastDragEnd?.({
        active: { id: `slot:${slot.id}` },
        over: { id: "day:2026-09-25" },
      } as unknown as Dnd.DragEndEvent);
    });

    // Optimista: salta al viernes sin esperar a la API.
    await waitFor(() => {
      expect(chips(cell(container, "2026-09-25"))).toHaveLength(1);
    });
    expect(chips(cell(container, "2026-09-23"))).toHaveLength(0);
    const before = calls;
    act(() => {
      release();
    });
    const patch = requestMock.mock.calls.find(([, o]) => o?.method === "PATCH");
    expect(patch?.[0]).toBe(`calendar/items/slot/${slot.id}`);
    expect(patch?.[1]?.body).toEqual({
      // Viernes 09:07 en BA = 12:07Z.
      scheduledAtUtc: Date.UTC(2026, 8, 25, 12, 7),
      brandId: BRAND_A,
    });
    // Y después refresca el rango, que ya trae la hora nueva.
    await waitFor(() => {
      expect(calls).toBeGreaterThan(before);
    });
    expect(chips(cell(container, "2026-09-25"))).toHaveLength(1);
  });

  it("si la API lo rechaza, vuelve a su día y lo dice", async () => {
    const post = item();
    serve((_path, options) =>
      options.method === "PATCH"
        ? Promise.reject(new ApiRequestError({ code: "conflict", status: 409 }))
        : Promise.resolve(calendar([post])),
    );
    const { container } = renderView();
    await settled(container);

    act(() => {
      lastDragEnd?.({
        active: { id: `post:${post.id}` },
        over: { id: "day:2026-09-24" },
      } as unknown as Dnd.DragEndEvent);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't be moved");
    await waitFor(() => {
      expect(chips(cell(container, "2026-09-23"))).toHaveLength(1);
    });
    expect(chips(cell(container, "2026-09-24"))).toHaveLength(0);
  });

  it("lo que ya salió no se arrastra ni pide nada", async () => {
    const posted = item({ status: "POSTED", movable: false });
    serve(() => Promise.resolve(calendar([posted])));
    const { container } = renderView();
    await settled(container);
    const [chip] = chips(cell(container, "2026-09-23"));
    expect(chip).toHaveAttribute("data-movable", "false");
    expect(chip).not.toHaveAttribute("aria-roledescription");

    act(() => {
      lastDragEnd?.({
        active: { id: `post:${posted.id}` },
        over: { id: "day:2026-09-24" },
      } as unknown as Dnd.DragEndEvent);
    });
    expect(requestMock.mock.calls.some(([, o]) => o?.method === "PATCH")).toBe(false);
  });

  it("soltar en el mismo día, fuera de un día o en el pasado no pide nada", async () => {
    const post = item();
    serve(() => Promise.resolve(calendar([post])));
    const { container } = renderView();
    await settled(container);
    for (const over of [{ id: "day:2026-09-23" }, null, { id: "day:2026-09-21" }]) {
      act(() => {
        lastDragEnd?.({
          active: { id: `post:${post.id}` },
          over,
        } as unknown as Dnd.DragEndEvent);
      });
    }
    expect(requestMock.mock.calls.some(([, o]) => o?.method === "PATCH")).toBe(false);
  });
});
