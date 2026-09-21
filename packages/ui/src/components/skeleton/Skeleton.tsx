import { type ComponentPropsWithRef, type CSSProperties } from "react";
import { cn } from "../../cn.js";
import { skeletonVariants, type SkeletonVariants } from "./skeleton.variants.js";

export interface SkeletonProps
  extends Omit<ComponentPropsWithRef<"div">, "children">,
    SkeletonVariants {
  /** Ancho CSS. Un número se interpreta en píxeles. */
  width?: number | string;
  /** Alto CSS. Un número se interpreta en píxeles. */
  height?: number | string;
}

/**
 * Placeholder de carga.
 *
 * Siempre `aria-hidden`: para un lector de pantalla no hay nada que leer. Quien
 * lo use debe marcar el contenedor con `aria-busy="true"` mientras carga; eso es
 * lo que anuncia el estado, no la forma gris.
 */
export function Skeleton({
  shape,
  width,
  height,
  className,
  style,
  ...props
}: SkeletonProps) {
  const sizing: CSSProperties = { ...style };
  if (width !== undefined) sizing.width = width;
  if (height !== undefined) sizing.height = height;
  return (
    <div
      {...props}
      aria-hidden="true"
      className={cn(skeletonVariants({ shape }), className)}
      style={sizing}
    />
  );
}

export interface SkeletonTextProps extends Omit<SkeletonProps, "shape"> {
  /** Cuántas líneas dibujar. La última sale más corta, como un párrafo real. */
  lines?: number;
}

/** Varias líneas de texto simuladas. */
export function SkeletonText({ lines = 3, className, ...props }: SkeletonTextProps) {
  const count = Math.max(1, Math.trunc(lines));
  return (
    <div className={cn("fg-skeleton-text", className)} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton
          {...props}
          key={index}
          shape="text"
          width={index === count - 1 && count > 1 ? "60%" : undefined}
        />
      ))}
    </div>
  );
}
