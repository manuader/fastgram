import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChromaKeyVideo, isKeyPixel } from "./ChromaKeyVideo";

describe("isKeyPixel (sprint 9, T)", () => {
  it("verde: el criterio de siempre", () => {
    expect(isKeyPixel(20, 200, 30, "green")).toBe(true);
    expect(isKeyPixel(20, 30, 200, "green")).toBe(false);
    expect(isKeyPixel(120, 140, 120, "green")).toBe(false);
  });

  it("azul: el mismo criterio sobre el canal azul", () => {
    expect(isKeyPixel(20, 30, 200, "blue")).toBe(true);
    expect(isKeyPixel(20, 200, 30, "blue")).toBe(false);
    expect(isKeyPixel(60, 60, 80, "blue")).toBe(false);
  });

  it("alfa y sin croma no recortan nada", () => {
    for (const type of ["alpha", "none"] as const) {
      expect(isKeyPixel(20, 200, 30, type)).toBe(false);
      expect(isKeyPixel(20, 30, 200, type)).toBe(false);
    }
  });
});

describe("<ChromaKeyVideo>", () => {
  it("dibuja el video oculto y el canvas, con o sin metadato", () => {
    for (const chroma of [
      undefined,
      { type: "blue" as const },
      { type: "alpha" as const },
    ]) {
      const { container, unmount } = render(
        <ChromaKeyVideo url="https://bucket.test/clip.webm" chroma={chroma} />,
      );
      expect(container.querySelector("video")?.getAttribute("src")).toBe(
        "https://bucket.test/clip.webm",
      );
      expect(container.querySelector("canvas")).not.toBeNull();
      unmount();
    }
  });
});
