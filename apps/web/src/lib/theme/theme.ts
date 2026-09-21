/**
 * Tema claro/oscuro · `P1-UI-002` / `NFR-021`.
 *
 * `packages/ui/src/tokens.css` ya trae las dos paletas y las engancha a dos
 * selectores:
 *
 *   · `:root[data-theme="dark"]`                          → elección explícita
 *   · `@media (prefers-color-scheme: dark)` acotado a
 *     `:root:not([data-theme="light"])`                    → preferencia del SO
 *
 * Lo que falta —y es lo que hay aquí— es **poner el atributo antes del primer
 * paint**. Si se pusiera en un `useEffect`, el navegador ya habría pintado una
 * pantalla clara: eso es el flash que prohíbe NFR-021. Por eso el script va
 * inline en el `<head>`, síncrono, y por eso es un string y no un módulo: un
 * `<script src>` es asíncrono por definición.
 *
 * Tres estados, no dos. `system` **no** es "claro": es no fijar el atributo y
 * dejar que la media query decida, y por eso escribir `light` u `oscuro` a la
 * fuerza es una elección distinta de no escribir nada.
 */

export const THEME_CHOICES = ["light", "dark", "system"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** La misma clave la leen el script inline y el provider. Un solo sitio. */
export const THEME_STORAGE_KEY = "fg-theme";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return (THEME_CHOICES as readonly unknown[]).includes(value);
}

/**
 * Aplica la elección al documento.
 *
 * `system` **quita** el atributo. Ponerle `data-theme="light"` a alguien que
 * eligió "seguir al sistema" congelaría su tema cuando el sistema cambie a
 * oscuro por la noche.
 */
export function applyTheme(root: HTMLElement, choice: ThemeChoice): void {
  if (choice === "system") {
    root.removeAttribute("data-theme");
    return;
  }
  root.setAttribute("data-theme", choice);
}

/**
 * El script inline del `<head>`.
 *
 * Todo dentro de un `try`: en modo incógnito de algunos navegadores el acceso a
 * `localStorage` lanza, y una excepción aquí —antes de que React monte— deja la
 * página en blanco. Un tema equivocado se arregla con un clic; una pantalla en
 * blanco, no.
 *
 * Sin comillas dobles ni `</`: va dentro de un `<script>` en el HTML.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var c=localStorage.getItem('${THEME_STORAGE_KEY}');if(c==='dark'||c==='light'){document.documentElement.setAttribute('data-theme',c);}}catch(e){}})();`;

/** Lee la elección guardada. `system` ante cualquier cosa rara o inaccesible. */
export function readStoredTheme(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

/** Guarda la elección. Que falle no puede romper el cambio de tema en pantalla. */
export function storeTheme(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    /* almacenamiento bloqueado: el tema vale para esta pestaña y ya. */
  }
}
