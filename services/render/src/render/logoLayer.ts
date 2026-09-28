/**
 * La capa de logo de las piezas clásicas — sprint 9 (S), `PU-S9-003`.
 *
 * El request trae las variantes del logo del design system (`images`, claro y
 * oscuro) y dónde va (`corner`, `size`, `opacity`, enums cerrados). Qué
 * variante se usa lo decide este archivo **midiendo píxeles**: para cada
 * variante, el contraste WCAG **píxel a píxel** entre cada píxel opaco del logo
 * y el píxel del fondo que tapa, promediado (tope 7:1, para que un borde
 * extremo no tape al resto). Gana la de mayor contraste medio. Nadie tiene que
 * etiquetar cuál logo es «el claro»: FOCUS trae `Asset 1.png` y `Asset 2.png`.
 *
 * Por qué píxel a píxel y no «luminancia media del fondo contra la del
 * logo»: con la media, un fondo mitad crema mitad negro (una manga sobre fondo
 * oscuro) daba ~0,4 y elegía el logo oscuro, que desaparecía sobre la mitad
 * negra justo donde caían las letras (medido en el frame del 2026-09-28). El
 * contraste por píxel mira dónde cae la tinta del logo.
 *
 * Por qué acá y no en el worker: el worker no tiene los píxeles del fondo (un
 * video que el render normaliza, recorta y compone). El render sí, y ya
 * cachea la base.
 *
 * El logo se compone **sobre la capa de texto** (la misma PNG transparente que
 * ffmpeg superpone a la base, o el JPEG del slide): una pasada, sin tocar el
 * encode de la base.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { RenderError } from "../errors.js";
import type { Canvas } from "../domain/canvas.js";
import { runFfmpeg } from "../ffmpeg/run.js";

export const LOGO_CORNERS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;
export const LOGO_SIZES = ["small", "medium", "large"] as const;
export type LogoCorner = (typeof LOGO_CORNERS)[number];
export type LogoSize = (typeof LOGO_SIZES)[number];

/** Hasta 4 variantes: claro, oscuro, y alguna más si el kit la trae. */
export const MAX_LOGO_IMAGES = 4;

export const logoRequestSchema = z
  .object({
    images: z
      .array(z.object({ url: z.string().url() }).strict())
      .min(1)
      .max(MAX_LOGO_IMAGES),
    corner: z.enum(LOGO_CORNERS),
    size: z.enum(LOGO_SIZES),
    opacity: z.number().min(0.1).max(1),
  })
  .strict();
export type LogoRequest = z.infer<typeof logoRequestSchema>;

/**
 * Ancho del logo en fracción del ancho del lienzo. 12 % es un logo de esquina
 * discreto en 1080 (130 px); 24 % ya es protagonista. Números nuestros: el PRD
 * no habla de logos.
 */
export const LOGO_WIDTH_RATIO: Readonly<Record<LogoSize, number>> = {
  small: 0.12,
  medium: 0.18,
  large: 0.24,
};
/** Un logo muy alto (vertical) no puede pasar de esta fracción del alto. */
export const LOGO_MAX_HEIGHT_RATIO = 0.12;
/** Margen a los bordes, en fracción del ancho: fuera de la zona que recortan las apps. */
export const LOGO_MARGIN_RATIO = 0.05;

export interface LogoBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Dónde va un logo de proporción `aspect` (ancho/alto) en el lienzo. */
export function logoBox(
  canvas: Canvas,
  corner: LogoCorner,
  size: LogoSize,
  aspect: number,
): LogoBox {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  let width = Math.round(canvas.width * LOGO_WIDTH_RATIO[size]);
  let height = Math.round(width / safeAspect);
  const maxHeight = Math.round(canvas.height * LOGO_MAX_HEIGHT_RATIO);
  if (height > maxHeight) {
    height = maxHeight;
    width = Math.round(height * safeAspect);
  }
  width = Math.max(1, width);
  height = Math.max(1, height);
  const margin = Math.round(canvas.width * LOGO_MARGIN_RATIO);
  const left = corner.endsWith("left") ? margin : canvas.width - margin - width;
  const top = corner.startsWith("top") ? margin : canvas.height - margin - height;
  return { left: Math.max(0, left), top: Math.max(0, top), width, height };
}

/** sRGB 0–255 → luminancia relativa WCAG (0 negro, 1 blanco). */
export function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Contraste WCAG entre dos luminancias (1–21). */
export function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Luminancia media de una imagen RGBA cruda, ponderada por alfa (los píxeles
 * transparentes de un logo no cuentan). `null` si no hay nada opaco.
 */
export function meanLuminance(
  data: Buffer,
  channels: number,
  alphaWeighted: boolean,
): number | null {
  let sum = 0;
  let weight = 0;
  for (let i = 0; i + channels - 1 < data.length; i += channels) {
    const a = alphaWeighted && channels === 4 ? (data[i + 3] ?? 0) / 255 : 1;
    if (a <= 0) continue;
    sum += a * relativeLuminance(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    weight += a;
  }
  return weight === 0 ? null : sum / weight;
}

export interface PreparedLogo {
  /** PNG RGBA recortado a su contenido. */
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  /** Luminancia de sus píxeles opacos. */
  readonly luminance: number;
}

/** Baja (vía el resolver ya autorizado) y mide cada variante. */
export async function prepareLogos(
  logo: LogoRequest,
  resolve: (url: string) => Promise<string>,
): Promise<PreparedLogo[]> {
  const out: PreparedLogo[] = [];
  for (const image of logo.images) {
    const local = await resolve(image.url);
    let png: Buffer;
    try {
      // `trim` saca el margen transparente que traen muchos logos: sin eso,
      // el tamaño y el margen de la esquina mienten.
      png = await sharp(local, { failOn: "error" })
        .ensureAlpha()
        .trim({ threshold: 1 })
        .png()
        .toBuffer();
    } catch {
      // Un logo todo transparente (o de un color) no se puede recortar: sin trim.
      png = await sharp(local, { failOn: "error" }).ensureAlpha().png().toBuffer();
    }
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    out.push({
      png,
      width: info.width,
      height: info.height,
      luminance: meanLuminance(data, info.channels, true) ?? 0.5,
    });
  }
  if (out.length === 0) {
    throw new RenderError("bad_request", "la capa de logo no trae imágenes");
  }
  return out;
}

/** Los píxeles RGB del fondo bajo `box` (exactamente `box.width × box.height`). */
export interface RegionPixels {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

/** Recorta `box` de una imagen (slide o frame del video) y lo devuelve crudo, RGB. */
export async function regionPixels(
  image: Buffer | string,
  box: LogoBox,
): Promise<RegionPixels> {
  const { data, info } = await sharp(image)
    .extract(await clampBox(image, box))
    .resize(box.width, box.height, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function clampBox(image: Buffer | string, box: LogoBox): Promise<LogoBox> {
  const meta = await sharp(image).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const left = Math.min(Math.max(0, box.left), Math.max(0, w - 1));
  const top = Math.min(Math.max(0, box.top), Math.max(0, h - 1));
  return {
    left,
    top,
    width: Math.max(1, Math.min(box.width, w - left)),
    height: Math.max(1, Math.min(box.height, h - top)),
  };
}

/** Tope del contraste por píxel: más allá de 7:1 (AAA) ya se lee igual. */
export const PIXEL_CONTRAST_CAP = 7;

/**
 * Contraste medio (ponderado por alfa) entre los píxeles de un logo RGBA y los
 * del fondo RGB que tapan, del mismo tamaño. `null` si el logo no tiene nada
 * opaco.
 */
export function pixelContrast(logoRgba: Buffer, background: RegionPixels): number | null {
  let sum = 0;
  let weight = 0;
  const n = background.width * background.height;
  for (let p = 0; p < n; p += 1) {
    const a = (logoRgba[p * 4 + 3] ?? 0) / 255;
    if (a <= 0.5) continue;
    const logo = relativeLuminance(
      logoRgba[p * 4] ?? 0,
      logoRgba[p * 4 + 1] ?? 0,
      logoRgba[p * 4 + 2] ?? 0,
    );
    const bg = relativeLuminance(
      background.data[p * 3] ?? 0,
      background.data[p * 3 + 1] ?? 0,
      background.data[p * 3 + 2] ?? 0,
    );
    sum += a * Math.min(PIXEL_CONTRAST_CAP, contrastRatio(logo, bg));
    weight += a;
  }
  return weight === 0 ? null : sum / weight;
}

/**
 * Frames del video base para medir el fondo: al 10 %, 50 % y 90 % de la
 * duración (un clip que arranca negro no decide solo). Devuelve rutas PNG.
 */
export async function sampleVideoFrames(
  videoPath: string,
  durationSeconds: number | null,
  workDir: string,
): Promise<string[]> {
  const duration =
    durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : 1;
  const out: string[] = [];
  for (const [index, fraction] of [0.1, 0.5, 0.9].entries()) {
    const target = path.join(workDir, `logo-bg-${String(index)}.png`);
    await runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        (duration * fraction).toFixed(3),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        target,
      ],
      { expectOutput: target },
    );
    out.push(target);
  }
  return out;
}

/** Una variante escalada a su caja, RGBA crudo. */
async function scaledLogo(logo: PreparedLogo, box: LogoBox): Promise<Buffer> {
  return sharp(logo.png)
    .resize(box.width, box.height, { fit: "fill", kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer();
}

/**
 * El logo elegido, escalado, con la opacidad aplicada y listo para `composite`.
 * `background(box)` devuelve el fondo bajo la caja: uno por slide, tres
 * frames en un video (el contraste se promedia).
 */
export async function placeLogo(
  canvas: Canvas,
  logo: LogoRequest,
  logos: readonly PreparedLogo[],
  background: (box: LogoBox) => Promise<readonly RegionPixels[]>,
): Promise<{
  overlay: sharp.OverlayOptions;
  chosen: number;
  box: LogoBox;
  scores: number[];
}> {
  const first = logos[0];
  if (first === undefined) throw new RenderError("bad_request", "sin logos");
  // Cada variante con su propia caja (casi siempre la misma proporción).
  const scored: { box: LogoBox; raw: Buffer; score: number }[] = [];
  const cache = new Map<string, readonly RegionPixels[]>();
  for (const candidate of logos) {
    const box = logoBox(
      canvas,
      logo.corner,
      logo.size,
      candidate.width / candidate.height,
    );
    const key = `${String(box.left)},${String(box.top)},${String(box.width)},${String(box.height)}`;
    let regions = cache.get(key);
    if (regions === undefined) {
      regions = await background(box);
      cache.set(key, regions);
    }
    const raw = await scaledLogo(candidate, box);
    let total = 0;
    let count = 0;
    for (const region of regions) {
      const c = pixelContrast(raw, region);
      if (c !== null) {
        total += c;
        count += 1;
      }
    }
    scored.push({ box, raw, score: count === 0 ? 0 : total / count });
  }
  let chosen = 0;
  scored.forEach((entry, index) => {
    if (entry.score > (scored[chosen]?.score ?? -1) + 1e-9) chosen = index;
  });
  const picked = scored[chosen] as { box: LogoBox; raw: Buffer; score: number };
  const data = Buffer.from(picked.raw);
  if (logo.opacity < 1) {
    for (let i = 3; i < data.length; i += 4) {
      data[i] = Math.round((data[i] ?? 0) * logo.opacity);
    }
  }
  const input = await sharp(data, {
    raw: { width: picked.box.width, height: picked.box.height, channels: 4 },
  })
    .png()
    .toBuffer();
  return {
    overlay: { input, left: picked.box.left, top: picked.box.top },
    chosen,
    box: picked.box,
    scores: scored.map((x) => Math.round(x.score * 100) / 100),
  };
}

/** Compone el logo sobre una imagen (la capa de texto transparente o el slide). */
export async function compositeOver(
  image: Buffer,
  overlay: sharp.OverlayOptions,
): Promise<Buffer> {
  return sharp(image).composite([overlay]).png({ compressionLevel: 9 }).toBuffer();
}

/** Huella para la clave de cache: otra esquina, tamaño, opacidad o logo = otro artefacto. */
export function logoFingerprint(logo: LogoRequest): string {
  const canonical = [
    logo.corner,
    logo.size,
    logo.opacity.toFixed(3),
    ...logo.images.map((i) => i.url),
  ].join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
