import { ChevronDown } from "lucide-react";
import { type ComponentPropsWithRef, type ReactNode } from "react";
import { cn } from "../../cn.js";
import { selectVariants, type SelectVariants } from "./select.variants.js";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps
  extends Omit<ComponentPropsWithRef<"select">, "size" | "children">, SelectVariants {
  /** Opciones. Alternativa a pasar `<option>` por `children`. */
  options?: readonly SelectOption[];
  /**
   * Opción inicial vacía y deshabilitada. Es el patrón que obliga a elegir:
   * si fuera seleccionable, un formulario podría enviarse con el placeholder.
   */
  placeholder?: string;
  invalid?: boolean;
  children?: ReactNode;
  wrapperClassName?: string;
}

/**
 * Selector desplegable.
 *
 * Es un `<select>` nativo, no un listbox a medida. Sin Radix instalado, un
 * listbox propio significa reimplementar teclado, tipeo-para-buscar, scroll y
 * comportamiento táctil — y en móvil el nativo abre la rueda del sistema, que
 * es mejor que cualquier cosa que dibujemos. La contrapartida está anotada en
 * el reporte: no se pueden pintar opciones con iconos o avatares.
 */
export function Select({
  selectSize,
  invalid,
  options,
  placeholder,
  className,
  wrapperClassName,
  children,
  ...props
}: SelectProps) {
  return (
    <span className={cn("fg-select", wrapperClassName)}>
      <select
        {...props}
        className={cn(selectVariants({ selectSize, invalid }), className)}
        aria-invalid={invalid === true ? true : props["aria-invalid"]}
      >
        {placeholder !== undefined && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options?.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown className="fg-select__chevron" aria-hidden="true" />
    </span>
  );
}
