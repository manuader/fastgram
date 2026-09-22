"use client";

import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "../../cn";
import { tooltipVariants, type TooltipVariants } from "./tooltip.variants";

export interface TooltipProps extends TooltipVariants {
  /** Texto del tooltip. Corto: no es un sitio para explicar nada largo. */
  content: ReactNode;
  /** Milisegundos antes de aparecer al pasar el mouse. El teclado no espera. */
  delay?: number;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Tooltip sobre un elemento enfocable.
 *
 * Lo pide `FR-001`: con el sidebar colapsado, el hover tiene que mostrar el
 * label de cada entrada. Aparece también **con el foco del teclado**, no sólo
 * con el mouse, y se cierra con Escape; si no, quien navega con teclado nunca
 * llega a ver el nombre de los iconos.
 *
 * Dos límites, sin librería de posicionamiento (no hay floating-ui instalado):
 * el lado es fijo —no se da vuelta solo al chocar con el borde de la ventana—
 * y el tooltip se recorta si el contenedor tiene `overflow: hidden`.
 *
 * Nunca es el único sitio donde vive una información: un tooltip no existe en
 * pantallas táctiles.
 */
export function Tooltip({
  content,
  side,
  delay = 300,
  disabled = false,
  className,
  children,
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancel(): void {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }

  function show(immediate: boolean): void {
    if (disabled) return;
    cancel();
    if (immediate || delay <= 0) {
      setOpen(true);
      return;
    }
    timer.current = setTimeout(() => {
      setOpen(true);
    }, delay);
  }

  function hide(): void {
    cancel();
    setOpen(false);
  }

  useEffect(() => cancel, []);

  const describedBy = open ? id : undefined;
  const trigger: ReactNode = isValidElement(children)
    ? cloneElement(
        children as ReactElement<{ "aria-describedby"?: string | undefined }>,
        {
          "aria-describedby": describedBy,
        },
      )
    : children;

  return (
    <span
      className={cn("fg-tooltip", className)}
      onMouseEnter={() => {
        show(false);
      }}
      onMouseLeave={hide}
      // El foco por teclado no espera al delay: ya fue una acción deliberada.
      onFocus={() => {
        show(true);
      }}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === "Escape") hide();
      }}
    >
      {trigger}
      {open && (
        <span role="tooltip" id={id} className={tooltipVariants({ side })}>
          {content}
        </span>
      )}
    </span>
  );
}
