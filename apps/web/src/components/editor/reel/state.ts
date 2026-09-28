/**
 * Estado del editor de reels: el spec en edición, la capa elegida y si hay
 * cambios sin guardar. Puro (lo fija `state.test.ts`): el componente sólo
 * despacha.
 *
 * Los tiempos se **acotan** acá y no en el input: arrastrar una barra fuera
 * del reel, o dejar una capa de menos de 0,2 s, produciría un spec que la API
 * rechaza con `bad_request` recién al guardar. Mejor que la barra se frene.
 */
import { REEL_MIN_LAYER_SEC, type ReelLayer, type ReelSpec } from "@fastgram/contracts";

export interface ReelEditorState {
  readonly spec: ReelSpec;
  /** El spec guardado (para descartar y para saber si hay cambios). */
  readonly saved: ReelSpec;
  readonly selectedId: string | null;
}

export type ReelEditorAction =
  | { readonly type: "load"; readonly spec: ReelSpec }
  | { readonly type: "select"; readonly id: string | null }
  | {
      readonly type: "timing";
      readonly id: string;
      readonly start: number;
      readonly end: number;
    }
  | { readonly type: "move"; readonly id: string; readonly delta: number }
  | {
      readonly type: "update";
      readonly id: string;
      readonly patch: (layer: ReelLayer) => ReelLayer;
    }
  | { readonly type: "discard" }
  | { readonly type: "commit" };

const round = (n: number): number => Math.round(n * 100) / 100;

/** `[start, end]` dentro del reel y con el largo mínimo. */
export function clampTiming(
  start: number,
  end: number,
  durationSec: number,
): { start: number; end: number } {
  let s = Math.max(0, Math.min(start, durationSec - REEL_MIN_LAYER_SEC));
  let e = Math.min(durationSec, Math.max(end, s + REEL_MIN_LAYER_SEC));
  s = round(s);
  e = round(e);
  return { start: s, end: e };
}

function mapLayer(
  spec: ReelSpec,
  id: string,
  fn: (layer: ReelLayer) => ReelLayer,
): ReelSpec {
  return { ...spec, layers: spec.layers.map((l) => (l.id === id ? fn(l) : l)) };
}

export function initialReelState(spec: ReelSpec): ReelEditorState {
  return {
    spec,
    saved: spec,
    selectedId: spec.layers.find((l) => l.kind === "text")?.id ?? null,
  };
}

export function reelEditorReducer(
  state: ReelEditorState,
  action: ReelEditorAction,
): ReelEditorState {
  switch (action.type) {
    case "load":
      return initialReelState(action.spec);
    case "select":
      return { ...state, selectedId: action.id };
    case "timing": {
      const t = clampTiming(action.start, action.end, state.spec.durationSec);
      return { ...state, spec: mapLayer(state.spec, action.id, (l) => ({ ...l, ...t })) };
    }
    case "move": {
      // Mover la barra entera conserva el largo; en los bordes, se frena.
      return {
        ...state,
        spec: mapLayer(state.spec, action.id, (l) => {
          const len = l.end - l.start;
          const start = Math.max(
            0,
            Math.min(l.start + action.delta, state.spec.durationSec - len),
          );
          return { ...l, start: round(start), end: round(start + len) };
        }),
      };
    }
    case "update":
      return { ...state, spec: mapLayer(state.spec, action.id, action.patch) };
    case "discard":
      return { ...state, spec: state.saved };
    case "commit":
      return { ...state, saved: state.spec };
  }
}

export function isDirty(state: ReelEditorState): boolean {
  return JSON.stringify(state.spec) !== JSON.stringify(state.saved);
}

/** Nombre de una capa en la lista: su texto si tiene, si no su tipo. */
export function layerName(layer: ReelLayer): string | null {
  if (layer.kind === "text")
    return layer.text.length > 28 ? `${layer.text.slice(0, 27)}…` : layer.text;
  return null;
}

/** `m:ss.s` para el reloj de la preview. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m)}:${rest.toFixed(1).padStart(4, "0")}`;
}
