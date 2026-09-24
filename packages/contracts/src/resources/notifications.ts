/**
 * Notificaciones — `P5-NOTIF-001…004`, PRD §13, `P3-OAUTH-005/011`.
 *
 *   GET  /notifications                    la campana (todas las marcas del dueño)
 *   POST /notifications/{id}/read          marcar una leída
 *   POST /notifications/read-all           marcar todas
 *   GET  /notifications/connection-alerts  el banner global de conexiones
 *   GET  /notifications/settings           preferencias y canales (enmascarados)
 *   PUT  /notifications/settings
 *   POST /notifications/test               mandar un aviso de prueba por un canal
 *
 * Ninguna ruta está en el §9.3 del PRD original: nacen de §13 (INFERRED) y
 * del plan de uso personal.
 *
 * ## Las categorías están duplicadas, a propósito
 *
 * Las decide `packages/core` (`notifications/categories.ts`) y este paquete
 * no importa `core`. `apps/api` tiene un test que compara las dos listas.
 *
 * ## `POST /notifications/test` responde 200 con `ok: false`
 *
 * Igual que `POST /models/test`: un `401` de Telegram traducido a `401` le
 * diría a la web que su sesión venció. El fallo del canal es un dato.
 */
import { z } from "zod";

export const NOTIFICATION_CATEGORY_VALUES = [
  "post_published",
  "post_failed",
  "tiktok_draft_ready",
  "connection_expired",
  "connection_expiring",
  "autopilot_rejected",
  "campaign_ready",
  "daily_summary",
  "queue_stuck",
  "queue_dead_letter",
] as const;
export const notificationCategorySchema = z.enum(NOTIFICATION_CATEGORY_VALUES);
export type NotificationCategoryId = z.infer<typeof notificationCategorySchema>;

export const notificationSeveritySchema = z.enum(["info", "success", "warning", "error"]);
export type NotificationSeverityId = z.infer<typeof notificationSeveritySchema>;

export const notificationSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    workspaceName: z.string(),
    category: notificationCategorySchema,
    severity: notificationSeveritySchema,
    title: z.string(),
    body: z.string(),
    /** Ruta de la web (`/home`, `/settings/connections`…). */
    link: z.string().nullable(),
    read: z.boolean(),
    createdAt: z.string(),
  })
  .strict();
export type AppNotification = z.infer<typeof notificationSchema>;

export const notificationListSchema = z
  .object({
    items: z.array(notificationSchema),
    unreadCount: z.number().int().nonnegative(),
  })
  .strict();
export type NotificationList = z.infer<typeof notificationListSchema>;

export const listNotificationsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    unread: z.enum(["true", "false"]).optional(),
    /** `all` = todas las marcas del dueño (modo personal). */
    brands: z.enum(["current", "all"]).default("all"),
  })
  .strict();
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const markAllNotificationsReadRequestSchema = z
  .object({ brands: z.enum(["current", "all"]).default("all") })
  .strict();

export const markAllNotificationsReadResponseSchema = z
  .object({ updated: z.number().int().nonnegative() })
  .strict();

export const connectionAlertSchema = z
  .object({
    workspaceId: z.string(),
    workspaceName: z.string(),
    connectionId: z.string(),
    platform: z.string(),
    account: z.string(),
    state: z.enum(["expired", "expiring"]),
    /** ISO. `null` en una vencida sin fecha (revocada, pausada). */
    deadline: z.string().nullable(),
    /** `expired` / `revoked` / `paused` / `token_expired`. `null` si está por vencer. */
    reason: z.string().nullable(),
  })
  .strict();
export type ConnectionAlert = z.infer<typeof connectionAlertSchema>;

export const connectionAlertsSchema = z
  .object({ alerts: z.array(connectionAlertSchema) })
  .strict();
export type ConnectionAlerts = z.infer<typeof connectionAlertsSchema>;

export const notificationSettingsSchema = z
  .object({
    categories: z.array(
      z
        .object({
          category: notificationCategorySchema,
          inApp: z.boolean(),
          push: z.boolean(),
        })
        .strict(),
    ),
    ntfy: z
      .object({
        configured: z.boolean(),
        enabled: z.boolean(),
        urlMasked: z.string().nullable(),
        tokenSet: z.boolean(),
      })
      .strict(),
    telegram: z
      .object({
        configured: z.boolean(),
        enabled: z.boolean(),
        chatId: z.string().nullable(),
        botTokenHint: z.string().nullable(),
      })
      .strict(),
    dailySummaryHour: z.number().int().min(0).max(23),
  })
  .strict();
export type NotificationSettingsView = z.infer<typeof notificationSettingsSchema>;

export const updateNotificationSettingsRequestSchema = z
  .object({
    categories: z
      .array(
        z
          .object({
            category: notificationCategorySchema,
            inApp: z.boolean().optional(),
            push: z.boolean().optional(),
          })
          .strict(),
      )
      .max(NOTIFICATION_CATEGORY_VALUES.length)
      .optional(),
    /** `null` borra el canal. Un secreto vacío u omitido conserva el guardado. */
    ntfy: z
      .object({
        enabled: z.boolean().optional(),
        url: z.string().max(500).optional(),
        /** `null` borra el token. */
        token: z.string().max(200).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    telegram: z
      .object({
        enabled: z.boolean().optional(),
        botToken: z.string().max(200).optional(),
        chatId: z.string().max(64).optional(),
      })
      .strict()
      .nullable()
      .optional(),
    dailySummaryHour: z.number().int().min(0).max(23).optional(),
  })
  .strict();
export type UpdateNotificationSettingsRequest = z.infer<
  typeof updateNotificationSettingsRequestSchema
>;

export const notificationChannelSchema = z.enum(["ntfy", "telegram"]);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const testNotificationRequestSchema = z
  .object({ channel: notificationChannelSchema })
  .strict();

export const notificationTestErrorSchema = z.enum([
  "not_configured",
  "unauthorized",
  "not_found",
  "rate_limited",
  "bad_request",
  "unavailable",
  "timeout",
]);
export type NotificationTestError = z.infer<typeof notificationTestErrorSchema>;

export const notificationTestResultSchema = z
  .object({
    ok: z.boolean(),
    channel: notificationChannelSchema,
    error: notificationTestErrorSchema.nullable(),
  })
  .strict();
export type NotificationTestResult = z.infer<typeof notificationTestResultSchema>;
