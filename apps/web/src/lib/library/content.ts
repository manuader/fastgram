"use client";

/**
 * Los datos de `Library → My Content` · FR-100 (PRD:1611-1613), §12 (PRD:2730).
 *
 * `GET /content` y `GET /content/:id`, con las tres cosas que la pantalla no
 * puede resolver sola:
 *
 * 1. **El schema es el del contrato, sin parches.** Lo hubo: ver
 *    `libraryContentSchema`.
 * 2. **El polling de ADR-014.** Una pieza nace en `BUILDING` y el worker la
 *    construye; la UI se entera preguntando cada 10 s (NFR-002, PRD:2961), no
 *    por websocket. Sin esto la Library enseña "Building…" para siempre y hay
 *    que recargar a mano — que es el producto no funcionando.
 * 3. **Aplanar las páginas del cursor** en una lista, que es lo que la grid
 *    dibuja.
 */
import {
  contentSchema,
  contentStatusSchema,
  contentTypeSchema,
  PAGINATION_LIMIT_DEFAULT,
  type ContentStatus,
  type ContentType,
} from "@fastgram/contracts";
import type { z } from "zod";
import type { UseInfiniteQueryResult, UseQueryResult } from "@tanstack/react-query";
import type { CopyKey } from "../i18n/t";
import type { CursorPage, QueryParams } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiInfiniteQuery, useApiQuery, type CursorPages } from "../api/hooks";
import { queryKeys } from "../api/keys";

/**
 * NFR-002 (PRD:2961) — *"la cadencia recomendada oficial es **10 s** para
 * builds"*. ADR-014 la declara parte del contrato público, no un detalle de
 * esta pantalla: terceros implementan lo mismo.
 */
export const BUILD_POLL_INTERVAL_MS = 10_000;

/**
 * El `Content` del contrato, tal cual.
 *
 * Acá hubo un `extend` que hacía `thumbnailUrl` opcional, porque el contrato lo
 * declaraba obligatorio y el servidor **omite el campo** cuando la columna es
 * null — o sea en toda pieza en `BUILDING`, justo la que esta pantalla tiene
 * que enseñar mientras se construye. Validar con el contrato convertía cada
 * build en curso en un `invalid_response`.
 *
 * **El contrato era el que estaba mal y ya está corregido**, así que el
 * `extend` se borró. El test que fijaba la diferencia disparó al corregirlo,
 * que era exactamente su trabajo.
 */
export const libraryContentSchema = contentSchema;
export type LibraryContent = z.infer<typeof libraryContentSchema>;

/** Los cinco tipos y los tres estados, tal y como los lista §12 (PRD:2730). */
export const CONTENT_TYPES: readonly ContentType[] = contentTypeSchema.options;
export const CONTENT_STATUSES: readonly ContentStatus[] = contentStatusSchema.options;

/**
 * Tipo → clave de copy. El `Record` completo, no un `switch`: si el contrato
 * agrega un sexto tipo, esto deja de compilar y alguien decide cómo se llama en
 * pantalla, en vez de que salga el identificador crudo.
 */
export const CONTENT_TYPE_COPY: Readonly<Record<ContentType, CopyKey>> = {
  slideshow: "library.type.slideshow",
  "wall-of-text": "library.type.wallOfText",
  "green-screen": "library.type.greenScreen",
  "video-hook": "library.type.videoHook",
  custom: "library.type.custom",
  reel: "library.type.reel",
};

export const CONTENT_STATUS_COPY: Readonly<Record<ContentStatus, CopyKey>> = {
  BUILDING: "library.status.building",
  CREATED: "library.status.created",
  FAILED: "library.status.failed",
};

export type FileKind = "image" | "video";

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm"];

/**
 * ¿Ese archivo se dibuja con `<img>` o con `<video>`?
 *
 * **El contrato no lo dice.** `contentSchema.files` es `array(string().url())`
 * y nada más: ni mime, ni tamaño, ni tipo por archivo. Así que hay que
 * inferirlo, y la inferencia se escribe acá —pura y con test— en vez de dentro
 * de un `?:` en el JSX, porque es una suposición y las suposiciones se revisan.
 *
 * Primero la extensión, que es lo único que viene del propio archivo. Si la URL
 * no la tiene (una firmada puede no tenerla), se cae al tipo de la pieza:
 * `slideshow` es el único que produce imágenes (FR-070, PRD:1458 — una por
 * slide); `wall-of-text`, `green-screen` y `video-hook` son renders de video.
 * `custom` acepta *"your own video or image"* (F-070) y sólo tiene endpoint de
 * video (§9.8), así que cae del lado del video — y si algún día sube imágenes,
 * este es el sitio que hay que corregir.
 */
export function fileKind(url: string, type: ContentType): FileKind {
  const withoutQuery = url.split(/[?#]/)[0] ?? "";
  const lower = withoutQuery.toLowerCase();
  if (IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "image";
  if (VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "video";
  return type === "slideshow" ? "image" : "video";
}

export interface ContentFilters {
  /** `undefined` = sin filtrar. §12: lista separada por comas. */
  readonly type?: ContentType | undefined;
  readonly status?: ContentStatus | undefined;
}

/** Los filtros, en la forma que viaja en la query string. */
export function contentQueryParams(filters: ContentFilters): QueryParams {
  return {
    ...(filters.type === undefined ? {} : { type: filters.type }),
    ...(filters.status === undefined ? {} : { status: filters.status }),
  };
}

/** Las páginas del cursor, en la lista que dibuja la grid. */
export function flattenPages(
  data: CursorPages<LibraryContent> | undefined,
): readonly LibraryContent[] {
  if (data === undefined) return [];
  return data.pages.flatMap((page: CursorPage<LibraryContent>) => page.items);
}

/** ¿Hay algo construyéndose? Es lo único que decide si se sigue preguntando. */
export function hasBuildingPiece(items: readonly { status: ContentStatus }[]): boolean {
  return items.some((item) => item.status === "BUILDING");
}

/**
 * La cadencia de polling que corresponde a lo que hay en pantalla.
 *
 * `false` —y no un número grande— cuando no queda nada construyéndose: una
 * Library abierta en una pestaña de fondo no tiene por qué gastar el rate
 * limit de §9.6 preguntando por piezas que ya están terminadas.
 *
 * ## Lo que cuesta media hora descubrir mirando la pantalla
 *
 * **En una pestaña oculta el intervalo no dispara.** TanStack Query tiene
 * `refetchIntervalInBackground: false` por defecto y su `focusManager` trata
 * `document.visibilityState === "hidden"` como "sin foco", así que el reloj se
 * para hasta que la pestaña vuelve al frente. Verificado en un navegador: con
 * la pestaña oculta, una pieza en `BUILDING` se quedaba en `Building…`
 * indefinidamente y el servidor no recibía una sola petición; con
 * `visibilityState` visible, las peticiones salieron en t+8,5 s y t+18,6 s
 * —10,1 s de separación— y pararon solas en cuanto la pieza pasó a `CREATED`.
 *
 * Se deja así **a propósito**: machacar la API por una pestaña que nadie mira
 * es exactamente lo que §9.6 no quiere. El precio es que al volver a la
 * pestaña puede pasar hasta un intervalo antes de ver el cambio, porque el
 * `QueryClient` de este proyecto tiene además `refetchOnWindowFocus: false`.
 * Si algún día eso molesta, la palanca es esa, no subir la cadencia.
 */
export function pollIntervalFor(
  items: readonly { status: ContentStatus }[],
): number | false {
  return hasBuildingPiece(items) ? BUILD_POLL_INTERVAL_MS : false;
}

export interface UseContentListOptions extends ContentFilters {
  readonly limit?: number;
}

/**
 * `GET /content` paginado por cursor, con polling mientras haya builds.
 *
 * `staleTime: 0` es deliberado y va contra el default de 30 s del
 * `QueryClient`: mezclar una ventana de frescura con una cadencia de polling
 * deja una duda —¿el refetch del intervalo respeta el staleTime?— que sólo se
 * resolvería leyendo el código de la librería. Con 0 no hay duda que resolver,
 * y lo que se paga es un refetch al volver a montar la pantalla.
 */
export function useContentList(
  options: UseContentListOptions = {},
): UseInfiniteQueryResult<CursorPages<LibraryContent>, ApiRequestError> {
  const { limit = PAGINATION_LIMIT_DEFAULT, ...filters } = options;
  const query = contentQueryParams(filters);
  return useApiInfiniteQuery<LibraryContent>({
    queryKey: queryKeys.content(query),
    path: "/content",
    query,
    itemSchema: libraryContentSchema,
    limit,
    staleTime: 0,
    refetchInterval: (q) => pollIntervalFor(flattenPages(q.state.data)),
  });
}

/** `GET /content/:id`, con el mismo polling si la pieza está construyéndose. */
export function useContentItem(
  contentId: string,
): UseQueryResult<LibraryContent, ApiRequestError> {
  return useApiQuery<LibraryContent>({
    queryKey: queryKeys.contentItem(contentId),
    path: `/content/${encodeURIComponent(contentId)}`,
    schema: libraryContentSchema,
    staleTime: 0,
    refetchInterval: (q) =>
      q.state.data?.status === "BUILDING" ? BUILD_POLL_INTERVAL_MS : false,
  });
}
