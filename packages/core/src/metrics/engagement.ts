/**
 * Engagement rate — `PU-AUTO-004`, `P3-ANALYT-001`.
 *
 * `(likes + comments + shares) / views`. Es la definición más común y la que
 * se puede calcular igual en las cuatro redes con adaptador; no sale de
 * ninguna plataforma (cada una tiene la suya, y no son comparables entre sí).
 *
 * Reglas que evitan mentir:
 * - **Sin views conocidas, o con 0 views, no hay tasa** (`null`), no `0`: un
 *   post pre-sync o una red que no da vistas no «tuvo 0 % de engagement».
 * - `shares` desconocido cuenta como 0 en el numerador (no infla nada); likes o
 *   comments desconocidos, también. Lo que no se sabe no suma.
 * - **No se recorta a [0, 1].** Las vistas de cada red se cuentan distinto
 *   (en X son impresiones) y una tasa > 1 es un dato raro que conviene ver,
 *   no esconder.
 */

export interface EngagementInput {
  readonly views: number | null;
  readonly likes: number | null;
  readonly comments: number | null;
  readonly shares: number | null;
}

export function interactionsOf(m: EngagementInput): number {
  return (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0);
}

export function engagementRate(m: EngagementInput): number | null {
  if (m.views === null || m.views <= 0) return null;
  return interactionsOf(m) / m.views;
}
