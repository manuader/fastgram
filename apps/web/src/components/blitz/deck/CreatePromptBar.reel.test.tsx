/**
 * Sprint 9 (`PU-S9-010`): «Create from prompt» con formato reel arma el reel
 * directo (`POST /reels/from-prompt`, con Idempotency-Key) y ofrece abrirlo en
 * el editor. Y la tarjeta de un reel ya renderizado muestra póster + video.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@fastgram/ui";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { deckSuggestionSchema } from "@/lib/blitz/deck/suggestion";
import { libraryContentSchema } from "@/lib/library/content";
import { CardFace } from "./CardFace";
import { CreatePromptBar } from "./CreatePromptBar";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiSend: vi.fn(),
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));

import { apiRequest } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);
const ID = "33333333-3333-4333-8333-333333333333";

function wrapper({ children }: { readonly children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  requestMock.mockReset();
  push.mockReset();
});

describe("Create from prompt · reel", () => {
  it("POST /reels/from-prompt con el prompt y una Idempotency-Key; el toast abre el editor", async () => {
    requestMock.mockImplementation(async (path, options = {}) => {
      if (path === "/reels/from-prompt") {
        const raw = { _id: ID, type: "reel", status: "BUILDING", files: [], revision: 0 };
        return (options.schema === undefined ? raw : options.schema.parse(raw)) as never;
      }
      throw new ApiRequestError({ code: "not_found", status: 404 });
    });
    render(<CreatePromptBar />, { wrapper });
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("What should it be about?"),
      "Stop scrolling. Coffee rules.",
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Format" }), "reel");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        "/reels/from-prompt",
        expect.objectContaining({
          method: "POST",
          body: { prompt: "Stop scrolling. Coffee rules." },
          idempotencyKey: expect.any(String),
        }),
      ),
    );
    expect(await screen.findByText(/Your reel is rendering/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open in editor" }));
    expect(push).toHaveBeenCalledWith(expect.stringContaining(ID));
    expect(
      libraryContentSchema.safeParse({
        _id: ID,
        type: "reel",
        status: "BUILDING",
        files: [],
        revision: 0,
      }).success,
    ).toBe(true);
  });
});

describe("CardFace · reel", () => {
  it("muestra el reel renderizado con póster, y controles sólo en la de arriba", () => {
    const suggestion = deckSuggestionSchema.parse({
      id: "s-reel",
      contentType: "green-screen",
      preview: {
        reel: { videoUrl: "https://cdn.test/r.mp4", posterUrl: "https://cdn.test/r.jpg" },
      },
    });
    const { container, rerender } = render(
      <CardFace card={{ kind: "preview", key: "k", suggestion }} interactive />,
    );
    const video = container.querySelector("video");
    expect(video).toHaveAttribute("src", "https://cdn.test/r.mp4");
    expect(video).toHaveAttribute("poster", "https://cdn.test/r.jpg");
    expect(screen.getByRole("button", { name: "Play reel" })).toBeInTheDocument();
    rerender(
      <CardFace card={{ kind: "preview", key: "k", suggestion }} interactive={false} />,
    );
    expect(container.querySelector("video")).not.toHaveAttribute("src");
    expect(screen.queryByRole("button", { name: "Play reel" })).toBeNull();
  });
});
