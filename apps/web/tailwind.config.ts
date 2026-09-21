import type { Config } from "tailwindcss";

/**
 * Tailwind en `apps/web`.
 *
 * **Qué hace Tailwind aquí y qué no.** El design system (`packages/ui`) es CSS
 * plano con clases semánticas y tokens `--fg-*`; eso no cambia. Tailwind se usa
 * para lo de la app que no merece una clase propia — un hueco, una columna, un
 * `hidden` puntual.
 *
 * Por eso el `theme` **no** trae una paleta nueva: cada escala apunta a los
 * mismos custom properties que consumen los componentes. Así `bg-surface` y
 * `.fg-card` son literalmente el mismo color, y siguen siéndolo al cambiar de
 * tema. Una paleta duplicada en JS sería una segunda fuente de verdad que en el
 * tema oscuro ya no coincide.
 *
 * Consecuencia: los modificadores de opacidad de Tailwind (`bg-surface/50`) no
 * funcionan sobre estos colores, porque el valor es una `var()` y no un canal
 * separable. Es el precio de tener un solo sitio donde vive el color.
 */
export default {
  content: ["./src/**/*.{ts,tsx}", "../../packages/ui/src/**/*.{ts,tsx}"],
  // El tema oscuro no lo decide Tailwind: lo decide `data-theme` en el `<html>`
  // (lo pone el script inline, NFR-021) y la media query de `tokens.css`. Esta
  // línea sólo le enseña a `dark:` a mirar el mismo atributo.
  darkMode: ["selector", ':root[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: "var(--fg-color-bg)",
        surface: "var(--fg-color-surface)",
        "surface-raised": "var(--fg-color-surface-raised)",
        "surface-sunken": "var(--fg-color-surface-sunken)",
        border: "var(--fg-color-border)",
        "border-strong": "var(--fg-color-border-strong)",
        text: "var(--fg-color-text)",
        "text-muted": "var(--fg-color-text-muted)",
        "text-subtle": "var(--fg-color-text-subtle)",
        accent: "var(--fg-color-accent)",
        "accent-subtle": "var(--fg-color-accent-subtle)",
        success: "var(--fg-color-success)",
        warning: "var(--fg-color-warning)",
        danger: "var(--fg-color-danger)",
        info: "var(--fg-color-info)",
      },
      fontFamily: {
        sans: "var(--fg-font-sans)",
        mono: "var(--fg-font-mono)",
      },
      fontSize: {
        xs: "var(--fg-text-xs)",
        sm: "var(--fg-text-sm)",
        base: "var(--fg-text-base)",
        lg: "var(--fg-text-lg)",
        xl: "var(--fg-text-xl)",
        "2xl": "var(--fg-text-2xl)",
        "3xl": "var(--fg-text-3xl)",
        "4xl": "var(--fg-text-4xl)",
      },
      spacing: {
        1: "var(--fg-space-1)",
        2: "var(--fg-space-2)",
        3: "var(--fg-space-3)",
        4: "var(--fg-space-4)",
        5: "var(--fg-space-5)",
        6: "var(--fg-space-6)",
        8: "var(--fg-space-8)",
        10: "var(--fg-space-10)",
        12: "var(--fg-space-12)",
        16: "var(--fg-space-16)",
        20: "var(--fg-space-20)",
      },
      borderRadius: {
        sm: "var(--fg-radius-sm)",
        md: "var(--fg-radius-md)",
        lg: "var(--fg-radius-lg)",
        xl: "var(--fg-radius-xl)",
        "2xl": "var(--fg-radius-2xl)",
        full: "var(--fg-radius-full)",
      },
      boxShadow: {
        xs: "var(--fg-shadow-xs)",
        sm: "var(--fg-shadow-sm)",
        md: "var(--fg-shadow-md)",
        lg: "var(--fg-shadow-lg)",
      },
      zIndex: {
        dropdown: "var(--fg-z-dropdown)",
        sticky: "var(--fg-z-sticky)",
        overlay: "var(--fg-z-overlay)",
        modal: "var(--fg-z-modal)",
        toast: "var(--fg-z-toast)",
        tooltip: "var(--fg-z-tooltip)",
      },
    },
  },
  plugins: [],
} satisfies Config;
