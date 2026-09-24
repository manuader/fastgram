/**
 * La política pura de la subida al Media Bank: qué archivo entra, qué tipo de
 * asset va a ser y qué categorías se le sugieren. Lo que depende de React y de
 * la red está en `components/library/MediaUpload.test.tsx`.
 */
import { mbToBytes } from "@fastgram/contracts";
import { describe, expect, it } from "vitest";
import { suggestCategories, toggleCategory } from "../categories";
import { describeMediaUpload, MEDIA_UPLOAD_ACCEPT, mediaTypeOfCandidate } from "./queue";

describe("describeMediaUpload — el schema del contrato decide", () => {
  it("cada tipo con su propio techo: 10 MB imagen, 50 MB video", () => {
    const eleven = mbToBytes(11);
    expect(
      describeMediaUpload({ name: "a.jpg", type: "image/jpeg", size: eleven }),
    ).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(
      describeMediaUpload({ name: "a.mp4", type: "video/mp4", size: eleven }).ok,
    ).toBe(true);
  });

  it("un `.mov` sin MIME (Windows, algunos Safari) se deduce por extensión", () => {
    const check = describeMediaUpload({ name: "clip.MOV", type: "", size: 10 });
    expect(check).toEqual({
      ok: true,
      body: { filename: "clip.MOV", contentType: "video/quicktime", sizeBytes: 10 },
    });
  });

  it("formato no soportado, extensión cambiada y archivo vacío tienen motivos distintos", () => {
    expect(describeMediaUpload({ name: "a.gif", type: "image/gif", size: 10 })).toEqual({
      ok: false,
      reason: "unsupported_type",
    });
    expect(describeMediaUpload({ name: "a.png", type: "image/jpeg", size: 10 })).toEqual({
      ok: false,
      reason: "extension_mismatch",
    });
    expect(describeMediaUpload({ name: "a.png", type: "image/png", size: 0 })).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("el `accept` lleva MIME y extensiones de los cinco tipos", () => {
    for (const token of ["image/webp", "video/quicktime", ".jpeg", ".mov", ".webp"]) {
      expect(MEDIA_UPLOAD_ACCEPT.split(",")).toContain(token);
    }
  });

  it("el tipo de asset sale del content type, o de la extensión", () => {
    expect(mediaTypeOfCandidate({ name: "a.webp", type: "", size: 1 })).toBe("image");
    expect(mediaTypeOfCandidate({ name: "a.mp4", type: "video/mp4", size: 1 })).toBe(
      "video",
    );
    expect(
      mediaTypeOfCandidate({ name: "a.txt", type: "text/plain", size: 1 }),
    ).toBeNull();
  });
});

describe("suggestCategories", () => {
  it("imagen → slideshow + fondo de pantalla verde", () => {
    expect(suggestCategories("image", null)).toEqual([
      "slideshow-image",
      "green-screen-background",
    ]);
  });

  it("video vertical o sin medidas → background; horizontal → hook", () => {
    expect(suggestCategories("video", { width: 1080, height: 1920 })).toEqual([
      "background-video",
    ]);
    expect(suggestCategories("video", null)).toEqual(["background-video"]);
    expect(suggestCategories("video", { width: 1920, height: 1080 })).toEqual([
      "hook-video",
    ]);
  });

  it("nunca sugiere `green-screen-video`: sería afirmar algo sin mirar el clip", () => {
    for (const dims of [null, { width: 1, height: 2 }, { width: 2, height: 1 }]) {
      expect(suggestCategories("video", dims)).not.toContain("green-screen-video");
    }
  });
});

describe("toggleCategory", () => {
  it("alterna y deja el orden canónico del contrato", () => {
    expect(toggleCategory("video", ["hook-video"], "background-video")).toEqual([
      "background-video",
      "hook-video",
    ]);
    expect(toggleCategory("image", ["slideshow-image"], "slideshow-image")).toEqual([]);
  });
});
