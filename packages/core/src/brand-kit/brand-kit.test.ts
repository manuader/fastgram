import type { Rng } from "@fastgram/ports";
import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import {
  buildMediaBank,
  formatsWithMedia,
  type PlanningMedia,
} from "../discovery/blitz-media.js";
import {
  DEFAULT_BLITZ_PREFERENCES,
  type BlitzPreferences,
} from "../discovery/blitz-preferences.js";
import {
  planBlitzSuggestion,
  type BlitzPlanningContext,
} from "../discovery/plan-blitz-suggestion.js";
import {
  AUTO_BRAND_KIT_SEED,
  BRAND_KIT_IMAGE_CATEGORIES,
  BRAND_KIT_VIDEO_CATEGORIES,
  DEFAULT_BRAND_KIT_IMAGES,
  DEFAULT_BRAND_KIT_VIDEOS,
  DEFAULT_BRAND_PALETTES,
  brandKitSeedTag,
  brandKitSingletonKey,
  defaultPaletteFor,
  paletteFromProfileText,
  parseBrandBackgroundsJob,
  planBrandKit,
  resolveBrandPalette,
} from "./brand-kit.js";

const COMPANY = "0b9a8c9e-6f0e-4d7c-9a51-3f1e2d4c5b6a";

function seeded(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return {
    next,
    nextInt: (min, max) => min + Math.floor(next() * (max - min)),
    weightedPick<T>(items: readonly { value: T; weight: number }[]): T {
      const total = items.reduce((s, i) => s + i.weight, 0);
      if (total <= 0) throw new Error("weightedPick sin peso");
      let target = next() * total;
      for (const item of items) {
        target -= item.weight;
        if (target < 0) return item.value;
      }
      const last = items[items.length - 1];
      if (last === undefined) throw new Error("vacío");
      return last.value;
    },
  };
}

describe("paleta de la marca", () => {
  it("la curada es determinista por id y cambia entre marcas", () => {
    expect(defaultPaletteFor(COMPANY)).toEqual(defaultPaletteFor(COMPANY));
    const ids = Array.from(
      { length: 40 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const distintas = new Set(ids.map((id) => defaultPaletteFor(id).join()));
    // Doce paletas y cuarenta marcas: si salen menos de seis, el hash no reparte.
    expect(distintas.size).toBeGreaterThanOrEqual(6);
    for (const palette of DEFAULT_BRAND_PALETTES) {
      expect(palette.length).toBeGreaterThanOrEqual(2);
      expect(palette.length).toBeLessThanOrEqual(5);
      for (const c of palette) expect(c).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("toma los hex del texto del perfil: #RGB expandido, sin repetir, hasta cinco", () => {
    expect(
      paletteFromProfileText([
        "Colores de marca: #1a2b3c y #FFF.",
        null,
        "Acento #ff6600, otra vez #1A2B3C, y #000 #111 #222 #333",
      ]),
    ).toEqual(["#1A2B3C", "#FFFFFF", "#FF6600", "#000000", "#111111"]);
  });

  it("con menos de dos colores en el perfil, la curada", () => {
    expect(paletteFromProfileText(["sólo #123456"])).toBeNull();
    expect(paletteFromProfileText(["un issue #12 no es un color"])).toBeNull();
    expect(
      resolveBrandPalette({ companyId: COMPANY, profileTexts: ["#123456"] }),
    ).toEqual({
      palette: defaultPaletteFor(COMPANY),
      source: "default",
    });
    expect(
      resolveBrandPalette({ companyId: COMPANY, profileTexts: ["#123456 y #abcdef"] }),
    ).toEqual({ palette: ["#123456", "#ABCDEF"], source: "profile" });
  });
});

describe("parseBrandBackgroundsJob", () => {
  const ok = { companyId: COMPANY, seed: "s-1", images: 8, videos: 3 };

  it("acepta el payload bueno", () => {
    expect(parseBrandBackgroundsJob(ok)).toEqual({ ok: true, payload: ok });
  });

  it.each([
    ["no objeto", null],
    ["companyId no uuid", { ...ok, companyId: "x" }],
    ["seed vacía", { ...ok, seed: "" }],
    ["seed con espacio", { ...ok, seed: "a b" }],
    ["seed larga", { ...ok, seed: "x".repeat(101) }],
    ["imágenes de más", { ...ok, images: 21 }],
    ["videos negativos", { ...ok, videos: -1 }],
    ["decimales", { ...ok, images: 1.5 }],
    ["nada que generar", { ...ok, images: 0, videos: 0 }],
  ])("rechaza: %s", (_, raw) => {
    expect(parseBrandBackgroundsJob(raw).ok).toBe(false);
  });

  it("la singletonKey es marca + semilla + cantidades", () => {
    expect(brandKitSingletonKey(ok)).toBe(`brand-backgrounds:${COMPANY}:s-1:8x3`);
    expect(brandKitSingletonKey({ ...ok, seed: "s-2" })).not.toBe(
      brandKitSingletonKey(ok),
    );
  });
});

describe("planBrandKit", () => {
  const job = { companyId: COMPANY, seed: AUTO_BRAND_KIT_SEED, images: 8, videos: 3 };

  it("ocho imágenes y tres videos por defecto, con sus categorías", () => {
    expect(DEFAULT_BRAND_KIT_IMAGES).toBe(8);
    expect(DEFAULT_BRAND_KIT_VIDEOS).toBe(3);
    const items = planBrandKit(job);
    const images = items.filter((i) => i.kind === "image");
    const videos = items.filter((i) => i.kind === "video");
    expect(images).toHaveLength(8);
    expect(videos).toHaveLength(3);
    for (const i of images) expect(i.categories).toEqual(BRAND_KIT_IMAGE_CATEGORIES);
    for (const v of videos) expect(v.categories).toEqual(BRAND_KIT_VIDEO_CATEGORIES);
    expect(new Set(images.map((i) => (i.kind === "image" ? i.aspectRatio : "")))).toEqual(
      new Set(["4:5", "9:16"]),
    );
  });

  it("claves de storage deterministas, únicas y bajo el prefijo del Media Bank", () => {
    const a = planBrandKit(job);
    const b = planBrandKit(job);
    expect(a).toEqual(b);
    const keys = a.map((i) => i.storageKey);
    expect(new Set(keys).size).toBe(keys.length);
    // El prefijo `media/<companyId>/` es el que autoriza el grant del build.
    for (const k of keys) expect(k.startsWith(`media/${COMPANY}/brand-kit/`)).toBe(true);
    // Otra semilla, otras claves.
    const other = planBrandKit({ ...job, seed: "otra" }).map((i) => i.storageKey);
    expect(other.some((k) => keys.includes(k))).toBe(false);
    // Semillas por pieza distintas: si no, el kit serían 8 copias.
    expect(new Set(a.map((i) => i.seed)).size).toBe(a.length);
    expect(brandKitSeedTag("x")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("con el kit en el Media Bank, Blitz ya planifica — PU-MEDIA-002", () => {
  const preferences: BlitzPreferences = {
    ...DEFAULT_BLITZ_PREFERENCES,
    angleWeights: {},
    textStyleWeights: {},
  };

  function context(media: readonly PlanningMedia[]): BlitzPlanningContext {
    return {
      activeAngleIds: [],
      influencers: [],
      bank: buildMediaBank(media, []),
      angleTitles: new Map(),
      influencerNames: new Map(),
    };
  }

  it("sin media: el error de hoy (la negativa primero)", () => {
    expect(() => planBlitzSuggestion(seeded(1), preferences, context([]))).toThrow(
      DomainError,
    );
    expect(() => planBlitzSuggestion(seeded(1), preferences, context([]))).toThrow(
      /No content type in the mix has media available/,
    );
  });

  it("con las filas que crea el kit: slideshow y wall-of-text, y cien planes sin fallar", () => {
    const kit = planBrandKit({ companyId: COMPANY, seed: "k", images: 8, videos: 3 });
    const media: PlanningMedia[] = kit.map((item, i) => ({
      id: `m-${String(i)}`,
      mediaType: item.kind,
      url: `https://bucket.test/${item.storageKey}`,
      categories: item.categories,
    }));
    const ctx = context(media);
    expect(formatsWithMedia(ctx.bank)).toEqual(["slideshow", "wall-of-text"]);

    const rng = seeded(42);
    const formats = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const planned = planBlitzSuggestion(rng, preferences, ctx);
      formats.add(planned.media.format);
      if (planned.media.format === "slideshow") {
        for (const slide of planned.media.slides) {
          expect(slide.url).toMatch(/\/brand-kit\/.*image-\d+\.jpg$/);
        }
      }
      if (planned.media.format === "wall-of-text") {
        expect(planned.media.video.url).toMatch(/\/brand-kit\/.*video-\d+\.mp4$/);
      }
    }
    expect(formats).toEqual(new Set(["slideshow", "wall-of-text"]));
  });
});
