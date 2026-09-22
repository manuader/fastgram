"use client";

import { type ComponentPropsWithRef, type ReactNode } from "react";
import { cn } from "../../cn";
import { Spinner } from "../spinner/Spinner";
import { buttonVariants, type ButtonVariants } from "./button.variants";

export interface ButtonProps
  extends Omit<ComponentPropsWithRef<"button">, "color">, ButtonVariants {
  /**
   * Muestra un spinner y deshabilita el botón. El label **no se reemplaza**:
   * un botón que cambia de ancho al pulsarlo mueve el resto de la fila.
   */
  loading?: boolean;
  /** Icono antes del label. Decorativo: se marca `aria-hidden`. */
  leadingIcon?: ReactNode;
  /** Icono después del label. Decorativo: se marca `aria-hidden`. */
  trailingIcon?: ReactNode;
}

/**
 * Botón del sistema.
 *
 * `type` es `"button"` por defecto a propósito: el default del HTML es
 * `"submit"`, y un botón secundario dentro de un form que envía sin querer es
 * de los bugs más caros de encontrar.
 *
 * Con `size="icon"` el botón no tiene texto: hay que pasarle `aria-label`.
 */
export function Button({
  variant,
  size,
  fullWidth,
  loading = false,
  leadingIcon,
  trailingIcon,
  disabled,
  className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={cn(buttonVariants({ variant, size, fullWidth }), className)}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
    >
      {loading ? (
        <Spinner size="sm" className="fg-btn__icon" aria-hidden />
      ) : leadingIcon !== undefined ? (
        <span className="fg-btn__icon" aria-hidden="true">
          {leadingIcon}
        </span>
      ) : null}
      {children !== undefined && <span className="fg-btn__label">{children}</span>}
      {trailingIcon !== undefined && (
        <span className="fg-btn__icon" aria-hidden="true">
          {trailingIcon}
        </span>
      )}
    </button>
  );
}
