"use client";

/**
 * Los datos de `Library → My Media Bank` · FR-100 (PRD:1618-1626), §12.
 *
 * `GET /media`, paginado por cursor, con filtros por `type` y —desde el
 * sprint 7 (`P2-MEDIA-007`, migración `0029`)— búsqueda `q` (nombre o
 * etiqueta), `category` y `tag`. El filtro por influencer sigue sin
 * parámetro: `DATA-010` no relaciona un asset con un personaje.
 *
 * ## Polling mientras haya un video en `processing`
 *
 * Un video se crea en `processing` y el worker lo normaliza en background
 * (`apps/worker/src/media/normalization-handler.ts`) hasta `ready` o `failed`
 * (FR-100). Mientras quede alguno así en pantalla se pregunta cada 10 s, con
 * la misma palanca que la Library (`lib/library/content.ts`, ADR-014): un
 * `refetchInterval` en forma de función que se apaga solo en cuanto no queda
 * nada procesándose.
 *
 * Hasta `PU-MEDIA-001` esto **no** se hacía, y con razón: no existía el
 * handler, y un intervalo contra un estado que nadie mueve es una petición cada
 * diez segundos para siempre. Si el worker no está corriendo, eso vuelve a
 * pasar — el costo es acotado (una petición cada 10 s, sólo con la pestaña
 * visible: ver `pollIntervalFor` en `content.ts`).
 */
import {
  mediaSchema,
  mediaTypeSchema,
  PAGINATION_LIMIT_DEFAULT,
  type Media,
  type MediaCategory,
  type MediaStatus,
  type MediaType,
} from "@fastgram/contracts";
import type { UseInfiniteQueryResult } from "@tanstack/react-query";
import type { CopyKey } from "../i18n/t";
import type { CursorPage, QueryParams } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiInfiniteQuery, type CursorPages } from "../api/hooks";
import { queryKeys } from "../api/keys";

export const MEDIA_PATH = "/media";

export const MEDIA_TYPES: readonly MediaType[] = mediaTypeSchema.options;

export const MEDIA_TYPE_COPY: Readonly<Record<MediaType, CopyKey>> = {
  image: "media.type.image",
  video: "media.type.video",
};

/**
 * Categoría → badge. El `Record` completo y no un `switch`: el día que el
 * contrato añada una sexta categoría, esto deja de compilar y alguien decide
 * cómo se llama en pantalla, en vez de que salga el identificador crudo.
 */
export const MEDIA_CATEGORY_COPY: Readonly<Record<MediaCategory, CopyKey>> = {
  "slideshow-image": "media.category.slideshowImage",
  "green-screen-background": "media.category.greenScreenBackground",
  "background-video": "media.category.backgroundVideo",
  "hook-video": "media.category.hookVideo",
  "green-screen-video": "media.category.greenScreenVideo",
};

export const MEDIA_STATUS_COPY: Readonly<Record<MediaStatus, CopyKey>> = {
  processing: "media.status.processing",
  ready: "media.status.ready",
  failed: "media.status.failed",
};

export interface MediaFilters {
  /** `undefined` = sin filtrar. §12 (PRD:2722) sólo contrata `image|video`. */
  readonly type?: MediaType | undefined;
  /** `P2-MEDIA-007` (sprint 7): nombre de archivo o etiqueta. */
  readonly q?: string | undefined;
  readonly category?: MediaCategory | undefined;
  /** Etiqueta exacta (incluidas las automáticas de los clips). */
  readonly tag?: string | undefined;
}

/** Sólo las claves con valor: la clave de caché no cambia por un `undefined`. */
export function mediaQueryParams(filters: MediaFilters): QueryParams {
  const q = filters.q?.trim();
  return {
    ...(filters.type === undefined ? {} : { type: filters.type }),
    ...(q === undefined || q === "" ? {} : { q }),
    ...(filters.category === undefined ? {} : { category: filters.category }),
    ...(filters.tag === undefined ? {} : { tag: filters.tag }),
  };
}

export function flattenMediaPages(
  data: CursorPages<Media> | undefined,
): readonly Media[] {
  if (data === undefined) return [];
  return data.pages.flatMap((page: CursorPage<Media>) => page.items);
}

export interface UseMediaListOptions extends MediaFilters {
  readonly limit?: number;
}

/** La misma cadencia que un build de la Library (NFR-002, ADR-014). */
export const MEDIA_POLL_INTERVAL_MS = 10_000;

/** ¿Hay algo que el worker todavía tiene que normalizar? */
export function hasProcessingMedia(items: readonly { status: MediaStatus }[]): boolean {
  return items.some((item) => item.status === "processing");
}

export function mediaPollIntervalFor(
  items: readonly { status: MediaStatus }[],
): number | false {
  return hasProcessingMedia(items) ? MEDIA_POLL_INTERVAL_MS : false;
}

/**
 * `GET /media` paginado. `staleTime: 0` por lo mismo que `useContentList`:
 * mezclar una ventana de frescura con una cadencia de polling deja una duda
 * que sólo se resuelve leyendo la librería.
 */
export function useMediaList(
  options: UseMediaListOptions = {},
): UseInfiniteQueryResult<CursorPages<Media>, ApiRequestError> {
  const { limit = PAGINATION_LIMIT_DEFAULT, ...filters } = options;
  const query = mediaQueryParams(filters);
  return useApiInfiniteQuery<Media>({
    queryKey: queryKeys.media(query),
    path: MEDIA_PATH,
    query,
    itemSchema: mediaSchema,
    limit,
    staleTime: 0,
    refetchInterval: (q) => mediaPollIntervalFor(flattenMediaPages(q.state.data)),
  });
}

/**
 * `<size> MB` del pie de la tarjeta (PRD:1626).
 *
 * Un decimal: `sizeMb` viene del tamaño real del objeto dividido por 1 MB, o
 * sea con todos los decimales del archivo. `12.3 MB` es un dato; `12.3178 MB`
 * es ruido, y `12 MB` esconde que un asset de 400 KB pesa algo.
 */
export function formatSizeMb(sizeMb: number): string {
  return sizeMb.toFixed(1);
}

/** `0:05` — la duración que el PRD dibuja sobre la miniatura de un video. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes)}:${String(rest).padStart(2, "0")}`;
}

/**
 * La fecha del pie, en UTC.
 *
 * Fijar la zona es la misma decisión que ya tomó `error-presentation.ts` con el
 * `resetAt` de las cuotas, y por el mismo motivo: sin fijarla, `Intl` formatea
 * en la zona de la máquina y **dos personas del mismo workspace ven fechas
 * distintas para el mismo archivo**. El ticket de soporte que eso genera
 * empieza con "a mí me dice otra cosa".
 *
 * El PRD no dice en qué zona se muestra (`<size> MB · <fecha>`, sin más), así
 * que esto es una decisión de esta tarea y no una lectura del PRD.
 */
const uploadedFormat = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
  timeZone: "UTC",
});

export function formatUploadedAt(msEpoch: number): string {
  return uploadedFormat.format(new Date(msEpoch));
}
