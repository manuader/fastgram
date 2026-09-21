import { type ComponentPropsWithRef } from "react";
import { cn } from "../../cn.js";
import { t } from "../../i18n/t.js";
import { spinnerVariants, type SpinnerVariants } from "./spinner.variants.js";

export interface SpinnerProps
  extends Omit<ComponentPropsWithRef<"span">, "children">,
    SpinnerVariants {
  /**
   * Qué anuncia el lector de pantalla. Por defecto `Loading...` (PRD ERR-L02).
   * Si el spinner acompaña a un texto que ya dice qué pasa —`Generating your
   * content...`— pasá `aria-hidden` para no anunciarlo dos veces.
   */
  label?: string;
}

/**
 * Indicador de progreso indeterminado.
 *
 * Con `aria-hidden` es puramente decorativo; si no, se anuncia como `role="status"`
 * (live region educada: no interrumpe lo que el usuario esté leyendo).
 */
export function Spinner({ size, tone, label, className, ...props }: SpinnerProps) {
  const hidden = props["aria-hidden"];
  const decorative = hidden === true || hidden === "true";
  return (
    <span
      {...props}
      className={cn(spinnerVariants({ size, tone }), className)}
      role={decorative ? undefined : "status"}
    >
      <svg
        className="fg-spinner__track"
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
      >
        <circle className="fg-spinner__rail" cx="12" cy="12" r="9" />
        <circle className="fg-spinner__arc" cx="12" cy="12" r="9" />
      </svg>
      {!decorative && (
        <span className="fg-visually-hidden">{label ?? t("common.loading")}</span>
      )}
    </span>
  );
}
