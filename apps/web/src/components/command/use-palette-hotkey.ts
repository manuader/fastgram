"use client";

import { useEffect } from "react";

/**
 * ⌘K en macOS, Ctrl+K en el resto. Se escucha en `window` en fase de captura
 * para ganarle a un campo de texto que quiera el atajo para sí; ⌘K no es un
 * atajo de edición en ningún navegador, así que no se le roba nada a nadie.
 */
export function isPaletteShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  return event.key.toLowerCase() === "k";
}

export function usePaletteHotkey(onToggle: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      onToggle();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onToggle]);
}
