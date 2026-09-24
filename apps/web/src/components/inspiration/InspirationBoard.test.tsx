/**
 * `/inspiration` — el tablero de referencias propio (FR-040 adaptado).
 *
 * Lo que persigue: los estados de FR-040 (vacío, `No results` con filtros,
 * error con el copy literal), que búsqueda y filtros viajan como query y se
 * resetean, que las métricas que el sitio no dio no se dibujan (nada de "0"),
 * guardar un link, y que «Remix this» llama a la ruta de remix y sigue el
 * pedido por el polling de «crear desde prompt» hasta ofrecer ir a Blitz.
 * El corte del mock es `apiRequest` / `apiList` / `apiSend`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InspirationItem } from "@fastgram/contracts";
import { ApiRequestError } from "@/lib/api/errors";
import { InspirationBoard } from "./InspirationBoard";

import type * as ApiClient from "@/lib/api/client";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiList: vi.fn(),
  apiSend: vi.fn(),
}));

import { apiList, apiRequest, apiSend } from "@/lib/api/client";

const listMock = vi.mocked(apiList);
const requestMock = vi.mocked(apiRequest);
const sendMock = vi.mocked(apiSend);

const ITEM: InspirationItem = {
  id: "0b8f3c1e-5d7a-4f2b-9c61-1a2b3c4d5e6f",
  platform: "youtube",
  url: "https://www.youtube.com/watch?v=MvV6i0zyDsc",
  thumbnailUrl: "https://bucket.test/thumb.jpg",
  title: "NASA | LOOP Trailer",
  author: "NASA Goddard",
  hashtags: ["nasa"],
  tags: ["space"],
  format: "video",
  views: 1_300_000,
  slideCount: 0,
  onScreenText: ["LOOP"],
  ingestState: "ready",
  createdAt: 1,
};

function renderBoard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<InspirationBoard />, { wrapper: Wrapper });
}

beforeEach(() => {
  listMock.mockReset();
  requestMock.mockReset();
  sendMock.mockReset();
  requestMock.mockImplementation(async (path) => {
    if (path === "/inspiration/tags") return ["space"];
    throw new Error(`inesperado: ${path}`);
  });
});

describe("InspirationBoard", () => {
  it("sin nada guardado: el vacío del tablero invita a guardar", async () => {
    listMock.mockResolvedValue({ items: [], cursor: null, hasMore: false });
    renderBoard();
    expect(await screen.findByText("No references yet")).toBeInTheDocument();
    expect(screen.queryByText("No results")).not.toBeInTheDocument();
  });

  it("dibuja la tarjeta: vistas sí, likes no (el sitio no los dio), Open original seguro", async () => {
    listMock.mockResolvedValue({ items: [ITEM], cursor: null, hasMore: false });
    renderBoard();
    const card = (await screen.findByText("NASA | LOOP Trailer")).closest("article");
    expect(card).not.toBeNull();
    const c = within(card as HTMLElement);
    expect(c.getByText("1.3M")).toBeInTheDocument();
    expect(c.getByText("1300000 views")).toBeInTheDocument();
    expect(c.queryByText(/likes/)).not.toBeInTheDocument();
    const open = c.getByRole("link", { name: "Open original" });
    expect(open).toHaveAttribute("href", ITEM.url);
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    expect(open).toHaveAttribute("target", "_blank");
    expect(c.getByText("On screen: LOOP")).toBeInTheDocument();
  });

  it("filtros y búsqueda viajan como query; sin resultados muestra No results y Clear all resetea", async () => {
    const user = userEvent.setup();
    listMock.mockImplementation(async (_path, options) => {
      const q = options?.query ?? {};
      return q["format"] === "slideshow" || q["q"] !== undefined
        ? { items: [], cursor: null, hasMore: false }
        : { items: [ITEM], cursor: null, hasMore: false };
    });
    renderBoard();
    await screen.findByText("NASA | LOOP Trailer");

    await user.click(screen.getByRole("button", { name: "Slideshow" }));
    expect(await screen.findByText("No results")).toBeInTheDocument();
    expect(
      screen.getByText("Try a different search or clear your filters."),
    ).toBeInTheDocument();
    expect(listMock.mock.calls.at(-1)?.[1]?.query).toMatchObject({
      format: "slideshow",
      page: 1,
    });

    await user.click(screen.getAllByRole("button", { name: "Clear all" })[0]!);
    expect(await screen.findByText("NASA | LOOP Trailer")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search inspiration"), "loop");
    await waitFor(() => {
      expect(listMock.mock.calls.at(-1)?.[1]?.query).toMatchObject({ q: "loop" });
    });
    await user.click(screen.getByRole("button", { name: "space" }));
    await waitFor(() => {
      expect(listMock.mock.calls.at(-1)?.[1]?.query).toMatchObject({
        q: "loop",
        tag: "space",
      });
    });
  });

  it("error: el copy literal de FR-040 y Try again", async () => {
    listMock.mockRejectedValue(
      new ApiRequestError({ code: "service_unavailable", status: 503 }),
    );
    renderBoard();
    expect(
      await screen.findByText(
        "We could not load inspiration right now. Try again in a moment.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("guardar un link manda url, etiquetas y saveClip", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue({ items: [], cursor: null, hasMore: false });
    requestMock.mockImplementation(async (path, options) => {
      if (path === "/inspiration/tags") return [];
      if (path === "/inspiration" && options?.method === "POST") {
        return { ...ITEM, ingestState: "pending" };
      }
      throw new Error(`inesperado: ${path}`);
    });
    renderBoard();
    await user.click(
      (await screen.findAllByRole("button", { name: "Save inspiration" }))[0]!,
    );
    await user.type(screen.getByLabelText("Link"), "https://www.tiktok.com/@a/video/1");
    await user.type(screen.getByLabelText("Tags"), "Hooks, pov, hooks");
    await user.click(screen.getByLabelText("Also save the video to my Media Bank"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const post = requestMock.mock.calls.find(([, o]) => o?.method === "POST");
      expect(post?.[1]?.body).toEqual({
        url: "https://www.tiktok.com/@a/video/1",
        tags: ["hooks", "pov"],
        saveClip: true,
      });
      expect(post?.[1]?.idempotencyKey).toEqual(expect.any(String));
    });
  });

  it("Remix this: llama a la ruta de remix y sigue el pedido hasta ofrecer Blitz", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue({ items: [ITEM], cursor: null, hasMore: false });
    requestMock.mockImplementation(async (path, options) => {
      if (path === "/inspiration/tags") return [];
      if (path === `/inspiration/${ITEM.id}/remix`) {
        expect(options?.method).toBe("POST");
        return { requestId: "req-1" };
      }
      if (path === "/blitz/generate/req-1") {
        return { requestId: "req-1", status: "done", suggestionIds: ["s1", "s2"] };
      }
      throw new Error(`inesperado: ${path}`);
    });
    renderBoard();
    await user.click(await screen.findByRole("button", { name: "Remix this" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Note (optional)"), "winter menu");
    await user.click(within(dialog).getByRole("button", { name: "Remix" }));

    expect(
      await screen.findByText("Your remixes are at the top of Blitz."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Blitz" })).toHaveAttribute(
      "href",
      "/blitz",
    );
    const call = requestMock.mock.calls.find(
      ([p]) => p === `/inspiration/${ITEM.id}/remix`,
    );
    expect(call?.[1]?.body).toEqual({ prompt: "winter menu", count: 3 });
  });
});
