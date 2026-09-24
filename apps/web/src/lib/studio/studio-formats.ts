/**
 * Qué formatos de `/content/<id>` arma a mano el Content Studio (sprint 7).
 *
 * Sin `"use client"` a propósito: lo leen las páginas del servidor (el hub y
 * `/content/[format]`). Importar una constante de un módulo cliente desde un
 * componente de servidor da una referencia de cliente, no el valor.
 */
import type { StudioFormat } from "@fastgram/contracts";

/** Segmento de `/content/<id>` → formato del Studio. Los ids son los del PRD. */
export const STUDIO_FORMAT_BY_ROUTE: Readonly<Record<string, StudioFormat>> = {
  slideshow: "slideshow",
  "wall-of-text": "wall-of-text",
  "green-screen-meme": "green-screen",
  "video-hook-and-demo": "video-hook",
};

export const STUDIO_ROUTE_IDS: readonly string[] = Object.keys(STUDIO_FORMAT_BY_ROUTE);

export function studioFormatOf(routeId: string): StudioFormat | null {
  return STUDIO_FORMAT_BY_ROUTE[routeId] ?? null;
}

/**
 * `custom`, el video propio. Está también en `custom-video.ts` (módulo
 * cliente); acá para las páginas del servidor, por la razón de la cabecera.
 */
export const CUSTOM_ROUTE_ID = "custom";
