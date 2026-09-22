"use client";

/**
 * Los datos de `Library → My Media Bank` · FR-100 (PRD:1618-1626), §12.
 *
 * `GET /media`, paginado por cursor, con **un solo filtro: `type`**.
 * `listMediaQuerySchema` es `.strict()` y sólo extiende `cursorQuerySchema` con
 * `type`: los filtros de categoría, influencer y búsqueda que dibuja el PRD
 * existen en la UI original pero **no tienen parámetro en el contrato**, y el
 * propio contrato lo dice ("quedan fuera del contrato"). Mandar `category=…`
 * no filtraría: lo rechazaría el `.strict()` con un `400`. Así que acá no hay
 * más filtro que el tipo, y es una ausencia declarada, no un olvido.
 *
 * ## Sin polling, a propósito
 *
 * Un video se crea en `processing` y se normaliza en background hasta `ready`
 * o `failed` (FR-100). La Library sí pregunta cada 10 s mientras hay un build
 * (ADR-014) y la tentación es copiarlo. **No se copia**, porque hoy no hay
 * quien normalice: `apps/worker` no tiene handler de normalización de media
 * —los que hay son `content-build`, `publishing`, `influencer-pipeline` y el
 * reset de cuota—, así que un asset en `processing` se queda ahí para siempre.
 * Un intervalo contra ese estado sería una petición cada diez segundos, sin
 * fin, contra el límite de §9.6, y no vería cambiar nada nunca.
 *
 * El día que exista el handler, la palanca es la misma que en
 * `lib/library/content.ts`: un `refetchInterval` en forma de función que mire
 * si queda algo en `processing`.
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
}

export function mediaQueryParams(filters: MediaFilters): QueryParams {
  return filters.type === undefined ? {} : { type: filters.type };
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
