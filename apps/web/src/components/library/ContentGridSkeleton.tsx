import { Skeleton } from "@fastgram/ui";

export interface ContentGridSkeletonProps {
  /** Cuántas tarjetas fantasma. Por defecto, una página del contrato. */
  readonly count?: number;
}

/**
 * El estado `loading` de la grid (PRD §19.2).
 *
 * Un skeleton y no un spinner, y no por estética: la grid tiene una forma fija
 * —tarjetas 9:16 en filas— y dibujarla antes de tener los datos hace que el
 * contenido **no salte** cuando llegan. Un spinner centrado obliga a un
 * reflow completo y a que el ojo vuelva a buscar dónde empezaba la lista.
 *
 * `Skeleton` ya se marca `aria-hidden`; quien anuncia el estado es el
 * `aria-busy` del contenedor, que pone la pantalla.
 */
export function ContentGridSkeleton({ count = 8 }: ContentGridSkeletonProps) {
  return (
    <ul className="fgw-content-grid">
      {Array.from({ length: count }, (_, index) => (
        <li key={index} className="fgw-content-card">
          <div className="fgw-content-card__link">
            <Skeleton className="fgw-content-card__thumb" />
            <div className="fgw-content-card__foot">
              <Skeleton shape="text" width="40%" />
              <Skeleton shape="text" width="30%" />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
