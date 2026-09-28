/**
 * Fuentes de marca: una caja con `family: "brand:<id>"` se dibuja con la
 * fuente del request, en el proceso hijo, y **verifica** contra el centinela —
 * con Pango real (sprint 9, M).
 *
 * Como fuente "de marca" se usa un TTF libre del directorio de fuentes del
 * render (`anton-400.ttf`): lo que se mide es el mecanismo (bajar, leer el
 * nombre del archivo, registrar en un proceso nuevo, dibujar), no la fuente.
 * La prueba con Rotis (el caso real de FOCUS) está en el reporte del sprint:
 * los archivos son del dueño y no se versionan.
 *
 * Se saltea, diciendo por qué, sin fuentes o, en macOS, sin `node:ffi`.
 */
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { textObjectSchema } from "../domain/text.js";
import { isSfnt, prepareBrandFonts } from "./brandText.js";
import { rasterizeOperation } from "./designSystemAssets.js";
import { renderTextBox } from "./textLayer.js";

const home = process.env["HOME"] ?? "";
const fontDirRaw =
  process.env["RENDER_TEST_FONT_DIR"] ??
  process.env["RENDER_FONT_DIR"] ??
  path.join(home, "fastgram-fonts");
const anton = path.join(fontDirRaw, "anton-400.ttf");
const hasFfiFlag = process.allowedNodeEnvironmentFlags.has("--experimental-ffi");
const skipReason = !existsSync(anton)
  ? `sin ${anton}: pnpm fonts:fetch <dir> y RENDER_TEST_FONT_DIR=<dir>`
  : process.platform === "darwin" && !hasFfiFlag
    ? "macOS necesita node:ffi (--experimental-ffi, Node ≥ 26)"
    : null;
if (skipReason !== null) console.warn(`[brandText.integration] salteado: ${skipReason}`);
const suite = skipReason === null ? describe : describe.skip;

const CANVAS = { width: 1080, height: 1350, aspectRatio: "4:5" } as const;

function box(family: string, text = "MIRAR no alcanza") {
  return textObjectSchema.parse({
    id: "t0",
    text,
    position: { x: 50, y: 50 },
    widthPercent: 90,
    font: { family, weight: 400, size: 24 },
    color: "#FFFFFF",
    stroke: { width: 2, color: "#000000" },
  });
}

suite("fuentes de marca en el render", () => {
  it("baja, valida y dibuja en el hijo; la sonda verifica contra el centinela", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fg-brand-font-"));
    // El resolver de media deja archivos sin extensión: se simula eso.
    const local = path.join(dir, "download-1");
    copyFileSync(anton, local);
    const fonts = await prepareBrandFonts(
      [
        {
          id: "focus-display",
          weight: 400,
          style: "normal",
          url: "https://cdn.test/fonts/x",
        },
      ],
      () => Promise.resolve(local),
    );
    expect(fonts[0]?.pangoFamily).toBe("Anton");
    expect(fonts[0]?.file.endsWith(".ttf")).toBe(true);

    const t0 = Date.now();
    const layer = await renderTextBox(box("brand:focus-display"), CANVAS, {
      fontDir: null,
      strict: true,
      brandFonts: fonts,
    });
    const ms = Date.now() - t0;
    expect(layer?.font).toMatchObject({
      family: "brand:focus-display",
      verified: true,
      pangoDescription: "Anton, 72px",
    });
    // Mismo texto con una familia que no existe en este proceso de test (sin
    // activación): la de marca tiene que dar otra imagen.
    const fallback = await renderTextBox(box("inter"), CANVAS, {
      fontDir: null,
      strict: false,
    });
    expect(layer?.png.equals(fallback?.png ?? Buffer.alloc(0))).toBe(false);
    console.info(`[brandText] una caja de marca en el hijo: ${String(ms)} ms`);
  });

  it("una caja de marca sin sus caras en el request → font_unavailable", async () => {
    await expect(
      renderTextBox(box("brand:nope"), CANVAS, {
        fontDir: null,
        strict: true,
        brandFonts: [],
      }),
    ).rejects.toMatchObject({ code: "font_unavailable" });
  });

  it("un archivo que no es sfnt → bad_request", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fg-brand-font-"));
    const bogus = path.join(dir, "x");
    copyFileSync(new URL(import.meta.url).pathname, bogus);
    await expect(
      prepareBrandFonts(
        [{ id: "x", weight: 400, style: "normal", url: "https://cdn.test/x" }],
        () => Promise.resolve(bogus),
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(isSfnt(new Uint8Array([0x4f, 0x54, 0x54, 0x4f]))).toBe(true);
    expect(isSfnt(new Uint8Array([0, 1, 0, 0]))).toBe(true);
    expect(isSfnt(new Uint8Array([0x77, 0x4f, 0x46, 0x32]))).toBe(false);
  });
});

describe("rasterizar motivos", () => {
  it("SVG con currentColor → PNG teñido del tamaño pedido", async () => {
    const out = await rasterizeOperation({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect x="0" y="0" width="100" height="100" fill="currentColor"/></svg>',
      color: "#FF00FF",
      size: 256,
    });
    expect(out).toMatchObject({ contentType: "image/png", width: 256, height: 256 });
    const { data } = await sharp(Buffer.from(out.dataBase64, "base64"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([255, 0, 255]);
  });

  it("scripts o referencias externas → bad_request", async () => {
    for (const svg of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://x.test/a.png"/></svg>',
      "no soy svg",
    ]) {
      await expect(rasterizeOperation({ svg, color: "#FF00FF" })).rejects.toMatchObject({
        code: "bad_request",
      });
    }
  });
});
