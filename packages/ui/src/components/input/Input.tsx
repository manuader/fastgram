import { type ComponentPropsWithRef, type ReactNode } from "react";
import { cn } from "../../cn.js";
import { inputVariants, type InputVariants } from "./input.variants.js";

export interface InputProps
  extends Omit<ComponentPropsWithRef<"input">, "size">,
    Omit<InputVariants, "hasLeadingIcon"> {
  /**
   * Marca el campo como inválido: pinta el borde **y** pone `aria-invalid`.
   * El color solo no comunica nada a quien no lo ve; el atributo sí.
   * El mensaje de error va aparte, enlazado con `aria-describedby`.
   */
  invalid?: boolean;
  /** Icono decorativo dentro del campo (lupa de búsqueda, por ejemplo). */
  leadingIcon?: ReactNode;
  /** Clase del envoltorio, que es quien posiciona el icono. */
  wrapperClassName?: string;
}

/** Campo de texto de una línea. */
export function Input({
  inputSize,
  invalid,
  leadingIcon,
  wrapperClassName,
  className,
  ...props
}: InputProps) {
  const field = (
    <input
      {...props}
      className={cn(
        inputVariants({
          inputSize,
          invalid,
          hasLeadingIcon: leadingIcon !== undefined,
        }),
        className,
      )}
      aria-invalid={invalid === true ? true : props["aria-invalid"]}
    />
  );

  if (leadingIcon === undefined) return field;

  return (
    <span className={cn("fg-input-wrap", wrapperClassName)}>
      <span className="fg-input-wrap__icon" aria-hidden="true">
        {leadingIcon}
      </span>
      {field}
    </span>
  );
}
