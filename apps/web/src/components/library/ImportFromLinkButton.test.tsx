/**
 * `Import from link` — `PU-MEME-001`: el pedido que sale, el progreso por
 * polling hasta que se asienta, y los errores con copy legible (nunca el
 * mensaje crudo del servidor). El corte del mock es `apiRequest`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { ImportFromLinkButton } from "./ImportFromLinkButton";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

import { apiRequest } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);
const IMPORT_ID = "5b0c2f5e-8f3b-4c51-9d52-7a9e3a1f0c11";

function renderButton() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<ImportFromLinkButton />, { wrapper: Wrapper });
}

const base = {
  importId: IMPORT_ID,
  kind: "video" as const,
  sourceUrl: "https://www.youtube.com/watch?v=abc",
  updatedAt: 1,
};

beforeEach(() => {
  requestMock.mockReset();
});

describe("ImportFromLinkButton", () => {
  it("manda url, tipo y categorías, y muestra el progreso hasta el resultado", async () => {
    const user = userEvent.setup();
    requestMock.mockImplementation(async (path, options) => {
      if (options?.method === "POST") return { ...base, state: "queued" };
      expect(path).toBe(`/media/import/${IMPORT_ID}`);
      return {
        ...base,
        state: "imported",
        mediaId: "m-1",
        mediaStatus: "ready",
        background: "green_screen",
        tagging: "tagged",
        tags: { emotion: "smug", situation: "x", people: 1, tags: ["cat", "reaction"] },
      };
    });

    renderButton();
    await user.click(screen.getByRole("button", { name: "Import from link" }));
    // El aviso de derechos está siempre (D-12).
    expect(
      screen.getByText(
        "You're responsible for having the rights to publish what you import.",
      ),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Link"), "https://www.youtube.com/watch?v=abc");
    await user.click(screen.getByRole("button", { name: /Green screen/i }));
    await user.click(screen.getByRole("button", { name: "Import" }));

    const post = requestMock.mock.calls.find(([, o]) => o?.method === "POST");
    expect(post?.[0]).toBe("/media/import");
    expect(post?.[1]?.body).toEqual({
      url: "https://www.youtube.com/watch?v=abc",
      kind: "video",
      categories: ["green-screen-video"],
    });
    expect(post?.[1]?.idempotencyKey).toEqual(expect.any(String));

    expect(await screen.findByText("Imported to your Media Bank.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Green screen detected: it's keyed out when the video is rendered.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("smug · cat, reaction")).toBeInTheDocument();
  });

  it("un fallo del worker se lee con el copy del código estable", async () => {
    const user = userEvent.setup();
    requestMock.mockImplementation(async (_path, options) =>
      options?.method === "POST"
        ? { ...base, state: "queued" }
        : { ...base, state: "failed", error: "too_long" },
    );
    renderButton();
    await user.click(screen.getByRole("button", { name: "Import from link" }));
    await user.type(screen.getByLabelText("Link"), "https://x.example.com/v");
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(
      await screen.findByText("That clip is too long. The limit is 3 minutes."),
    ).toBeInTheDocument();
  });

  it("una URL rechazada al encolar muestra el copy de link no soportado, no el del servidor", async () => {
    const user = userEvent.setup();
    requestMock.mockRejectedValue(
      new ApiRequestError({
        code: "bad_request",
        status: 400,
        serverMessage: "Links to local or private addresses can't be imported.",
        details: { reason: "unsupported_url" },
      }),
    );
    renderButton();
    await user.click(screen.getByRole("button", { name: "Import from link" }));
    await user.type(screen.getByLabelText("Link"), "http://localhost/x");
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "That link can't be imported. Use a public http(s) link to a single clip.",
      );
    });
  });

  it("audio no ofrece categorías", async () => {
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole("button", { name: "Import from link" }));
    await user.click(screen.getByRole("radio", { name: "Audio" }));
    expect(screen.queryByRole("group", { name: "Use it as" })).not.toBeInTheDocument();
  });
});
