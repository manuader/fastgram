import { type ComponentPropsWithRef, type ReactNode } from "react";
import { cn } from "../../cn.js";
import {
  emptyStatePresets,
  resolveStatePreset,
  type EmptyStatePresetId,
} from "../../i18n/presets.js";
import { type MessageVars } from "../../i18n/t.js";
import { emptyStateVariants, type EmptyStateVariants } from "./empty-state.variants.js";

export interface EmptyStateProps
  extends Omit<ComponentPropsWithRef<"div">, "title">, EmptyStateVariants {
  /**
   * Estado vacío del PRD §19.1 por su ID (`ERR-E04`). Resuelve título y
   * descripción desde el catálogo de copy. Pasar `title` lo sobrescribe.
   *
   * Hay que dar `preset` o `title`: sin ninguno de los dos no se renderiza
   * encabezado, que es justo lo que un estado vacío no puede permitirse.
   */
  preset?: EmptyStatePresetId;
  /** Valores para los huecos del copy del preset (`{handle}`, `{count}`). */
  vars?: MessageVars;
  title?: ReactNode;
  description?: ReactNode;
  /** Icono decorativo grande. */
  icon?: ReactNode;
  /** Acción principal. Normalmente un `<Button>`; el texto sale de `actionLabel`. */
  action?: ReactNode;
  secondaryAction?: ReactNode;
}

/**
 * Estado vacío (PRD §19.1).
 *
 * Un estado vacío sin salida es una pantalla muerta: casi todos los del PRD
 * traen qué puede hacer el usuario, y por eso `action` está en la API de
 * entrada y no como añadido posterior.
 *
 * El componente no sabe de negocio: recibe copy o el ID de un preset, y el
 * preset es sólo un mapa a claves del catálogo.
 */
export function EmptyState({
  preset,
  vars,
  title,
  description,
  icon,
  action,
  secondaryAction,
  size,
  bordered,
  className,
  children,
  ...props
}: EmptyStateProps) {
  const resolved =
    preset === undefined
      ? undefined
      : resolveStatePreset(emptyStatePresets[preset], vars);
  const finalTitle = title ?? resolved?.title;
  const finalDescription = description ?? resolved?.description;

  return (
    <div {...props} className={cn(emptyStateVariants({ size, bordered }), className)}>
      {icon !== undefined && (
        <div className="fg-state__icon" aria-hidden="true">
          {icon}
        </div>
      )}
      {finalTitle !== undefined && <p className="fg-state__title">{finalTitle}</p>}
      {finalDescription !== undefined && (
        <p className="fg-state__description">{finalDescription}</p>
      )}
      {children}
      {(action !== undefined || secondaryAction !== undefined) && (
        <div className="fg-state__actions">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
