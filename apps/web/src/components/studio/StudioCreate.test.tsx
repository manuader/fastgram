/**
 * «Create New» del Studio · `F-073` (Save deshabilitado hasta completar los
 * pasos), `F-081`/`F-082` (Save y Clear), `P2-STUDIO-002`.
 */
import { mediaSchema, type Media } from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiList: vi.fn(),
  apiRequest: vi.fn(),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/content/wall-of-text",
}));

import { apiList, apiRequest } from "@/lib/api/client";
import { StudioCreate } from "./StudioCreate";

const listMock = vi.mocked(apiList);
const requestMock = vi.mocked(apiRequest);

const VIDEO_ID = "00000000-0000-4000-8000-000000000001";

function video(): Media {
  return mediaSchema.parse({
    mediaId: VIDEO_ID,
    mediaType: "video",
    filename: "bg.mp4",
    r2Url: "https://cdn.test/bg.mp4",
    status: "ready",
    sizeMb: 3,
    categories: ["background-video"],
    origin: "manual_upload",
    uploadedAt: Date.UTC(2026, 8, 22),
  });
}

function renderStudio() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<StudioCreate format="wall-of-text" />, { wrapper: Wrapper });
}

beforeEach(() => {
  listMock.mockReset();
  requestMock.mockReset();
  push.mockReset();
  listMock.mockResolvedValue({ items: [video()], cursor: null, hasMore: false });
});

describe("StudioCreate · wall of text", () => {
  it("Save arranca deshabilitado y se habilita con media + texto; crea y abre el editor", async () => {
    const user = userEvent.setup();
    requestMock.mockResolvedValue({
      _id: "content-1",
      type: "wall-of-text",
      status: "BUILDING",
      files: [],
      revision: 1,
    });
    renderStudio();

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Choose" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: "bg.mp4" }));
    await user.click(within(dialog).getByRole("button", { name: "Use" }));

    expect(save).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Text" }), "3 running tips");
    expect(save).toBeEnabled();

    await user.click(save);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/library/content-1/edit"));
    const [path, options] = requestMock.mock.calls[0] ?? [];
    expect(path).toBe("/content/studio");
    expect(options?.method).toBe("POST");
    expect(options?.idempotencyKey).toEqual(expect.any(String));
    expect(options?.body).toEqual({
      format: "wall-of-text",
      media: { video: VIDEO_ID },
      texts: ["3 running tips"],
      textStylePresetId: "tiktok-classic",
    });
  });

  it("Clear vuelve al draft vacío", async () => {
    const user = userEvent.setup();
    renderStudio();
    await user.type(screen.getByRole("textbox", { name: "Text" }), "algo");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("textbox", { name: "Text" })).toHaveValue("");
  });

  it("con IA alcanza el brief (el texto lo escribe el worker)", async () => {
    const user = userEvent.setup();
    renderStudio();
    await user.click(screen.getByRole("button", { name: "Choose" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: "bg.mp4" }));
    await user.click(within(dialog).getByRole("button", { name: "Use" }));
    await user.click(screen.getByRole("radio", { name: "Generate with AI" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "What should it say?" }), "tips");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("un error de la API se muestra y no navega", async () => {
    const user = userEvent.setup();
    requestMock.mockRejectedValue(new Error("boom"));
    renderStudio();
    await user.click(screen.getByRole("button", { name: "Choose" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: "bg.mp4" }));
    await user.click(within(dialog).getByRole("button", { name: "Use" }));
    await user.type(screen.getByRole("textbox", { name: "Text" }), "x");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
