/**
 * El borrador del editor y el body del `PATCH` · `PU-EDIT-003`, FR-051.
 *
 * Un reducer puro: todo lo que el editor hace —mover, estilar, swapear— es una
 * acción sobre `draft`, y `base` es la última versión que dio el servidor. Así
 * "¿hay cambios?", "descartar" y "qué mando" son funciones de dos valores y se
 * prueban sin React.
 *
 * ## Qué viaja en el `PATCH`
 *
 * - `textBoxes`: **todas** las cajas, siempre. El contrato exige al menos una
 *   (FR-051) y la API hace upsert por id; mandar sólo las cambiadas no ahorra
 *   nada y abre la duda de qué pasa con las otras.
 * - `assets`: **sólo lo que cambió**, como parche (`url` y/o `draw*`). Un
 *   `assets` vacío no se manda: sin swaps, el body es el de PU-EDIT-002.
 * - `revision`: la de la pieza que el usuario está viendo. Si alguien la movió,
 *   el servidor contesta `409 stale_revision` y la UI ofrece recargar.
 */
import type {
  ContentAssets,
  ContentAssetsPatch,
  ContentTextBox,
  EditableContent,
  MediaElement,
  MediaElementPatch,
  UpdateContentRequest,
} from "@fastgram/contracts";
import { clampWidthPercent, moveBox, type DrawRect } from "./geometry";

export type MediaSlot = "image" | "video" | "hook_video" | "demo_video";
export const MEDIA_SLOTS: readonly MediaSlot[] = [
  "image",
  "video",
  "hook_video",
  "demo_video",
];

export interface EditorSnapshot {
  readonly boxes: readonly ContentTextBox[];
  readonly assets: ContentAssets;
}

export interface EditorState {
  readonly base: EditorSnapshot;
  readonly draft: EditorSnapshot;
  readonly selectedId: string | null;
  readonly slide: number;
}

export type EditorAction =
  | { readonly type: "load"; readonly editable: EditableContent }
  | { readonly type: "select"; readonly id: string | null }
  | { readonly type: "slide"; readonly index: number }
  | {
      readonly type: "move";
      readonly id: string;
      readonly dx: number;
      readonly dy: number;
    }
  /** Posición absoluta del centro (drag): se acota igual que `move`. */
  | {
      readonly type: "place";
      readonly id: string;
      readonly x: number;
      readonly y: number;
    }
  | { readonly type: "width"; readonly id: string; readonly widthPercent: number }
  | {
      readonly type: "update";
      readonly id: string;
      readonly patch: (box: ContentTextBox) => ContentTextBox;
      /** `Apply to all text boxes` (slideshow): el mismo estilo a todas. */
      readonly all?: boolean;
    }
  | { readonly type: "swapSlide"; readonly index: number; readonly url: string }
  | { readonly type: "swapMedia"; readonly slot: MediaSlot; readonly url: string }
  | { readonly type: "mediaRect"; readonly slot: MediaSlot; readonly rect: DrawRect }
  | { readonly type: "audio"; readonly url: string | null }
  | { readonly type: "discard" }
  /** El servidor aceptó el `PATCH`: lo guardado pasa a ser la base. */
  | { readonly type: "commit" };

const slideOf = (box: ContentTextBox): number => box.slideIndex ?? 0;

export function initialEditorState(editable: EditableContent): EditorState {
  const snapshot: EditorSnapshot = {
    boxes: editable.textBoxes,
    assets: editable.assets ?? {},
  };
  const first = editable.textBoxes[0];
  return {
    base: snapshot,
    draft: snapshot,
    selectedId: first?.id ?? null,
    slide: first === undefined ? 0 : slideOf(first),
  };
}

function mapBoxes(
  boxes: readonly ContentTextBox[],
  pick: (box: ContentTextBox) => boolean,
  fn: (box: ContentTextBox) => ContentTextBox,
): readonly ContentTextBox[] {
  return boxes.map((box) => (pick(box) ? fn(box) : box));
}

function withDraft(state: EditorState, draft: Partial<EditorSnapshot>): EditorState {
  return { ...state, draft: { ...state.draft, ...draft } };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "load":
      return initialEditorState(action.editable);
    case "select":
      return { ...state, selectedId: action.id };
    case "slide": {
      const first = state.draft.boxes.find((b) => slideOf(b) === action.index);
      return { ...state, slide: action.index, selectedId: first?.id ?? null };
    }
    case "move":
      return withDraft(state, {
        boxes: mapBoxes(
          state.draft.boxes,
          (b) => b.id === action.id,
          (b) => moveBox(b, action.dx, action.dy),
        ),
      });
    case "place":
      return withDraft(state, {
        boxes: mapBoxes(
          state.draft.boxes,
          (b) => b.id === action.id,
          (b) => moveBox(b, action.x - b.position.x, action.y - b.position.y),
        ),
      });
    case "width":
      return withDraft(state, {
        boxes: mapBoxes(
          state.draft.boxes,
          (b) => b.id === action.id,
          (b) => ({ ...b, widthPercent: clampWidthPercent(action.widthPercent) }),
        ),
      });
    case "update":
      return withDraft(state, {
        boxes: mapBoxes(
          state.draft.boxes,
          (b) => action.all === true || b.id === action.id,
          action.patch,
        ),
      });
    case "swapSlide": {
      const slides = state.draft.assets.slides;
      if (slides === undefined || slides[action.index] === undefined) return state;
      return withDraft(state, {
        assets: {
          ...state.draft.assets,
          slides: slides.map((s, i) =>
            i === action.index ? { ...s, url: action.url } : s,
          ),
        },
      });
    }
    case "swapMedia": {
      const current = state.draft.assets[action.slot];
      if (current === undefined) return state;
      return withDraft(state, {
        assets: { ...state.draft.assets, [action.slot]: { ...current, url: action.url } },
      });
    }
    case "mediaRect": {
      const current = state.draft.assets[action.slot];
      if (current === undefined) return state;
      return withDraft(state, {
        assets: { ...state.draft.assets, [action.slot]: { ...current, ...action.rect } },
      });
    }
    case "audio":
      if (!("audio" in state.draft.assets)) return state;
      return withDraft(state, {
        assets: {
          ...state.draft.assets,
          audio: action.url === null ? null : { url: action.url },
        },
      });
    case "discard":
      return { ...state, draft: state.base };
    case "commit":
      return { ...state, base: state.draft };
  }
}

// --- Qué cambió ---------------------------------------------------------------

function mediaPatch(
  before: MediaElement | undefined,
  after: MediaElement | undefined,
): MediaElementPatch | null {
  if (before === undefined || after === undefined) return null;
  const patch: Record<string, string | number> = {};
  if (after.url !== before.url) patch["url"] = after.url;
  for (const k of ["drawX", "drawY", "drawW", "drawH"] as const) {
    if (after[k] !== before[k]) patch[k] = after[k];
  }
  return Object.keys(patch).length === 0 ? null : (patch as MediaElementPatch);
}

/** El parche de media entre dos snapshots. `null` = sin cambios. */
export function assetsPatchOf(
  base: ContentAssets,
  draft: ContentAssets,
): ContentAssetsPatch | null {
  const out: Record<string, unknown> = {};

  const slides: { index: number; image: MediaElementPatch }[] = [];
  (draft.slides ?? []).forEach((after, index) => {
    const p = mediaPatch(base.slides?.[index], after);
    if (p !== null) slides.push({ index, image: p });
  });
  if (slides.length > 0) out["slides"] = slides;

  for (const slot of MEDIA_SLOTS) {
    const p = mediaPatch(base[slot], draft[slot]);
    if (p !== null) out[slot] = p;
  }

  if ("audio" in draft && (draft.audio?.url ?? null) !== (base.audio?.url ?? null)) {
    out["audio"] = draft.audio ?? null;
  }

  return Object.keys(out).length === 0 ? null : (out as ContentAssetsPatch);
}

const sameBoxes = (a: readonly ContentTextBox[], b: readonly ContentTextBox[]): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

export function isDirty(state: EditorState): boolean {
  return (
    !sameBoxes(state.base.boxes, state.draft.boxes) ||
    assetsPatchOf(state.base.assets, state.draft.assets) !== null
  );
}

/** El body de `PATCH /content/:id`. */
export function buildPatchBody(
  revision: number,
  state: EditorState,
): UpdateContentRequest {
  const assets = assetsPatchOf(state.base.assets, state.draft.assets);
  return {
    revision,
    textBoxes: [...state.draft.boxes],
    ...(assets === null ? {} : { assets }),
  };
}

// --- Lecturas para la UI ------------------------------------------------------

export function boxesOnSlide(
  boxes: readonly ContentTextBox[],
  slide: number,
): readonly ContentTextBox[] {
  return boxes.filter((b) => slideOf(b) === slide);
}

export function selectedBox(state: EditorState): ContentTextBox | null {
  return state.draft.boxes.find((b) => b.id === state.selectedId) ?? null;
}

/** Cuántos slides tiene la pieza. Los formatos de una superficie tienen 1. */
export function slideCount(state: EditorState): number {
  const fromAssets = state.draft.assets.slides?.length ?? 0;
  const fromBoxes = state.draft.boxes.reduce(
    (max, b) => Math.max(max, slideOf(b) + 1),
    1,
  );
  return Math.max(fromAssets, fromBoxes, 1);
}
