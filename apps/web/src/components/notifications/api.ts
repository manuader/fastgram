"use client";

/**
 * Hooks de notificaciones — `P5-NOTIF-001…004` (sprint 7). La campana y el
 * banner son de **todas** las marcas del dueño (la API lo resuelve); las
 * preferencias son de la instalación.
 *
 * Viven acá y no en `lib/` porque este directorio es el que el sprint le
 * asignó al agente; si otra pantalla los necesita, se mudan a
 * `lib/notifications/`.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import {
  connectionAlertsSchema,
  markAllNotificationsReadResponseSchema,
  notificationListSchema,
  notificationSettingsSchema,
  notificationTestResultSchema,
  type ConnectionAlerts,
  type NotificationChannel,
  type NotificationList,
  type NotificationSettingsView,
  type NotificationTestResult,
  type UpdateNotificationSettingsRequest,
} from "@fastgram/contracts";
import { apiRequest, apiSend } from "@/lib/api/client";
import type { ApiRequestError } from "@/lib/api/errors";
import { useApiQuery } from "@/lib/api/hooks";

export const notificationKeys = {
  list: () => ["notifications", "list"] as const,
  alerts: () => ["notifications", "connection-alerts"] as const,
  settings: () => ["notifications", "settings"] as const,
};

/** El worker escribe cada 30 s; mirar cada minuto alcanza para la campana. */
export const NOTIFICATIONS_POLL_MS = 60_000;
/** Las conexiones cambian poco: cada 5 minutos. */
export const CONNECTION_ALERTS_POLL_MS = 5 * 60_000;

export function useNotifications(): UseQueryResult<NotificationList, ApiRequestError> {
  return useApiQuery<NotificationList>({
    queryKey: notificationKeys.list(),
    path: "/notifications",
    query: { limit: 50 },
    schema: notificationListSchema,
    refetchInterval: NOTIFICATIONS_POLL_MS,
  });
}

export function useMarkNotificationRead(): UseMutationResult<
  void,
  ApiRequestError,
  string
> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiRequestError, string>({
    mutationFn: (id) => apiSend(`/notifications/${id}/read`, { method: "POST" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: notificationKeys.list() }),
  });
}

export function useMarkAllNotificationsRead(): UseMutationResult<
  { updated: number },
  ApiRequestError,
  void
> {
  const queryClient = useQueryClient();
  return useMutation<{ updated: number }, ApiRequestError, void>({
    mutationFn: () =>
      apiRequest<{ updated: number }>("/notifications/read-all", {
        method: "POST",
        body: { brands: "all" },
        schema: markAllNotificationsReadResponseSchema,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: notificationKeys.list() }),
  });
}

export function useConnectionAlerts(): UseQueryResult<ConnectionAlerts, ApiRequestError> {
  return useApiQuery<ConnectionAlerts>({
    queryKey: notificationKeys.alerts(),
    path: "/notifications/connection-alerts",
    schema: connectionAlertsSchema,
    refetchInterval: CONNECTION_ALERTS_POLL_MS,
  });
}

export function useNotificationSettings(): UseQueryResult<
  NotificationSettingsView,
  ApiRequestError
> {
  return useApiQuery<NotificationSettingsView>({
    queryKey: notificationKeys.settings(),
    path: "/notifications/settings",
    schema: notificationSettingsSchema,
  });
}

export function useUpdateNotificationSettings(): UseMutationResult<
  NotificationSettingsView,
  ApiRequestError,
  UpdateNotificationSettingsRequest
> {
  const queryClient = useQueryClient();
  return useMutation<
    NotificationSettingsView,
    ApiRequestError,
    UpdateNotificationSettingsRequest
  >({
    mutationFn: (body) =>
      apiRequest<NotificationSettingsView>("/notifications/settings", {
        method: "PUT",
        body,
        schema: notificationSettingsSchema,
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(notificationKeys.settings(), next);
    },
  });
}

export function useSendTestNotification(): UseMutationResult<
  NotificationTestResult,
  ApiRequestError,
  NotificationChannel
> {
  return useMutation<NotificationTestResult, ApiRequestError, NotificationChannel>({
    mutationFn: (channel) =>
      apiRequest<NotificationTestResult>("/notifications/test", {
        method: "POST",
        body: { channel },
        schema: notificationTestResultSchema,
      }),
  });
}
