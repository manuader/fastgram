import { THEME_INIT_SCRIPT_WITH_DEFAULT } from "@/components/theme/default-theme";

/**
 * El script que fija el tema antes del primer paint (`NFR-021`).
 *
 * Va en el `<head>` del root layout y **no** puede ser `next/script`: cualquier
 * estrategia de `next/script` lo ejecuta después del paint, que es justo lo que
 * hay que evitar. Un `<script>` crudo y síncrono es lo correcto aquí.
 *
 * `dangerouslySetInnerHTML` con una constante del propio repo: no hay entrada
 * de usuario en este string. Desde `PU-UI-001` sin elección guardada fija
 * `dark` (`default-theme.ts`).
 */
export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT_WITH_DEFAULT }} />;
}
