/**
 * Presets de movimiento del reel, como **datos**.
 *
 * El compilador no escribe JavaScript por capa: emite una lista de entradas
 * `{selector, keyframes, delay, duration, easing, fill}` que un script fijo de
 * diez líneas convierte en `element.animate(...)` + `pause()` (Web Animations
 * API). HyperFrames trae un adaptador `waapi` que hace seek de cada animación
 * a la hora del frame (`document.getAnimations()` → `currentTime`), así que
 * esto es determinístico sin depender de GSAP — que no está instalado en el
 * repo y cuya licencia no es OSS. Ver el ADR en el reporte del sprint 9.
 *
 * Reglas que salen de haber mirado frames:
 *  · Los `delay` son hora **global** del reel (el adaptador hace seek del
 *    timeline del documento), no relativos a la capa.
 *  · Dos animaciones sobre la misma propiedad del mismo elemento se pisan
 *    (la última creada gana, incluso antes de su `delay` si tiene
 *    `fill: backwards`). Por eso la entrada anima `.tin` y la salida `.tbox`.
 *  · `clip-path` sobre un `<span>` inline multilínea recorta sólo el primer
 *    renglón: los barridos van sobre un bloque o con `background-size`.
 */
import type { ReelMediaAnimation, ReelTextAnimation } from "../spec.js";
import { ms } from "./html.js";

export type Keyframe = Readonly<Record<string, string | number>>;

export interface MotionEntry {
  /** Selector CSS (siempre un `#id` o `#id .clase`). */
  readonly s: string;
  readonly k: readonly Keyframe[];
  /** delay (ms, hora global del reel). */
  readonly t: number;
  /** duración (ms). */
  readonly d: number;
  readonly e: string;
  readonly f: "both" | "forwards" | "backwards" | "none";
}

export const EASE_OUT_EXPO = "cubic-bezier(0.16,1,0.3,1)";
export const EASE_OUT_BACK = "cubic-bezier(0.34,1.56,0.64,1)";
export const EASE_IN_OUT = "cubic-bezier(0.65,0,0.35,1)";
export const EASE_OUT = "cubic-bezier(0.22,1,0.36,1)";

/** Cuánto dura la entrada de cada preset (s). Las de palabras suman el escalonado. */
export const ENTRANCE_SEC: Readonly<Record<ReelTextAnimation, number>> = {
  none: 0,
  "fade-up": 0.6,
  pop: 0.5,
  typewriter: 0,
  "word-by-word": 0.35,
  "slide-left": 0.55,
  "highlight-sweep": 0.6,
  "kinetic-bounce": 0.6,
  "zoom-blur": 0.55,
  "wipe-reveal": 0.6,
};

/** Duración de la salida `fade` (s). Termina un frame antes del fin de la capa. */
export const EXIT_SEC = 0.25;
const FRAME_SEC = 1 / 30;

/** Las animaciones que animan palabras sueltas y necesitan `<span class="w">`. */
export function animatesWords(animation: ReelTextAnimation): boolean {
  return animation === "word-by-word" || animation === "kinetic-bounce";
}

/**
 * Entrada de un bloque entero (texto sin separar o imagen). `target` es el
 * selector del nodo interno (`#L-x .tin`).
 */
export function blockEntrance(
  animation: ReelMediaAnimation | ReelTextAnimation,
  target: string,
  startSec: number,
  layerSec: number,
): MotionEntry[] {
  // Nunca más larga que la mitad de la capa: una capa de 0,6 s no puede pasarse
  // entera entrando.
  const cap = (sec: number): number => ms(Math.min(sec, layerSec / 2));
  const t = ms(startSec);
  switch (animation) {
    case "fade-up":
      return [
        {
          s: target,
          k: [
            { opacity: 0, transform: "translateY(60px)" },
            { opacity: 1, transform: "translateY(0px)" },
          ],
          t,
          d: cap(ENTRANCE_SEC["fade-up"]),
          e: EASE_OUT_EXPO,
          f: "both",
        },
      ];
    case "pop":
      return [
        {
          s: target,
          k: [
            { opacity: 0, transform: "scale(0.4)", offset: 0 },
            { opacity: 1, transform: "scale(1.1)", offset: 0.6 },
            { opacity: 1, transform: "scale(1)", offset: 1 },
          ],
          t,
          d: cap(ENTRANCE_SEC.pop),
          e: EASE_OUT,
          f: "both",
        },
      ];
    case "slide-left":
      return [
        {
          s: target,
          k: [
            { opacity: 0, transform: "translateX(110%)" },
            { opacity: 1, transform: "translateX(0%)" },
          ],
          t,
          d: cap(ENTRANCE_SEC["slide-left"]),
          e: EASE_OUT_EXPO,
          f: "both",
        },
      ];
    case "zoom-blur":
      return [
        {
          s: target,
          k: [
            { opacity: 0, transform: "scale(1.6)", filter: "blur(18px)" },
            { opacity: 1, transform: "scale(1)", filter: "blur(0px)" },
          ],
          t,
          d: cap(ENTRANCE_SEC["zoom-blur"]),
          e: EASE_OUT_EXPO,
          f: "both",
        },
      ];
    case "wipe-reveal":
      // El `inset` negativo arriba/abajo/izquierda deja entrar el contorno.
      return [
        {
          s: target,
          k: [
            { clipPath: "inset(-30% 100% -30% -10%)" },
            { clipPath: "inset(-30% -10% -30% -10%)" },
          ],
          t,
          d: cap(ENTRANCE_SEC["wipe-reveal"]),
          e: EASE_IN_OUT,
          f: "both",
        },
      ];
    case "highlight-sweep":
      // El texto aparece rápido y el marcador barre detrás, renglón por renglón
      // (`background-size` sobre el span inline con `box-decoration-break`).
      return [
        {
          s: target,
          k: [{ opacity: 0 }, { opacity: 1 }],
          t,
          d: cap(0.15),
          e: "linear",
          f: "both",
        },
        {
          s: `${target} .tline`,
          k: [{ backgroundSize: "0% 100%" }, { backgroundSize: "100% 100%" }],
          t: t + ms(0.1),
          d: cap(ENTRANCE_SEC["highlight-sweep"]),
          e: EASE_IN_OUT,
          f: "both",
        },
      ];
    case "none":
    case "typewriter":
    case "word-by-word":
    case "kinetic-bounce":
      return [];
  }
}

/** Entrada palabra por palabra. `wordSelectors` en orden de lectura. */
export function wordEntrance(
  animation: "word-by-word" | "kinetic-bounce",
  wordSelectors: readonly string[],
  startSec: number,
  layerSec: number,
): MotionEntry[] {
  const count = wordSelectors.length;
  if (count === 0) return [];
  const per = ENTRANCE_SEC[animation];
  // Toda la entrada entra en 1,4 s o en la mitad de la capa, lo que sea menor.
  const budget = Math.min(1.4, layerSec / 2);
  const stagger = count > 1 ? Math.min(0.12, Math.max(0, budget - per) / (count - 1)) : 0;
  return wordSelectors.map((s, i) => {
    const t = ms(startSec + i * stagger);
    if (animation === "word-by-word") {
      return {
        s,
        k: [
          { opacity: 0, transform: "translateY(45%)" },
          { opacity: 1, transform: "translateY(0%)" },
        ],
        t,
        d: ms(Math.min(per, budget)),
        e: EASE_OUT_EXPO,
        f: "both" as const,
      };
    }
    return {
      s,
      k: [
        { opacity: 0, transform: "translateY(-120%) scale(1.25)", offset: 0 },
        { opacity: 1, transform: "translateY(0%) scale(0.94)", offset: 0.55 },
        { opacity: 1, transform: "translateY(-14%) scale(1.03)", offset: 0.78 },
        { opacity: 1, transform: "translateY(0%) scale(1)", offset: 1 },
      ],
      t,
      d: ms(Math.min(per, budget)),
      e: "cubic-bezier(0.33,1,0.68,1)",
      f: "both" as const,
    };
  });
}

/**
 * Máquina de escribir: cada letra aparece de golpe (`steps`) a su turno. La
 * escritura entera tarda 45 ms por letra con techo de 1,6 s y de 60 % de la capa.
 */
export function typewriter(
  charSelectors: readonly string[],
  startSec: number,
  layerSec: number,
): MotionEntry[] {
  const count = charSelectors.length;
  if (count === 0) return [];
  const total = Math.min(0.045 * count, 1.6, layerSec * 0.6);
  const step = total / count;
  return charSelectors.map((s, i) => ({
    s,
    k: [{ opacity: 0 }, { opacity: 1 }],
    t: ms(startSec + i * step),
    d: 1,
    e: "steps(1,end)",
    f: "both" as const,
  }));
}

/** Salida `fade`: termina un frame antes de que la capa desaparezca. */
export function exitFade(
  target: string,
  endSec: number,
  layerSec: number,
): MotionEntry[] {
  const sec = Math.min(EXIT_SEC, layerSec / 4);
  return [
    {
      s: target,
      k: [{ opacity: 1 }, { opacity: 0 }],
      t: ms(endSec - sec - FRAME_SEC),
      d: ms(sec),
      e: "linear",
      f: "forwards",
    },
  ];
}

/** Acercamiento lento de un fondo de imagen durante toda la capa. */
export function kenBurns(
  target: string,
  startSec: number,
  layerSec: number,
): MotionEntry {
  return {
    s: target,
    k: [{ transform: "scale(1)" }, { transform: "scale(1.12)" }],
    t: ms(startSec),
    d: ms(layerSec),
    e: "linear",
    f: "both",
  };
}
