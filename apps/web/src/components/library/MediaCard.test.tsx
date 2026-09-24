/**
 * La miniatura de un video del Media Bank (sprint 7, segunda tanda): el primer
 * frame con `preload="metadata"` y `#t=0.1`, no el rótulo "Video". Sin estar
 * `ready`, o si el navegador no lo decodifica, vuelve el rótulo.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mediaSchema, type Media } from "@fastgram/contracts";

import { MediaCard } from "./MediaCard";

const URL_MP4 = "https://bucket.test/media/ws/clip.mp4";

function video(over: Partial<Media> = {}): Media {
  return mediaSchema.parse({
    mediaId: "33333333-3333-4333-8333-333333333333",
    mediaType: "video",
    filename: "clip.mp4",
    r2Url: URL_MP4,
    status: "ready",
    sizeMb: 4,
    videoDurationSec: 5,
    categories: ["hook-video"],
    origin: "manual_upload",
    uploadedAt: Date.parse("2026-09-24T12:00:00.000Z"),
    ...over,
  });
}

function renderCard(item: Media) {
  return render(
    <ul>
      <MediaCard item={item} />
    </ul>,
  );
}

describe("MediaCard · miniatura de video", () => {
  it("un video listo muestra su primer frame sin bajar el archivo entero", () => {
    renderCard(video());
    const frame = screen.getByTestId("media-video-frame") as HTMLVideoElement;
    expect(frame.getAttribute("src")).toBe(`${URL_MP4}#t=0.1`);
    expect(frame.getAttribute("preload")).toBe("metadata");
    expect(frame.muted).toBe(true);
    expect(frame.autoplay).toBe(false);
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByText("Video")).toBeNull();
  });

  it("mientras se procesa, el rótulo de siempre", () => {
    renderCard(video({ status: "processing" }));
    expect(screen.queryByTestId("media-video-frame")).toBeNull();
    expect(screen.getByText("Video")).toBeInTheDocument();
  });

  it("si el navegador no puede decodificarlo, vuelve el rótulo", () => {
    renderCard(video());
    fireEvent.error(screen.getByTestId("media-video-frame"));
    expect(screen.queryByTestId("media-video-frame")).toBeNull();
    expect(screen.getByText("Video")).toBeInTheDocument();
  });
});
