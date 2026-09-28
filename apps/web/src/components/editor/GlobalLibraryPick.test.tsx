/**
 * Sprint 9 (T, `PU-S9-015`): la biblioteca global en los pickers del editor
 * clásico. Elegir copia a la marca (`use-in-brand`) y el editor recibe la URL
 * de la copia, nunca la de `library/`.
 *
 * El corte del mock es `apiList` / `apiRequest`, como en los tests de N.
 */
import { libraryAssetSchema, type LibraryAsset } from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AudioPickerDialog } from "./AudioPickerDialog";
import { MediaPickerDialog } from "./MediaPickerDialog";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiList: vi.fn(),
  apiRequest: vi.fn(),
}));

// jsdom no tiene canvas 2D: la preview del picker usa el keyer.
vi.mock("@/components/blitz/deck/ChromaKeyVideo", () => ({
  ChromaKeyVideo: () => <div data-testid="chroma-key" />,
}));

import { apiList, apiRequest } from "@/lib/api/client";

const listMock = vi.mocked(apiList);
const requestMock = vi.mocked(apiRequest);

const ASSET_ID = "0b7f3c1a-2c4e-4f5a-8b6d-9e0f1a2b3c4d";
const COPY_ID = "2d9b5e3c-4e6a-4b7c-8d8f-1a2b3c4d5e6f";
const NOW = "2026-09-28T12:00:00.000Z";
const LICENSE = {
  type: "cc0",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:X.webm",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  verifiedAt: NOW,
};

function asset(kind: "green_screen_video" | "audio"): LibraryAsset {
  return libraryAssetSchema.parse({
    id: ASSET_ID,
    title: kind === "audio" ? "Drum loop" : "Facepalm",
    kind,
    mediaType: kind === "audio" ? "audio" : "video",
    status: "ready",
    url: "https://cdn.example.test/library/x.mp4",
    previewUrl: null,
    contentType: kind === "audio" ? "audio/mpeg" : "video/mp4",
    sizeMb: 1,
    durationSec: 4,
    width: kind === "audio" ? null : 1080,
    height: kind === "audio" ? null : 1920,
    license: LICENSE,
    metadataSource: "auto",
    provider: "wikimedia",
    externalId: "File:X.webm",
    failureCode: null,
    createdAt: NOW,
    updatedAt: NOW,
    metadata: {
      schemaVersion: 1,
      kind,
      description: "x",
      memeType: kind === "audio" ? "music" : "reaction",
      emotions: [],
      useCases: [],
      characters: [],
      tags: [],
      language: null,
      hasSpeech: false,
      durationSec: 4,
      aspect:
        kind === "audio"
          ? { ratio: "other", width: null, height: null }
          : { ratio: "9:16", width: 1080, height: 1920 },
      framing: "none",
      chroma:
        kind === "audio"
          ? { type: "none", keyQuality: null, keyColor: null }
          : { type: "green", keyQuality: 0.9, keyColor: "#00FF00" },
      nsfw: false,
      energy: "medium",
      needsReview: false,
      license: LICENSE,
    },
  });
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function routeLists(libraryItem: LibraryAsset) {
  listMock.mockImplementation(((path: string) =>
    Promise.resolve({
      items: path === "/library/assets" ? [libraryItem] : [],
      cursor: null,
      hasMore: false,
    })) as unknown as typeof apiList);
}

beforeEach(() => {
  listMock.mockReset();
  requestMock.mockReset();
});

describe("MediaPickerDialog → Library (biblioteca global)", () => {
  it("abre el picker global con los tipos del hueco, copia a la marca y entrega la URL de la copia", async () => {
    const user = userEvent.setup();
    routeLists(asset("green_screen_video"));
    const copyUrl = `https://cdn.example.test/media/co/library/${COPY_ID}.mp4`;
    requestMock.mockResolvedValue({
      assetId: ASSET_ID,
      target: "media",
      targetId: COPY_ID,
      url: copyUrl,
    });
    const onPick = vi.fn();
    render(
      <MediaPickerDialog
        open
        type="video"
        title="Select Video"
        onCancel={() => undefined}
        onPick={onPick}
      />,
      { wrapper },
    );

    await user.click(screen.getByRole("tab", { name: "Library" }));
    await user.click(screen.getByRole("button", { name: "Browse the global library" }));

    expect(
      await screen.findByRole("heading", { name: "Global library" }),
    ).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith(
      "/library/assets",
      expect.objectContaining({
        query: expect.objectContaining({ status: "ready" }) as unknown,
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Use Facepalm" }));

    await waitFor(() => {
      expect(onPick).toHaveBeenCalledWith(copyUrl);
    });
    expect(requestMock).toHaveBeenCalledWith(
      `/library/assets/${ASSET_ID}/use-in-brand`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("si copiar falla, vuelve al picker del editor y lo dice", async () => {
    const user = userEvent.setup();
    routeLists(asset("green_screen_video"));
    requestMock.mockRejectedValue(new Error("boom"));
    const onPick = vi.fn();
    render(
      <MediaPickerDialog
        open
        type="video"
        title="Select Video"
        onCancel={() => undefined}
        onPick={onPick}
      />,
      { wrapper },
    );
    await user.click(screen.getByRole("tab", { name: "Library" }));
    await user.click(screen.getByRole("button", { name: "Browse the global library" }));
    await user.click(await screen.findByRole("button", { name: "Use Facepalm" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't add it to this brand",
    );
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("AudioPickerDialog → Global library", () => {
  it("sólo audio; la pista elegida se copia a la biblioteca de la marca y se elige la copia", async () => {
    const user = userEvent.setup();
    routeLists(asset("audio"));
    const copyUrl = "https://cdn.example.test/audio/co/library/drum.mp3";
    requestMock.mockResolvedValue({
      assetId: ASSET_ID,
      target: "audio",
      targetId: COPY_ID,
      url: copyUrl,
    });
    const onPick = vi.fn();
    render(
      <AudioPickerDialog
        open
        format="wall-of-text"
        currentUrl={null}
        onCancel={() => undefined}
        onPick={onPick}
      />,
      { wrapper },
    );

    await user.click(screen.getByRole("button", { name: "Global library" }));
    await user.click(await screen.findByRole("button", { name: "Use Drum loop" }));

    await waitFor(() => {
      expect(onPick).toHaveBeenCalledWith(copyUrl);
    });
    expect(listMock).toHaveBeenCalledWith(
      "/library/assets",
      expect.objectContaining({
        query: expect.objectContaining({ kind: "audio" }) as unknown,
      }),
    );
  });
});
