/**
 * `Select Audio` con la biblioteca de la marca (sprint 7, FR-053).
 *
 * El corte del mock es `apiList` (el listado); el preview se prueba con un
 * `Audio` falso porque jsdom no reproduce nada.
 */
import { brandAudioTrackSchema, type BrandAudioTrack } from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { AudioPickerDialog } from "./AudioPickerDialog";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiList: vi.fn(),
}));

import { apiList } from "@/lib/api/client";

const listMock = vi.mocked(apiList);

function track(overrides: Record<string, unknown> = {}): BrandAudioTrack {
  return brandAudioTrackSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    title: "Beat",
    url: "https://cdn.example.test/audio/co/beat.mp3",
    origin: "upload",
    contentType: "audio/mpeg",
    sizeMb: 1,
    durationSec: 65,
    autoUse: true,
    createdAt: 1,
    ...overrides,
  });
}

const plays: string[] = [];
class FakeAudio {
  src = "";
  preload = "";
  onended: (() => void) | null = null;
  play(): Promise<void> {
    plays.push(this.src);
    return Promise.resolve();
  }
  pause(): void {}
  removeAttribute(): void {}
}

beforeEach(() => {
  listMock.mockReset();
  plays.length = 0;
  vi.stubGlobal("Audio", FakeAudio);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPicker(props: Partial<Parameters<typeof AudioPickerDialog>[0]> = {}): {
  onPick: ReturnType<typeof vi.fn>;
} {
  const onPick = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(
    <AudioPickerDialog
      open
      format="wall-of-text"
      currentUrl={null}
      onCancel={() => {}}
      onPick={onPick}
      {...props}
    />,
    { wrapper: Wrapper },
  );
  return { onPick };
}

describe("AudioPickerDialog · biblioteca de la marca", () => {
  it("lista `No audio` primero y las pistas de la marca; elegir devuelve la URL", async () => {
    listMock.mockResolvedValue({ items: [track()], cursor: null, hasMore: false });
    const { onPick } = renderPicker();

    const beat = await screen.findByRole("button", { name: /^Beat/ });
    const items = screen.getAllByRole("listitem");
    expect(items[0]?.textContent).toMatch(/No audio/i);
    expect(items[1]?.textContent).toContain("Beat");
    expect(beat.textContent).toContain("1:05");

    await userEvent.click(beat);
    expect(onPick).toHaveBeenCalledWith("https://cdn.example.test/audio/co/beat.mp3");
    expect(listMock).toHaveBeenCalledWith("/audio/library", expect.anything());
  });

  it("`No audio` marcado cuando la pieza no lleva pista, y elegirlo devuelve null", async () => {
    listMock.mockResolvedValue({ items: [], cursor: null, hasMore: false });
    const { onPick } = renderPicker();
    const none = screen.getByRole("button", { name: /No audio/i });
    expect(none.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(none);
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("preview: play y pause sin elegir la pista", async () => {
    listMock.mockResolvedValue({ items: [track()], cursor: null, hasMore: false });
    const { onPick } = renderPicker();
    const play = await screen.findByRole("button", { name: "Play Beat" });
    await userEvent.click(play);
    expect(plays).toEqual(["https://cdn.example.test/audio/co/beat.mp3"]);
    expect(await screen.findByRole("button", { name: "Pause Beat" })).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("biblioteca vacía: lo dice (no es un error)", async () => {
    listMock.mockResolvedValue({ items: [], cursor: null, hasMore: false });
    renderPicker();
    expect(await screen.findByText(/audio library is empty/i)).toBeTruthy();
  });

  it("el vacío y el sin-resultados viven en una región viva (P5-A11Y-001)", async () => {
    listMock.mockResolvedValue({ items: [], cursor: null, hasMore: false });
    renderPicker();
    const empty = await screen.findByText(/audio library is empty/i);
    expect(empty.closest('[role="status"]')).not.toBeNull();
  });

  it("un fallo de la API se ve como error, con reintento", async () => {
    listMock.mockRejectedValue(
      new ApiRequestError({ code: "service_unavailable", status: 503 }),
    );
    renderPicker();
    expect(await screen.findByText(/Couldn't load your audio library/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Try again/i })).toBeTruthy();
    expect(screen.queryByText(/audio library is empty/i)).toBeNull();
  });

  it("green-screen explica la mezcla con el audio del clip", async () => {
    listMock.mockResolvedValue({ items: [], cursor: null, hasMore: false });
    renderPicker({ format: "green-screen" });
    await waitFor(() =>
      expect(screen.getByText(/clip keeps its own sound/i)).toBeTruthy(),
    );
  });
});
