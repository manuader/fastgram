/**
 * Editor por capas del reel: carga el spec, edita texto + animación, guarda con
 * `PUT /content/:id/reel` y la revisión vista; la preview es la composición
 * del motor en un iframe (en jsdom no corre, pero su `srcdoc` sí se ve), y sin
 * servicio de render lo dice en vez de quedarse cargando.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { libraryContentSchema } from "@/lib/library/content";
import { ContentEditor } from "../ContentEditor";
import { reelFixture } from "./fixture";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiList: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

import { apiRequest, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);
const ID = "22222222-2222-4222-8222-222222222222";

const content = (over: Record<string, unknown> = {}) =>
  libraryContentSchema.parse({
    _id: ID,
    type: "reel",
    status: "CREATED",
    files: ["https://cdn.test/reel.mp4"],
    revision: 3,
    ...over,
  });

function serve(
  opts: { preview?: "ok" | "unavailable"; onPut?: (body: unknown) => unknown } = {},
) {
  requestMock.mockImplementation(
    async (path, options: ApiRequestOptions<unknown> = {}) => {
      const method = options.method ?? "GET";
      let raw: unknown;
      if (path === "/reels/preview") {
        if (opts.preview === "unavailable") {
          throw new ApiRequestError({ code: "service_unavailable", status: 503 });
        }
        raw = { html: "<!doctype html><p>reel</p>", durationSec: 10, warnings: [] };
      } else if (path.endsWith("/reel") && method === "PUT") {
        raw = opts.onPut?.(options.body) ?? content({ status: "BUILDING", revision: 4 });
      } else if (path.endsWith("/reel")) {
        raw = { revision: 3, reel: reelFixture() };
      } else if (path.endsWith("/editable")) {
        throw new ApiRequestError({ code: "content_not_editable", status: 422 });
      } else {
        raw = content();
      }
      const schema = options.schema;
      return (schema === undefined ? raw : schema.parse(raw)) as never;
    },
  );
}

function wrapper({ children }: { readonly children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  requestMock.mockReset();
});

describe("ReelEditor", () => {
  it("muestra capas, la preview del motor y edita texto + animación → PUT con la revisión vista", async () => {
    let sent: unknown = null;
    serve({ onPut: (body) => ((sent = body), undefined) });
    render(<ContentEditor contentId={ID} />, { wrapper });

    const timeline = await screen.findByTestId("reel-timeline");
    expect(
      within(timeline).getByRole("button", { name: /Stop scrolling/ }),
    ).toHaveAttribute("aria-pressed", "true");
    // La preview es la composición del motor en un iframe.
    await waitFor(() =>
      expect(screen.getByTitle("Preview")).toHaveAttribute(
        "srcdoc",
        "<!doctype html><p>reel</p>",
      ),
    );

    const user = userEvent.setup();
    const text = screen.getByLabelText("Text");
    await user.clear(text);
    await user.type(text, "New hook");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Animation" }),
      "typewriter",
    );
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save & render" }));

    await waitFor(() => expect(sent).not.toBeNull());
    const body = sent as { revision: number; reel: ReturnType<typeof reelFixture> };
    expect(body.revision).toBe(3);
    expect(body.reel.layers.find((l) => l.id === "hook")).toMatchObject({
      text: "New hook",
      animation: "typewriter",
    });
    expect(requestMock).toHaveBeenCalledWith(
      `/content/${ID}/reel`,
      expect.objectContaining({ method: "PUT", idempotencyKey: expect.any(String) }),
    );
    expect(await screen.findByText(/Rendering the new version/)).toBeInTheDocument();
  });

  it("sin servicio de render lo dice en la preview", async () => {
    serve({ preview: "unavailable" });
    render(<ContentEditor contentId={ID} />, { wrapper });
    expect(
      await screen.findByText(/Previews need the render service/),
    ).toBeInTheDocument();
  });

  it("elegir el clip muestra sus controles de croma y el swap", async () => {
    serve();
    render(<ContentEditor contentId={ID} />, { wrapper });
    const timeline = await screen.findByTestId("reel-timeline");
    const user = userEvent.setup();
    await user.click(within(timeline).getByRole("button", { name: /^Edit Clip/ }));
    expect(screen.getByRole("combobox", { name: "Remove background" })).toHaveValue(
      "green",
    );
    expect(screen.getByRole("button", { name: "Swap Clip" })).toBeInTheDocument();
  });

  it("un reel todavía en render avisa y no deja guardar", async () => {
    requestMock.mockImplementation(
      async (path, options: ApiRequestOptions<unknown> = {}) => {
        const raw = path.endsWith("/reel")
          ? { revision: 3, reel: reelFixture() }
          : path === "/reels/preview"
            ? { html: "<p/>", durationSec: 10, warnings: [] }
            : content({ status: "BUILDING" });
        return (options.schema === undefined ? raw : options.schema.parse(raw)) as never;
      },
    );
    render(<ContentEditor contentId={ID} />, { wrapper });
    expect(await screen.findByText(/still rendering/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save & render" })).toBeDisabled();
  });
});
