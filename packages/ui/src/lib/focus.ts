/**
 * Utilidades de foco compartidas por Dialog, Drawer y Tooltip.
 *
 * La parte que decide *a dónde* va el foco está separada del DOM a propósito:
 * es la lógica que puede equivocarse (y dejar a alguien encerrado fuera del
 * modal) y es la única que se puede testear sin un navegador.
 */

/** Selector de lo que el navegador considera enfocable por teclado. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Elementos enfocables dentro de un contenedor, en orden de tabulación. */
export function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (container === null) return [];
  const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return nodes.filter(
    (node) =>
      node.getAttribute("aria-hidden") !== "true" &&
      // `offsetParent === null` descarta lo que está con display:none. No
      // detecta visibility:hidden, que es el caso raro; el coste de un falso
      // positivo acá es un tab que no parece moverse, no quedar encerrado.
      (node.offsetParent !== null || node.tagName === "DIALOG"),
  );
}

/**
 * Dado el orden de tabulación de un modal, a qué elemento hay que mover el foco
 * cuando se pulsa Tab. Devuelve `null` si el comportamiento por defecto del
 * navegador ya es correcto (es decir: el foco se queda dentro sin ayuda).
 *
 * Genérico sobre `T` para poder testearlo con strings en vez de nodos del DOM.
 */
export function resolveTrapTarget<T>(
  focusables: readonly T[],
  active: T | null,
  shiftKey: boolean,
): T | null {
  const first = focusables[0];
  if (first === undefined) return null; // nada enfocable: el foco vive en el contenedor
  const last = focusables[focusables.length - 1];
  if (last === undefined) return null;

  const index = active === null ? -1 : focusables.indexOf(active);
  if (index === -1) {
    // El foco está fuera del modal (o en el contenedor): lo traemos al borde
    // correcto según la dirección del tab.
    return shiftKey ? last : first;
  }
  if (shiftKey && index === 0) return last;
  if (!shiftKey && index === focusables.length - 1) return first;
  return null;
}
