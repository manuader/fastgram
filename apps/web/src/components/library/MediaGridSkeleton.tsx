import { Skeleton } from "@fastgram/ui";

export interface MediaGridSkeletonProps {
  /** Cuántas tarjetas fantasma. Por defecto, una página del contrato. */
  readonly count?: number;
}

/**
 * El estado `loading` de la grid del Media Bank (PRD §19.2).
 *
 * La clase es **distinta** a la de una tarjeta real (`fgw-media-skeleton`
 * contra `fgw-media-card`) a propósito. La grid de `My Content` reutiliza la
 * misma clase para las dos cosas, y eso obliga a que cualquier comprobación de
 * "¿hay datos en pantalla?" tenga que mirar otra señal. Acá la forma gris y el
 * dato no se confunden ni en el DOM.
 */
export function MediaGridSkeleton({ count = 8 }: MediaGridSkeletonProps) {
  return (
    // La lista entera es decorativa: quien anuncia la carga es el `aria-busy`
    // del contenedor, no ocho listitems sin nombre. Sin esto, un lector de
    // pantalla lee "lista, 8 elementos" y ninguno dice nada.
    <ul className="fgw-media-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <li key={index} className="fgw-media-skeleton">
          <Skeleton className="fgw-media-card__thumb" />
          <Skeleton shape="text" width="70%" />
          <Skeleton shape="text" width="45%" />
        </li>
      ))}
    </ul>
  );
}
