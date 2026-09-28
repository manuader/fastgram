/**
 * Utilidades de escritura de HTML del compilador. Todo texto del usuario pasa
 * por `escapeHtml`; todo atributo, por `escapeAttr`. Una copy con `<script>` o
 * con `"` tiene que salir como texto en el frame, nunca como marcado.
 */

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Un número a texto con precisión fija. El HTML tiene que ser **idéntico**
 * para el mismo spec (se hashea para la cache y se compara en el snapshot): un
 * `0.30000000000000004` que aparece según el orden de las sumas lo rompería.
 */
export function num(value: number, digits = 3): string {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  // `-0` → `0`: mismo valor, distinto texto.
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** Segundos del spec a milisegundos enteros de WAAPI. */
export function ms(seconds: number): number {
  return Math.round(seconds * 1000);
}

/** `#RRGGBB` + opacidad → `rgba()`. */
export function rgba(hex: string, opacity: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${String(r)},${String(g)},${String(b)},${num(opacity, 3)})`;
}

/** JSON dentro de `<script type="application/json">`: `</` no puede cerrar el tag. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

/**
 * Texto dentro de `url("…")` en un `<style>`. El contenido de `<style>` no se
 * decodifica como HTML (un `&amp;` llega literal y rompe una URL firmada), así
 * que acá se escapa como CSS: comillas, barras, saltos y `<` (para que nada
 * cierre el `</style>`).
 */
export function cssString(value: string): string {
  return value.replace(/[\\"\n\r<>]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);
}
