import { type ComponentPropsWithRef } from "react";
import { cn } from "../../cn.js";
import { textareaVariants, type TextareaVariants } from "./textarea.variants.js";

export interface TextareaProps
  extends ComponentPropsWithRef<"textarea">, TextareaVariants {
  invalid?: boolean;
}

/**
 * Campo de texto multilínea (captions, descripciones, script de Talking Head).
 *
 * El contador de caracteres —IG 2200, TikTok 90/4000 (`F-153`)— **no vive acá**:
 * es regla de negocio. El componente sólo expone `maxLength` y `aria-describedby`
 * para que el contador lo renderice quien conoce el límite.
 */
export function Textarea({
  invalid,
  resize,
  className,
  rows = 4,
  ...props
}: TextareaProps) {
  return (
    <textarea
      {...props}
      rows={rows}
      className={cn(textareaVariants({ invalid, resize }), className)}
      aria-invalid={invalid === true ? true : props["aria-invalid"]}
    />
  );
}
