import { describe, expect, it } from "vitest";
import {
  finalizeMediaRequestSchema,
  listMediaQuerySchema,
  mediaSchema,
  MEDIA_SET_MIN_ASSETS,
  updateImageMediaRequestSchema,
  updateMediaRequestSchema,
  updateVideoMediaRequestSchema,
} from "./media";

const image = {
  mediaId: "med_1",
  mediaType: "image" as const,
  filename: "a.png",
  r2Url: "https://cdn.example.com/a.png",
  status: "ready" as const,
  sizeMb: 1.2,
  categories: [],
  origin: "manual_upload" as const,
  uploadedAt: 1,
};

describe("categorías válidas por tipo · F-129 · PRD:601 · FR-100 · PRD:1633", () => {
  it("una imagen acepta slideshow-image y green-screen-background", () => {
    expect(
      mediaSchema.parse({
        ...image,
        categories: ["slideshow-image", "green-screen-background"],
      }).categories,
    ).toHaveLength(2);
  });

  it("una imagen NO acepta una categoría de video", () => {
    expect(() => mediaSchema.parse({ ...image, categories: ["hook-video"] })).toThrow();
  });

  it("un video acepta background-video, hook-video y green-screen-video", () => {
    const video = { ...image, mediaType: "video" as const, filename: "a.mp4" };
    expect(
      mediaSchema.parse({
        ...video,
        categories: ["background-video", "hook-video", "green-screen-video"],
      }).categories,
    ).toHaveLength(3);
  });

  it("un video NO acepta una categoría de imagen", () => {
    expect(() =>
      mediaSchema.parse({
        ...image,
        mediaType: "video",
        categories: ["slideshow-image"],
      }),
    ).toThrow();
  });

  it("los schemas estrechos rechazan la categoría del otro tipo", () => {
    expect(() =>
      updateImageMediaRequestSchema.parse({ categories: ["hook-video"] }),
    ).toThrow();
    expect(() =>
      updateVideoMediaRequestSchema.parse({ categories: ["slideshow-image"] }),
    ).toThrow();
  });
});

describe("PATCH de categorías: reemplazo total · FR-100 · PRD:1634", () => {
  it("la lista vacía es válida — saca el asset de todos los pools de Blitz", () => {
    expect(updateMediaRequestSchema.parse({ categories: [] }).categories).toEqual([]);
  });

  it("no existe una operación de 'añadir': sólo `categories`", () => {
    expect(() =>
      updateMediaRequestSchema.parse({ addCategories: ["hook-video"] }),
    ).toThrow();
  });
});

describe("sets y listado", () => {
  it("un set necesita al menos 5 assets · FR-100 · PRD:1621", () => {
    expect(MEDIA_SET_MIN_ASSETS).toBe(5);
  });

  it("GET /media filtra por type · §12 · PRD:2722", () => {
    expect(listMediaQuerySchema.parse({ type: "video" }).type).toBe("video");
    expect(() => listMediaQuerySchema.parse({ type: "audio" })).toThrow();
  });

  it("el listado hereda el limit por defecto 20", () => {
    expect(listMediaQuerySchema.parse({}).limit).toBe(20);
  });

  it("la finalización identifica la reserva · §9.8 · PRD:2338", () => {
    expect(finalizeMediaRequestSchema.parse({ uploadId: "up_1" }).uploadId).toBe("up_1");
    expect(() => finalizeMediaRequestSchema.parse({})).toThrow();
  });
});

describe("el recurso público no filtra campos internos · NFR-007 · PRD:2957", () => {
  it("rechaza storageKey y companyId", () => {
    expect(() =>
      mediaSchema.parse({ ...image, storageKey: "workspaces/1/a.png" }),
    ).toThrow();
    expect(() => mediaSchema.parse({ ...image, companyId: "cmp_1" })).toThrow();
  });
});
