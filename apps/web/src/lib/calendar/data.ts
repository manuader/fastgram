"use client";

/**
 * Los datos del Calendar · F-140..F-143.
 *
 * ## El hueco: `GET /posts` no sabe de fechas
 *
 * Una vista mes necesita "los posts de septiembre". La API no lo permite:
 *
 * · `listPostsQuerySchema` es `.strict()` y sólo contrata `cursor`, `limit` y
 *   `status`. No hay `from`/`to` ni nada parecido: mandarlo es un `400`.
 * · El orden es **`createdAt` descendente** (`createCompanyScopedRepository`,
 *   `packages/db`), no `scheduledAtUtc`. Un post creado hoy puede estar
 *   programado para dentro de tres meses, así que no existe una página a partir
 *   de la cual se pueda afirmar "ya no quedan posts de este mes".
 * · `Post` no publica `createdAt`, así que ni siquiera se puede cortar por él.
 *
 * Así que se hace lo único honesto con lo que hay: se piden páginas de 100 (el
 * máximo del contrato) **hasta un tope explícito** de `CALENDAR_MAX_PAGES`, se
 * reparten en el cliente, y si al llegar al tope todavía queda `hasMore`, la
 * pantalla **lo dice** —los contadores llevan `+` y hay un aviso—. Lo que no se
 * hace es paginar sin límite: con un workspace grande, abrir el Calendar
 * serían cientos de peticiones contra el límite de 60/min de §9.6.
 *
 * Lo que cerraría el hueco es un filtro de rango (`scheduledFrom`/`scheduledTo`)
 * en `GET /posts`, o un endpoint de conteos para la cabecera. Ninguno existe.
 *
 * ## El tipo de contenido, que el post no trae
 *
 * F-141 pide `Plataforma: Tipo` en el chip, y `Post` sólo trae `contentId` (ver
 * `lib/library/posts.ts`, que por eso no dibuja el tipo). Acá sí se dibuja, con
 * una petición por **página** y no por post: `GET /content` paginado con el
 * mismo tope, y un mapa `contentId → type`. El contenido nace antes que su
 * post y los dos listados van por `createdAt` descendente, así que las páginas
 * de contenido cubren a las de posts. Un post cuya pieza no llegó en esas
 * páginas —o si `GET /content` falla— lleva el chip sin tipo, y la pantalla lo
 * avisa; no se deduce el tipo de otra cosa.
 *
 * ## Sin polling
 *
 * La Library pregunta cada 10 s mientras haya un `BUILDING`. Acá no: refetchear
 * un listado infinito pide **todas** las páginas cargadas (ver `hooks.ts`), y
 * con cinco de posts y cinco de contenido son 60 peticiones por minuto — el
 * límite entero de §9.6. La vista se refresca al volver a ella o al
 * invalidarse la clave.
 */
import {
  PAGINATION_LIMIT_MAX,
  postSchema,
  type ContentType,
  type Post,
} from "@fastgram/contracts";
import { useEffect, useMemo } from "react";
import type { CursorPage, OutputSchema } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiInfiniteQuery, type CursorPages } from "../api/hooks";
import { queryKeys } from "../api/keys";
import { libraryContentSchema, type LibraryContent } from "../library/content";
import { POSTS_PATH } from "../library/posts";

/** El máximo del contrato (PRD:2345). Menos páginas para el mismo tope. */
export const CALENDAR_PAGE_LIMIT = PAGINATION_LIMIT_MAX;

/**
 * El tope: 5 páginas de 100 = 500 posts. Cubre un workspace que publica varias
 * veces al día durante meses, y al abrir la vista son como mucho 10 peticiones
 * (posts + contenido) de las 60/min.
 */
export const CALENDAR_MAX_PAGES = 5;

export const CONTENT_PATH = "/content";

export interface CollectedList<TItem> {
  readonly items: readonly TItem[];
  /** La primera página todavía no llegó. */
  readonly pending: boolean;
  /** Quedan páginas por pedir **dentro del tope**. */
  readonly collecting: boolean;
  /** Se llegó al tope y la API dice que hay más. */
  readonly truncated: boolean;
  readonly error: ApiRequestError | null;
  readonly retry: () => void;
}

interface CollectOptions<TItem> {
  readonly queryKey: readonly unknown[];
  readonly path: string;
  readonly itemSchema: OutputSchema<TItem>;
  readonly maxPages: number;
}

function flatten<TItem>(data: CursorPages<TItem> | undefined): readonly TItem[] {
  if (data === undefined) return [];
  return data.pages.flatMap((page: CursorPage<TItem>) => page.items);
}

/**
 * Un listado por cursor que se pide solo, página tras página, hasta el final o
 * hasta `maxPages`. Un error corta la cadena: no se reintenta en bucle.
 */
function useCollectedList<TItem>(options: CollectOptions<TItem>): CollectedList<TItem> {
  const { queryKey, path, itemSchema, maxPages } = options;
  const query = useApiInfiniteQuery<TItem>({
    queryKey,
    path,
    itemSchema,
    limit: CALENDAR_PAGE_LIMIT,
  });

  const loadedPages = query.data?.pages.length ?? 0;
  const canContinue =
    query.hasNextPage && loadedPages < maxPages && !query.isError && !query.isFetching;

  const { fetchNextPage } = query;
  useEffect(() => {
    if (canContinue) void fetchNextPage();
  }, [canContinue, fetchNextPage, loadedPages]);

  const items = useMemo(() => flatten(query.data), [query.data]);

  return {
    items,
    pending: query.isPending,
    collecting: query.hasNextPage && loadedPages < maxPages && !query.isError,
    truncated: query.hasNextPage && loadedPages >= maxPages,
    error: query.isError ? query.error : null,
    retry: () => {
      // Con páginas ya en pantalla, lo que falló es la siguiente: se pide ésa.
      // `refetch` volvería a pedir todas las cargadas.
      if (loadedPages > 0) void query.fetchNextPage();
      else void query.refetch();
    },
  };
}

export function useCalendarPosts(): CollectedList<Post> {
  return useCollectedList<Post>({
    queryKey: queryKeys.calendarPosts(),
    path: POSTS_PATH,
    itemSchema: postSchema,
    maxPages: CALENDAR_MAX_PAGES,
  });
}

export interface ContentTypes {
  readonly typeOf: ReadonlyMap<string, ContentType>;
  /** Todavía se están pidiendo páginas: un tipo que falta puede llegar. */
  readonly loading: boolean;
}

export function useCalendarContentTypes(): ContentTypes {
  const list = useCollectedList<LibraryContent>({
    queryKey: queryKeys.calendarContent(),
    path: CONTENT_PATH,
    itemSchema: libraryContentSchema,
    maxPages: CALENDAR_MAX_PAGES,
  });
  const typeOf = useMemo(
    () => new Map(list.items.map((item) => [item._id as string, item.type] as const)),
    [list.items],
  );
  return {
    typeOf,
    loading: list.pending || list.collecting,
  };
}
