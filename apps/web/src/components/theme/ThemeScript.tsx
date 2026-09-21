import { THEME_INIT_SCRIPT } from "@/lib/theme/theme";

/**
 * El script que fija el tema antes del primer paint (`NFR-021`).
 *
 * Va en el `<head>` del root layout y **no** puede ser `next/script`: cualquier
 * estrategia de `next/script` lo ejecuta después del paint, que es justo lo que
 * hay que evitar. Un `<script>` crudo y síncrono es lo correcto aquí.
 *
 * `dangerouslySetInnerHTML` con una constante del propio repo: no hay entrada
 * de usuario en este string.
 */
export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />;
}
