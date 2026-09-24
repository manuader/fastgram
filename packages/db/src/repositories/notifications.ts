/**
 * Notificaciones — `P5-NOTIF-001…004`, `P1-OBS-005`. Tabla y función de
 * `0028_notifications.sql`.
 *
 * Todo con `TenantScope` salvo {@link listNotificationBrands} (la pregunta de
 * arriba del tenant para los barridos del worker, por la función
 * `SECURITY DEFINER`) y {@link readQueueHealth} (el esquema de pg-boss, que
 * no es de ningún tenant).
 *
 * Lo que este archivo **no** decide: qué merece un aviso, con qué texto, ni si
 * una conexión está por vencer. Eso es `@fastgram/core` (`notifications/`).
 * Acá se guarda lo que core decidió y se leen los hechos de los que sale.
 */
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import {
  autopilotRuns,
  automations,
  connections,
  notifications,
  posts,
  type NotificationPushStatus,
  type NotificationSeverity,
} from "../schema/index.js";
import type { TenantScope } from "./base.js";

export type NotificationRow = typeof notifications.$inferSelect;

/* ------------------------------------------------------------------------ *
 * Marcas (barridos del worker)
 * ------------------------------------------------------------------------ */

export interface NotificationBrandRow {
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly timezone: string;
}

export async function listNotificationBrands(
  exec: Executor,
): Promise<NotificationBrandRow[]> {
  const rows = (await exec.execute(
    sql`select company_id, owner_user_id, name, timezone from app.notification_brands()`,
  )) as unknown as Array<{
    company_id: string;
    owner_user_id: string;
    name: string;
    timezone: string;
  }>;
  return rows.map((r) => ({
    companyId: r.company_id,
    ownerUserId: r.owner_user_id,
    name: r.name,
    timezone: r.timezone,
  }));
}

/* ------------------------------------------------------------------------ *
 * Escribir
 * ------------------------------------------------------------------------ */

export interface NewNotification {
  readonly category: string;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly dedupeKey: string | null;
  readonly inApp: boolean;
  readonly pushStatus: NotificationPushStatus;
}

/**
 * Inserta el aviso. Con `dedupeKey` repetida no hace nada y devuelve
 * `created: false` (`ON CONFLICT DO NOTHING` sobre el índice parcial).
 */
export async function insertNotification(
  exec: Executor,
  scope: TenantScope,
  value: NewNotification,
): Promise<{ readonly id: string | null; readonly created: boolean }> {
  const rows = await exec
    .insert(notifications)
    .values({
      companyId: scope.companyId,
      category: value.category,
      severity: value.severity,
      title: value.title,
      body: value.body,
      link: value.link,
      dedupeKey: value.dedupeKey,
      inApp: value.inApp,
      pushStatus: value.pushStatus,
    })
    .onConflictDoNothing({
      target: [notifications.companyId, notifications.dedupeKey],
      where: sql`${notifications.dedupeKey} is not null`,
    })
    .returning({ id: notifications.id });
  const id = rows[0]?.id ?? null;
  return { id, created: id !== null };
}

/* ------------------------------------------------------------------------ *
 * La campana
 * ------------------------------------------------------------------------ */

export async function listNotifications(
  exec: Executor,
  scope: TenantScope,
  options: { readonly limit: number; readonly unreadOnly: boolean },
): Promise<NotificationRow[]> {
  return exec
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.companyId, scope.companyId),
        eq(notifications.inApp, true),
        options.unreadOnly ? isNull(notifications.readAt) : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(options.limit);
}

export async function countUnreadNotifications(
  exec: Executor,
  scope: TenantScope,
): Promise<number> {
  const rows = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.companyId, scope.companyId),
        eq(notifications.inApp, true),
        isNull(notifications.readAt),
      ),
    );
  return rows[0]?.n ?? 0;
}

/** `false` si el aviso no es de esta marca (o no existe). Idempotente. */
export async function markNotificationRead(
  exec: Executor,
  scope: TenantScope,
  id: string,
  now: Date,
): Promise<boolean> {
  const rows = await exec
    .update(notifications)
    .set({
      readAt: sql`coalesce(${notifications.readAt}, ${now.toISOString()}::timestamptz)`,
      updatedAt: now,
    })
    .where(and(eq(notifications.companyId, scope.companyId), eq(notifications.id, id)))
    .returning({ id: notifications.id });
  return rows.length > 0;
}

export async function markAllNotificationsRead(
  exec: Executor,
  scope: TenantScope,
  now: Date,
): Promise<number> {
  const rows = await exec
    .update(notifications)
    .set({ readAt: now, updatedAt: now })
    .where(
      and(eq(notifications.companyId, scope.companyId), isNull(notifications.readAt)),
    )
    .returning({ id: notifications.id });
  return rows.length;
}

/* ------------------------------------------------------------------------ *
 * El outbox de push
 * ------------------------------------------------------------------------ */

/**
 * Los avisos que esperan salir por ntfy/Telegram, los más viejos primero.
 * `SKIP LOCKED` sólo evita esperar a otro despachador que esté escribiendo un
 * resultado; el envío va fuera de la transacción (`apps/worker/.../delivery.ts`
 * explica por qué y qué implica con más de un worker).
 */
export async function claimPendingPushes(
  exec: Executor,
  scope: TenantScope,
  limit: number,
): Promise<NotificationRow[]> {
  return exec
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.companyId, scope.companyId),
        eq(notifications.pushStatus, "pending"),
      ),
    )
    .orderBy(notifications.createdAt)
    .limit(limit)
    .for("update", { skipLocked: true });
}

export async function recordPushOutcome(
  exec: Executor,
  scope: TenantScope,
  id: string,
  outcome: {
    readonly status: NotificationPushStatus;
    readonly attempts: number;
    readonly error: string | null;
    readonly now: Date;
  },
): Promise<void> {
  await exec
    .update(notifications)
    .set({
      pushStatus: outcome.status,
      pushAttempts: outcome.attempts,
      pushError: outcome.error,
      pushedAt: outcome.status === "sent" ? outcome.now : null,
      updatedAt: outcome.now,
    })
    .where(and(eq(notifications.companyId, scope.companyId), eq(notifications.id, id)));
}

/* ------------------------------------------------------------------------ *
 * Hechos que leen los detectores
 * ------------------------------------------------------------------------ */

export interface PostEventRow {
  readonly id: string;
  readonly status: string;
  readonly platform: string;
  readonly connectionUsername: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly postUrl: string | null;
  readonly updatedAt: Date;
}

/** Posts que llegaron a `POSTED`, `FAILED` o `IN_USER_INBOX` desde `since`. */
export async function listRecentPostEvents(
  exec: Executor,
  scope: TenantScope,
  since: Date,
  limit = 200,
): Promise<PostEventRow[]> {
  return exec
    .select({
      id: posts.id,
      status: posts.status,
      platform: posts.platform,
      connectionUsername: posts.connectionUsername,
      errorCode: posts.errorCode,
      errorMessage: posts.errorMessage,
      postUrl: posts.postUrl,
      updatedAt: posts.updatedAt,
    })
    .from(posts)
    .where(
      and(
        eq(posts.companyId, scope.companyId),
        inArray(posts.status, ["POSTED", "FAILED", "IN_USER_INBOX"]),
        gte(posts.updatedAt, since),
      ),
    )
    .orderBy(posts.updatedAt)
    .limit(limit);
}

export interface AutopilotRunEventRow {
  readonly lastRunAt: Date;
  readonly rejected: number;
  readonly approved: number;
}

/** La última corrida del piloto, si fue desde `since` y rechazó algo. */
export async function findRecentAutopilotRejections(
  exec: Executor,
  scope: TenantScope,
  since: Date,
): Promise<AutopilotRunEventRow | null> {
  const rows = await exec
    .select({
      lastRunAt: autopilotRuns.lastRunAt,
      rejected: autopilotRuns.rejected,
      approved: autopilotRuns.approved,
    })
    .from(autopilotRuns)
    .where(
      and(
        eq(autopilotRuns.companyId, scope.companyId),
        gte(autopilotRuns.lastRunAt, since),
        sql`${autopilotRuns.rejected} > 0`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface CampaignEventRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly failureCode: string | null;
}

/** Campañas que pasaron a `REVIEW` (generada) o `FAILED` desde `since`. */
export async function listRecentCampaignEvents(
  exec: Executor,
  scope: TenantScope,
  since: Date,
): Promise<CampaignEventRow[]> {
  return exec
    .select({
      id: automations.id,
      name: automations.name,
      status: automations.status,
      failureCode: automations.failureCode,
    })
    .from(automations)
    .where(
      and(
        eq(automations.companyId, scope.companyId),
        inArray(automations.status, ["REVIEW", "FAILED"]),
        gte(automations.updatedAt, since),
      ),
    )
    .limit(50);
}

export interface ConnectionHealthRow {
  readonly id: string;
  readonly platform: string;
  readonly platformUsername: string;
  readonly displayName: string | null;
  readonly status: string;
  readonly statusReason: string | null;
  readonly tokenExpiry: Date | null;
  readonly refreshTokenExpiry: Date | null;
  readonly tokenIssuedAt: Date | null;
  readonly hasRefreshToken: boolean;
}

/** Lo que hace falta para decidir si una conexión venció o está por vencer. Sin tokens. */
export async function listConnectionsForHealth(
  exec: Executor,
  scope: TenantScope,
): Promise<ConnectionHealthRow[]> {
  return exec
    .select({
      id: connections.id,
      platform: connections.platform,
      platformUsername: connections.platformUsername,
      displayName: connections.displayName,
      status: connections.status,
      statusReason: connections.statusReason,
      tokenExpiry: connections.tokenExpiry,
      refreshTokenExpiry: connections.refreshTokenExpiry,
      tokenIssuedAt: connections.tokenIssuedAt,
      hasRefreshToken: sql<boolean>`${connections.refreshToken} is not null`,
    })
    .from(connections)
    .where(eq(connections.companyId, scope.companyId))
    .orderBy(connections.createdAt);
}

export interface DailySummaryCounts {
  readonly posted: number;
  readonly failed: number;
  readonly draftsWaiting: number;
  readonly scheduledNext24h: number;
  readonly queuedSuggestions: number;
}

/** Los números del resumen diario: el día `[from, to)` y lo que viene. */
export async function readDailySummaryCounts(
  exec: Executor,
  scope: TenantScope,
  range: { readonly from: Date; readonly to: Date },
): Promise<DailySummaryCounts> {
  const next24 = new Date(range.to.getTime() + 86_400_000);
  const rows = (await exec.execute(sql`
    select
      (select count(*)::int from posts
         where company_id = ${scope.companyId}::uuid and status = 'POSTED'
           and posted_at >= ${range.from.toISOString()}::timestamptz and posted_at < ${range.to.toISOString()}::timestamptz) as posted,
      (select count(*)::int from posts
         where company_id = ${scope.companyId}::uuid and status = 'FAILED'
           and updated_at >= ${range.from.toISOString()}::timestamptz and updated_at < ${range.to.toISOString()}::timestamptz) as failed,
      (select count(*)::int from posts
         where company_id = ${scope.companyId}::uuid and status = 'IN_USER_INBOX') as drafts,
      (select count(*)::int from posts
         where company_id = ${scope.companyId}::uuid and status = 'SCHEDULED'
           and scheduled_at_utc >= ${range.to.toISOString()}::timestamptz and scheduled_at_utc < ${next24.toISOString()}::timestamptz) as scheduled,
      (select count(*)::int from suggestions
         where company_id = ${scope.companyId}::uuid and status = 'queued') as queued
  `)) as unknown as Array<{
    posted: number;
    failed: number;
    drafts: number;
    scheduled: number;
    queued: number;
  }>;
  const r = rows[0];
  return {
    posted: r?.posted ?? 0,
    failed: r?.failed ?? 0,
    draftsWaiting: r?.drafts ?? 0,
    scheduledNext24h: r?.scheduled ?? 0,
    queuedSuggestions: r?.queued ?? 0,
  };
}

/* ------------------------------------------------------------------------ *
 * Salud de la cola (pg-boss) — `P1-OBS-005`
 * ------------------------------------------------------------------------ */

const SQL_IDENT_RE = /^[a-z_][a-z0-9_]*$/;

export interface QueueHealthRow {
  readonly queue: string;
  /** `waiting`: esperando consumidor; `active`: tomado y colgado; `failed`: dead-letter. */
  readonly kind: "waiting" | "active" | "failed";
  readonly count: number;
  readonly oldest: Date;
}

/**
 * Tres preguntas al esquema de pg-boss (v10, tabla `job`):
 *
 * - **waiting**: `created`/`retry` con `start_after` hace más de
 *   `waitingMinutes`. Es la cola que nadie consume — el modo de falla que
 *   «no falla» (cabecera de `apps/worker/src/main.ts`).
 * - **active**: `active` desde hace más que su propio `expire_in` +
 *   `activeMarginMinutes`. pg-boss expira eso solo; si sigue ahí, el
 *   mantenimiento del worker no está corriendo.
 * - **failed**: `failed` (reintentos agotados = dead-letter) terminados desde
 *   `failedSince`.
 *
 * Las colas internas de pg-boss (`__pgboss__…`) quedan afuera.
 */
export async function readQueueHealth(
  exec: Executor,
  options: {
    readonly schema: string;
    readonly waitingMinutes: number;
    readonly activeMarginMinutes: number;
    readonly failedSince: Date;
  },
): Promise<QueueHealthRow[]> {
  if (!SQL_IDENT_RE.test(options.schema)) {
    throw new Error(`Esquema de cola inválido: ${JSON.stringify(options.schema)}`);
  }
  const job = sql.raw(`"${options.schema}"."job"`);
  const waiting = `${String(Math.max(1, Math.floor(options.waitingMinutes)))} minutes`;
  const margin = `${String(Math.max(0, Math.floor(options.activeMarginMinutes)))} minutes`;
  const rows = (await exec.execute(sql`
    select name as queue, 'waiting' as kind, count(*)::int as count, min(start_after) as oldest
      from ${job}
     where state in ('created', 'retry')
       and start_after < now() - ${waiting}::interval
       and name not like '\_\_pgboss%'
     group by name
    union all
    select name, 'active', count(*)::int, min(started_on)
      from ${job}
     where state = 'active'
       and started_on < now() - expire_in - ${margin}::interval
       and name not like '\_\_pgboss%'
     group by name
    union all
    select name, 'failed', count(*)::int, min(completed_on)
      from ${job}
     where state = 'failed'
       and completed_on >= ${options.failedSince.toISOString()}::timestamptz
       and name not like '\_\_pgboss%'
     group by name
  `)) as unknown as Array<{
    queue: string;
    kind: "waiting" | "active" | "failed";
    count: number;
    oldest: Date | string;
  }>;
  return rows.map((r) => ({
    queue: r.queue,
    kind: r.kind,
    count: r.count,
    oldest: r.oldest instanceof Date ? r.oldest : new Date(r.oldest),
  }));
}
