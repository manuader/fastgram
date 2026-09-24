/**
 * La marca activa (`PU-BRAND-001`): el cambio resetea la caché de la marca y
 * una cookie que apunta a una marca que ya no existe se limpia sola.
 *
 * El corte está en `apiRequest` (como en `BrandProfile.test.tsx`): el doble
 * responde `/mode` y `/workspaces` y mira la cookie como lo haría el proxy.
 */
import { ToastProvider } from "@fastgram/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import {
  clearWorkspaceCookie,
  readWorkspaceCookie,
  writeWorkspaceCookie,
} from "@/lib/brands/workspace-cookie";
import type { Workspace } from "@/lib/brands/workspaces";
import { useWorkspace, WorkspaceProvider } from "./WorkspaceProvider";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

import { apiRequest } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

const A: Workspace = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme",
  profileStatus: "ready",
  createdAt: "2026-09-01T00:00:00.000Z",
};
const B: Workspace = {
  ...A,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Beta",
  createdAt: "2026-09-02T00:00:00.000Z",
};
const GONE = "33333333-3333-4333-8333-333333333333";

let brands: Workspace[];

beforeEach(() => {
  brands = [A, B];
  requestMock.mockImplementation(async (path: string) => {
    if (path === "mode") return Promise.resolve({ mode: "personal" });
    if (path === "workspaces") {
      const cookie = readWorkspaceCookie();
      // Como la API: con header de una marca ajena o borrada, 404 a todo.
      if (cookie !== null && !brands.some((b) => b.id === cookie)) {
        return Promise.reject(new ApiRequestError({ code: "not_found", status: 404 }));
      }
      return Promise.resolve(brands);
    }
    return Promise.reject(new Error(`ruta inesperada: ${path}`));
  });
});

afterEach(() => {
  clearWorkspaceCookie();
});

function Probe() {
  const { active, selectedId, switchTo } = useWorkspace();
  return (
    <div>
      <p data-testid="active">{active?.name ?? "none"}</p>
      <p data-testid="selected">{selectedId ?? "default"}</p>
      <button
        type="button"
        onClick={() => {
          switchTo(B);
        }}
      >
        switch
      </button>
    </div>
  );
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <WorkspaceProvider>{children}</WorkspaceProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
  render(<Probe />, { wrapper });
  return client;
}

describe("WorkspaceProvider", () => {
  it("sin cookie muestra la marca más antigua como activa", async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByTestId("active")).toHaveTextContent("Acme");
    });
    expect(screen.getByTestId("selected")).toHaveTextContent("default");
  });

  it("cambiar de marca escribe la cookie y resetea sólo lo que depende de la marca", async () => {
    const client = setup();
    await waitFor(() => {
      expect(screen.getByTestId("active")).toHaveTextContent("Acme");
    });
    client.setQueryData(["posts", {}], ["post de Acme"]);

    act(() => {
      screen.getByRole("button", { name: "switch" }).click();
    });

    expect(readWorkspaceCookie()).toBe(B.id);
    expect(screen.getByTestId("active")).toHaveTextContent("Beta");
    // Los posts de Acme no pueden seguir en caché bajo el nombre de Beta.
    expect(client.getQueryData(["posts", {}])).toBeUndefined();
    // La lista de marcas es del dueño: no depende de la activa.
    expect(client.getQueryData(["workspaces"])).toEqual([A, B]);
    expect(await screen.findByText("Switched to Beta")).toBeInTheDocument();
  });

  it("una cookie de una marca borrada (404) se limpia y vuelve a la default", async () => {
    writeWorkspaceCookie(GONE);
    setup();
    await waitFor(() => {
      expect(readWorkspaceCookie()).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId("active")).toHaveTextContent("Acme");
    });
    expect(screen.getByTestId("selected")).toHaveTextContent("default");
    expect(
      await screen.findByText(
        "That brand is no longer available. You're back on your default brand.",
      ),
    ).toBeInTheDocument();
  });

  it("una cookie que la lista no incluye también se limpia", async () => {
    writeWorkspaceCookie(GONE);
    // Una API que no validara el header devolvería la lista igual.
    requestMock.mockImplementation(async (path: string) =>
      Promise.resolve(path === "mode" ? { mode: "personal" } : brands),
    );
    setup();
    await waitFor(() => {
      expect(readWorkspaceCookie()).toBeNull();
    });
    expect(screen.getByTestId("active")).toHaveTextContent("Acme");
  });

  it("fuera del modo personal no pide la lista", async () => {
    requestMock.mockImplementation(async (path: string) =>
      path === "mode"
        ? Promise.resolve({ mode: "standard" })
        : Promise.reject(new Error("no debería pedirse")),
    );
    setup();
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("mode", expect.anything());
    });
    expect(requestMock).not.toHaveBeenCalledWith("workspaces", expect.anything());
    expect(screen.getByTestId("active")).toHaveTextContent("none");
  });
});
