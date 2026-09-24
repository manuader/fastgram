/**
 * La campana, el banner de conexiones y Settings → Notifications (sprint 7)
 * contra un `apiRequest` falso: los estados de cada uno, el contador, el
 * cambio de marca al tocar un aviso y que un secreto no vuelve a aparecer.
 */
import type {
  AppNotification,
  ConnectionAlert,
  NotificationSettingsView,
} from "@fastgram/contracts";
import { ToastProvider } from "@fastgram/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiSend: vi.fn(),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const switchTo = vi.fn();
const BRAND_A = { id: "a", name: "Acme", profileStatus: "ready", createdAt: "x" };
const BRAND_B = { id: "b", name: "Globex", profileStatus: "ready", createdAt: "x" };
vi.mock("@/components/brands/WorkspaceProvider", () => ({
  useWorkspace: () => ({
    mode: "personal",
    isPersonal: true,
    workspaces: { data: [BRAND_A, BRAND_B] },
    active: BRAND_A,
    selectedId: "a",
    switchTo,
    forget: vi.fn(),
  }),
}));

import { apiRequest, apiSend, type ApiRequestOptions } from "@/lib/api/client";
import { NotificationBell, badgeText } from "./NotificationBell";
import { ConnectionBanner } from "./ConnectionBanner";
import { NotificationSettings } from "./NotificationSettings";

const requestMock = vi.mocked(apiRequest);
const sendMock = vi.mocked(apiSend);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

type Handler = (path: string, options: ApiRequestOptions<unknown>) => Promise<unknown>;

function server(handler: Handler) {
  const calls: { path: string; options: ApiRequestOptions<unknown> }[] = [];
  requestMock.mockImplementation(
    (path: string, options: ApiRequestOptions<unknown> = {}) => {
      calls.push({ path, options });
      return handler(path, options) as Promise<never>;
    },
  );
  return calls;
}

afterEach(() => {
  requestMock.mockReset();
  sendMock.mockReset();
  push.mockReset();
  switchTo.mockReset();
});

function note(over: Partial<AppNotification> = {}): AppNotification {
  return {
    id: "n1",
    workspaceId: "a",
    workspaceName: "Acme",
    category: "post_failed",
    severity: "error",
    title: "Post failed on Instagram",
    body: "Acme: Reconnect the account.",
    link: "/home",
    read: false,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe("badge", () => {
  it("nada en 0, el número hasta 9, 9+ después", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(3)).toBe("3");
    expect(badgeText(12)).toBe("9+");
  });
});

describe("la campana", () => {
  it("el contador va en el aria-label y el panel lista los avisos", async () => {
    server(() =>
      Promise.resolve({
        items: [
          note(),
          note({ id: "n2", workspaceId: "b", workspaceName: "Globex", read: true }),
        ],
        unreadCount: 1,
      }),
    );
    render(<NotificationBell />, { wrapper });
    const bell = await screen.findByRole("button", { name: "Notifications, 1 unread" });
    fireEvent.click(bell);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByText("Post failed on Instagram")).toHaveLength(2);
    // Con dos marcas, cada aviso dice de cuál es.
    expect(within(dialog).getByText(/Globex ·/)).toBeInTheDocument();
  });

  it("tocar un aviso de otra marca la marca leída, cambia de marca y navega", async () => {
    server(() =>
      Promise.resolve({
        items: [
          note({
            id: "nb",
            workspaceId: "b",
            workspaceName: "Globex",
            link: "/calendar",
          }),
        ],
        unreadCount: 1,
      }),
    );
    sendMock.mockResolvedValue(undefined);
    render(<NotificationBell />, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: /Notifications/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Post failed on Instagram/ }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/calendar"));
    expect(switchTo).toHaveBeenCalledWith(BRAND_B, { silent: true });
    expect(sendMock).toHaveBeenCalledWith("/notifications/nb/read", { method: "POST" });
  });

  it("vacío y error", async () => {
    server(() => Promise.resolve({ items: [], unreadCount: 0 }));
    const { unmount } = render(<NotificationBell />, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
    unmount();

    server(() =>
      Promise.reject(new ApiRequestError({ code: "service_unavailable", status: 503 })),
    );
    render(<NotificationBell />, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    expect(
      await screen.findByRole("button", { name: /try again|retry/i }),
    ).toBeInTheDocument();
  });

  it("marcar todo manda read-all", async () => {
    const calls = server((path) =>
      path === "/notifications/read-all"
        ? Promise.resolve({ updated: 1 })
        : Promise.resolve({ items: [note()], unreadCount: 1 }),
    );
    render(<NotificationBell />, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: /Notifications/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Mark all as read" }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/notifications/read-all")).toBe(true),
    );
  });
});

function alert(over: Partial<ConnectionAlert> = {}): ConnectionAlert {
  return {
    workspaceId: "a",
    workspaceName: "Acme",
    connectionId: "c1",
    platform: "linkedin",
    account: "acme",
    state: "expiring",
    deadline: "2026-09-30T12:00:00.000Z",
    reason: null,
    ...over,
  };
}

describe("banner de conexiones", () => {
  it("sin alertas no pinta nada", async () => {
    const calls = server(() => Promise.resolve({ alerts: [] }));
    render(<ConnectionBanner />, { wrapper });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByRole("link", { name: "Reconnect" })).toBeNull();
    expect(screen.queryByText(/expires on|disconnected for/)).toBeNull();
  });

  it("una vencida: alerta con Reconnect y sin descartar", async () => {
    server(() =>
      Promise.resolve({
        alerts: [
          alert({
            platform: "instagram",
            state: "expired",
            deadline: null,
            reason: "revoked",
          }),
          alert(),
        ],
      }),
    );
    render(<ConnectionBanner />, { wrapper });
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Instagram (acme) disconnected for Acme");
    expect(banner).toHaveTextContent("+1 more");
    expect(within(banner).getByRole("link", { name: "Reconnect" })).toHaveAttribute(
      "href",
      "/settings/connections",
    );
    expect(within(banner).queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("una por vencer se puede descartar", async () => {
    server(() => Promise.resolve({ alerts: [alert()] }));
    render(<ConnectionBanner />, { wrapper });
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("LinkedIn (acme) for Acme expires on Sep 30");
    fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
});

const SETTINGS: NotificationSettingsView = {
  categories: [
    { category: "post_failed", inApp: true, push: true },
    { category: "post_published", inApp: true, push: false },
  ],
  ntfy: { configured: false, enabled: false, urlMasked: null, tokenSet: false },
  telegram: {
    configured: true,
    enabled: true,
    chatId: "424242",
    botTokenHint: "…Dsaw",
  },
  dailySummaryHour: 8,
};

describe("Settings → Notifications", () => {
  it("loading, después las categorías; el token guardado sólo como pista", async () => {
    let resolve: (v: unknown) => void = () => undefined;
    server(() => new Promise((r) => (resolve = r)));
    const { container } = render(<NotificationSettings />, { wrapper });
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    resolve(SETTINGS);
    expect(await screen.findByText("Post failed")).toBeInTheDocument();
    const token = screen.getByLabelText("Bot token");
    expect(token).toHaveValue("");
    expect(token).toHaveAttribute("placeholder", expect.stringContaining("…Dsaw"));
  });

  it("apagar el push de una categoría manda sólo ese cambio", async () => {
    const calls = server((_path, options) =>
      Promise.resolve(options.method === "PUT" ? SETTINGS : SETTINGS),
    );
    render(<NotificationSettings />, { wrapper });
    fireEvent.click(await screen.findByRole("switch", { name: "Post failed — Push" }));
    await waitFor(() => {
      const put = calls.find((c) => c.options.method === "PUT");
      expect(put?.options.body).toEqual({
        categories: [{ category: "post_failed", push: false }],
      });
    });
  });

  it("guardar ntfy manda la URL y el campo queda vacío; el 400 muestra el motivo", async () => {
    let fail = false;
    const calls = server((_path, options) => {
      if (options.method === "PUT" && fail) {
        return Promise.reject(
          new ApiRequestError({
            code: "bad_request",
            status: 400,
            serverMessage:
              "The URL needs a topic at the end, like https://ntfy.sh/your-topic.",
          }),
        );
      }
      return Promise.resolve(SETTINGS);
    });
    render(<NotificationSettings />, { wrapper });
    const url = await screen.findByLabelText("Topic URL");
    fireEvent.change(url, { target: { value: "https://ntfy.sh/fg-topic" } });
    const form = url.closest("form");
    if (form === null) throw new Error("sin form");
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.options.method === "PUT")?.options.body).toEqual({
        ntfy: { url: "https://ntfy.sh/fg-topic" },
      }),
    );
    await waitFor(() => expect(url).toHaveValue(""));

    fail = true;
    fireEvent.change(url, { target: { value: "https://ntfy.sh/" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("needs a topic");
  });

  it("send test muestra el resultado del canal", async () => {
    server((path) =>
      path === "/notifications/test"
        ? Promise.resolve({ ok: false, channel: "telegram", error: "unauthorized" })
        : Promise.resolve(SETTINGS),
    );
    render(<NotificationSettings />, { wrapper });
    const chat = await screen.findByLabelText("Chat id");
    const form = chat.closest("form");
    if (form === null) throw new Error("sin form");
    fireEvent.click(within(form).getByRole("button", { name: "Send test" }));
    expect(await within(form).findByText(/token was rejected/)).toBeInTheDocument();
  });
});
