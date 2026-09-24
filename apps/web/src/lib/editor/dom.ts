"use client";

/**
 * Dos efectos de DOM que el editor necesita y no tienen que ver con React Query.
 */
import { useEffect, useState, type RefObject } from "react";
import type { FontFamily } from "@fastgram/contracts";
import { googleFontsUrl } from "./fonts";

const LINK_ID = "fgw-editor-fonts";

/**
 * Carga las familias del editor desde Google Fonts, una sola vez por página.
 *
 * Se piden **las 12** en una URL: la CSS de Google sólo declara `@font-face`,
 * y el navegador baja cada archivo recién cuando algo lo usa. Así el selector
 * de familia no tiene que esperar una carga al cambiar.
 *
 * Si Google no responde, el texto sale en la reserva: el preview queda menos
 * fiel, pero el editor no se rompe. Por eso no hay estado de error.
 */
export function useEditorFonts(families: readonly FontFamily[]): void {
  const url = googleFontsUrl(families);
  useEffect(() => {
    if (url === null || typeof document === "undefined") return;
    const existing = document.getElementById(LINK_ID);
    if (existing instanceof HTMLLinkElement) {
      if (existing.href !== url) existing.href = url;
      return;
    }
    const link = document.createElement("link");
    link.id = LINK_ID;
    link.rel = "stylesheet";
    link.href = url;
    document.head.appendChild(link);
  }, [url]);
}

/**
 * Ancho de un elemento, con `ResizeObserver`. Devuelve `fallback` hasta medir,
 * y para siempre en entornos sin el observer (jsdom): el editor tiene que
 * funcionar a 360 aunque no pueda medir.
 */
export function useElementWidth(
  ref: RefObject<HTMLElement | null>,
  fallback: number,
): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined && w > 0) setWidth(Math.round(w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
