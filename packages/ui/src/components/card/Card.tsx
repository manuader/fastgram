import { type ComponentPropsWithRef } from "react";
import { cn } from "../../cn";
import { cardVariants, type CardVariants } from "./card.variants";

export interface CardProps extends ComponentPropsWithRef<"div">, CardVariants {}

/**
 * Contenedor de superficie.
 *
 * `interactive` sólo aporta el estilo de hover/foco. Si la tarjeta entera va a
 * ser clicable, **el elemento clicable tiene que ser un botón o un enlace de
 * verdad**: un `<div onClick>` no se enfoca, no se activa con Enter y no lo
 * anuncia ningún lector de pantalla.
 */
export function Card({ tone, padding, interactive, className, ...props }: CardProps) {
  return (
    <div
      {...props}
      className={cn(cardVariants({ tone, padding, interactive }), className)}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div {...props} className={cn("fg-card__header", className)} />;
}

export interface CardTitleProps extends ComponentPropsWithRef<"h3"> {
  /**
   * Nivel de encabezado. El default `h3` asume una tarjeta dentro de una
   * sección con su propio `h2`; ajustalo si la jerarquía real es otra, porque
   * los saltos de nivel rompen la navegación por encabezados.
   */
  as?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
}

export function CardTitle({ as: Tag = "h3", className, ...props }: CardTitleProps) {
  return <Tag {...props} className={cn("fg-card__title", className)} />;
}

export function CardDescription({ className, ...props }: ComponentPropsWithRef<"p">) {
  return <p {...props} className={cn("fg-card__description", className)} />;
}

export function CardContent({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div {...props} className={cn("fg-card__content", className)} />;
}

export function CardFooter({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div {...props} className={cn("fg-card__footer", className)} />;
}
