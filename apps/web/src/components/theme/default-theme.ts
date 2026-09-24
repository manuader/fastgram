/**
 * Oscuro por defecto · `PU-UI-001` (PLAN-USO-PERSONAL §7).
 *
 * `lib/theme/theme.ts` sigue siendo la mecánica (clave de storage, cómo se
 * aplica el atributo). Lo único que cambia acá es **qué pasa sin elección
 * guardada**: antes era `system`; ahora es `dark`. Una elección guardada —las
 * tres, incluida `system`— se respeta siempre: quien eligió "seguir al
 * sistema" no se despierta con la app a oscuras.
 *
 * El script inline es la versión con default del `THEME_INIT_SCRIPT` de
 * `lib/theme/theme.ts`: mismas reglas (síncrono, en el `<head>`, todo dentro de
 * un `try`, sin comillas dobles ni `</`), una rama más.
 */
import { isThemeChoice, THEME_STORAGE_KEY, type ThemeChoice } from "@/lib/theme/theme";

export const DEFAULT_THEME: ThemeChoice = "dark";

export const THEME_INIT_SCRIPT_WITH_DEFAULT = `(function(){var d=document.documentElement;try{var c=localStorage.getItem('${THEME_STORAGE_KEY}');if(c==='dark'||c==='light'){d.setAttribute('data-theme',c);}else if(c!=='system'){d.setAttribute('data-theme','${DEFAULT_THEME}');}}catch(e){d.setAttribute('data-theme','${DEFAULT_THEME}');}})();`;

/** La elección guardada, o el default si no hay ninguna (o no se puede leer). */
export function readThemeChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}
