"use client";

import { useDraggable } from "@dnd-kit/core";
import type { CalendarItem, PostStatus } from "@fastgram/contracts";
import { createContext, useContext, type CSSProperties, type KeyboardEvent } from "react";
import { dragIdOf, NETWORK_CHIP_COLOR, NETWORK_LABEL } from "@/lib/calendar/board";
import { formatChipTime } from "@/lib/calendar/calendar";
import { tw } from "@/lib/i18n/t";
import { CONTENT_TYPE_COPY } from "@/lib/library/content";
import { POST_STATUS_COPY, POST_STATUS_TONE } from "@/lib/library/posts";

export interface CalendarChipProps {
  readonly item: CalendarItem;
  readonly timeZone: string;
  /** "All brands": el chip dice de qué marca es. */
  readonly showBrand: boolean;
  /** Vista semana: más alto, con miniatura. */
  readonly roomy: boolean;
}

function statusCopy(status: CalendarItem["status"]): string {
  return status === "PLANNED"
    ? tw("calendar.chip.planned")
    : tw(POST_STATUS_COPY[status as PostStatus]);
}

function statusTone(status: CalendarItem["status"]): string {
  return status === "PLANNED" ? "neutral" : POST_STATUS_TONE[status as PostStatus];
}

/**
 * Abrir un post del calendario (sprint 7): `CalendarView` provee quién abre el
 * diálogo de editar/reintentar. Sin proveedor el chip no es clickeable.
 */
export const CalendarOpenContext = createContext<((item: CalendarItem) => void) | null>(
  null,
);

/**
 * La tecla que abre un post desde el teclado — `P5-A11Y-001`.
 *
 * Enter y Espacio **ya son de dnd-kit** en un chip movible: arrancan el
 * arrastre con teclado (y soltarlo con otra Enter). Robarle una rompe mover
 * sin mouse, que es justo la alternativa que exige WCAG 2.5.7. Así que abrir
 * va por una tecla propia, `E` ("edit"), anunciada con `aria-keyshortcuts` y
 * en el texto de ayuda de la pantalla. En un chip **no** movible (ya salió o
 * falló) Enter y Espacio están libres, y también abren.
 */
export const OPEN_POST_KEY = "e";

function isOpenKey(event: KeyboardEvent, movable: boolean): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  if (event.key.toLowerCase() === OPEN_POST_KEY) return true;
  return !movable && (event.key === "Enter" || event.key === " ");
}

/**
 * Un post o un slot planificado · F-141 (PRD:1659) + `PU-CAL-002`.
 *
 * Color por red (el borde y el tinte), punto de estado, `Red: Tipo`, hora, y
 * en la vista semana la miniatura. Un slot planificado lleva el borde punteado
 * y la etiqueta `Planned`: todavía no es un post, le falta la cuenta.
 *
 * Arrastrable sólo si `item.movable` (lo que no salió). El resto es un `<li>`
 * quieto: un control que parece arrastrable y no se mueve es peor que ninguno.
 * dnd-kit pone el rol y el foco para arrastrar con teclado (espacio + flechas).
 */
export function CalendarChip({ item, timeZone, showBrand, roomy }: CalendarChipProps) {
  const openItem = useContext(CalendarOpenContext);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: dragIdOf(item),
    disabled: !item.movable,
  });

  const network = NETWORK_LABEL[item.network];
  const title =
    item.contentType === undefined
      ? network
      : tw("calendar.chip.withType", {
          platform: network,
          type: tw(CONTENT_TYPE_COPY[item.contentType]),
        });
  const time = formatChipTime(item.at, timeZone);
  const status = statusCopy(item.status);
  const planned = item.kind === "slot";

  const style: CSSProperties & Record<"--fgw-chip-color", string> = {
    "--fgw-chip-color": NETWORK_CHIP_COLOR[item.network],
    ...(planned ? { borderLeftStyle: "dashed" } : {}),
    ...(transform === null
      ? {}
      : {
          transform: `translate3d(${String(transform.x)}px, ${String(transform.y)}px, 0)`,
        }),
    ...(isDragging ? { opacity: 0.6, zIndex: 10, position: "relative" } : {}),
    ...(openItem !== null && item.kind === "post" ? { cursor: "pointer" } : {}),
  };

  const open =
    openItem !== null && item.kind === "post"
      ? () => {
          openItem(item);
        }
      : null;
  const dndKeyDown = item.movable ? listeners?.["onKeyDown"] : undefined;
  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>): void => {
    // Durante un arrastre con teclado la `E` no abre nada: el foco es del
    // arrastre hasta que se suelte o se cancele.
    if (open !== null && !isDragging && isOpenKey(event, item.movable)) {
      event.preventDefault();
      open();
      return;
    }
    (dndKeyDown as ((e: KeyboardEvent<HTMLLIElement>) => void) | undefined)?.(event);
  };

  const label = [
    showBrand ? item.brandName : null,
    tw("calendar.chip.label", { title, time, status }),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <li
      ref={setNodeRef}
      className="fgw-cal-chip"
      data-network={item.network}
      data-kind={item.kind}
      data-status={item.status}
      data-movable={item.movable ? "true" : "false"}
      title={planned ? tw("calendar.chip.plannedHint", { network }) : label}
      style={style}
      {...(item.movable ? { ...attributes, ...listeners } : {})}
      // Un chip que ya salió no es arrastrable, pero sí se abre: sin esto era
      // un `<li>` con `onClick` al que el teclado no llegaba.
      {...(open !== null && !item.movable ? { role: "button", tabIndex: 0 } : {})}
      aria-label={label}
      {...(open !== null
        ? {
            onClick: open,
            onKeyDown,
            "aria-keyshortcuts": item.movable ? "E" : "Enter Space E",
          }
        : {})}
    >
      {roomy && item.thumbnailUrl !== undefined && (
        // Miniatura chica y decorativa: el texto del chip ya dice qué es. `<img>` y
        // no `next/image`, por lo mismo que `CardFace`: los hosts de la media no
        // están declarados en `next.config.ts`.
        <img
          src={item.thumbnailUrl}
          alt=""
          className="h-8 w-6 flex-none rounded-sm object-cover"
          loading="lazy"
        />
      )}
      <span
        aria-hidden="true"
        className="fgw-cal-chip__dot"
        data-tone={statusTone(item.status)}
      />
      <span className="fgw-cal-chip__title">
        {showBrand && <span className="font-semibold">{item.brandName} · </span>}
        {title}
        {planned && (
          <span className="ml-1 text-text-muted">({tw("calendar.chip.planned")})</span>
        )}
      </span>
      <span className="fgw-cal-chip__time">{time}</span>
    </li>
  );
}
