"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ComponentPropsWithRef } from "react";
import { cn } from "../../cn.js";
import { t } from "../../i18n/t.js";
import {
  getPaginationRange,
  PAGINATION_ELLIPSIS,
  type PaginationItem,
} from "../../lib/pagination.js";
import { paginationVariants, type PaginationVariants } from "./pagination.variants.js";

export interface PaginationProps
  extends Omit<ComponentPropsWithRef<"nav">, "onChange">, PaginationVariants {
  /** Página actual, 1-indexada. */
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /** Páginas a cada lado de la actual en modo `numbers`. */
  siblings?: number;
  /** Páginas fijas en cada extremo en modo `numbers`. */
  boundaries?: number;
}

/**
 * Paginador.
 *
 * Es un `<nav>` con nombre accesible, y la página actual lleva
 * `aria-current="page"`: sin eso, un lector de pantalla oye una fila de
 * números sin saber en cuál está. En modo `status`, el `Page X of Y` es una
 * live region educada, así que al cambiar de página se anuncia el cambio sin
 * mover el foco.
 */
export function Pagination({
  page,
  totalPages,
  onPageChange,
  siblings,
  boundaries,
  size,
  display,
  className,
  ...props
}: PaginationProps) {
  const total = Math.max(0, Math.trunc(totalPages));
  const current = Math.min(Math.max(Math.trunc(page), 1), Math.max(total, 1));
  const isFirst = current <= 1;
  const isLast = current >= total;

  const items: PaginationItem[] =
    display === "numbers"
      ? getPaginationRange({
          current,
          total,
          ...(siblings === undefined ? {} : { siblings }),
          ...(boundaries === undefined ? {} : { boundaries }),
        })
      : [];

  return (
    <nav
      {...props}
      aria-label={props["aria-label"] ?? t("pagination.label")}
      className={cn(paginationVariants({ size, display }), className)}
    >
      <button
        type="button"
        className="fg-pagination__item fg-pagination__arrow"
        aria-label={t("pagination.previous")}
        disabled={isFirst}
        onClick={() => {
          onPageChange(current - 1);
        }}
      >
        <ChevronLeft aria-hidden="true" />
      </button>

      {display === "numbers" ? (
        <ol className="fg-pagination__list">
          {items.map((item, index) =>
            item === PAGINATION_ELLIPSIS ? (
              <li key={`gap-${index}`} className="fg-pagination__gap" aria-hidden="true">
                …
              </li>
            ) : (
              <li key={item}>
                <button
                  type="button"
                  className="fg-pagination__item"
                  aria-label={t("pagination.goToPage", { page: item })}
                  aria-current={item === current ? "page" : undefined}
                  onClick={() => {
                    onPageChange(item);
                  }}
                >
                  {item}
                </button>
              </li>
            ),
          )}
        </ol>
      ) : (
        <span className="fg-pagination__status-text" aria-live="polite">
          {t("pagination.pageXofY", { current, total })}
        </span>
      )}

      <button
        type="button"
        className="fg-pagination__item fg-pagination__arrow"
        aria-label={t("pagination.next")}
        disabled={isLast}
        onClick={() => {
          onPageChange(current + 1);
        }}
      >
        <ChevronRight aria-hidden="true" />
      </button>
    </nav>
  );
}
