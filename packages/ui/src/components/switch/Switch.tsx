"use client";

import { useState, type ComponentPropsWithRef } from "react";
import { cn } from "../../cn.js";
import { switchVariants, type SwitchVariants } from "./switch.variants.js";

export interface SwitchProps
  extends Omit<ComponentPropsWithRef<"button">, "onChange" | "type" | "value">,
    SwitchVariants {
  /** Estado controlado. Si se pasa, el componente no guarda estado propio. */
  checked?: boolean;
  /** Estado inicial en modo no controlado. */
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

/**
 * Interruptor de encendido/apagado (`Auto-Add Music`, `Mention business`…).
 *
 * Es un `<button role="switch">`: el botón ya trae activación con Enter y con
 * Espacio, foco y estado deshabilitado. `aria-checked` es lo que convierte el
 * dibujo en información para un lector de pantalla — sin él, esto es un botón
 * cualquiera que no dice si está encendido.
 *
 * Un switch aplica el cambio **al instante**. Si hace falta confirmar, es una
 * casilla dentro de un formulario, no un switch.
 */
export function Switch({
  switchSize,
  checked,
  defaultChecked = false,
  onCheckedChange,
  disabled,
  className,
  onClick,
  ...props
}: SwitchProps) {
  const [internal, setInternal] = useState(defaultChecked);
  const isControlled = checked !== undefined;
  const isOn = isControlled ? checked : internal;

  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={isOn}
      disabled={disabled}
      className={cn(switchVariants({ switchSize }), className)}
      data-state={isOn ? "checked" : "unchecked"}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (!isControlled) setInternal(!isOn);
        onCheckedChange?.(!isOn);
      }}
    >
      <span className="fg-switch__thumb" aria-hidden="true" />
    </button>
  );
}
