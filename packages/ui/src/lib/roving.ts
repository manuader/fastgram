/**
 * Navegación con flechas para grupos de widgets (roving tabindex).
 *
 * La usa `Tabs`, y es la misma regla que necesita el deck de Blitz: el PRD
 * `F-052` especifica ← rechazar / → aprobar. Un deck que sólo se opera con el
 * mouse deja gente afuera.
 */

export type Orientation = "horizontal" | "vertical";

/**
 * Índice al que debe moverse el foco tras una tecla, o `null` si la tecla no
 * corresponde a este grupo (y el evento no debe interceptarse).
 *
 * `loop` hace que el último lleve al primero; es el comportamiento que espera
 * el patrón tablist de WAI-ARIA.
 */
export function nextRovingIndex(options: {
  current: number;
  count: number;
  key: string;
  orientation?: Orientation;
  loop?: boolean;
}): number | null {
  const { current, count, key } = options;
  const orientation = options.orientation ?? "horizontal";
  const loop = options.loop ?? true;
  if (count <= 0) return null;

  const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  const prevKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";

  if (key === "Home") return 0;
  if (key === "End") return count - 1;

  const step = key === nextKey ? 1 : key === prevKey ? -1 : 0;
  if (step === 0) return null;

  const raw = current + step;
  if (loop) return (raw + count) % count;
  return Math.min(Math.max(raw, 0), count - 1);
}
