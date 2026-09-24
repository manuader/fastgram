/**
 * Un modelo del catálogo de un adaptador de generación: su ficha pública
 * (`GenModelSpec`, la que ve la UI) más cómo se arma su cuerpo.
 *
 * Cada proveedor publica **un esquema por modelo** (Higgsfield lo dice:
 * «Endpoint fields vary by model and workflow»), así que el cuerpo no se puede
 * derivar de un denominador común: se arma por modelo, con los campos que su
 * página documenta, y la página va citada en `docsUrl`.
 */
import type {
  GenAspectRatio,
  GenModelSpec,
  ImageGenRequest,
  VideoGenRequest,
} from "@fastgram/ports";

import { genError } from "./http.js";

export interface ImageModelEntry {
  readonly spec: GenModelSpec & { readonly kind: "image" };
  /** El JSON que se manda al proveedor (y a su estimador, si tiene). */
  body(request: ImageGenRequest): Record<string, unknown>;
}

export interface VideoModelEntry {
  readonly spec: GenModelSpec & { readonly kind: "video" };
  body(request: VideoGenRequest): Record<string, unknown>;
}

export type ModelEntry = ImageModelEntry | VideoModelEntry;

export function imageSpec(
  spec: Omit<
    GenModelSpec,
    "kind" | "durationsSeconds" | "imageInput" | "promptRequired" | "aspectFromImage"
  >,
): GenModelSpec & { readonly kind: "image" } {
  return {
    durationsSeconds: [],
    imageInput: "none",
    promptRequired: true,
    aspectFromImage: false,
    ...spec,
    kind: "image",
  };
}

export function videoSpec(
  spec: Omit<
    GenModelSpec,
    "kind" | "counts" | "maxReferenceImages" | "promptRequired"
  > & {
    readonly promptRequired?: boolean;
  },
): GenModelSpec & { readonly kind: "video" } {
  return {
    counts: [1],
    maxReferenceImages: 0,
    promptRequired: true,
    ...spec,
    kind: "video",
  };
}

/** Valida un pedido de imagen contra la ficha. Lanza `bad_request`. */
export function checkImageRequest(
  spec: GenModelSpec,
  request: ImageGenRequest,
  source: string,
): void {
  const n = request.n ?? 1;
  if (request.prompt.trim().length === 0) {
    throw genError("bad_request", "A prompt is required", source);
  }
  if (!spec.aspectRatios.includes(request.aspectRatio)) {
    throw genError(
      "bad_request",
      `This model does not support the ${request.aspectRatio} aspect ratio`,
      source,
    );
  }
  if (!spec.counts.includes(n)) {
    throw genError(
      "bad_request",
      `This model generates ${spec.counts.join(" or ")} image(s) per request`,
      source,
    );
  }
  const refs = request.referenceImageUrls ?? [];
  if (refs.length > spec.maxReferenceImages) {
    throw genError(
      "bad_request",
      spec.maxReferenceImages === 0
        ? "This model does not take reference images"
        : `This model takes at most ${String(spec.maxReferenceImages)} reference images`,
      source,
    );
  }
}

/** Valida un pedido de video contra la ficha. Lanza `bad_request`. */
export function checkVideoRequest(
  spec: GenModelSpec,
  request: VideoGenRequest,
  source: string,
): void {
  if (spec.promptRequired && request.prompt.trim().length === 0) {
    throw genError("bad_request", "A prompt is required", source);
  }
  if (!spec.durationsSeconds.includes(request.durationSeconds)) {
    throw genError(
      "bad_request",
      `This model makes ${spec.durationsSeconds.join(", ")} second videos`,
      source,
    );
  }
  if (!spec.aspectFromImage && !spec.aspectRatios.includes(request.aspectRatio)) {
    throw genError(
      "bad_request",
      `This model does not support the ${request.aspectRatio} aspect ratio`,
      source,
    );
  }
  const hasImage = request.imageUrl !== undefined && request.imageUrl.trim() !== "";
  if (spec.imageInput === "required" && !hasImage) {
    throw genError("bad_request", "This model needs a start image URL", source);
  }
  if (spec.imageInput === "none" && hasImage) {
    throw genError("bad_request", "This model does not take a start image", source);
  }
}

/** Todas las relaciones que la app pide, en el orden de la UI. */
export const ALL_RATIOS: readonly GenAspectRatio[] = [
  "1:1",
  "4:5",
  "3:4",
  "4:3",
  "9:16",
  "16:9",
];
