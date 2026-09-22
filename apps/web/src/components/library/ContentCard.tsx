"use client";

import { Badge, Spinner } from "@fastgram/ui";
import Link from "next/link";
import { ROUTES } from "@/lib/nav/routes";
import { tw } from "@/lib/i18n/t";
import { CONTENT_TYPE_COPY, type LibraryContent } from "@/lib/library/content";

export interface ContentCardProps {
  readonly item: LibraryContent;
}

/**
 * Una pieza de `My Content` (PRD:1611-1613): thumbnail y badge de tipo. **Sin
 * métricas ni cuenta** — eso es el pie de `My Posts`, y el PRD las separa en
 * dos tabs justamente porque no son lo mismo.
 *
 * ## Lo que falta, y por qué no se inventa
 *
 * El PRD pone `Created: DD/MM/YY` en esta tarjeta y **`contentSchema` no
 * publica ninguna fecha** (DATA-008). La columna existe (`contents.created_at`)
 * y el cursor de paginación la usa, pero el serializer no la emite. Poner la
 * fecha de hoy, o la de `deletedAt`, sería un número que parece un dato. Así
 * que la tarjeta no la muestra y la pantalla lo dice una vez, arriba.
 *
 * Una pieza en `BUILDING` no tiene thumbnail —tampoco es un fallo: todavía no
 * existe el archivo— y por eso el hueco lleva un spinner en vez de una imagen
 * rota.
 */
export function ContentCard({ item }: ContentCardProps) {
  const isBuilding = item.status === "BUILDING";
  const isFailed = item.status === "FAILED";

  return (
    <li className="fgw-content-card">
      <Link
        href={`${ROUTES.library}/${item._id}`}
        className="fgw-content-card__link fg-focusable"
      >
        <span className="fgw-content-card__thumb" data-status={item.status}>
          {item.thumbnailUrl === undefined ? (
            <span className="fgw-content-card__placeholder">
              {isBuilding ? <Spinner size="sm" aria-hidden /> : null}
            </span>
          ) : (
            /* `next/image` exigiría declarar en `next.config.ts` los dominios
               desde los que se sirven los archivos, y esta tarea no sabe
               cuáles son (R2 está en revisión, ADR-006). Un `<img>` con
               `loading="lazy"` no inventa configuración. */
            <img
              className="fgw-content-card__image"
              src={item.thumbnailUrl}
              alt=""
              loading="lazy"
            />
          )}
        </span>
        <span className="fgw-content-card__foot">
          {isBuilding || isFailed ? (
            <span className="fgw-content-card__status" data-status={item.status}>
              {tw(isBuilding ? "library.building" : "library.failed")}
            </span>
          ) : (
            <span className="fgw-content-card__status" />
          )}
          <Badge
            tone={isFailed ? "danger" : isBuilding ? "warning" : "neutral"}
            size="sm"
          >
            {tw(CONTENT_TYPE_COPY[item.type])}
          </Badge>
        </span>
      </Link>
    </li>
  );
}
