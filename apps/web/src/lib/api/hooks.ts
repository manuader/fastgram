"use client";

/**
 * Hooks sobre el cliente de API · `P1-UI-007`.
 *
 * Dos envoltorios finos —uno para recurso, otro para listado paginado— y los
 * hooks concretos que hoy usa la shell. Finos a propósito: la lógica está en
 * `client.ts`, que se puede probar sin React.
 */
import {
  useInfiniteQuery,
  useQuery,
  type Query,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  apiList,
  apiRequest,
  type CursorPage,
  type OutputSchema,
  type QueryParams,
} from "./client";
import type { ApiRequestError } from "./errors";

/**
 * Cadencia de refetch, en la forma que la necesita el polling de ADR-014.
 *
 * La forma de **función** no es un adorno: la cadencia depende de lo que haya
 * en la caché. Una pieza en `BUILDING` se consulta cada 10 s (NFR-002,
 * PRD:2961) y una en `CREATED` no se consulta más. Con un número fijo habría
 * que elegir entre machacar la API para siempre o no enterarse nunca de que el
 * build terminó — y con un número calculado *antes* de la llamada, el hook no
 * podría verlo, porque el dato es justo lo que devuelve.
 *
 * `undefined` desde la función significa "dejá la cadencia como está".
 */
export type RefetchInterval<TQueryFnData, TData> =
  | number
  | false
  | ((
      query: Query<TQueryFnData, ApiRequestError, TData, readonly unknown[]>,
    ) => number | false | undefined);

export interface ApiQueryOptions<TOutput> {
  queryKey: readonly unknown[];
  path: string;
  query?: QueryParams;
  schema?: OutputSchema<TOutput>;
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: RefetchInterval<TOutput, TOutput>;
}

/** Un recurso. El `signal` de TanStack Query se pasa a `fetch`: cancela de verdad. */
export function useApiQuery<TOutput>(
  options: ApiQueryOptions<TOutput>,
): UseQueryResult<TOutput, ApiRequestError> {
  const { queryKey, path, query, schema, enabled, staleTime, refetchInterval } = options;
  return useQuery<TOutput, ApiRequestError>({
    queryKey,
    queryFn: ({ signal }) =>
      apiRequest<TOutput>(path, {
        signal,
        ...(query === undefined ? {} : { query }),
        ...(schema === undefined ? {} : { schema }),
      }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(staleTime === undefined ? {} : { staleTime }),
    ...(refetchInterval === undefined ? {} : { refetchInterval }),
  });
}

/** Lo que TanStack guarda en caché para un listado infinito. */
export type CursorPages<TItem> = {
  pages: CursorPage<TItem>[];
  pageParams: (string | null)[];
};

export interface ApiListQueryOptions<TItem> {
  queryKey: readonly unknown[];
  path: string;
  query?: QueryParams;
  itemSchema?: OutputSchema<TItem>;
  limit?: number;
  enabled?: boolean;
  staleTime?: number;
  /**
   * Ojo con el coste: refetchear un listado infinito vuelve a pedir **todas**
   * las páginas cargadas, no sólo la primera. Con tres páginas abiertas y 10 s
   * de cadencia son 18 peticiones por minuto contra el límite de 60 (§9.6). Por
   * eso la forma de función: se apaga en cuanto no queda nada construyéndose.
   */
  refetchInterval?: RefetchInterval<CursorPage<TItem>, CursorPages<TItem>>;
}

/**
 * Un listado paginado por cursor (PRD:2345).
 *
 * `getNextPageParam` mira `hasMore`, no si el cursor es `null`: el API puede
 * devolver cursor con `hasMore: false`, y pedir esa página de más es una
 * petición tirada contra el rate limit.
 */
export function useApiInfiniteQuery<TItem>(
  options: ApiListQueryOptions<TItem>,
): UseInfiniteQueryResult<CursorPages<TItem>, ApiRequestError> {
  const {
    queryKey,
    path,
    query,
    itemSchema,
    limit,
    enabled,
    staleTime,
    refetchInterval,
  } = options;
  return useInfiniteQuery<
    CursorPage<TItem>,
    ApiRequestError,
    CursorPages<TItem>,
    readonly unknown[],
    string | null
  >({
    queryKey,
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) =>
      apiList<TItem>(path, {
        signal,
        cursor: pageParam,
        ...(query === undefined ? {} : { query }),
        ...(itemSchema === undefined ? {} : { itemSchema }),
        ...(limit === undefined ? {} : { limit }),
      }),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.cursor : null),
    ...(enabled === undefined ? {} : { enabled }),
    ...(staleTime === undefined ? {} : { staleTime }),
    ...(refetchInterval === undefined ? {} : { refetchInterval }),
  });
}
