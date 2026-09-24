/**
 * Catálogo verificado de fal — `PU-MODEL-003`/`004`/`005`.
 *
 * Cada entrada salió el 2026-09-24 del `llms.txt` del modelo
 * (`https://fal.ai/models/<endpoint-id>/llms.txt`, el formato que fal publica
 * para agentes) y, para FLUX schnell, de su OpenAPI
 * (`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/flux/schnell`).
 * El endpoint id, los campos, los valores permitidos y **el precio** son los
 * de esas páginas; `docsUrl` apunta a cada una.
 *
 * ## Los precios son de lista y se marcan como estimación
 *
 * fal cobra «based on the output you generate» y puede aplicar precios
 * propios por cuenta (`/docs/documentation/model-apis/pricing`). Acá se
 * multiplica el precio de la página por las unidades del pedido, y la UI lo
 * muestra como estimado. Las unidades salen de la misma página:
 *
 * - FLUX schnell: «$0.003 per megapixels». Los megapíxeles salen del
 *   `image_size` que se manda (ancho × alto explícitos, un tipo que su OpenAPI
 *   documenta: `ImageSize {width, height}`).
 * - Wan 2.2 A14B: «$0.04 per video second for 480p… Video seconds are
 *   calculated at 16 frames per second». Se pide 480p (el más barato) y
 *   `num_frames = 16 × segundos + 1` (el default documentado es 81 = 5 s).
 * - Kling 2.5 Turbo Pro: «For 5s video your request will cost $0.35. For every
 *   additional second you will be charged $0.07».
 *
 * Las dimensiones por relación son una elección nuestra (múltiplos de 16,
 * cerca de 1 MP), no un dato de fal.
 */
import type { GenAspectRatio } from "@fastgram/ports";

import { roundUsd } from "../genai/http.js";
import {
  imageSpec,
  videoSpec,
  type ImageModelEntry,
  type VideoModelEntry,
} from "../genai/spec.js";

const MODELS = "https://fal.ai/models";

export interface FalPricedImageEntry extends ImageModelEntry {
  price(request: { readonly n: number; readonly aspectRatio: GenAspectRatio }): {
    readonly usd: number;
    readonly basis: string;
  };
}

export interface FalPricedVideoEntry extends VideoModelEntry {
  price(request: { readonly durationSeconds: number }): {
    readonly usd: number;
    readonly basis: string;
  };
}

export type FalModelEntry = FalPricedImageEntry | FalPricedVideoEntry;

/** Ancho × alto por relación: múltiplos de 16, cerca de 1 MP. */
export const FLUX_SIZES: Readonly<
  Record<GenAspectRatio, { width: number; height: number }>
> = {
  "1:1": { width: 1024, height: 1024 },
  "4:5": { width: 896, height: 1120 },
  "3:4": { width: 864, height: 1152 },
  "4:3": { width: 1152, height: 864 },
  "9:16": { width: 720, height: 1280 },
  "16:9": { width: 1280, height: 720 },
};

const FLUX_SCHNELL_USD_PER_MP = 0.003;

const fluxSchnell: FalPricedImageEntry = {
  spec: imageSpec({
    id: "fal-ai/flux/schnell",
    label: "FLUX.1 [schnell]",
    aspectRatios: ["1:1", "4:5", "3:4", "4:3", "9:16", "16:9"],
    // `num_images`: «Range: 1 to 4».
    counts: [1, 2, 3, 4],
    maxReferenceImages: 0,
    docsUrl: `${MODELS}/fal-ai/flux/schnell/llms.txt`,
    listPrice: {
      summary: "$0.003 per megapixel",
      sourceUrl: `${MODELS}/fal-ai/flux/schnell/llms.txt`,
    },
  }),
  body: (r) => ({
    prompt: r.prompt,
    image_size: FLUX_SIZES[r.aspectRatio],
    num_images: r.n ?? 1,
  }),
  price: ({ n, aspectRatio }) => {
    const { width, height } = FLUX_SIZES[aspectRatio];
    const mp = (width * height) / 1_000_000;
    return {
      usd: roundUsd(n * mp * FLUX_SCHNELL_USD_PER_MP),
      basis: `${String(n)} × ${mp.toFixed(2)} MP × $0.003 per MP (list price)`,
    };
  },
};

/** Segundos de video → `num_frames` (rango documentado 17–161). */
export function wanFrames(seconds: number): number {
  return 16 * seconds + 1;
}

const WAN_480P_USD_PER_SECOND = 0.04;

function wanPrice({ durationSeconds }: { durationSeconds: number }) {
  const billed = wanFrames(durationSeconds) / 16;
  return {
    usd: roundUsd(billed * WAN_480P_USD_PER_SECOND),
    basis: `${billed.toFixed(2)} video s × $0.04 per second at 480p (list price)`,
  };
}

const WAN_DURATIONS = [3, 5, 8, 10];

const wanT2v: FalPricedVideoEntry = {
  spec: videoSpec({
    id: "fal-ai/wan/v2.2-a14b/text-to-video",
    label: "Wan 2.2 A14B · text to video (480p)",
    aspectRatios: ["16:9", "9:16", "1:1"],
    aspectFromImage: false,
    durationsSeconds: WAN_DURATIONS,
    imageInput: "none",
    docsUrl: `${MODELS}/fal-ai/wan/v2.2-a14b/text-to-video/llms.txt`,
    listPrice: {
      summary: "$0.04 per video second at 480p",
      sourceUrl: `${MODELS}/fal-ai/wan/v2.2-a14b/text-to-video/llms.txt`,
    },
  }),
  body: (r) => ({
    prompt: r.prompt,
    num_frames: wanFrames(r.durationSeconds),
    resolution: "480p",
    aspect_ratio: r.aspectRatio,
  }),
  price: wanPrice,
};

const wanI2v: FalPricedVideoEntry = {
  spec: videoSpec({
    id: "fal-ai/wan/v2.2-a14b/image-to-video",
    label: "Wan 2.2 A14B · image to video (480p)",
    // `aspect_ratio`: «auto», 16:9, 9:16, 1:1.
    aspectRatios: ["16:9", "9:16", "1:1"],
    aspectFromImage: false,
    durationsSeconds: WAN_DURATIONS,
    imageInput: "required",
    docsUrl: `${MODELS}/fal-ai/wan/v2.2-a14b/image-to-video/llms.txt`,
    listPrice: {
      summary: "$0.04 per video second at 480p",
      sourceUrl: `${MODELS}/fal-ai/wan/v2.2-a14b/image-to-video/llms.txt`,
    },
  }),
  body: (r) => ({
    prompt: r.prompt,
    image_url: r.imageUrl,
    num_frames: wanFrames(r.durationSeconds),
    resolution: "480p",
    aspect_ratio: r.aspectRatio,
  }),
  price: wanPrice,
};

function klingPrice({ durationSeconds }: { durationSeconds: number }) {
  const extra = Math.max(0, durationSeconds - 5);
  return {
    usd: roundUsd(0.35 + extra * 0.07),
    basis:
      extra === 0
        ? "$0.35 for a 5 s video (list price)"
        : `$0.35 for 5 s + ${String(extra)} s × $0.07 (list price)`,
  };
}

const klingT2v: FalPricedVideoEntry = {
  spec: videoSpec({
    id: "fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
    label: "Kling 2.5 Turbo Pro · text to video",
    aspectRatios: ["16:9", "9:16", "1:1"],
    aspectFromImage: false,
    durationsSeconds: [5, 10],
    imageInput: "none",
    docsUrl: `${MODELS}/fal-ai/kling-video/v2.5-turbo/pro/text-to-video/llms.txt`,
    listPrice: {
      summary: "$0.35 per 5 s, $0.07 per extra second",
      sourceUrl: `${MODELS}/fal-ai/kling-video/v2.5-turbo/pro/text-to-video/llms.txt`,
    },
  }),
  // `duration` es un enum de **cadenas** («"5"», «"10"») en su esquema.
  body: (r) => ({
    prompt: r.prompt,
    duration: String(r.durationSeconds),
    aspect_ratio: r.aspectRatio,
  }),
  price: klingPrice,
};

const klingI2v: FalPricedVideoEntry = {
  spec: videoSpec({
    id: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    label: "Kling 2.5 Turbo Pro · image to video",
    // Su esquema no tiene `aspect_ratio`: sale de la imagen.
    aspectRatios: [],
    aspectFromImage: true,
    durationsSeconds: [5, 10],
    imageInput: "required",
    docsUrl: `${MODELS}/fal-ai/kling-video/v2.5-turbo/pro/image-to-video/llms.txt`,
    listPrice: {
      summary: "$0.35 per 5 s, $0.07 per extra second",
      sourceUrl: `${MODELS}/fal-ai/kling-video/v2.5-turbo/pro/image-to-video/llms.txt`,
    },
  }),
  body: (r) => ({
    prompt: r.prompt,
    image_url: r.imageUrl,
    duration: String(r.durationSeconds),
  }),
  price: klingPrice,
};

export const FAL_MODELS: readonly FalModelEntry[] = [
  fluxSchnell,
  wanT2v,
  wanI2v,
  klingT2v,
  klingI2v,
];
