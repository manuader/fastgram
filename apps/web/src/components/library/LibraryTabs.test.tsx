/**
 * Las tres tabs de la Library · FR-100 (PRD:332).
 *
 * Lo único que este archivo prueba es **cuándo se monta cada panel**, y no es
 * un detalle de implementación: `TabsContent` renderiza siempre su contenido y
 * lo tapa con `hidden`, así que con las tres tabs cableadas, abrir `/library`
 * dispararía `GET /content`, `GET /media` **y** `GET /posts` para enseñar una
 * sola. Son el triple de peticiones contra el límite de §9.6 y el triple de
 * tiempo hasta que aparece lo que el usuario sí pidió.
 *
 * La aserción es sobre la petición y no sobre el DOM a propósito: "el panel
 * está en el árbol" no es lo que cuesta dinero, la petición sí.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryTabs } from "./LibraryTabs";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiList: vi.fn(),
}));

import { apiList } from "@/lib/api/client";

const listMock = vi.mocked(apiList);

function pathsRequested(): readonly string[] {
  return listMock.mock.calls.map(([path]) => path);
}

function renderTabs() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<LibraryTabs />, { wrapper: Wrapper });
}

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue({ items: [], cursor: null, hasMore: false });
});

describe("cuándo habla con la API cada tab", () => {
  it("al abrir la Library sólo se pide el contenido, ni los posts ni el Media Bank", async () => {
    renderTabs();

    await waitFor(() => {
      expect(pathsRequested()).toEqual(["/content"]);
    });
    expect(pathsRequested()).not.toContain("/media");
    expect(pathsRequested()).not.toContain("/posts");
  });

  it("el Media Bank se pide la primera vez que se abre su pestaña", async () => {
    const user = userEvent.setup();
    renderTabs();
    await waitFor(() => {
      expect(pathsRequested()).toEqual(["/content"]);
    });

    await user.click(screen.getByRole("tab", { name: "My Media Bank" }));

    await waitFor(() => {
      expect(pathsRequested()).toContain("/media");
    });
  });

  it("volver a una pestaña ya vista no la vuelve a pedir", async () => {
    const user = userEvent.setup();
    renderTabs();
    await waitFor(() => {
      expect(pathsRequested()).toEqual(["/content"]);
    });

    await user.click(screen.getByRole("tab", { name: "My Media Bank" }));
    await waitFor(() => {
      expect(pathsRequested()).toContain("/media");
    });

    await user.click(screen.getByRole("tab", { name: "My Content" }));
    await user.click(screen.getByRole("tab", { name: "My Media Bank" }));

    // Una vez montado, el panel se queda. `useContentList` corre con
    // `staleTime: 0`, así que desmontar al cambiar de tab convertiría cada ida
    // y vuelta en dos peticiones más.
    expect(pathsRequested().filter((path) => path === "/media")).toHaveLength(1);
    expect(pathsRequested().filter((path) => path === "/content")).toHaveLength(1);
  });

  it("`My Posts` se pide la primera vez que se abre su pestaña, y sólo una vez", async () => {
    const user = userEvent.setup();
    renderTabs();
    await waitFor(() => {
      expect(pathsRequested()).toEqual(["/content"]);
    });

    await user.click(screen.getByRole("tab", { name: "My Posts" }));
    await waitFor(() => {
      expect(pathsRequested()).toContain("/posts");
    });

    await user.click(screen.getByRole("tab", { name: "My Content" }));
    await user.click(screen.getByRole("tab", { name: "My Posts" }));

    expect(pathsRequested().filter((path) => path === "/posts")).toHaveLength(1);
  });
});
