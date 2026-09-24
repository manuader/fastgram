/**
 * Catálogo verificado de Higgsfield — `PU-MODEL-003`/`004`.
 *
 * **Cada entrada salió de su página en https://docs.higgsfield.ai el
 * 2026-09-24** (citada en `docsUrl`): el endpoint id, los campos del cuerpo,
 * sus valores permitidos y cuáles son obligatorios. Nada de acá es de
 * memoria. Higgsfield publica 82 entradas (16 de imagen, 66 de video) y dice
 * que «Endpoint fields vary by model and workflow»: por eso esto es una lista
 * curada y no un listado dinámico. No tiene endpoint de listado de modelos
 * (el índice `docs/llms.txt` manda a la consola), y su `openapi.json` se
 * declara «supplementary, not the authoritative model catalog».
 *
 * Qué se eligió y por qué:
 *
 * - **Imagen**: SOUL V2 (`batch_size` 1 o 4) y Z-Image Turbo, los dos que el
 *   plan (§4) nombra. Ninguno acepta imágenes de referencia en su esquema.
 * - **Video**: los que aceptan `aspect_ratio` (el de la app es vertical) o
 *   toman el cuadro de la imagen. Wan 2.6 text-to-video y Hailuo 2.3 Standard
 *   quedaron afuera porque su esquema **no tiene** `aspect_ratio`: no se podría
 *   pedir 9:16.
 * - El audio se apaga donde el esquema lo permite (`sound: "off"`,
 *   `generate_audio: false`): los clips son fondos y el render los usa mudos.
 *
 * Ningún precio va acá: Higgsfield tiene `POST /estimate/{endpoint}` y el costo
 * sale de ahí, para esta cuenta (`/docs/concepts/billing-and-retention`).
 */
import type { GenAspectRatio } from "@fastgram/ports";

import {
  imageSpec,
  videoSpec,
  type ImageModelEntry,
  type ModelEntry,
  type VideoModelEntry,
} from "../genai/spec.js";

const DOCS = "https://docs.higgsfield.ai/docs/models";

const ratiosFrom = (
  documented: readonly string[],
  wanted: readonly GenAspectRatio[] = ["1:1", "4:5", "3:4", "4:3", "9:16", "16:9"],
): GenAspectRatio[] => wanted.filter((r) => documented.includes(r));

/** `docs/models/soul-2/generate.md`: aspect_ratio 9:16 16:9 4:3 3:4 1:1 2:3 3:2; batch_size 1|4. */
const soulV2: ImageModelEntry = {
  spec: imageSpec({
    id: "higgsfield-ai/soul/v2/standard",
    label: "SOUL V2",
    aspectRatios: ratiosFrom(["9:16", "16:9", "4:3", "3:4", "1:1", "2:3", "3:2"]),
    counts: [1, 4],
    maxReferenceImages: 0,
    docsUrl: `${DOCS}/soul-2/generate`,
    listPrice: null,
  }),
  body: (r) => ({
    prompt: r.prompt,
    aspect_ratio: r.aspectRatio,
    batch_size: r.n ?? 1,
  }),
};

/** `docs/models/z-image-turbo/generate.md`: prompt ≤ 800, additionalProperties false. */
const zImageTurbo: ImageModelEntry = {
  spec: imageSpec({
    id: "z-image/turbo",
    label: "Z-Image Turbo",
    aspectRatios: ratiosFrom([
      "1:1",
      "2:3",
      "3:2",
      "3:4",
      "4:3",
      "7:9",
      "9:7",
      "9:16",
      "16:9",
      "21:9",
    ]),
    counts: [1],
    maxReferenceImages: 0,
    docsUrl: `${DOCS}/z-image-turbo/generate`,
    listPrice: null,
  }),
  body: (r) => ({ prompt: r.prompt, aspect_ratio: r.aspectRatio }),
};

/** Máximo documentado del prompt de Z-Image Turbo. */
export const Z_IMAGE_PROMPT_MAX = 800;

/** `docs/models/kling-2-6/pro-text-to-video.md`: duration 5|10, aspect 16:9 9:16 1:1, sound on|off. */
const kling26T2v: VideoModelEntry = {
  spec: videoSpec({
    id: "kling-video/v2.6/pro/text-to-video",
    label: "Kling 2.6 Pro · text to video",
    aspectRatios: ratiosFrom(["16:9", "9:16", "1:1"]),
    aspectFromImage: false,
    durationsSeconds: [5, 10],
    imageInput: "none",
    docsUrl: `${DOCS}/kling-2-6/pro-text-to-video`,
    listPrice: null,
  }),
  body: (r) => ({
    prompt: r.prompt,
    duration: r.durationSeconds,
    aspect_ratio: r.aspectRatio,
    sound: "off",
  }),
};

/** `docs/models/kling-2-6/pro-image-to-video.md`: prompt + image_url obligatorios. */
const kling26I2v: VideoModelEntry = {
  spec: videoSpec({
    id: "kling-video/v2.6/pro/image-to-video",
    label: "Kling 2.6 Pro · image to video",
    aspectRatios: ratiosFrom(["16:9", "9:16", "1:1"]),
    aspectFromImage: false,
    durationsSeconds: [5, 10],
    imageInput: "required",
    docsUrl: `${DOCS}/kling-2-6/pro-image-to-video`,
    listPrice: null,
  }),
  body: (r) => ({
    prompt: r.prompt,
    image_url: r.imageUrl,
    duration: r.durationSeconds,
    aspect_ratio: r.aspectRatio,
    sound: "off",
  }),
};

/**
 * `docs/models/seedance-2/text-to-video.md`: duration entero 4–15, aspect
 * 16:9 4:3 1:1 3:4 9:16 21:9, additionalProperties false. Las duraciones son
 * un subconjunto del rango documentado, elegido para la UI.
 */
const seedance2T2v: VideoModelEntry = {
  spec: videoSpec({
    id: "bytedance/seedance-2.0/text-to-video",
    label: "Seedance 2.0 · text to video",
    aspectRatios: ratiosFrom(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]),
    aspectFromImage: false,
    durationsSeconds: [4, 5, 8, 10, 15],
    imageInput: "none",
    docsUrl: `${DOCS}/seedance-2/text-to-video`,
    listPrice: null,
  }),
  body: (r) => ({
    prompt: r.prompt,
    duration: r.durationSeconds,
    aspect_ratio: r.aspectRatio,
    generate_audio: false,
  }),
};

/**
 * `docs/models/seedance-2/image-to-video.md`: sólo `image_url` obligatorio,
 * «Output framing follows image_url».
 */
const seedance2I2v: VideoModelEntry = {
  spec: videoSpec({
    id: "bytedance/seedance-2.0/image-to-video",
    label: "Seedance 2.0 · image to video",
    aspectRatios: [],
    aspectFromImage: true,
    durationsSeconds: [4, 5, 8, 10, 15],
    imageInput: "required",
    promptRequired: false,
    docsUrl: `${DOCS}/seedance-2/image-to-video`,
    listPrice: null,
  }),
  body: (r) => ({
    image_url: r.imageUrl,
    ...(r.prompt.trim() === "" ? {} : { prompt: r.prompt }),
    duration: r.durationSeconds,
    generate_audio: false,
  }),
};

/** `docs/models/ltx-2-5/text-to-video-fast.md`: duration 6|8|10, aspect 16:9|9:16. */
const ltx25T2vFast: VideoModelEntry = {
  spec: videoSpec({
    id: "lightricks/ltx-2.5/text-to-video/fast",
    label: "LTX-2.5 Fast · text to video",
    aspectRatios: ratiosFrom(["16:9", "9:16"]),
    aspectFromImage: false,
    durationsSeconds: [6, 8, 10],
    imageInput: "none",
    docsUrl: `${DOCS}/ltx-2-5/text-to-video-fast`,
    listPrice: null,
  }),
  body: (r) => ({
    prompt: r.prompt,
    duration: r.durationSeconds,
    aspect_ratio: r.aspectRatio,
    generate_audio: false,
  }),
};

export const HIGGSFIELD_MODELS: readonly ModelEntry[] = [
  soulV2,
  zImageTurbo,
  kling26T2v,
  kling26I2v,
  seedance2T2v,
  seedance2I2v,
  ltx25T2vFast,
];
