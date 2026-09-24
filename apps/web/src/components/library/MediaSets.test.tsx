/**
 * Media Sets y modo `CREATING SET` · `F-127`, PRD:1648-1654, `P2-MEDIA-005/006`;
 * búsqueda y deep link `focus` · `P2-MEDIA-007/008`.
 */
import { mediaSchema, type Media } from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiList: vi.fn(),
  apiRequest: vi.fn(),
  apiSend: vi.fn(),
}));

import { apiList, apiRequest } from "@/lib/api/client";
import { MyMediaBankTab } from "./MyMediaBankTab";

const listMock = vi.mocked(apiList);
const requestMock = vi.mocked(apiRequest);

function asset(n: number): Media {
  return mediaSchema.parse({
    mediaId: `00000000-0000-4000-8000-00000000000${String(n)}`,
    mediaType: "image",
    filename: `pic-${String(n)}.jpg`,
    r2Url: `https://cdn.test/${String(n)}.jpg`,
    status: "ready",
    sizeMb: 1,
    categories: [],
    origin: "manual_upload",
    uploadedAt: Date.UTC(2026, 8, 22),
  });
}

function renderTab(focusId: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<MyMediaBankTab focusId={focusId} />, { wrapper: Wrapper });
}

beforeEach(() => {
  listMock.mockReset();
  requestMock.mockReset();
  listMock.mockResolvedValue({
    items: [1, 2, 3, 4, 5, 6].map(asset),
    cursor: null,
    hasMore: false,
  });
  requestMock.mockImplementation((path, options) => {
    if (path === "/media/sets" && options?.method === "POST")
      return Promise.resolve({
        id: "set-1",
        name: "Bedroom shots",
        kind: "CURATED",
        mediaIds: [],
        createdAt: 1,
      });
    if (path === "/media/sets") return Promise.resolve([]);
    if (path === "/media/tags") return Promise.resolve([{ tag: "office", count: 2 }]);
    return Promise.resolve([]);
  });
});

describe("CREATING SET", () => {
  it("contador `need N more`, Save deshabilitado hasta 5 y nombre, y crea el set", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("pic-1.jpg");

    await user.click(screen.getByRole("button", { name: "+ New set" }));
    expect(screen.getByText("0 selected (need 5 more)")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "✓ Save" });
    expect(save).toBeDisabled();

    for (const n of [1, 2, 3, 4]) {
      await user.click(
        screen.getByRole("checkbox", { name: `Select pic-${String(n)}.jpg` }),
      );
    }
    expect(screen.getByText("4 selected (need 1 more)")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select pic-5.jpg" }));
    expect(screen.getByText("5 selected")).toBeInTheDocument();
    expect(save).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: "Set name" }), "Bedroom shots");
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        "/media/sets",
        expect.objectContaining({
          method: "POST",
          body: {
            name: "Bedroom shots",
            kind: "CURATED",
            mediaIds: [1, 2, 3, 4, 5].map((n) => asset(n).mediaId),
          },
        }),
      ),
    );
    // Guardado: se sale del modo.
    await waitFor(() =>
      expect(
        screen.queryByText("CREATING SET", { selector: "span" }),
      ).not.toBeInTheDocument(),
    );
  });
});

describe("filtros", () => {
  it("un chip de etiqueta filtra por `tag` en el servidor", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: /#office/ }));
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(
        "/media",
        expect.objectContaining({ query: expect.objectContaining({ tag: "office" }) }),
      ),
    );
  });

  it("la búsqueda viaja como `q`", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.type(await screen.findByRole("searchbox"), "beach");
    await waitFor(
      () =>
        expect(listMock).toHaveBeenLastCalledWith(
          "/media",
          expect.objectContaining({ query: expect.objectContaining({ q: "beach" }) }),
        ),
      { timeout: 2000 },
    );
  });
});

describe("deep link", () => {
  it("`focus` resalta el asset pedido", async () => {
    renderTab(asset(3).mediaId);
    const name = await screen.findByText("pic-3.jpg");
    expect(name.closest("li")).toHaveAttribute("data-focused", "true");
  });
});
