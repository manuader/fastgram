/**
 * "Extract from a video" (sprint 7, segunda tanda, H): elegir un video del
 * Media Bank, encolar y seguir el estado hasta `done`/`failed`.
 */
import { mediaSchema, type Media } from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExtractFromVideoButton } from "./ExtractFromVideoDialog";
import { withinExtractLimit } from "./extract-api";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiList: vi.fn(),
  apiRequest: vi.fn(),
}));

import { apiList, apiRequest } from "@/lib/api/client";

const listMock = vi.mocked(apiList);
const requestMock = vi.mocked(apiRequest);

const MEDIA_ID = "22222222-2222-4222-8222-222222222222";
const LONG_ID = "33333333-3333-4333-8333-333333333333";
const EXTRACTION_ID = "44444444-4444-4444-8444-444444444444";

function video(overrides: Record<string, unknown> = {}): Media {
  return mediaSchema.parse({
    mediaId: MEDIA_ID,
    mediaType: "video",
    filename: "demo.mp4",
    r2Url: "https://cdn.example.test/media/co/demo.mp4",
    status: "ready",
    sizeMb: 3,
    videoDurationSec: 42,
    categories: [],
    origin: "manual_upload",
    uploadedAt: 1,
    ...overrides,
  });
}

function renderButton() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<ExtractFromVideoButton />, { wrapper: Wrapper });
}

beforeEach(() => {
  listMock.mockReset();
  requestMock.mockReset();
});

describe("withinExtractLimit", () => {
  it("deja pasar sin duración (el worker mide) y corta pasado el tope", () => {
    expect(withinExtractLimit(undefined)).toBe(true);
    expect(withinExtractLimit(300)).toBe(true);
    expect(withinExtractLimit(302)).toBe(false);
  });
});

describe("ExtractFromVideoButton", () => {
  it("lista sólo videos, deshabilita los largos y encola el elegido", async () => {
    listMock.mockResolvedValue({
      items: [
        video(),
        video({ mediaId: LONG_ID, filename: "long.mp4", videoDurationSec: 900 }),
      ],
      cursor: null,
      hasMore: false,
    });
    requestMock.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/audio/library/extract"
          ? { id: EXTRACTION_ID, mediaId: MEDIA_ID, state: "queued", updatedAt: 1 }
          : {
              id: EXTRACTION_ID,
              mediaId: MEDIA_ID,
              state: "done",
              trackId: "55555555-5555-4555-8555-555555555555",
              updatedAt: 2,
            },
      ),
    );
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: "Extract from a video" }));

    const long = (await screen.findByText("long.mp4")).closest("button");
    expect(long?.hasAttribute("disabled")).toBe(true);
    expect(listMock).toHaveBeenCalledWith(
      "/media",
      expect.objectContaining({ query: expect.objectContaining({ type: "video" }) }),
    );

    const start = screen.getByRole("button", { name: "Extract audio" });
    expect(start.hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByText("demo.mp4"));
    await userEvent.click(start);

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        "/audio/library/extract",
        expect.objectContaining({ method: "POST", body: { mediaId: MEDIA_ID } }),
      ),
    );
    expect(
      await screen.findByText("Done. The track is in your audio library."),
    ).toBeTruthy();
  });

  it("un fallo del worker se dice con su motivo", async () => {
    listMock.mockResolvedValue({ items: [video()], cursor: null, hasMore: false });
    requestMock.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/audio/library/extract"
          ? { id: EXTRACTION_ID, mediaId: MEDIA_ID, state: "queued", updatedAt: 1 }
          : {
              id: EXTRACTION_ID,
              mediaId: MEDIA_ID,
              state: "failed",
              error: "no_audio",
              updatedAt: 2,
            },
      ),
    );
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: "Extract from a video" }));
    await userEvent.click(await screen.findByText("demo.mp4"));
    await userEvent.click(screen.getByRole("button", { name: "Extract audio" }));
    expect(await screen.findByText("That video has no sound.")).toBeTruthy();
  });

  it("sin videos: vacío, no error", async () => {
    listMock.mockResolvedValue({ items: [], cursor: null, hasMore: false });
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: "Extract from a video" }));
    expect(await screen.findByText("No videos in your Media Bank yet.")).toBeTruthy();
  });
});
