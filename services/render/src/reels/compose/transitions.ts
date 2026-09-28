/**
 * Transiciones entre escenas. Una escena = un fondo; la transición es la
 * **entrada** del fondo nuevo (`transitionIn`), que se compone encima del
 * anterior. Para que haya algo debajo mientras entra, el fondo que sale se
 * mantiene visible hasta que la entrada termina (`visibleEnd`, ver
 * `backgroundWindows`).
 */
import type { ReelBackgroundLayer, ReelTransition } from "../spec.js";
import { EASE_IN_OUT, EASE_OUT_EXPO, type MotionEntry } from "./motion.js";
import { ms } from "./html.js";

/** Tolerancia para decidir que un fondo "sigue" a otro (medio frame y poco). */
const JOIN_TOLERANCE_SEC = 0.05;

export interface BackgroundWindow {
  readonly start: number;
  readonly end: number;
}

/**
 * Ventana visible de cada fondo: su `[start, end)` extendido hasta el fin de la
 * transición de cualquier fondo que entre mientras él está (o justo cuando
 * termina). Sin eso, un `crossfade` fundiría contra negro.
 */
export function backgroundWindows(
  backgrounds: readonly ReelBackgroundLayer[],
  durationSec: number,
): Map<string, BackgroundWindow> {
  const windows = new Map<string, BackgroundWindow>();
  for (const a of backgrounds) {
    let end = a.end;
    for (const b of backgrounds) {
      if (b === a || b.transitionIn.kind === "cut" || b.transitionIn.kind === "flash")
        continue;
      if (b.start > a.start && b.start <= a.end + JOIN_TOLERANCE_SEC) {
        end = Math.max(end, Math.min(durationSec, b.start + b.transitionIn.durationSec));
      }
    }
    windows.set(a.id, { start: a.start, end });
  }
  return windows;
}

/** Keyframes de la entrada, sobre el nodo interno del fondo nuevo. */
export function transitionIn(
  kind: ReelTransition,
  target: string,
  startSec: number,
  durationSec: number,
): MotionEntry[] {
  const t = ms(startSec);
  const d = ms(durationSec);
  const one = (k: MotionEntry["k"], e: string): MotionEntry[] => [
    { s: target, k, t, d, e, f: "both" },
  ];
  switch (kind) {
    case "cut":
    case "flash":
      // `flash` no mueve el fondo: el destello es un nodo aparte (`flashNode`).
      return [];
    case "crossfade":
      return one([{ opacity: 0 }, { opacity: 1 }], "linear");
    case "slide-up":
      return one(
        [{ transform: "translateY(100%)" }, { transform: "translateY(0%)" }],
        EASE_OUT_EXPO,
      );
    case "slide-left":
      return one(
        [{ transform: "translateX(100%)" }, { transform: "translateX(0%)" }],
        EASE_OUT_EXPO,
      );
    case "zoom-in":
      return one(
        [
          { opacity: 0, transform: "scale(1.35)" },
          { opacity: 1, transform: "scale(1)" },
        ],
        EASE_OUT_EXPO,
      );
    case "whip":
      return one(
        [
          { transform: "translateX(100%)", filter: "blur(24px)" },
          { transform: "translateX(0%)", filter: "blur(0px)" },
        ],
        EASE_IN_OUT,
      );
    case "blur":
      return one(
        [
          { opacity: 0, filter: "blur(40px)" },
          { opacity: 1, filter: "blur(0px)" },
        ],
        "linear",
      );
  }
}

/**
 * El destello blanco de `flash`: centrado en el corte, por encima de todo.
 * Devuelve la ventana del nodo y su animación.
 */
export function flashWindow(
  startSec: number,
  durationSec: number,
  reelSec: number,
): BackgroundWindow {
  const start = Math.max(0, startSec - durationSec / 2);
  return { start, end: Math.min(reelSec, start + durationSec) };
}

export function flashMotion(target: string, window: BackgroundWindow): MotionEntry {
  return {
    s: target,
    k: [
      { opacity: 0, offset: 0 },
      { opacity: 1, offset: 0.4 },
      { opacity: 0, offset: 1 },
    ],
    t: ms(window.start),
    d: ms(window.end - window.start),
    e: "linear",
    f: "both",
  };
}
