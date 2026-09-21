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

export interface ApiQueryOptions<TOutput> {
  queryKey: readonly unknown[];
  path: string;
  query?: QueryParams;
  schema?: OutputSchema<TOutput>;
  enabled?: boolean;
  staleTime?: number;
}

/** Un recurso. El `signal` de TanStack Query se pasa a `fetch`: cancela de verdad. */
export function useApiQuery<TOutput>(
  options: ApiQueryOptions<TOutput>,
): UseQueryResult<TOutput, ApiRequestError> {
  const { queryKey, path, query, schema, enabled, staleTime } = options;
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
  });
}

export interface ApiListQueryOptions<TItem> {
  queryKey: readonly unknown[];
  path: string;
  query?: QueryParams;
  itemSchema?: OutputSchema<TItem>;
  limit?: number;
  enabled?: boolean;
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
): UseInfiniteQueryResult<
  { pages: CursorPage<TItem>[]; pageParams: (string | null)[] },
  ApiRequestError
> {
  const { queryKey, path, query, itemSchema, limit, enabled } = options;
  return useInfiniteQuery<
    CursorPage<TItem>,
    ApiRequestError,
    { pages: CursorPage<TItem>[]; pageParams: (string | null)[] },
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
  });
}
