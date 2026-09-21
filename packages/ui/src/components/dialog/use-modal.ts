"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { getFocusableElements, resolveTrapTarget } from "../../lib/focus.js";

export interface UseModalOptions {
  open: boolean;
  onClose: () => void;
  /** Escape cierra. Apagalo sólo en un diálogo destructivo que exija decidir. */
  closeOnEscape?: boolean;
  /** Elemento que recibe el foco al abrir. Por defecto, el primero enfocable. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export interface UseModalResult {
  containerRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * Comportamiento compartido por Dialog y Drawer: foco atrapado, cierre con
 * Escape, bloqueo del scroll de fondo y devolución del foco al cerrar.
 *
 * Lo de devolver el foco no es un detalle: quien navega con teclado y abre un
 * modal desde un botón de una tabla, al cerrarlo tiene que volver a ese botón.
 * Si no, aparece al principio del documento y pierde el sitio.
 */
export function useModal({
  open,
  onClose,
  closeOnEscape = true,
  initialFocusRef,
}: UseModalOptions): UseModalResult {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const target =
      initialFocusRef?.current ?? getFocusableElements(container)[0] ?? container;
    target?.focus();

    const { body } = document;
    body.classList.add("fg-scroll-locked");

    return () => {
      body.classList.remove("fg-scroll-locked");
      // `isConnected` evita intentar enfocar un nodo que ya no está en el DOM
      // (la fila de la tabla desde la que se abrió el modal pudo borrarse).
      if (previous !== null && previous.isConnected) previous.focus();
    };
  }, [open, initialFocusRef]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape") {
        if (!closeOnEscape) return;
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusables = getFocusableElements(containerRef.current);
      const active =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const next = resolveTrapTarget(focusables, active, event.shiftKey);
      if (next === null) return;
      event.preventDefault();
      next.focus();
    },
    [closeOnEscape, onClose],
  );

  return { containerRef, onKeyDown };
}
