"use client";

import { Check, Minus } from "lucide-react";
import { useCallback, type ComponentPropsWithRef, type ReactNode } from "react";
import { cn } from "../../cn.js";

export interface CheckboxProps extends Omit<
  ComponentPropsWithRef<"input">,
  "type" | "size"
> {
  /** Texto junto a la caja. Va dentro del `<label>`, así que aumenta el área de click. */
  label?: ReactNode;
  /** Segunda línea, más apagada. Se enlaza con `aria-describedby` si hay `id`. */
  description?: ReactNode;
  /**
   * Estado mixto (una selección parcial en la grid de Library, `F-122`).
   * No existe como atributo HTML: hay que ponerlo por DOM, y por eso este
   * componente necesita una ref propia.
   */
  indeterminate?: boolean;
  wrapperClassName?: string;
}

/**
 * Casilla de verificación.
 *
 * Por dentro es un `<input type="checkbox">` real con `appearance: none`: el
 * cuadrito que se ve es un hermano decorativo. Así el teclado, el estado
 * `:checked`, los formularios y los lectores de pantalla siguen funcionando
 * gratis, en vez de reimplementarlos sobre un `<div role="checkbox">`.
 */
export function Checkbox({
  label,
  description,
  indeterminate = false,
  className,
  wrapperClassName,
  id,
  ref,
  ...props
}: CheckboxProps) {
  const describedBy =
    description !== undefined && id !== undefined ? `${id}-description` : undefined;

  const setNode = useCallback(
    (node: HTMLInputElement | null) => {
      if (node !== null) node.indeterminate = indeterminate;
      if (typeof ref === "function") {
        ref(node);
        return;
      }
      if (ref !== null && ref !== undefined) ref.current = node;
    },
    [indeterminate, ref],
  );

  return (
    <label className={cn("fg-checkbox", wrapperClassName)}>
      <input
        {...props}
        id={id}
        ref={setNode}
        type="checkbox"
        className={cn("fg-checkbox__input", className)}
        aria-describedby={describedBy ?? props["aria-describedby"]}
      />
      <span className="fg-checkbox__box" aria-hidden="true">
        {indeterminate ? (
          <Minus className="fg-checkbox__mark" />
        ) : (
          <Check className="fg-checkbox__mark" />
        )}
      </span>
      {(label !== undefined || description !== undefined) && (
        <span className="fg-checkbox__text">
          {label !== undefined && <span className="fg-checkbox__label">{label}</span>}
          {description !== undefined && (
            <span className="fg-checkbox__description" id={describedBy}>
              {description}
            </span>
          )}
        </span>
      )}
    </label>
  );
}
