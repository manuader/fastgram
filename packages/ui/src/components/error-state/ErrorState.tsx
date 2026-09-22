import { AlertTriangle } from "lucide-react";
import { type ComponentPropsWithRef, type ReactNode } from "react";
import { cn } from "../../cn";
import {
  errorStatePresets,
  resolveStatePreset,
  type ErrorStatePresetId,
} from "../../i18n/presets";
import { t, type MessageVars } from "../../i18n/t";
import { Button } from "../button/Button";
import { errorStateVariants, type ErrorStateVariants } from "./error-state.variants";

export interface ErrorStateProps
  extends Omit<ComponentPropsWithRef<"div">, "title">, ErrorStateVariants {
  /**
   * Error del PRD §19.3/§19.4/§19.8 por su ID (`ERR-U02`) o por su nombre
   * (`generic`). Por defecto `generic`: `Something went wrong` + `Try again`.
   */
  preset?: ErrorStatePresetId;
  vars?: MessageVars;
  title?: ReactNode;
  description?: ReactNode;
  /** Icono. Por defecto un triángulo de aviso; `null` lo quita. */
  icon?: ReactNode | null;
  /** Si se pasa, se renderiza el botón de reintento con el copy del preset. */
  onRetry?: () => void;
  /** Acción a medida, en lugar de `onRetry`. */
  action?: ReactNode;
}

/**
 * Estado de error de una pantalla o de un panel (PRD §19.3–§19.8).
 *
 * `role="alert"` por defecto: cuando un error reemplaza a un contenido que se
 * estaba cargando, alguien que no ve la pantalla tiene que enterarse sin
 * volver a recorrerla. Se puede bajar a `role="status"` —o quitar— pasando
 * `role` si el error es secundario.
 */
export function ErrorState({
  preset = "generic",
  vars,
  title,
  description,
  icon,
  onRetry,
  action,
  size,
  tone,
  bordered,
  className,
  children,
  role = "alert",
  ...props
}: ErrorStateProps) {
  const resolved = resolveStatePreset(errorStatePresets[preset], vars);
  const finalTitle = title ?? resolved.title;
  const finalDescription = description ?? resolved.description;
  const retryLabel = resolved.actionLabel ?? t("common.tryAgain");

  return (
    <div
      {...props}
      role={role}
      className={cn(errorStateVariants({ size, tone, bordered }), className)}
    >
      {icon !== null && (
        <div className="fg-state__icon" aria-hidden="true">
          {icon ?? <AlertTriangle />}
        </div>
      )}
      <p className="fg-state__title">{finalTitle}</p>
      {finalDescription !== undefined && (
        <p className="fg-state__description">{finalDescription}</p>
      )}
      {children}
      {(action !== undefined || onRetry !== undefined) && (
        <div className="fg-state__actions">
          {action ?? (
            <Button variant="secondary" onClick={onRetry}>
              {retryLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
