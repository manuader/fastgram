/**
 * Settings → Integrations y Settings → Connections (`PU-PUB-002`) contra un
 * `apiRequest` falso: los tres estados de cada pantalla, que el secret
 * tipeado no vuelve a aparecer, y lo que se ve según el estado de la cuenta.
 */
import type {
  ConnectionAccount,
  IntegrationApp,
  IntegrationsOverview,
} from "@fastgram/contracts";
import { ToastProvider } from "@fastgram/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { IntegrationsSettings } from "@/components/integrations/IntegrationsSettings";
import { ConnectionsSettings } from "./ConnectionsSettings";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiSend: vi.fn(),
}));

import { apiRequest, apiSend, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);
const sendMock = vi.mocked(apiSend);

function app(
  platform: IntegrationApp["platform"],
  over: Partial<IntegrationApp> = {},
): IntegrationApp {
  return {
    platform,
    label: platform,
    configured: false,
    clientId: null,
    hasSecret: false,
    secretLast4: null,
    updatedAt: null,
    redirectUri: `http://localhost:3000/api/fastgram/oauth/${platform}/callback`,
    https: platform === "tiktok" ? "verified" : "no",
    redirectAllowed: platform !== "tiktok",
    scopes: ["a", "b"],
    optionalScopes: [],
    optionalScopesNote: null,
    optionalScopesEnabled: false,
    consoleUrl: "https://console.example",
    docsUrl: "https://docs.example",
    setupNote: "note",
    ...over,
  };
}

const OVERVIEW: IntegrationsOverview = {
  apps: [
    app("instagram"),
    app("tiktok"),
    app("x", {
      configured: true,
      clientId: "x-client",
      hasSecret: true,
      secretLast4: "6789",
    }),
    app("threads"),
    app("facebook"),
    app("youtube"),
    app("linkedin", {
      https: "verified",
      optionalScopes: ["w_organization_social", "r_organization_admin"],
      optionalScopesNote: "Also let me post as a Page I manage.",
    }),
  ],
  redirectBase: "http://localhost:3000",
  redirectSource: "local",
  publicUrlInvalid: false,
};

function account(over: Partial<ConnectionAccount> = {}): ConnectionAccount {
  return {
    _id: "c1" as ConnectionAccount["_id"],
    platform: "x",
    platformUserId: "42",
    username: "brand_a",
    displayName: "Brand A",
    avatarUrl: null,
    status: "active",
    statusReason: null,
    scopes: [],
    publishable: true,
    tokenExpiresAt: null,
    createdAt: 1 as ConnectionAccount["createdAt"],
    updatedAt: 1 as ConnectionAccount["updatedAt"],
    ...over,
  };
}

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
});

describe("Settings → Integrations", () => {
  it("loading, y después las cinco apps con su redirect URI", async () => {
    let resolve: (v: unknown) => void = () => undefined;
    server(() => new Promise((r) => (resolve = r)));
    const { container } = render(<IntegrationsSettings />, { wrapper });
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    resolve(OVERVIEW);
    expect(await screen.findByTestId("redirect-x")).toHaveTextContent(
      "http://localhost:3000/api/fastgram/oauth/x/callback",
    );
    // TikTok exige https: aviso visible.
    expect(
      within(screen.getByTestId("integration-tiktok")).getByRole("alert"),
    ).toBeInTheDocument();
  });

  it("error → ApiErrorState", async () => {
    server(() =>
      Promise.reject(new ApiRequestError({ code: "service_unavailable", status: 503 })),
    );
    render(<IntegrationsSettings />, { wrapper });
    expect(
      await screen.findByRole("button", { name: /try again|retry/i }),
    ).toBeInTheDocument();
  });

  it("guardar manda el secret en el cuerpo y el campo queda vacío", async () => {
    const calls = server((path) =>
      path === "/integrations"
        ? Promise.resolve(OVERVIEW)
        : Promise.resolve(
            app("instagram", { clientId: "ig", hasSecret: true, configured: true }),
          ),
    );
    render(<IntegrationsSettings />, { wrapper });
    const card = await screen.findByTestId("integration-instagram");
    fireEvent.change(within(card).getByLabelText("Client ID"), {
      target: { value: "ig" },
    });
    const secret = within(card).getByLabelText("Client secret");
    fireEvent.change(secret, { target: { value: "super-secret-value" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/integrations/instagram")).toBe(true),
    );
    const put = calls.find((c) => c.path === "/integrations/instagram")!;
    expect(put.options).toMatchObject({
      method: "PUT",
      body: { clientId: "ig", clientSecret: "super-secret-value" },
    });
    await waitFor(() => expect(secret).toHaveValue(""));
    expect(screen.queryByDisplayValue("super-secret-value")).toBeNull();
  });
});

describe("Settings → Connections", () => {
  const withAccounts = (accounts: ConnectionAccount[] | Error) =>
    server((path) => {
      if (path === "/integrations") return Promise.resolve(OVERVIEW);
      if (path === "/connections/accounts") {
        return accounts instanceof Error
          ? Promise.reject(accounts)
          : Promise.resolve(accounts);
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

  it("empty: sin cuentas; Connect X habilitado y los no configurados deshabilitados", async () => {
    withAccounts([]);
    render(<ConnectionsSettings />, { wrapper });
    expect(await screen.findByText("No accounts connected yet")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Connect X" })).not.toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Connect Instagram" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Connect TikTok" })).toBeDisabled();
  });

  it("error de la lista → ApiErrorState", async () => {
    withAccounts(new ApiRequestError({ code: "service_unavailable", status: 503 }));
    render(<ConnectionsSettings />, { wrapper });
    expect(
      await screen.findByRole("button", { name: /try again|retry/i }),
    ).toBeInTheDocument();
  });

  it("cuentas con avatar/handle y estado; expired ofrece reconectar", async () => {
    withAccounts([
      account(),
      account({
        _id: "c2" as ConnectionAccount["_id"],
        platform: "instagram",
        username: "brand_ig",
        displayName: null,
        status: "expired",
        statusReason: "refresh_rejected",
      }),
    ]);
    render(<ConnectionsSettings />, { wrapper });
    const active = await screen.findByTestId("account-c1");
    expect(within(active).getByText("X · @brand_a")).toBeInTheDocument();
    expect(within(active).getByText("Connected")).toBeInTheDocument();
    const expired = screen.getByTestId("account-c2");
    expect(within(expired).getByText("Connection Expired")).toBeInTheDocument();
    expect(
      within(expired).getByRole("button", { name: "Reconnect" }),
    ).toBeInTheDocument();
  });

  it("vuelta del callback: banner de conectado y de error (§19.5)", async () => {
    withAccounts([]);
    const { unmount } = render(<ConnectionsSettings notice={{ connected: "tiktok" }} />, {
      wrapper,
    });
    expect(await screen.findByRole("status")).toHaveTextContent("TikTok connected.");
    unmount();
    render(<ConnectionsSettings notice={{ error: "oauth_denied", platform: "x" }} />, {
      wrapper,
    });
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => a.textContent?.includes("You declined a permission"))).toBe(
      true,
    );
  });

  it("desconectar llama DELETE sobre la cuenta", async () => {
    withAccounts([account()]);
    sendMock.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ConnectionsSettings />, { wrapper });
    const row = await screen.findByTestId("account-c1");
    fireEvent.click(within(row).getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith("/connections/accounts/c1", {
        method: "DELETE",
      }),
    );
  });
});

describe("YouTube y LinkedIn · PU-LATER-001/002", () => {
  it("Integrations: YouTube avisa que sin auditoría todo queda privado", async () => {
    server(() => Promise.resolve(OVERVIEW));
    render(<IntegrationsSettings />, { wrapper });
    const card = await screen.findByTestId("integration-youtube");
    expect(within(card).getByTestId("youtube-audit-note")).toHaveTextContent(
      /stays private/,
    );
  });

  it("Integrations: LinkedIn manda optionalScopes al tildar la casilla de Páginas", async () => {
    const calls = server((path) =>
      path === "/integrations"
        ? Promise.resolve(OVERVIEW)
        : Promise.resolve(app("linkedin", { optionalScopesEnabled: true })),
    );
    render(<IntegrationsSettings />, { wrapper });
    const card = await screen.findByTestId("integration-linkedin");
    fireEvent.change(within(card).getByLabelText("Client ID"), {
      target: { value: "li-client" },
    });
    expect(
      within(card).getByText("Also let me post as a Page I manage."),
    ).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("checkbox"));
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/integrations/linkedin")).toBe(true),
    );
    expect(calls.find((c) => c.path === "/integrations/linkedin")!.options).toMatchObject(
      {
        method: "PUT",
        body: { clientId: "li-client", optionalScopes: true },
      },
    );
  });

  it("Connections: una cuenta de YouTube activa muestra el aviso de auditoría", async () => {
    server((path) => {
      if (path === "/integrations") return Promise.resolve(OVERVIEW);
      if (path === "/connections/accounts")
        return Promise.resolve([account({ platform: "youtube", username: "marca" })]);
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(<ConnectionsSettings />, { wrapper });
    const row = await screen.findByTestId("account-c1");
    expect(within(row).getByTestId("youtube-audit-warning")).toBeInTheDocument();
    expect(within(row).getByText("YouTube · @marca")).toBeInTheDocument();
  });

  it("Connections: la vuelta de LinkedIn con varias cuentas abre el selector y conecta la elegida", async () => {
    const calls = server((path) => {
      if (path === "/integrations") return Promise.resolve(OVERVIEW);
      if (path === "/connections/accounts") return Promise.resolve([]);
      if (path === "/connections/linkedin/pages/sel-1")
        return Promise.resolve({
          platform: "linkedin",
          selectionId: "sel-1",
          pages: [
            { id: "urn:li:person:782bbtaQ", name: "John Doe", avatarUrl: null },
            { id: "urn:li:organization:2414183", name: "Devtestco", avatarUrl: null },
          ],
          expiresAt: 1,
        });
      if (path === "/connections/linkedin/pages")
        return Promise.resolve(account({ platform: "linkedin", username: "Devtestco" }));
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(<ConnectionsSettings notice={{ select: "sel-1", platform: "linkedin" }} />, {
      wrapper,
    });
    const picker = await screen.findByTestId("linkedin-picker");
    expect(
      within(picker).getByText("Choose where this brand posts on LinkedIn"),
    ).toBeInTheDocument();
    await within(picker).findByText("Devtestco");
    const buttons = within(picker).getAllByRole("button", { name: "Use this account" });
    fireEvent.click(buttons[1]!);
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/connections/linkedin/pages")).toBe(true),
    );
    expect(
      calls.find((c) => c.path === "/connections/linkedin/pages")!.options,
    ).toMatchObject({
      method: "POST",
      body: { selectionId: "sel-1", pageId: "urn:li:organization:2414183" },
    });
  });
});
