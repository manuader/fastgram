"use client";

/**
 * Content Studio · «Create New» paso a paso (`F-072`, `F-073`, `F-078`,
 * `F-079`, `P2-STUDIO-002/003/007/008`, sprint 7).
 *
 * Los cuatro formatos base (los de Blitz) se arman a mano: elegir media del
 * Media Bank, escribir el texto —o dejar que lo escriba el modelo de la tarea
 * `text`—, elegir estilo, y `Save` (`POST /content/studio`). La geometría la
 * arma el servidor con la misma función que Blitz; acá sólo se decide **qué**.
 *
 * Todo lo que decide si se puede generar es puro y está testeado
 * (`studio.test.ts`): `Generate` deshabilitado hasta completar los pasos es
 * literal de `F-073`.
 */
import {
  SLIDESHOW_MAX_SLIDES,
  STUDIO_AI_PROMPT_MAX,
  TEXT_BOX_MAX_LENGTH,
  TEXT_STYLE_PRESET_IDS,
  contentSchema,
  type AspectRatio,
  type Content,
  type MediaCategory,
  type MediaType,
  type StudioContentRequest,
  type StudioFormat,
} from "@fastgram/contracts";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { apiRequest } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { newIdempotencyKey } from "../api/idempotency-key";
import { queryKeys } from "../api/keys";

export { SLIDESHOW_MAX_SLIDES, STUDIO_AI_PROMPT_MAX, TEXT_BOX_MAX_LENGTH };

export {
  STUDIO_FORMAT_BY_ROUTE,
  STUDIO_ROUTE_IDS,
  studioFormatOf,
} from "./studio-formats";

export type StudioSlotKey = "slides" | "video" | "image" | "hookVideo" | "demoVideo";

export interface StudioSlot {
  readonly key: StudioSlotKey;
  readonly mediaType: MediaType;
  /** La categoría que se muestra primero en el picker (no restringe). */
  readonly preferred: MediaCategory | null;
  readonly multiple: boolean;
}

/** Qué pide cada formato — `FR-070` (PRD:1455-1458). */
export const STUDIO_SLOTS: Readonly<Record<StudioFormat, readonly StudioSlot[]>> = {
  slideshow: [
    { key: "slides", mediaType: "image", preferred: "slideshow-image", multiple: true },
  ],
  "wall-of-text": [
    { key: "video", mediaType: "video", preferred: "background-video", multiple: false },
  ],
  "green-screen": [
    {
      key: "image",
      mediaType: "image",
      preferred: "green-screen-background",
      multiple: false,
    },
    {
      key: "video",
      mediaType: "video",
      preferred: "green-screen-video",
      multiple: false,
    },
  ],
  "video-hook": [
    { key: "hookVideo", mediaType: "video", preferred: "hook-video", multiple: false },
    { key: "demoVideo", mediaType: "video", preferred: null, multiple: false },
  ],
};

/** Lo que el usuario eligió. Las URLs van sólo para el preview. */
export interface StudioPick {
  readonly mediaId: string;
  readonly url: string;
  readonly mediaType: MediaType;
}

export interface StudioDraft {
  readonly slides: readonly StudioPick[];
  readonly video: StudioPick | null;
  readonly image: StudioPick | null;
  readonly hookVideo: StudioPick | null;
  readonly demoVideo: StudioPick | null;
  /** Un texto por slide en slideshow; uno en el resto. */
  readonly texts: readonly string[];
  readonly textMode: "write" | "ai";
  readonly aiPrompt: string;
  readonly mentionBusiness: boolean;
  readonly stylePresetId: string;
  readonly aspectRatio: AspectRatio;
}

export const DEFAULT_STYLE_PRESET = "tiktok-classic";
export const STUDIO_STYLE_PRESETS: readonly string[] = TEXT_STYLE_PRESET_IDS;
export const STUDIO_ASPECT_RATIOS: readonly AspectRatio[] = ["4:5", "1:1", "3:4", "9:16"];

export function emptyDraft(): StudioDraft {
  return {
    slides: [],
    video: null,
    image: null,
    hookVideo: null,
    demoVideo: null,
    texts: [""],
    textMode: "write",
    aiPrompt: "",
    mentionBusiness: false,
    stylePresetId: DEFAULT_STYLE_PRESET,
    aspectRatio: "4:5",
  };
}

/** Cuántos textos pide el draft: uno por slide, o uno. */
export function textCountOf(format: StudioFormat, draft: StudioDraft): number {
  return format === "slideshow" ? Math.max(1, draft.slides.length) : 1;
}

/** Ajusta `texts` al largo que pide el formato, sin perder lo escrito. */
export function withTextCount(format: StudioFormat, draft: StudioDraft): StudioDraft {
  const n = textCountOf(format, draft);
  if (draft.texts.length === n) return draft;
  const texts = Array.from({ length: n }, (_, i) => draft.texts[i] ?? "");
  return { ...draft, texts };
}

export function slotFilled(slot: StudioSlot, draft: StudioDraft): boolean {
  if (slot.key === "slides") return draft.slides.length > 0;
  return draft[slot.key] !== null;
}

export type StudioStepId = "media" | "text" | "style";

export interface StudioStep {
  readonly id: StudioStepId;
  readonly done: boolean;
}

/**
 * Los pasos y si están completos. El texto está completo si **todos** los
 * textos tienen algo (modo escribir) o si hay brief para la IA.
 */
export function studioSteps(format: StudioFormat, draft: StudioDraft): StudioStep[] {
  const media = STUDIO_SLOTS[format].every((slot) => slotFilled(slot, draft));
  const n = textCountOf(format, draft);
  const text =
    draft.textMode === "ai"
      ? draft.aiPrompt.trim().length > 0 && draft.aiPrompt.length <= STUDIO_AI_PROMPT_MAX
      : draft.texts.length === n &&
        draft.texts.every((t) => t.trim().length > 0 && t.length <= TEXT_BOX_MAX_LENGTH);
  const style = STUDIO_STYLE_PRESETS.includes(draft.stylePresetId);
  return [
    { id: "media", done: media },
    { id: "text", done: text },
    { id: "style", done: style },
  ];
}

/** `F-073`: `Generate` deshabilitado hasta completar los pasos. */
export function canGenerate(format: StudioFormat, draft: StudioDraft): boolean {
  return studioSteps(format, draft).every((step) => step.done);
}

/** El cuerpo de `POST /content/studio`, o `null` si el draft no está completo. */
export function toStudioRequest(
  format: StudioFormat,
  draft: StudioDraft,
): StudioContentRequest | null {
  if (!canGenerate(format, draft)) return null;
  const media: StudioContentRequest["media"] =
    format === "slideshow"
      ? { slides: draft.slides.map((s) => s.mediaId) }
      : format === "wall-of-text"
        ? { video: draft.video?.mediaId as string }
        : format === "green-screen"
          ? {
              image: draft.image?.mediaId as string,
              video: draft.video?.mediaId as string,
            }
          : {
              hookVideo: draft.hookVideo?.mediaId as string,
              demoVideo: draft.demoVideo?.mediaId as string,
            };
  const n = textCountOf(format, draft);
  const texts =
    draft.textMode === "ai"
      ? Array.from({ length: n }, (_, i) => draft.texts[i]?.trim() ?? "")
      : draft.texts.slice(0, n).map((t) => t.trim());
  return {
    format,
    media,
    texts,
    textStylePresetId: draft.stylePresetId,
    ...(format === "slideshow" ? { aspectRatio: draft.aspectRatio } : {}),
    ...(draft.textMode === "ai"
      ? {
          ai: {
            prompt: draft.aiPrompt.trim(),
            ...(draft.mentionBusiness ? { mentionBusiness: true } : {}),
          },
        }
      : {}),
  };
}

export function useCreateStudioContent(): UseMutationResult<
  Content,
  ApiRequestError,
  { readonly body: StudioContentRequest; readonly idempotencyKey: string }
> {
  const queryClient = useQueryClient();
  return useMutation<
    Content,
    ApiRequestError,
    { readonly body: StudioContentRequest; readonly idempotencyKey: string }
  >({
    mutationFn: ({ body, idempotencyKey }) =>
      apiRequest<Content>("/content/studio", {
        method: "POST",
        body,
        idempotencyKey,
        schema: contentSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.content() });
    },
  });
}

export { newIdempotencyKey };
