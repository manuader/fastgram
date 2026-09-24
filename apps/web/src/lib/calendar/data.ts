"use client";

/**
 * Los datos del Calendar — `PU-CAL-002` (y F-140..F-143, FR-110).
 *
 * ## `GET /calendar`, no `GET /posts` paginado
 *
 * Hasta el sprint 1 esto pedía `GET /posts` de a 100 hasta un tope, porque la
 * API no sabía de fechas, y hacía un join de tipos contra `GET /content`. Ahora
 * hay un endpoint de rango que trae, en una sola ida, los posts **y los slots
 * planificados** del `[from, to)` pedido, con tipo, miniatura, marca y si se
 * puede mover; más los contadores globales de FR-110.
 *
 * ## "Todas las marcas" lo resuelve la API
 *
 * El proxy de la web (`app/api/fastgram/v1/[...path]`) arma el header de marca
 * con **su** cookie y no reenvía uno del navegador, así que pedir marca por
 * marca desde acá no es posible. `?brands=all` le pide a la API que recorra las
 * marcas del dueño, cada una con su scope.
 *
 * ## Claves
 *
 * Cuelgan de `["posts", "calendar"]`: invalidar los posts (programar, cancelar,
 * aceptar en Blitz con auto-slot) también refresca el calendario.
 */
import {
  calendarItemSchema,
  calendarSchema,
  type Calendar,
  type CalendarItem,
} from "@fastgram/contracts";
import { useMutation, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { apiRequest } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";
import type { BrandScope, MoveRequest } from "./board";

export const CALENDAR_PATH = "calendar";

export const calendarKeys = {
  all: () => ["posts", "calendar"] as const,
  range: (brands: BrandScope, from: number, to: number) =>
    ["posts", "calendar", brands, from, to] as const,
};

export function useCalendar(
  brands: BrandScope,
  range: { readonly from: number; readonly to: number } | null,
): UseQueryResult<Calendar, ApiRequestError> {
  return useApiQuery<Calendar>({
    queryKey: calendarKeys.range(brands, range?.from ?? 0, range?.to ?? 0),
    path: CALENDAR_PATH,
    query: { from: range?.from, to: range?.to, brands },
    schema: calendarSchema,
    enabled: range !== null,
  });
}

interface MoveContext {
  readonly snapshots: readonly (readonly [readonly unknown[], Calendar | undefined])[];
}

/**
 * Mover un post o un slot (`PATCH /calendar/items/:kind/:id`).
 *
 * **Optimista**: el chip salta al día nuevo apenas se suelta —esperar la
 * respuesta con el chip de vuelta en su lugar se lee como "no se movió"— y si
 * la API lo rechaza (ya salió, carril lento de TikTok) vuelve a donde estaba.
 * Al terminar se invalida igual: mover un post lo recrea con otro id (ver
 * `apps/api/src/routes/v1/calendar.ts`), y el id nuevo sólo lo trae la API.
 */
export function useMoveCalendarItem() {
  const queryClient = useQueryClient();
  return useMutation<CalendarItem, ApiRequestError, MoveRequest, MoveContext>({
    mutationFn: ({ item, scheduledAtUtc }) =>
      apiRequest<CalendarItem>(
        `${CALENDAR_PATH}/items/${item.kind}/${encodeURIComponent(item.id)}`,
        {
          method: "PATCH",
          body: { scheduledAtUtc, brandId: item.brandId },
          schema: calendarItemSchema,
        },
      ),
    onMutate: async ({ item, scheduledAtUtc }) => {
      await queryClient.cancelQueries({ queryKey: calendarKeys.all() });
      const snapshots = queryClient.getQueriesData<Calendar>({
        queryKey: calendarKeys.all(),
      });
      for (const [key, value] of snapshots) {
        if (value === undefined) continue;
        queryClient.setQueryData<Calendar>(key, {
          ...value,
          items: value.items.map((other) =>
            other.kind === item.kind && other.id === item.id
              ? { ...other, at: scheduledAtUtc }
              : other,
          ),
        });
      }
      return { snapshots };
    },
    onError: (_error, _vars, context) => {
      for (const [key, value] of context?.snapshots ?? []) {
        queryClient.setQueryData(key, value);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: calendarKeys.all() }),
  });
}
