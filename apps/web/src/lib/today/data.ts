"use client";

/**
 * Los datos de "Today" · `PU-UI-002`. La aritmética está en `today.ts`.
 *
 * | Qué                         | De dónde                                   | Alcance          |
 * |-----------------------------|--------------------------------------------|------------------|
 * | timeline, fallidos, TikTok  | `GET /calendar?brands=all`                 | todas las marcas |
 * | motivo del fallo y link     | `GET /posts?from&to`                       | marca activa     |
 * | esperando aprobación        | `GET /blitz/queue`                         | marca activa     |
 * | marcar publicado            | `POST /posts/:id/mark-posted` + `brandId`  | cualquier marca  |
 *
 * ## Los dos huecos "sólo la marca activa", dichos en voz alta
 *
 * El proxy arma `X-Fastgram-Workspace` con **su** cookie y no reenvía uno del
 * navegador (`app/api/fastgram/v1/[...path]/route.ts`, regla 6). Así que todo
 * endpoint que no sepa "todas las marcas" por sí mismo sólo se puede leer para
 * la activa:
 *
 * 1. **`CalendarItem` no trae `errorMessage` ni `postUrl`.** Para la marca activa
 *    se completan con `GET /posts?from&to`; para las otras el fallido dice
 *    "Failed" sin motivo y el publicado no tiene link. Lo arregla sumar esos dos
 *    campos opcionales a `calendarItemSchema`.
 * 2. **La cola de Blitz es por marca** y no hay versión "todas". El contador es
 *    el de la activa; las demás marcas tienen su botón "Review" sin número.
 *
 * ## Claves
 *
 * El calendario y los posts cuelgan de `["posts", …]`: marcar publicado, o
 * cualquier invalidación de posts del resto de la app, refresca esta pantalla.
 * La cola cuelga de `["blitz", …]` por lo mismo. Ninguna es independiente de la
 * marca: cambiar de marca las resetea (`WorkspaceProvider`), que es lo correcto
 * para las dos de la marca activa.
 */
import {
  calendarSchema,
  postSchema,
  PAGINATION_LIMIT_MAX,
  type Calendar,
  type Post,
} from "@fastgram/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { z } from "zod";
import { apiList, apiRequest } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";
import { TODAY_REFRESH_MS, type TodayWindow } from "./today";

export const todayKeys = {
  calendar: (from: number, to: number) =>
    ["posts", "calendar", "today", from, to] as const,
  details: (from: number, to: number) => ["posts", "today-details", from, to] as const,
  blitzCount: () => ["blitz", "queue", "today-count"] as const,
};

export const BLITZ_QUEUE_PATH = "blitz/queue";
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

/** Lo que `CalendarItem` no trae. Ver el punto 1 de la cabecera. */
export interface PostDetail {
  readonly errorMessage?: string;
  readonly postUrl?: string;
}

/**
 * Los posts de la marca activa en la ventana, por id. Una página de 100 alcanza
 * para un mes de una marca con el tope anti-bot (3 por red y día); si no
 * alcanza, faltan motivos de los más nuevos y nada más: esto sólo decora.
 */
export function useTodayPostDetails(
  range: TodayWindow | null,
): UseQueryResult<ReadonlyMap<string, PostDetail>, ApiRequestError> {
  return useQuery<ReadonlyMap<string, PostDetail>, ApiRequestError>({
    queryKey: todayKeys.details(range?.queryFrom ?? 0, range?.dayEnd ?? 0),
    enabled: range !== null,
    refetchInterval: TODAY_REFRESH_MS,
    queryFn: async ({ signal }) => {
      const page = await apiList<Post>("posts", {
        signal,
        itemSchema: postSchema,
        limit: PAGINATION_LIMIT_MAX,
        query: { from: range?.queryFrom, to: range?.dayEnd },
      });
      const out = new Map<string, PostDetail>();
      for (const post of page.items) {
        out.set(post._id, {
          ...(post.errorMessage === undefined ? {} : { errorMessage: post.errorMessage }),
          ...(post.postUrl === undefined ? {} : { postUrl: post.postUrl }),
        });
      }
      return out;
    },
  });
}

/**
 * Cuántas tarjetas esperan en el Blitz de la marca activa. Sólo interesa el
 * largo: el schema es `unknown[]` a propósito, para que un cambio en la forma de
 * la tarjeta —que es del deck— no tire abajo el contador de esta pantalla.
 *
 * Ojo: `GET /blitz/queue` con la cola corta **pide relleno** (FR-055). Es lo
 * mismo que hace el deck al abrirse; con el refresco de 30 s, esta pantalla
 * abierta mantiene llena la cola de la marca activa.
 */
export function useBlitzQueueCount(): UseQueryResult<number, ApiRequestError> {
  return useQuery<number, ApiRequestError>({
    queryKey: todayKeys.blitzCount(),
    refetchInterval: TODAY_REFRESH_MS,
    retry: false,
    queryFn: async ({ signal }) => {
      const queue = await apiRequest(BLITZ_QUEUE_PATH, {
        signal,
        schema: z.array(z.unknown()),
      });
      return queue.length;
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
