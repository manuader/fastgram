/**
 * `PU-EDIT-004` — el lienzo traduce punteros y teclas a posiciones del
 * contrato (centro en % del canvas).
 *
 * Se monta con el reducer de verdad, no con un `dispatch` espiado: lo que
 * importa es la posición que termina en el borrador, que es lo que va a salir
 * en el `PATCH`.
 */
import { editableContentSchema } from "@fastgram/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { describe, expect, it, vi } from "vitest";
import { editorReducer, initialEditorState, type EditorState } from "@/lib/editor/state";
import { EditorCanvas } from "./EditorCanvas";

const editable = editableContentSchema.parse({
  canvas: { width: 1080, height: 1920 },
  textBoxes: [
    {
      id: "slide-0-text-0",
      slideIndex: 0,
      text: "Hola",
      position: { x: 50, y: 50 },
      widthPercent: 80,
      font: { family: "inter", weight: 700, size: 18 },
      color: "#FFFFFF",
      stroke: { width: 3, color: "#000000" },
      background: null,
    },
  ],
  assets: {
    video: {
      url: "https://cdn.test/v.mp4",
      drawX: 0,
      drawY: 0,
      drawW: 1080,
      drawH: 1920,
    },
  },
});

/**
 * jsdom no trae `PointerEvent`: `fireEvent.pointerDown` cae a un `Event`
 * genérico y `clientX` llega `undefined`. Uno mínimo sobre `MouseEvent` basta
 * para que las coordenadas viajen; `pointerId` no se usa para calcular.
 */
if (typeof window !== "undefined" && !("PointerEvent" in window)) {
  class PointerEventShim extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  (window as unknown as { PointerEvent: typeof PointerEventShim }).PointerEvent =
    PointerEventShim;
}

let latest: EditorState | null = null;

function Harness({ onDelete }: { readonly onDelete?: () => void }) {
  const [state, dispatch] = useReducer(editorReducer, editable, initialEditorState);
  latest = state;
  return (
    <EditorCanvas
      canvas={editable.canvas}
      contentType="wall-of-text"
      state={state}
      dispatch={dispatch}
      previewWidth={360}
      {...(onDelete === undefined ? {} : { onDeleteAttempt: onDelete })}
    />
  );
}

const position = () => latest?.draft.boxes[0]?.position;

describe("EditorCanvas", () => {
  it("dibuja la caja con la geometría del render: centro (180, 320), ancho 288, 18 px", () => {
    render(<Harness />);
    const el = screen.getByTestId("text-box-slide-0-text-0");
    expect(el.style.left).toBe("36px"); // 180 − 288/2
    expect(el.style.top).toBe("320px");
    expect(el.style.width).toBe("288px");
    expect(screen.getByText("Hola").style.fontSize).toBe("18px");
  });

  it("drag: 36 px a la derecha y 64 abajo en 360×640 → (60 %, 60 %)", () => {
    render(<Harness />);
    const el = screen.getByTestId("text-box-slide-0-text-0");
    fireEvent.pointerDown(el, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 118, clientY: 132, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 136, clientY: 164, pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: 136, clientY: 164, pointerId: 1 });
    expect(position()).toEqual({ x: 60, y: 60 });

    // Después de soltar, mover el puntero no mueve la caja.
    fireEvent.pointerMove(el, { clientX: 300, clientY: 300, pointerId: 1 });
    expect(position()).toEqual({ x: 60, y: 60 });
  });

  it("el drag no saca la caja del lienzo", () => {
    render(<Harness />);
    const el = screen.getByTestId("text-box-slide-0-text-0");
    fireEvent.pointerDown(el, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 1000, clientY: -1000, pointerId: 1 });
    expect(position()).toEqual({ x: 100, y: 0 });
  });

  it("flechas: 1 %; con Shift, 5 %", () => {
    render(<Harness />);
    const el = screen.getByTestId("text-box-slide-0-text-0");
    fireEvent.keyDown(el, { key: "ArrowLeft" });
    fireEvent.keyDown(el, { key: "ArrowDown", shiftKey: true });
    expect(position()).toEqual({ x: 49, y: 55 });
  });

  it("Delete no borra la caja: avisa", () => {
    const onDelete = vi.fn();
    render(<Harness onDelete={onDelete} />);
    fireEvent.keyDown(screen.getByTestId("text-box-slide-0-text-0"), { key: "Delete" });
    expect(onDelete).toHaveBeenCalledOnce();
    expect(latest?.draft.boxes).toHaveLength(1);
  });

  it("el borde de la caja seleccionada cambia el ancho, simétrico", () => {
    render(<Harness />);
    const handle = screen.getByTestId("resize-slide-0-text-0");
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 2 });
    fireEvent.pointerMove(handle, { clientX: -36, clientY: 0, pointerId: 2 });
    expect(latest?.draft.boxes[0]?.widthPercent).toBe(60);
    expect(position()).toEqual({ x: 50, y: 50 });
  });
});
