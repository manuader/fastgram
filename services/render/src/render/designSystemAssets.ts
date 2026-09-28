/**
 * `POST /design-system/rasterize` — sprint 9 (M), `PU-S9-001`.
 *
 * Los motivos de un design system vienen en SVG (`currentColor`, para
 * teñirlos). El Media Bank y el render de piezas trabajan con PNG/JPEG, y el
 * worker no tiene `sharp`: rasteriza acá, que ya lo tiene. El SVG se tiñe con
 * el color pedido (un acento de la marca) y sale en PNG con alfa.
 *
 * Defensa en profundidad: el worker ya descartó los SVG con scripts,
 * manejadores, entidades o referencias externas (`core/design-system/
 * zip-guard.ts`); acá se vuelve a mirar lo mismo antes de dárselo a librsvg.
 *
 * La respuesta lleva los bytes en base64 y no un `href` a `/artifact/`: un
 * motivo rasterizado pesa decenas de KB y `/artifact/` sólo sirve MP4/JPEG.
 */
import sharp from "sharp";
import { z } from "zod";

import { RenderError } from "../errors.js";

export const MAX_SVG_CHARS = 256 * 1024;

const rasterizeSchema = z
  .object({
    svg: z.string().min(1).max(MAX_SVG_CHARS),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    size: z.number().int().min(64).max(4096).default(2048),
  })
  .strict();

const UNSAFE: readonly RegExp[] = [
  /<\s*script/iu,
  /\son[a-z]+\s*=/iu,
  /javascript\s*:/iu,
  /<\s*foreignObject/iu,
  /<!\s*ENTITY/iu,
  /(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/|file:)/iu,
  /url\(\s*["']?\s*(?:https?:|\/\/|file:)/iu,
];

export interface RasterizeResponse {
  readonly contentType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly dataBase64: string;
}

export async function rasterizeOperation(raw: unknown): Promise<RasterizeResponse> {
  const parsed = rasterizeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RenderError("bad_request", "el pedido de rasterizado no es válido", {
      details: {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    });
  }
  const { svg, color, size } = parsed.data;
  if (UNSAFE.some((re) => re.test(svg)) || !/<\s*svg[\s>]/iu.test(svg)) {
    throw new RenderError("bad_request", "el SVG trae contenido no permitido");
  }
  const tinted = svg.replace(/currentColor/gu, color);
  let png: { data: Buffer; info: sharp.OutputInfo };
  try {
    png = await sharp(Buffer.from(tinted), { density: 300 })
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: false })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
  } catch (cause) {
    throw new RenderError("unsupported_media_format", "el SVG no se pudo rasterizar", {
      cause,
    });
  }
  return {
    contentType: "image/png",
    width: png.info.width,
    height: png.info.height,
    dataBase64: png.data.toString("base64"),
  };
}
