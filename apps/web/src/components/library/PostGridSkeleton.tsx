import { Skeleton } from "@fastgram/ui";

export interface PostGridSkeletonProps {
  /** Cuántas tarjetas fantasma. Por defecto, una página del contrato. */
  readonly count?: number;
}

/**
 * El estado `loading` de la grid de `My Posts` (PRD §19.2).
 *
 * La clase es **distinta** a la de una tarjeta real (`fgw-post-skeleton` contra
 * `fgw-post-card`), como en el Media Bank y por el mismo motivo: así cualquier
 * comprobación de "¿hay datos en pantalla?" no tiene que inventarse otra señal
 * para no confundir la forma gris con el dato.
 */
export function PostGridSkeleton({ count = 8 }: PostGridSkeletonProps) {
  return (
    // La lista entera es decorativa: quien anuncia la carga es el `aria-busy`
    // del contenedor, no ocho listitems sin nombre.
    <ul className="fgw-post-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <li key={index} className="fgw-post-skeleton">
          <Skeleton shape="text" width="55%" />
          <Skeleton shape="text" width="80%" />
          <Skeleton shape="text" width="70%" />
        </li>
      ))}
    </ul>
  );
}
