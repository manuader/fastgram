/** Un hueco en la lista de páginas: `…` entre dos bloques de números. */
export const PAGINATION_ELLIPSIS = "ellipsis";

export type PaginationItem = number | typeof PAGINATION_ELLIPSIS;

export interface PaginationRangeOptions {
  /** Página actual, 1-indexada. Se acota al rango válido. */
  current: number;
  /** Total de páginas. `0` devuelve una lista vacía. */
  total: number;
  /** Cuántas páginas mostrar a cada lado de la actual. Por defecto 1. */
  siblings?: number;
  /** Cuántas páginas fijar en cada extremo. Por defecto 1. */
  boundaries?: number;
}

function range(start: number, end: number): number[] {
  if (end < start) return [];
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Qué páginas mostrar en el paginador, con elipsis donde hay hueco.
 *
 * El ancho del control es **estable**: para un mismo `siblings`/`boundaries` el
 * número de items no cambia al movernos de página, así que los botones no
 * bailan bajo el cursor.
 */
export function getPaginationRange(options: PaginationRangeOptions): PaginationItem[] {
  const total = Math.max(0, Math.trunc(options.total));
  if (total === 0) return [];

  const siblings = Math.max(0, Math.trunc(options.siblings ?? 1));
  const boundaries = Math.max(1, Math.trunc(options.boundaries ?? 1));
  const current = clamp(Math.trunc(options.current), 1, total);

  // extremos + vecinos + actual + las dos elipsis
  const totalVisible = boundaries * 2 + siblings * 2 + 3;
  if (totalVisible >= total) return range(1, total);

  const leftSibling = Math.max(current - siblings, boundaries);
  const rightSibling = Math.min(current + siblings, total - boundaries);

  const showLeftEllipsis = leftSibling > boundaries + 2;
  const showRightEllipsis = rightSibling < total - (boundaries + 1);

  if (!showLeftEllipsis && showRightEllipsis) {
    return [
      ...range(1, siblings * 2 + boundaries + 2),
      PAGINATION_ELLIPSIS,
      ...range(total - boundaries + 1, total),
    ];
  }
  if (showLeftEllipsis && !showRightEllipsis) {
    return [
      ...range(1, boundaries),
      PAGINATION_ELLIPSIS,
      ...range(total - (boundaries + 1 + siblings * 2), total),
    ];
  }
  return [
    ...range(1, boundaries),
    PAGINATION_ELLIPSIS,
    ...range(leftSibling, rightSibling),
    PAGINATION_ELLIPSIS,
    ...range(total - boundaries + 1, total),
  ];
}
