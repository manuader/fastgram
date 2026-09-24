"use client";

import type { ContentTextBox, ContentType, MediaElement } from "@fastgram/contracts";
import { useRef, type Dispatch, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@fastgram/ui";
import { tw } from "@/lib/i18n/t";
import { cssFontFamily } from "@/lib/editor/fonts";
import {
  boxToPreviewGeometry,
  nudgeFor,
  panRect,
  pointerDeltaToPercent,
  previewHeight,
  previewScale,
  renderedBackground,
  resizeFromEdge,
  type CanvasSize,
} from "@/lib/editor/geometry";
import { boxesOnSlide, type EditorAction, type EditorState } from "@/lib/editor/state";
import { MediaLayer } from "./MediaLayer";

export interface EditorCanvasProps {
  readonly canvas: CanvasSize;
  readonly contentType: ContentType;
  readonly state: EditorState;
  readonly dispatch: Dispatch<EditorAction>;
  /** Ancho del lienzo en pantalla. A 360 las unidades de editor son px. */
  readonly previewWidth: number;
  /** Delete/Backspace sobre una caja: no se borra (el contrato no lo permite). */
  readonly onDeleteAttempt?: () => void;
  readonly readOnly?: boolean;
}

/**
 * El lienzo WYSIWYG · `PU-EDIT-004`, FR-051.
 *
 * Todo lo que se dibuja pasa por `lib/editor/geometry.ts`, que replica el
 * mapeo del render (centro + ancho en %, fuente × `canvas.width / 360`). El
 * lienzo en sí es sólo el que traduce punteros y teclas a acciones del reducer.
 *
 * El drag es con pointer events y captura, no con `@dnd-kit`: dnd-kit resuelve
 * soltar **sobre** algo (listas, zonas), y acá no hay destino, sólo una
 * posición continua. Con punteros, además, el test puede mover la caja con
 * `clientX` sin depender de `getBoundingClientRect` (jsdom devuelve ceros).
 */
export function EditorCanvas({
  canvas,
  contentType,
  state,
  dispatch,
  previewWidth,
  onDeleteAttempt,
  readOnly = false,
}: EditorCanvasProps) {
  const height = previewHeight(previewWidth, canvas);
  const scale = previewScale(previewWidth, canvas);
  const assets = state.draft.assets;
  const boxes = boxesOnSlide(state.draft.boxes, state.slide);

  return (
    <div
      role="group"
      aria-label={tw("editor.canvas.label")}
      className="relative overflow-hidden rounded-lg bg-black shadow-sm"
      style={{ width: previewWidth, height, touchAction: "none" }}
      data-testid="editor-canvas"
      onPointerDown={(e) => {
        // Click en el vacío: deselecciona.
        if (e.target === e.currentTarget) dispatch({ type: "select", id: null });
      }}
    >
      <BackgroundLayers
        contentType={contentType}
        slide={state.slide}
        assets={assets}
        scale={scale}
        previewWidth={previewWidth}
        canvas={canvas}
        dispatch={dispatch}
        readOnly={readOnly}
      />
      {boxes.map((box, index) => (
        <TextBoxView
          key={box.id}
          box={box}
          index={index}
          canvas={canvas}
          previewWidth={previewWidth}
          previewHeightPx={height}
          selected={box.id === state.selectedId}
          dispatch={dispatch}
          readOnly={readOnly}
          {...(onDeleteAttempt === undefined ? {} : { onDeleteAttempt })}
        />
      ))}
    </div>
  );
}

// --- Media --------------------------------------------------------------------

function BackgroundLayers({
  contentType,
  slide,
  assets,
  scale,
  previewWidth,
  canvas,
  dispatch,
  readOnly,
}: {
  readonly contentType: ContentType;
  readonly slide: number;
  readonly assets: EditorState["draft"]["assets"];
  readonly scale: number;
  readonly previewWidth: number;
  readonly canvas: CanvasSize;
  readonly dispatch: Dispatch<EditorAction>;
  readonly readOnly: boolean;
}) {
  const layers: { media: MediaElement; kind: "image" | "video"; key: string }[] = [];
  if (contentType === "slideshow") {
    const image = assets.slides?.[slide];
    if (image !== undefined) layers.push({ media: image, kind: "image", key: "slide" });
  } else {
    if (assets.image !== undefined)
      layers.push({ media: assets.image, kind: "image", key: "image" });
    if (assets.hook_video !== undefined)
      layers.push({ media: assets.hook_video, kind: "video", key: "hook" });
    if (assets.demo_video !== undefined)
      layers.push({ media: assets.demo_video, kind: "video", key: "demo" });
    if (assets.video !== undefined && contentType !== "green-screen")
      layers.push({ media: assets.video, kind: "video", key: "video" });
  }

  if (
    layers.length === 0 &&
    (contentType !== "green-screen" || assets.video === undefined)
  ) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-xs text-text-subtle">
        {tw("editor.canvas.noMedia")}
      </div>
    );
  }

  return (
    <>
      {layers.map((l) => (
        <MediaLayer key={l.key} media={l.media} kind={l.kind} scale={scale} />
      ))}
      {contentType === "green-screen" && assets.video !== undefined && (
        <PannableVideo
          media={assets.video}
          scale={scale}
          previewWidth={previewWidth}
          canvas={canvas}
          dispatch={dispatch}
          readOnly={readOnly}
        />
      )}
    </>
  );
}

/** El meme del green-screen: `Drag video to reposition` (FR-051). */
function PannableVideo({
  media,
  scale,
  previewWidth,
  canvas,
  dispatch,
  readOnly,
}: {
  readonly media: MediaElement;
  readonly scale: number;
  readonly previewWidth: number;
  readonly canvas: CanvasSize;
  readonly dispatch: Dispatch<EditorAction>;
  readonly readOnly: boolean;
}) {
  const drag = useRef<{ x: number; y: number; rect: MediaElement } | null>(null);
  return (
    <div
      aria-label={tw("editor.canvas.video")}
      className={cn("absolute", !readOnly && "cursor-move")}
      style={{
        left: media.drawX * scale,
        top: media.drawY * scale,
        width: media.drawW * scale,
        height: media.drawH * scale,
      }}
      onPointerDown={(e) => {
        if (readOnly) return;
        dispatch({ type: "select", id: null });
        drag.current = { x: e.clientX, y: e.clientY, rect: media };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const start = drag.current;
        if (start === null) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        dispatch({
          type: "mediaRect",
          slot: "video",
          rect: panRect(start.rect, dx, dy, previewWidth, canvas),
        });
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      <MediaLayer
        media={{ ...media, drawX: 0, drawY: 0 }}
        kind="video"
        scale={scale}
        chromaKey
      />
    </div>
  );
}

// --- Texto --------------------------------------------------------------------

interface DragState {
  readonly mode: "move" | "resize";
  readonly startX: number;
  readonly startY: number;
  readonly origin: ContentTextBox;
}

function TextBoxView({
  box,
  index,
  canvas,
  previewWidth,
  previewHeightPx,
  selected,
  dispatch,
  readOnly,
  onDeleteAttempt,
}: {
  readonly box: ContentTextBox;
  readonly index: number;
  readonly canvas: CanvasSize;
  readonly previewWidth: number;
  readonly previewHeightPx: number;
  readonly selected: boolean;
  readonly dispatch: Dispatch<EditorAction>;
  readonly readOnly: boolean;
  readonly onDeleteAttempt?: () => void;
}) {
  const drag = useRef<DragState | null>(null);
  const g = boxToPreviewGeometry(box, canvas, previewWidth);
  const bg = renderedBackground(box.background);
  const empty = box.text.trim() === "";
  const label = empty
    ? tw("editor.canvas.boxEmpty", { n: index + 1 })
    : tw("editor.canvas.box", { n: index + 1, text: box.text.slice(0, 60) });

  const start = (mode: DragState["mode"]) => (e: PointerEvent<HTMLElement>) => {
    if (readOnly) return;
    e.stopPropagation();
    dispatch({ type: "select", id: box.id });
    drag.current = { mode, startX: e.clientX, startY: e.clientY, origin: box };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d === null) return;
    const dxPx = e.clientX - d.startX;
    const dyPx = e.clientY - d.startY;
    // Un evento sin coordenadas (algunos sintéticos) daría NaN, y `NaN` pasa
    // los clamps y rompe el contrato en el `PATCH`.
    if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return;
    if (d.mode === "resize") {
      dispatch({
        type: "width",
        id: box.id,
        widthPercent: resizeFromEdge(d.origin.widthPercent, dxPx, previewWidth),
      });
      return;
    }
    const { dx, dy } = pointerDeltaToPercent(dxPx, dyPx, {
      width: previewWidth,
      height: previewHeightPx,
    });
    dispatch({
      type: "place",
      id: box.id,
      x: d.origin.position.x + dx,
      y: d.origin.position.y + dy,
    });
  };

  const end = () => {
    drag.current = null;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const nudge = nudgeFor(e.key, e.shiftKey);
    if (nudge !== null) {
      e.preventDefault();
      dispatch({ type: "move", id: box.id, dx: nudge.dx, dy: nudge.dy });
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      // Las cajas son las del contrato: el `PATCH` no puede quitar una
      // (FR-051 rechaza ids faltantes sólo como "inexistentes", no hay
      // operación de borrado). Se avisa en vez de fingir que se borró.
      e.preventDefault();
      onDeleteAttempt?.();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      data-testid={`text-box-${box.id}`}
      className={cn(
        "fg-focusable absolute flex items-center",
        !readOnly && "cursor-move",
        selected
          ? "outline outline-2 outline-accent"
          : "hover:outline hover:outline-1 hover:outline-dashed hover:outline-white/60",
      )}
      style={{
        left: g.centerX - g.width / 2,
        top: g.centerY,
        width: g.width,
        transform: "translateY(-50%)",
        justifyContent: "center",
        minHeight: empty ? g.fontSize : undefined,
      }}
      onPointerDown={start("move")}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
      onFocus={() => dispatch({ type: "select", id: box.id })}
      onKeyDown={onKeyDown}
    >
      {!empty && (
        <span
          aria-hidden
          style={{
            display: "inline-block",
            boxSizing: "content-box",
            maxWidth: g.wrapWidth,
            padding: g.strokeWidth + (bg === null ? 0 : g.backgroundPadding),
            fontFamily: cssFontFamily(box.font.family),
            fontWeight: box.font.weight,
            fontSize: g.fontSize,
            lineHeight: "normal",
            color: box.color,
            textAlign: "center",
            whiteSpace: "pre-wrap",
            overflowWrap: "break-word",
            // El contorno del render crece hacia afuera `strokeWidth` px. CSS
            // lo centra en el borde del glifo: con el doble de ancho y el
            // relleno pintado encima, lo que queda visible es el anillo de
            // afuera, del mismo grosor.
            ...(g.strokeWidth > 0
              ? {
                  WebkitTextStroke: `${g.strokeWidth * 2}px ${box.stroke.color}`,
                  paintOrder: "stroke fill",
                }
              : {}),
            ...(bg === null ? {} : { background: bg.color, borderRadius: 9999 }),
          }}
        >
          {box.text}
        </span>
      )}
      {selected && !readOnly && (
        <span
          role="presentation"
          aria-label={tw("editor.canvas.resize", { n: index + 1 })}
          data-testid={`resize-${box.id}`}
          className="absolute right-0 top-1/2 h-4 w-2 -translate-y-1/2 translate-x-1/2 cursor-ew-resize rounded-sm bg-accent"
          onPointerDown={start("resize")}
          onPointerMove={onMove}
          onPointerUp={end}
          onPointerCancel={end}
        />
      )}
    </div>
  );
}
