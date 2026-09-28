/**
 * Sprint 9 (S): la capa de logo — geometría, luminancia y elección claro/oscuro.
 */
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  contrastRatio,
  logoBox,
  logoFingerprint,
  logoRequestSchema,
  meanLuminance,
  placeLogo,
  pixelContrast,
  prepareLogos,
  regionPixels,
  relativeLuminance,
  type LogoRequest,
} from "./logoLayer.js";

const CANVAS = { width: 1080, height: 1920 };

async function solid(
  width: number,
  height: number,
  rgb: { r: number; g: number; b: number },
  alpha = 1,
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { ...rgb, alpha } } })
    .png()
    .toBuffer();
}

/** Un «logo»: un rectángulo del color pedido con margen transparente. */
async function logoPng(rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  const mark = await solid(200, 80, rgb);
  return sharp({
    create: {
      width: 300,
      height: 180,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: mark, left: 50, top: 50 }])
    .png()
    .toBuffer();
}

describe("luminancia y contraste (WCAG)", () => {
  it("blanco 1, negro 0, contraste 21", () => {
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 5);
    expect(relativeLuminance(0, 0, 0)).toBe(0);
    expect(contrastRatio(1, 0)).toBeCloseTo(21, 5);
  });

  it("los píxeles transparentes de un logo no cuentan", () => {
    // 1 píxel blanco opaco + 1 negro transparente → luminancia 1.
    const data = Buffer.from([255, 255, 255, 255, 0, 0, 0, 0]);
    expect(meanLuminance(data, 4, true)).toBeCloseTo(1, 5);
    expect(meanLuminance(Buffer.from([0, 0, 0, 0]), 4, true)).toBeNull();
  });
});

describe("geometría", () => {
  it("esquinas con margen del 5 % y ancho por tamaño", () => {
    const tr = logoBox(CANVAS, "top-right", "small", 2);
    expect(tr).toEqual({ left: 1080 - 54 - 130, top: 54, width: 130, height: 65 });
    const bl = logoBox(CANVAS, "bottom-left", "large", 2);
    expect(bl.left).toBe(54);
    expect(bl.top + bl.height).toBe(1920 - 54);
    expect(bl.width).toBe(259);
  });

  it("un logo vertical no pasa del 12 % del alto", () => {
    const box = logoBox(CANVAS, "top-left", "large", 0.2);
    expect(box.height).toBe(Math.round(1920 * 0.12));
    expect(box.width).toBe(Math.round(box.height * 0.2));
  });
});

describe("contrato del request", () => {
  it("enums cerrados, 1–4 imágenes, sin claves de más", () => {
    const ok = {
      images: [{ url: "https://s3/a.png" }],
      corner: "top-right",
      size: "small",
      opacity: 0.9,
    };
    expect(logoRequestSchema.safeParse(ok).success).toBe(true);
    expect(logoRequestSchema.safeParse({ ...ok, images: [] }).success).toBe(false);
    expect(logoRequestSchema.safeParse({ ...ok, corner: "middle" }).success).toBe(false);
    expect(logoRequestSchema.safeParse({ ...ok, x: 3 }).success).toBe(false);
  });

  it("la huella cambia con la esquina, el tamaño, la opacidad y las URLs", () => {
    const base: LogoRequest = {
      images: [{ url: "https://s3/a.png" }],
      corner: "top-right",
      size: "small",
      opacity: 0.9,
    };
    const fp = logoFingerprint(base);
    expect(logoFingerprint({ ...base })).toBe(fp);
    expect(logoFingerprint({ ...base, corner: "top-left" })).not.toBe(fp);
    expect(logoFingerprint({ ...base, opacity: 0.8 })).not.toBe(fp);
    expect(logoFingerprint({ ...base, images: [{ url: "https://s3/b.png" }] })).not.toBe(
      fp,
    );
  });
});

describe("con píxeles de verdad (sharp)", () => {
  const request: LogoRequest = {
    images: [{ url: "https://s3/dark.png" }, { url: "https://s3/light.png" }],
    corner: "top-right",
    size: "medium",
    opacity: 1,
  };

  async function prepared() {
    const files: Record<string, Buffer> = {
      "https://s3/dark.png": await logoPng({ r: 20, g: 20, b: 30 }),
      "https://s3/light.png": await logoPng({ r: 250, g: 250, b: 245 }),
    };
    // `prepareLogos` pide rutas: sharp también acepta buffers, así que el
    // resolver de prueba devuelve la clave y se intercepta abajo.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(tmpdir(), "logo-test-"));
    return prepareLogos(request, async (url) => {
      const file = path.join(dir, `${url.endsWith("dark.png") ? "dark" : "light"}.png`);
      await writeFile(file, files[url] ?? Buffer.alloc(0));
      return file;
    });
  }

  it("recorta el margen transparente y mide cada variante", async () => {
    const logos = await prepared();
    expect(logos.map((l) => [l.width, l.height])).toEqual([
      [200, 80],
      [200, 80],
    ]);
    expect(logos[0]?.luminance).toBeLessThan(0.05);
    expect(logos[1]?.luminance).toBeGreaterThan(0.9);
  });

  it("fondo oscuro → logo claro; fondo claro → logo oscuro", async () => {
    const logos = await prepared();
    const dark = await solid(1080, 1920, { r: 10, g: 10, b: 10 });
    const light = await solid(1080, 1920, { r: 240, g: 240, b: 240 });
    const onDark = await placeLogo(CANVAS, request, logos, async (box) => [
      await regionPixels(dark, box),
    ]);
    const onLight = await placeLogo(CANVAS, request, logos, async (box) => [
      await regionPixels(light, box),
    ]);
    expect(onDark.chosen).toBe(1);
    expect(onLight.chosen).toBe(0);
  });

  it("mide el fondo bajo la esquina, no el promedio de la imagen", async () => {
    // Imagen clara con la esquina superior derecha negra.
    const base = await sharp(await solid(1080, 1920, { r: 240, g: 240, b: 240 }))
      .composite([
        { input: await solid(400, 300, { r: 0, g: 0, b: 0 }), left: 680, top: 0 },
      ])
      .png()
      .toBuffer();
    const placed = await placeLogo(CANVAS, request, await prepared(), async (box) => [
      await regionPixels(base, box),
    ]);
    expect(placed.chosen).toBe(1); // claro, porque la esquina es negra
  });

  it("contraste píxel a píxel: mira dónde cae la tinta, no la media del fondo", async () => {
    // Logo 200×80 con tinta sólo en la mitad izquierda (y un píxel a la
    // derecha para que el recorte no la achique).
    const ink = (rgb: { r: number; g: number; b: number }) => {
      const data = Buffer.alloc(200 * 80 * 4);
      for (let y = 0; y < 80; y += 1) {
        for (let x = 0; x < 200; x += 1) {
          const on = x < 100 || (x === 199 && y === 79);
          const i = (y * 200 + x) * 4;
          data[i] = rgb.r;
          data[i + 1] = rgb.g;
          data[i + 2] = rgb.b;
          data[i + 3] = on ? 255 : 0;
        }
      }
      return data;
    };
    // Fondo: mitad izquierda negra, mitad derecha blanca → media ≈ 0,5.
    const bg = Buffer.alloc(200 * 80 * 3);
    for (let y = 0; y < 80; y += 1) {
      for (let x = 0; x < 200; x += 1) {
        const v = x < 100 ? 0 : 255;
        const i = (y * 200 + x) * 3;
        bg[i] = v;
        bg[i + 1] = v;
        bg[i + 2] = v;
      }
    }
    const region = { data: bg, width: 200, height: 80 };
    const light = pixelContrast(ink({ r: 250, g: 250, b: 250 }), region) ?? 0;
    const dark = pixelContrast(ink({ r: 10, g: 10, b: 10 }), region) ?? 0;
    // La tinta cae sobre el negro: gana el claro, aunque la media del fondo
    // no distinga.
    expect(light).toBeGreaterThan(6);
    expect(dark).toBeLessThan(1.5);
  });

  it("la opacidad baja el alfa del logo", async () => {
    const logos = await prepared();
    const bg = await solid(1080, 1920, { r: 0, g: 0, b: 0 });
    const half = await placeLogo(
      CANVAS,
      { ...request, opacity: 0.5 },
      logos,
      async (box) => [await regionPixels(bg, box)],
    );
    const { data } = await sharp(half.overlay.input as Buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[3]).toBeGreaterThan(120);
    expect(data[3]).toBeLessThan(135);
  });
});
