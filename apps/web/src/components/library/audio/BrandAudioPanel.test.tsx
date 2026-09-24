/**
 * El panel de audio de la Library (sprint 7): los estados (cargando, vacío,
 * error, lista) y las escrituras (renombrar, sacar del sorteo, borrar).
 */
import { brandAudioTrackSchema, type BrandAudioTrack } from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { BrandAudioPanel } from "./BrandAudioPanel";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiList: vi.fn(),
  apiRequest: vi.fn(),
  apiSend: vi.fn(),
}));

import { apiList, apiRequest, apiSend } from "@/lib/api/client";

const listMock = vi.mocked(apiList);
const requestMock = vi.mocked(apiRequest);
const sendMock = vi.mocked(apiSend);

const ID = "11111111-1111-4111-8111-111111111111";

function track(overrides: Record<string, unknown> = {}): BrandAudioTrack {
  return brandAudioTrackSchema.parse({
    id: ID,
    title: "Beat",
    url: "https://cdn.example.test/audio/co/beat.mp3",
    origin: "import",
    contentType: "audio/mp4",
    sizeMb: 1.25,
    durationSec: 12,
    autoUse: true,
    createdAt: 1,
    ...overrides,
  });
}

beforeEach(() => {
  listMock.mockReset();
  requestMock.mockReset();
  sendMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<BrandAudioPanel />, { wrapper: Wrapper });
}

describe("BrandAudioPanel", () => {
  it("lista las pistas con origen, duración y tamaño", async () => {
    listMock.mockResolvedValue({ items: [track()], cursor: null, hasMore: false });
    renderPanel();
    expect(await screen.findByText("Beat")).toBeTruthy();
    expect(screen.getByText("Imported · 0:12 · 1.3 MB")).toBeTruthy();
    expect(listMock).toHaveBeenCalledWith("/audio/library", expect.anything());
  });

  it("vacío no es error: invita a subir o importar", async () => {
    listMock.mockResolvedValue({ items: [], cursor: null, hasMore: false });
    renderPanel();
    expect(await screen.findByText("No audio yet")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("un fallo de la API se ve como error con reintento, no como vacío", async () => {
    listMock.mockRejectedValue(
      new ApiRequestError({ code: "service_unavailable", status: 503 }),
    );
    renderPanel();
    expect(await screen.findByText(/Couldn't load your audio library/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("No audio yet")).toBeNull();
  });

  it("renombrar manda PATCH con el título nuevo", async () => {
    listMock.mockResolvedValue({ items: [track()], cursor: null, hasMore: false });
    requestMock.mockResolvedValue(track({ title: "Intro" }));
    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Track name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Intro");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        `/audio/library/${ID}`,
        expect.objectContaining({ method: "PATCH", body: { title: "Intro" } }),
      ),
    );
  });

  it("sacar del sorteo de Blitz manda autoUse=false", async () => {
    listMock.mockResolvedValue({ items: [track()], cursor: null, hasMore: false });
    requestMock.mockResolvedValue(track({ autoUse: false }));
    renderPanel();
    await userEvent.click(await screen.findByRole("checkbox", { name: "Use in Blitz" }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        `/audio/library/${ID}`,
        expect.objectContaining({ method: "PATCH", body: { autoUse: false } }),
      ),
    );
  });

  it("borrar pide confirmación y manda DELETE", async () => {
    listMock.mockResolvedValue({ items: [track()], cursor: null, hasMore: false });
    sendMock.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    renderPanel();
    const del = await screen.findByRole("button", { name: "Delete" });
    await userEvent.click(del);
    expect(sendMock).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    await userEvent.click(del);
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(`/audio/library/${ID}`, { method: "DELETE" }),
    );
  });

  it("un archivo que no es audio se rechaza sin llamar a la API", async () => {
    listMock.mockResolvedValue({ items: [], cursor: null, hasMore: false });
    renderPanel();
    await screen.findByText("No audio yet");
    const input = screen.getByTestId("brand-audio-file");
    await userEvent.upload(input, new File(["x"], "clip.mp4", { type: "video/mp4" }), {
      applyAccept: false,
    });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(requestMock).not.toHaveBeenCalled();
  });
});
