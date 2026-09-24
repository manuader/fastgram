/**
 * Las tres formas de decidir sobre una tarjeta · FR-050 criterio 1: *"las tres
 * formas de aprobar (swipe, botón, `→`) producen el mismo resultado"*.
 *
 * Por eso la traducción de gesto y tecla a decisión vive acá, pura: el
 * componente sólo llama a `onDecide(decision)`, venga de donde venga, y los
 * umbrales se prueban sin montar React ni simular punteros.
 */

export type Decision = "accept" | "skip";

/**
 * Distancia horizontal, en px, a partir de la cual soltar la tarjeta decide.
 *
 * 120 px es poco más de un tercio de una tarjeta de 360 px de ancho: lo bastante
 * para que un arrastre de "sólo estoy mirando" no decida nada, y lo bastante
 * poco para no obligar a cruzar la pantalla en un móvil.
 */
export const SWIPE_DISTANCE_PX = 120;

/**
 * Velocidad, en px/s, que decide aunque no se haya llegado a la distancia: un
 * *flick* corto y rápido es una decisión tan clara como un arrastre largo.
 */
export const SWIPE_VELOCITY_PX_S = 600;

/**
 * Decisión al soltar. `null` = la tarjeta vuelve al centro.
 *
 * Un flick en contra del desplazamiento (arrastrar a la derecha y soltar
 * lanzando a la izquierda) no decide: las dos señales se contradicen y la duda
 * se resuelve no haciendo nada, que es lo único reversible.
 */
export function decisionFromDrag(offsetX: number, velocityX: number): Decision | null {
  if (offsetX >= SWIPE_DISTANCE_PX) return "accept";
  if (offsetX <= -SWIPE_DISTANCE_PX) return "skip";
  if (velocityX >= SWIPE_VELOCITY_PX_S && offsetX > 0) return "accept";
  if (velocityX <= -SWIPE_VELOCITY_PX_S && offsetX < 0) return "skip";
  return null;
}

/** Lo mínimo de un `KeyboardEvent` que hace falta para decidir. */
export interface KeyLike {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly target: EventTarget | null;
}

/**
 * ¿El foco está en algo donde las flechas significan otra cosa?
 *
 * Un input, un textarea, un select o un `contenteditable` usan ← → para mover el
 * cursor; un slider (`role="slider"`) para cambiar el valor. Robarle las flechas
 * a esos controles es el bug clásico de los atajos globales.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object") return false;
  const el = target as Partial<HTMLElement>;
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable === true) return true;
  const role = typeof el.getAttribute === "function" ? el.getAttribute("role") : null;
  return role === "slider" || role === "textbox" || role === "spinbutton";
}

/**
 * Tecla → decisión (F-052: `←` rechazar, `→` aprobar). `null` si la tecla no es
 * un atajo del deck o si no le corresponde a él.
 *
 * Con modificadores no se decide nada: `Alt+←` es "atrás" en el navegador y
 * `⌘→` es "fin de línea". Un atajo de una sola tecla sólo es seguro sola.
 */
export function keyToDecision(event: KeyLike): Decision | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (isTypingTarget(event.target)) return null;
  if (event.key === "ArrowRight") return "accept";
  if (event.key === "ArrowLeft") return "skip";
  return null;
}
