"use client";

/**
 * Lista de capas con su tiempo: una fila por capa, una barra arrastrable por
 * fila (el cuerpo la mueve; los bordes cambian inicio y fin). Los tiempos
 * exactos se escriben en el inspector (inputs numéricos): la barra es para
 * mirar y ajustar rápido, y los inputs son el camino accesible por teclado.
 */
import type { ReelLayer, ReelSpec } from "@fastgram/contracts";
import { cn } from "@fastgram/ui";
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { layerName, type ReelEditorAction } from "./state";

export const KIND_COPY: Readonly<Record<ReelLayer["kind"], CopyKey>> = {
  background: "editor.reel.kind.background",
  clip: "editor.reel.kind.clip",
  image: "editor.reel.kind.image",
  text: "editor.reel.kind.text",
  captions: "editor.reel.kind.captions",
  audio: "editor.reel.kind.audio",
};

const KIND_COLOR: Readonly<Record<ReelLayer["kind"], string>> = {
  background: "bg-slate-500",
  clip: "bg-emerald-500",
  image: "bg-sky-500",
  text: "bg-amber-500",
  captions: "bg-fuchsia-500",
  audio: "bg-indigo-500",
};

type Drag = {
  id: string;
  mode: "move" | "start" | "end";
  x0: number;
  start: number;
  end: number;
};

export function layerLabel(layer: ReelLayer): string {
  return layerName(layer) ?? tw(KIND_COPY[layer.kind]);
}

export function ReelTimeline({
  spec,
  selectedId,
  dispatch,
  onSelect,
}: {
  readonly spec: ReelSpec;
  readonly selectedId: string | null;
  readonly dispatch: (action: ReelEditorAction) => void;
  readonly onSelect: (layer: ReelLayer) => void;
}) {
  const drag = useRef<Drag | null>(null);
  const track = useRef<HTMLDivElement | null>(null);
  const pct = (t: number): string => `${String((t / spec.durationSec) * 100)}%`;

  function secondsPerPixel(): number {
    const w = track.current?.getBoundingClientRect().width ?? 0;
    // jsdom (y un layout todavía sin medir) da 0: se asume 300 px.
    return spec.durationSec / (w > 0 ? w : 300);
  }

  function begin(e: ReactPointerEvent, layer: ReelLayer, mode: Drag["mode"]): void {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = {
      id: layer.id,
      mode,
      x0: e.clientX,
      start: layer.start,
      end: layer.end,
    };
  }

  function move(e: ReactPointerEvent): void {
    const d = drag.current;
    if (d === null) return;
    const delta = (e.clientX - d.x0) * secondsPerPixel();
    if (d.mode === "move") {
      const len = d.end - d.start;
      const start = Math.max(0, Math.min(d.start + delta, spec.durationSec - len));
      dispatch({ type: "timing", id: d.id, start, end: start + len });
    } else if (d.mode === "start") {
      dispatch({ type: "timing", id: d.id, start: d.start + delta, end: d.end });
    } else {
      dispatch({ type: "timing", id: d.id, start: d.start, end: d.end + delta });
    }
  }

  function end(): void {
    drag.current = null;
  }

  return (
    <section
      aria-label={tw("editor.reel.timeline")}
      className="grid gap-1"
      data-testid="reel-timeline"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
        {tw("editor.reel.layers")}
      </h3>
      <ul className="grid gap-1">
        {spec.layers.map((layer) => {
          const name = layerLabel(layer);
          const selected = layer.id === selectedId;
          return (
            <li key={layer.id} className="grid grid-cols-[88px_1fr] items-center gap-2">
              <button
                type="button"
                aria-pressed={selected}
                aria-label={tw("editor.reel.selectLayer", {
                  name,
                  start: layer.start.toFixed(1),
                  end: layer.end.toFixed(1),
                })}
                onClick={() => onSelect(layer)}
                className={cn(
                  "fg-focusable truncate rounded px-1.5 py-1 text-left text-xs",
                  selected
                    ? "bg-accent-subtle font-semibold text-text"
                    : "text-text-muted hover:text-text",
                )}
              >
                {name}
              </button>
              <div
                ref={layer === spec.layers[0] ? track : undefined}
                className="relative h-6 rounded bg-surface-subtle"
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
              >
                <div
                  data-testid={`bar-${layer.id}`}
                  className={cn(
                    "absolute top-0.5 bottom-0.5 cursor-grab rounded",
                    KIND_COLOR[layer.kind],
                    selected ? "opacity-100 ring-2 ring-accent" : "opacity-70",
                  )}
                  style={{ left: pct(layer.start), width: pct(layer.end - layer.start) }}
                  onPointerDown={(e) => {
                    onSelect(layer);
                    begin(e, layer, "move");
                  }}
                >
                  <span
                    aria-label={tw("editor.reel.dragStart", { name })}
                    className="absolute left-0 top-0 h-full w-2 cursor-ew-resize rounded-l bg-black/30"
                    onPointerDown={(e) => begin(e, layer, "start")}
                  />
                  <span
                    aria-label={tw("editor.reel.dragEnd", { name })}
                    className="absolute right-0 top-0 h-full w-2 cursor-ew-resize rounded-r bg-black/30"
                    onPointerDown={(e) => begin(e, layer, "end")}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
