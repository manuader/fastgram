/**
 * "Today" (`PU-UI-002`): contadores, timeline ordenado, "Mark as posted" y los
 * estados vacío y de error.
 *
 * El corte está en el cliente tipado (`apiRequest`/`apiList`), como en
 * `BlitzDeck.test.tsx`. El doble es **con estado**: marcar publicado cambia lo
 * que devuelve el calendario después, igual que la API. Sin eso, la
 * invalidación que sigue al éxito volvería a traer el borrador y el test
 * mediría la caché y no la pantalla.
 *
 * El reloj: `Date.now` fijo y la zona del navegador en UTC (se reemplaza
 * `browserTimeZone`), para que "hoy" no dependa de la máquina que corre el test.
 */
import { calendarItemSchema, postSchema, type CalendarItem } from "@fastgram/contracts";
import { ToastProvider } from "@fastgram/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MotionGlobalConfig } from "motion/react";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { WorkspaceProvider } from "@/components/brands/WorkspaceProvider";
import { ApiRequestError } from "@/lib/api/errors";
import { clearWorkspaceCookie } from "@/lib/brands/workspace-cookie";
import type { Workspace } from "@/lib/brands/workspaces";
import { markPostedPath } from "@/lib/today/data";
import { TodayScreen } from "./TodayScreen";

import type * as ApiClient from "@/lib/api/client";
import type * as CalendarLib from "@/lib/calendar/calendar";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiList: vi.fn(),
}));

vi.mock("@/lib/calendar/calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof CalendarLib>()),
  browserTimeZone: () => "UTC",
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/home",
}));

import { apiList, apiRequest } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);
const listMock = vi.mocked(apiList);

const NOW = Date.parse("2026-09-24T15:00:00.000Z");

const ACME: Workspace = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme",
  profileStatus: "ready",
  createdAt: "2026-09-01T00:00:00.000Z",
};
const BETA: Workspace = {
  ...ACME,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Beta",
  createdAt: "2026-09-02T00:00:00.000Z",
};

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function item(
  n: number,
  brand: Workspace,
  status: CalendarItem["status"],
  at: string,
  network: CalendarItem["network"] = "instagram",
): CalendarItem {
  return calendarItemSchema.parse({
    kind: status === "PLANNED" ? "slot" : "post",
    id: uuid(n),
    brandId: brand.id,
    brandName: brand.name,
    contentId: uuid(100 + n),
    network,
    status,
    at: Date.parse(at),
    movable: false,
  });
}

const POSTED_9 = item(1, ACME, "POSTED", "2026-09-24T09:00:00Z");
const PLANNED_12 = item(2, BETA, "PLANNED", "2026-09-24T12:00:00Z", "x");
const SCHEDULED_18 = item(3, ACME, "SCHEDULED", "2026-09-24T18:00:00Z");
const FAILED_RECENT = item(4, ACME, "FAILED", "2026-09-22T10:00:00Z");
const FAILED_OLD = item(5, BETA, "FAILED", "2026-09-10T10:00:00Z");
const DRAFT = item(6, BETA, "IN_USER_INBOX", "2026-09-20T10:00:00Z", "tiktok");
const CANCELLED_TODAY = item(7, ACME, "CANCELLED", "2026-09-24T11:00:00Z");

interface Backend {
  items: CalendarItem[];
  queue: unknown[];
  calendarError: ApiRequestError | null;
}

let backend: Backend;

function installBackend(over: Partial<Backend> = {}): void {
  backend = {
    items: [
      SCHEDULED_18,
      FAILED_RECENT,
      POSTED_9,
      FAILED_OLD,
      DRAFT,
      PLANNED_12,
      CANCELLED_TODAY,
    ],
    queue: [{}, {}, {}],
    calendarError: null,
    ...over,
  };

  requestMock.mockImplementation(async (path: string, options) => {
    if (path === "mode") return { mode: "personal" };
    if (path === "workspaces") return [ACME, BETA];
    if (path === "calendar") {
      if (backend.calendarError !== null) throw backend.calendarError;
      const inbox = backend.items.filter((i) => i.status === "IN_USER_INBOX").length;
      return {
        items: backend.items,
        brands: [ACME, BETA].map((b) => ({ id: b.id, name: b.name, timezone: "UTC" })),
        counts: { posted: 0, inbox, scheduled: 0 },
        truncated: false,
      };
    }
    if (path === "blitz/queue") return backend.queue;
    // `PU-AUTO-003`: sin marcas en piloto la tarjeta no se dibuja.
    if (path === "autopilot/digest") return { brands: [] };
    if (path === markPostedPath(DRAFT.id)) {
      expect(options?.method).toBe("POST");
      backend.items = backend.items.map((i) =>
        i.id === DRAFT.id ? { ...i, status: "POSTED", at: NOW } : i,
      );
      return postSchema.parse({
        _id: DRAFT.id,
        contentId: DRAFT.contentId,
        platform: "tiktok",
        accountType: "oauth",
        scheduledAtUtc: DRAFT.at,
        caption: "",
        description: "",
        status: "POSTED",
        postedAt: NOW,
        views: 0,
        likes: 0,
        comments: 0,
      });
    }
    throw new Error(`ruta inesperada: ${path}`);
  });

  // Los detalles de la marca activa: el motivo del fallo de Acme.
  listMock.mockImplementation(async (path: string) => {
    if (path !== "posts") throw new Error(`listado inesperado: ${path}`);
    return {
      items: [
        postSchema.parse({
          _id: FAILED_RECENT.id,
          contentId: FAILED_RECENT.contentId,
          platform: "instagram",
          accountType: "oauth",
          scheduledAtUtc: FAILED_RECENT.at,
          caption: "",
          description: "",
          status: "FAILED",
          errorMessage: "Instagram rejected the caption.",
          views: 0,
          likes: 0,
          comments: 0,
        }),
      ],
      cursor: null,
      hasMore: false,
    };
  });
}

function renderToday(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <WorkspaceProvider>{children}</WorkspaceProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
  render(<TodayScreen />, { wrapper });
}

async function counter(id: string): Promise<string> {
  const tile = await screen.findByTestId(`today-counter-${id}-value`);
  return tile.textContent ?? "";
}

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});

afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  installBackend();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearWorkspaceCookie();
});

describe("TodayScreen", () => {
  it("saluda con la fecha y cuenta hoy, la cola y los fallidos de 7 días", async () => {
    renderToday();

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "Good afternoon",
    );
    await waitFor(() => {
      expect(screen.getByTestId("today-date")).toHaveTextContent(
        "Thursday, September 24 · all your brands",
      );
    });

    expect(await counter("posted")).toBe("1");
    // El programado de las 18 y el slot planificado de las 12. El cancelado no.
    expect(await counter("scheduled")).toBe("2");
    expect(await counter("approval")).toBe("3");
    // El del 22; el del 10 queda fuera de la semana.
    expect(await counter("failed")).toBe("1");
    expect(screen.getByText("in Acme")).toBeInTheDocument();
  });

  it("ordena el timeline por hora, con el estado y el motivo legible del fallo", async () => {
    renderToday();

    await waitFor(() => {
      expect(screen.getAllByTestId("today-timeline-item")).toHaveLength(3);
    });
    const rows = screen.getAllByTestId("today-timeline-item");
    expect(rows.map((r) => r.getAttribute("data-status"))).toEqual([
      "POSTED",
      "PLANNED",
      "SCHEDULED",
    ]);
    expect(within(rows[0] as HTMLElement).getByText("Posted")).toBeInTheDocument();
    // Con más de una marca, cada fila dice de cuál es (cuando llega la lista).
    expect(await within(rows[1] as HTMLElement).findByText("Beta")).toBeInTheDocument();

    const failed = await screen.findAllByTestId("today-failed-item");
    expect(failed).toHaveLength(1);
    expect(
      await within(failed[0] as HTMLElement).findByText(
        "Instagram rejected the caption.",
      ),
    ).toBeInTheDocument();
    expect(
      within(failed[0] as HTMLElement).getByRole("link", { name: "Open" }),
    ).toHaveAttribute("href", `/library/${FAILED_RECENT.contentId}`);
  });

  it("Mark as posted llama al endpoint con la marca del post y actualiza la pantalla", async () => {
    const user = userEvent.setup();
    renderToday();

    const draft = await screen.findByTestId("today-draft");
    expect(within(draft).getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Go to Inbox → System notifications.")).toBeInTheDocument();
    expect(await counter("posted")).toBe("1");

    await user.click(within(draft).getByRole("button", { name: /mark as posted/i }));

    expect(requestMock).toHaveBeenCalledWith(
      markPostedPath(DRAFT.id),
      expect.objectContaining({ method: "POST", body: { brandId: BETA.id } }),
    );
    await waitFor(() => {
      expect(screen.queryByTestId("today-draft")).not.toBeInTheDocument();
    });
    // Salió ahora: suma a "posted today" y aparece en el timeline.
    await waitFor(async () => {
      expect(await counter("posted")).toBe("2");
    });
    expect(await screen.findByText("Marked as posted.")).toBeInTheDocument();
  });

  it("un día sin nada invita a Blitz y a crear desde un prompt", async () => {
    installBackend({ items: [], queue: [] });
    renderToday();

    expect(await screen.findByText("A quiet day")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Blitz" })).toHaveAttribute(
      "href",
      "/blitz",
    );
    expect(screen.getByRole("link", { name: /create from prompt/i })).toHaveAttribute(
      "href",
      "/blitz#create",
    );
    expect(await counter("posted")).toBe("0");
    expect(screen.queryByTestId("today-draft")).not.toBeInTheDocument();
    expect(screen.getByTestId("today-approval-count")).toHaveTextContent(
      "Nothing waiting",
    );
  });

  it("si el calendario falla, lo dice y deja reintentar; los contadores no inventan ceros", async () => {
    installBackend({
      calendarError: new ApiRequestError({ code: "service_unavailable", status: 503 }),
    });
    renderToday();

    expect(await screen.findByText("Couldn't load today's plan.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again|retry/i })).toBeInTheDocument();
    expect(screen.queryByTestId("today-counter-posted-value")).not.toBeInTheDocument();
    // La cola de Blitz no depende del calendario: sigue contando.
    expect(await counter("approval")).toBe("3");
  });

  it("Review de otra marca cambia a esa marca y abre Blitz", async () => {
    const user = userEvent.setup();
    renderToday();

    const other = await screen.findByTestId("today-approval-brand");
    expect(within(other).getByText("Beta")).toBeInTheDocument();
    await user.click(within(other).getByRole("button", { name: /review/i }));

    expect(push).toHaveBeenCalledWith("/blitz");
    expect(document.cookie).toContain(BETA.id);
  });
});
