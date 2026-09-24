/**
 * `PU-EDIT-003` — los swaps de media sobre el payload original.
 */
import { describe, expect, it } from "vitest";

import {
  applyAssetSwaps,
  assetsOf,
  hasAssetSwaps,
  readAssetSwaps,
  resolveAssetPatch,
  withAssetSwaps,
  type MediaDraw,
} from "./asset-swaps.js";

const draw = (url: string, w = 1080, h = 1920): MediaDraw => ({
  url,
  drawX: 0,
  drawY: 0,
  drawW: w,
  drawH: h,
});

const text = { content: "hola", x: 540, y: 960, width: 864, fontSize: 18 };

const wallOfText = {
  canvas: { width: 1080, height: 1920 },
  video: draw("https://cdn.test/v.mp4"),
  audio: { url: "https://cdn.test/a.mp3" },
  text,
};

const greenScreen = {
  canvas: { width: 1080, height: 1920 },
  image: draw("https://cdn.test/bg.jpg"),
  video: draw("https://cdn.test/meme.mp4"),
  text,
};

const slideshow = {
  num_images: 2,
  images: [
    {
      canvas: { width: 1080, height: 1350, aspectRatio: "4:5" },
      image: draw("https://cdn.test/s0.jpg", 1080, 1350),
      texts: [],
    },
    {
      canvas: { width: 1080, height: 1350, aspectRatio: "4:5" },
      image: draw("https://cdn.test/s1.jpg", 1080, 1350),
      texts: [],
    },
  ],
};

describe("assetsOf", () => {
  it("wall-of-text: video y audio", () => {
    expect(assetsOf(wallOfText)).toEqual({
      video: wallOfText.video,
      audio: { url: "https://cdn.test/a.mp3" },
    });
  });

  it("wall-of-text sin audio → audio null (No audio)", () => {
    const { audio: _omit, ...sinAudio } = wallOfText;
    expect(assetsOf(sinAudio).audio).toBeNull();
  });

  it("green-screen: imagen y video, sin clave de audio", () => {
    const assets = assetsOf(greenScreen);
    expect(assets.image?.url).toBe("https://cdn.test/bg.jpg");
    expect(assets.video?.url).toBe("https://cdn.test/meme.mp4");
    expect("audio" in assets).toBe(false);
  });

  it("slideshow: una imagen por slide", () => {
    expect(assetsOf(slideshow).slides?.map((s) => s.url)).toEqual([
      "https://cdn.test/s0.jpg",
      "https://cdn.test/s1.jpg",
    ]);
  });
});

describe("applyAssetSwaps", () => {
  it("sin swaps devuelve la misma referencia", () => {
    const r = applyAssetSwaps(wallOfText, {});
    expect(r.ok && r.payload).toBe(wallOfText);
  });

  it("reemplaza sólo el slide indicado (FR-071)", () => {
    const r = applyAssetSwaps(slideshow, {
      slides: [{ index: 1, image: draw("https://cdn.test/new.jpg", 1080, 1350) }],
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.payload.images[0]?.image.url).toBe("https://cdn.test/s0.jpg");
    expect(r.payload.images[1]?.image.url).toBe("https://cdn.test/new.jpg");
    expect(r.payload.num_images).toBe(2);
  });

  it("audio null omite el bloque entero (FR-053.1)", () => {
    const r = applyAssetSwaps(wallOfText, { audio: null });
    if (!r.ok) throw new Error(r.reason);
    expect("audio" in r.payload).toBe(false);
    expect(r.payload.video).toEqual(wallOfText.video);
  });

  it("no muta el original", () => {
    const copia = JSON.parse(JSON.stringify(greenScreen)) as typeof greenScreen;
    applyAssetSwaps(greenScreen, { video: draw("https://cdn.test/otro.mp4") });
    expect(greenScreen).toEqual(copia);
  });

  it("rechaza un slot que el formato no tiene", () => {
    const r = applyAssetSwaps(greenScreen, { audio: null });
    expect(r.ok ? null : r.code).toBe("asset_slot_not_in_format");
    const r2 = applyAssetSwaps(wallOfText, { image: draw("https://cdn.test/x.jpg") });
    expect(r2.ok ? null : r2.code).toBe("asset_slot_not_in_format");
  });

  it("rechaza un slide inexistente", () => {
    const r = applyAssetSwaps(slideshow, {
      slides: [{ index: 2, image: draw("https://cdn.test/x.jpg") }],
    });
    expect(r.ok ? null : r.code).toBe("asset_slide_out_of_range");
  });
});

describe("resolveAssetPatch", () => {
  it("zoom del meme: sólo draw*, sin URL nueva que validar", () => {
    const r = resolveAssetPatch(
      greenScreen,
      {},
      {
        video: { drawX: -270, drawY: -480, drawW: 1620, drawH: 2880 },
      },
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.incoming).toEqual([]);
    expect(r.swaps.video).toEqual({
      url: "https://cdn.test/meme.mp4",
      drawX: -270,
      drawY: -480,
      drawW: 1620,
      drawH: 2880,
    });
  });

  it("swap de video: URL nueva de tipo video, conserva el rectángulo", () => {
    const r = resolveAssetPatch(
      greenScreen,
      {},
      {
        video: { url: "https://cdn.test/nuevo.mp4" },
      },
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.incoming).toEqual([
      { url: "https://cdn.test/nuevo.mp4", kind: "video", slot: "video" },
    ]);
    expect(r.swaps.video?.drawW).toBe(1080);
  });

  it("acumula sobre los swaps guardados", () => {
    const stored = { image: draw("https://cdn.test/bg2.jpg") };
    const r = resolveAssetPatch(greenScreen, stored, {
      video: { url: "https://cdn.test/nuevo.mp4" },
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.swaps.image?.url).toBe("https://cdn.test/bg2.jpg");
    expect(r.swaps.video?.url).toBe("https://cdn.test/nuevo.mp4");
  });

  it("re-mandar la URL vigente no cuenta como nueva", () => {
    const stored = { video: draw("https://cdn.test/nuevo.mp4") };
    const r = resolveAssetPatch(greenScreen, stored, {
      video: { url: "https://cdn.test/nuevo.mp4", drawW: 2000 },
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.incoming).toEqual([]);
  });

  it("slides: acumula por índice y ordena", () => {
    const stored = {
      slides: [{ index: 1, image: draw("https://cdn.test/b.jpg", 1080, 1350) }],
    };
    const r = resolveAssetPatch(slideshow, stored, {
      slides: [{ index: 0, image: { url: "https://cdn.test/a.jpg" } }],
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.swaps.slides?.map((s) => [s.index, s.image.url])).toEqual([
      [0, "https://cdn.test/a.jpg"],
      [1, "https://cdn.test/b.jpg"],
    ]);
    expect(r.incoming).toEqual([
      { url: "https://cdn.test/a.jpg", kind: "image", slot: "slides[0]" },
    ]);
  });

  it("audio: null es No audio y no pide validar nada", () => {
    const r = resolveAssetPatch(wallOfText, {}, { audio: null });
    if (!r.ok) throw new Error(r.reason);
    expect(r.swaps.audio).toBeNull();
    expect(r.incoming).toEqual([]);
  });

  it("rechaza sin tocar nada si el slot no existe", () => {
    const r = resolveAssetPatch(
      slideshow,
      {},
      { video: { url: "https://x.test/v.mp4" } },
    );
    expect(r.ok).toBe(false);
  });
});

describe("readAssetSwaps / withAssetSwaps", () => {
  it("sin studioState → {}", () => {
    expect(readAssetSwaps(null)).toEqual({});
    expect(readAssetSwaps({ otra: 1 })).toEqual({});
  });

  it("ida y vuelta", () => {
    const swaps = {
      video: draw("https://cdn.test/v2.mp4"),
      audio: null,
      slides: [{ index: 0, image: draw("https://cdn.test/s.jpg") }],
    };
    const state = withAssetSwaps({ otra: 1 }, swaps);
    expect(state["otra"]).toBe(1);
    expect(readAssetSwaps(JSON.parse(JSON.stringify(state)))).toEqual(swaps);
  });

  it("forma rota → null", () => {
    expect(readAssetSwaps({ assets: { video: { url: 3 } } })).toBeNull();
    expect(readAssetSwaps({ assets: "x" })).toBeNull();
    expect(readAssetSwaps("x")).toBeNull();
  });

  it("hasAssetSwaps", () => {
    expect(hasAssetSwaps({})).toBe(false);
    expect(hasAssetSwaps({ audio: null })).toBe(true);
    expect(hasAssetSwaps({ slides: [] })).toBe(false);
  });
});
