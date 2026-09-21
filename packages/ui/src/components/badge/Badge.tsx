import { type ComponentPropsWithRef, type ReactNode } from "react";
import { cn } from "../../cn.js";
import { badgeVariants, type BadgeVariants } from "./badge.variants.js";

export interface BadgeProps extends ComponentPropsWithRef<"span">, BadgeVariants {
  /** Punto de color antes del texto (estados: posted, scheduled, failed…). */
  dot?: boolean;
  /** Icono antes del texto. Decorativo. */
  icon?: ReactNode;
}

/**
 * Chip de estado o de categoría.
 *
 * El color nunca es la única señal: siempre lleva texto. Un badge rojo sin
 * palabra no le dice nada a quien no distingue rojo de verde.
 */
export function Badge({ tone, size, dot, icon, className, children, ...props }: BadgeProps) {
  return (
    <span {...props} className={cn(badgeVariants({ tone, size }), className)}>
      {dot === true && <span className="fg-badge__dot" aria-hidden="true" />}
      {icon !== undefined && (
        <span className="fg-badge__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </span>
  );
}
