import type { CalendarItem } from "@fastgram/contracts";
import { NETWORK_CHIP_COLOR } from "@/lib/calendar/board";
import { isVideoUrl } from "@/lib/today/today";

/**
 * La miniatura de una pieza, decorativa (el texto del ítem ya dice qué es).
 * `<img>`/`<video>` y no `next/image`: los hosts de la media no están en
 * `next.config.ts` (mismo motivo que `CalendarChip`). Sin archivos todavía, un
 * bloque con el color de la red.
 */
export function ItemThumb({ item }: { item: CalendarItem }) {
  const url = item.thumbnailUrl;
  const base = "h-12 w-9 flex-none overflow-hidden rounded-md bg-surface-sunken";
  if (url === undefined) {
    return (
      <span
        aria-hidden="true"
        className={base}
        style={{
          background: `color-mix(in srgb, ${NETWORK_CHIP_COLOR[item.network]} 18%, var(--fg-color-surface-sunken))`,
        }}
      />
    );
  }
  if (isVideoUrl(url)) {
    return (
      <video
        aria-hidden="true"
        className={`${base} object-cover`}
        src={url}
        muted
        playsInline
        preload="metadata"
      />
    );
  }
  return <img src={url} alt="" loading="lazy" className={`${base} object-cover`} />;
}
