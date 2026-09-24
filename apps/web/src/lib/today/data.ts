"use client";

/**
 * Los datos de "Today" · `PU-UI-002`. La aritmética está en `today.ts`.
 *
 * | Qué                                  | De dónde                                  | Alcance          |
 * |--------------------------------------|-------------------------------------------|------------------|
 * | timeline, fallidos, TikTok, motivo   | `GET /calendar?brands=all`                | todas las marcas |
 * | y link del post publicado            |                                           |                  |
 * | esperando aprobación                 | `GET /blitz/queue/counts?brands=all`      | todas las marcas |
 * | marcar publicado                     | `POST /posts/:id/mark-posted` + `brandId` | cualquier marca  |
 *
 * El proxy arma `X-Fastgram-Workspace` con **su** cookie y no reenvía uno del
 * navegador (`app/api/fastgram/v1/[...path]/route.ts`, regla 6): todo lo que
 * esta pantalla muestra de las otras marcas tiene que venir de un endpoint que
 * sepa "todas las marcas" por sí mismo. Hasta el 2026-09-24 el motivo de los
 * fallos y la cola eran sólo de la marca activa; ahora `CalendarItem` trae
 * `errorCode`/`errorMessage`/`postUrl` y la cola tiene su versión agregada.
 *
 * ## Claves
 *
 * El calendario cuelga de `["posts", …]`: marcar publicado, o cualquier
 * invalidación de posts del resto de la app, refresca esta pantalla. Las colas
 * cuelgan de `["blitz", …]` por lo mismo.
 */
import {
  blitzQueueCountsSchema,
  calendarSchema,
  postSchema,
  type Calendar,
  type Post,
} from "@fastgram/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiRequest } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";
import { TODAY_REFRESH_MS, type TodayWindow } from "./today";

export const todayKeys = {
  calendar: (from: number, to: number) =>
    ["posts", "calendar", "today", from, to] as const,
  blitzCounts: () => ["blitz", "queue", "counts", "all"] as const,
};

export const BLITZ_QUEUE_COUNTS_PATH = "blitz/queue/counts";
export const markPostedPath = (postId: string): string =>
  `posts/${encodeURIComponent(postId)}/mark-posted`;

export function useTodayCalendar(
  range: TodayWindow | null,
): UseQueryResult<Calendar, ApiRequestError> {
  return useApiQuery<Calendar>({
    queryKey: todayKeys.calendar(range?.queryFrom ?? 0, range?.dayEnd ?? 0),
    path: "calendar",
    query: { from: range?.queryFrom, to: range?.dayEnd, brands: "all" },
    schema: calendarSchema,
    enabled: range !== null,
    refetchInterval: TODAY_REFRESH_MS,
  });
}

/**
 * Cuántas tarjetas esperan en el Blitz de **cada** marca del dueño, por id.
 *
 * `GET /blitz/queue/counts` sólo cuenta: al revés que `GET /blitz/queue`, no
 * pide relleno. Con el refresco de 30 s esta pantalla no mantiene llenas las
 * colas de marcas que nadie está mirando; las rellena el deck al abrirse.
 */
export function useBlitzQueueCounts(): UseQueryResult<
  ReadonlyMap<string, number>,
  ApiRequestError
> {
  return useQuery<ReadonlyMap<string, number>, ApiRequestError>({
    queryKey: todayKeys.blitzCounts(),
    refetchInterval: TODAY_REFRESH_MS,
    retry: false,
    queryFn: async ({ signal }) => {
      const rows = await apiRequest(BLITZ_QUEUE_COUNTS_PATH, {
        signal,
        query: { brands: "all" },
        schema: blitzQueueCountsSchema,
      });
      return new Map(rows.map((r) => [r.brandId, r.queued]));
    },
  });
}

export interface MarkPostedVariables {
  readonly postId: string;
  readonly brandId: string;
}

/**
 * "Mark as posted": `IN_USER_INBOX` → `POSTED`. Al volver, el ítem se actualiza
 * en la caché del calendario de esta pantalla —así desaparece de los borradores
 * y, si es de hoy, suma a "posted" sin esperar al refetch— y después se
 * invalidan los posts para que el resto de la app se entere.
 */
export function useMarkPosted() {
  const queryClient = useQueryClient();
  return useMutation<Post, ApiRequestError, MarkPostedVariables>({
    mutationFn: ({ postId, brandId }) =>
      apiRequest<Post>(markPostedPath(postId), {
        method: "POST",
        body: { brandId },
        schema: postSchema,
      }),
    onSuccess: (post, { postId }) => {
      for (const [key, value] of queryClient.getQueriesData<Calendar>({
        queryKey: ["posts", "calendar", "today"],
      })) {
        if (value === undefined) continue;
        queryClient.setQueryData<Calendar>(key, {
          ...value,
          items: value.items.map((item) =>
            item.kind === "post" && item.id === postId
              ? {
                  ...item,
                  status: "POSTED",
                  at: post.postedAt ?? item.at,
                  movable: false,
                }
              : item,
          ),
          counts: {
            ...value.counts,
            inbox: Math.max(0, value.counts.inbox - 1),
            posted: value.counts.posted + 1,
          },
        });
      }
      void queryClient.invalidateQueries({ queryKey: ["posts"] });
    },
  });
}
