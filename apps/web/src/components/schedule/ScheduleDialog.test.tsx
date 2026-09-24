/**
 * El diálogo de Schedule (sprint 7). El corte está en `apiRequest`, como en las
 * otras pantallas: lo que se prueba es el diálogo y sus hooks.
 *
 *  - carga (skeleton) → datos: la caption derivada viene prellenada, con su
 *    contador contra el tope de la red;
 *  - error de la API: se ve el error, no un formulario vacío;
 *  - Regenerate reemplaza el campo con lo que devuelve el modelo, y un 503 sin
 *    modelo dice que hay que configurarlo;
 *  - `Post now` manda `postNow: true` (no una hora pasada);
 *  - una caption sobre el tope bloquea el envío.
 */
import type { ScheduleOptions } from "@fastgram/contracts";
import { ToastProvider } from "@fastgram/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { ScheduleDialog } from "./ScheduleDialog";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

import { apiRequest } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);
const CONTENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const OPTIONS: ScheduleOptions = {
  contentId: CONTENT as ScheduleOptions["contentId"],
  contentType: "wall-of-text",
  contentStatus: "CREATED",
  timezone: "UTC",
  suggestedAtUtc: Date.UTC(2030, 0, 1, 15, 0),
  xAllowLinks: false,
  networks: [
    {
      network: "x",
      inStrategy: true,
      suggestedAtUtc: Date.UTC(2030, 0, 1, 15, 0),
      alreadyScheduled: false,
      connections: [{ connectionId: CONN as never, username: "marca" }],
      caption: "Caption derivada",
      description: null,
    },
    {
      network: "instagram",
      inStrategy: true,
      suggestedAtUtc: null,
      alreadyScheduled: false,
      connections: [],
      caption: "otra",
      description: null,
    },
  ] as ScheduleOptions["networks"],
};

type Handler = (options: Record<string, unknown> | undefined) => unknown;
let routes: Record<string, Handler>;

beforeEach(() => {
  requestMock.mockReset();
  routes = {
    [`content/${CONTENT}/schedule-options`]: () => OPTIONS,
  };
  requestMock.mockImplementation(async (path: string, options?: unknown) => {
    const handler = routes[path];
    if (handler === undefined) throw new Error(`sin ruta: ${path}`);
    return handler(options as Record<string, unknown> | undefined) as never;
  });
});

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onClose = vi.fn();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    );
  }
  render(<ScheduleDialog open contentId={CONTENT} onClose={onClose} />, {
    wrapper: Wrapper,
  });
  return { onClose };
}

describe("ScheduleDialog", () => {
  it("carga y prellena la caption derivada con su contador", async () => {
    renderDialog();
    const field = await screen.findByDisplayValue("Caption derivada");
    expect(field).toBeTruthy();
    expect(screen.getByText("16/280")).toBeTruthy();
    // Instagram en la estrategia sin conexión: marcado, no seleccionable.
    expect(screen.getByText("Not connected")).toBeTruthy();
  });

  it("un error de la API se ve como error", async () => {
    routes[`content/${CONTENT}/schedule-options`] = () => {
      throw new ApiRequestError({ code: "service_unavailable", status: 503 });
    };
    renderDialog();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByDisplayValue("Caption derivada")).toBeNull();
  });

  it("Regenerate reemplaza el campo; sin modelo, lo dice", async () => {
    const user = userEvent.setup();
    routes[`content/${CONTENT}/caption`] = () => ({
      platform: "x",
      field: "caption",
      text: "Nueva de la IA",
      model: "fake",
    });
    renderDialog();
    await screen.findByDisplayValue("Caption derivada");
    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(await screen.findByDisplayValue("Nueva de la IA")).toBeTruthy();

    routes[`content/${CONTENT}/caption`] = () => {
      throw new ApiRequestError({
        code: "service_unavailable",
        status: 503,
        details: { reason: "llm_not_configured" },
      });
    };
    await user.click(screen.getByRole("button", { name: "Improve" }));
    expect(await screen.findByText(/No text model is set up/)).toBeTruthy();
  });

  it("Post now manda postNow, sin hora", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    routes[`content/${CONTENT}/schedule`] = (options) => {
      bodies.push(options?.["body"]);
      return [];
    };
    const { onClose } = renderDialog();
    await screen.findByDisplayValue("Caption derivada");
    await user.click(screen.getByRole("button", { name: "Post now" }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(bodies[0]).toEqual({
      postNow: true,
      targets: [{ platform: "x", connectionId: CONN, caption: "Caption derivada" }],
    });
  });

  it("una caption sobre el tope bloquea programar", async () => {
    const user = userEvent.setup();
    renderDialog();
    const field = await screen.findByDisplayValue("Caption derivada");
    await user.clear(field);
    await user.click(field);
    await user.paste("a".repeat(281));
    expect(screen.getByText("281/280")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Post now" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("The X text is over the limit.")).toBeTruthy();
  });
});
