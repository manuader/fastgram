/**
 * Notificaciones — `P5-NOTIF-001…004`, PRD §13. Migración
 * `0028_notifications.sql`, donde está el porqué de cada restricción.
 *
 * Una fila por aviso y por marca. Es a la vez la campana (`in_app`,
 * `read_at`) y el outbox de los avisos fuera de la app (`push_*`).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { timestamps, tsColumn } from "./_shared.js";
import { companyRef } from "./identity.js";

export const NOTIFICATION_PUSH_STATUS = ["pending", "sent", "failed", "skipped"] as const;
export type NotificationPushStatus = (typeof NOTIFICATION_PUSH_STATUS)[number];

export const NOTIFICATION_SEVERITY = ["info", "success", "warning", "error"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITY)[number];

export const notifications = pgTable(
  "notifications",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    /** Código estable (`core/notifications/categories.ts`). */
    category: text().notNull(),
    severity: text().$type<NotificationSeverity>().notNull().default("info"),
    title: text().notNull(),
    body: text().notNull().default(""),
    /** Ruta de la web (`/calendar`, `/settings/connections`…), nunca una URL externa. */
    link: text(),
    /** La guarda contra avisar dos veces lo mismo. Ver la migración. */
    dedupeKey: text(),
    inApp: boolean().notNull().default(true),
    readAt: tsColumn(),
    pushStatus: text().$type<NotificationPushStatus>().notNull().default("skipped"),
    pushAttempts: integer().notNull().default(0),
    /** Código estable; nunca la respuesta del proveedor. */
    pushError: text(),
    pushedAt: tsColumn(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("notifications_company_dedupe_uq")
      .on(t.companyId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    index("notifications_company_created_idx").on(t.companyId, t.createdAt),
    check(
      "notifications_push_status_check",
      sql`${t.pushStatus} in ('pending', 'sent', 'failed', 'skipped')`,
    ),
    check(
      "notifications_severity_check",
      sql`${t.severity} in ('info', 'success', 'warning', 'error')`,
    ),
  ],
);
