/**
 * Salud de la cola — `P1-OBS-005` (cola atascada y dead-letter).
 *
 * Pregunta directo a las tablas de pg-boss (`readQueueHealth`, el porqué de
 * cada pregunta está ahí) y convierte cada problema en un aviso. Los números
 * (N = {@link QUEUE_WAITING_ALERT_MINUTES} minutos esperando, margen de
 * {@link QUEUE_ACTIVE_MARGIN_MINUTES} sobre el `expire_in` de un job activo)
 * están en `core/notifications/schedule.ts` con su razón.
 *
 * **No es un job de pg-boss, a propósito.** Corre en un timer del proceso: un
 * chequeo de la cola que viaja por la cola no avisaría justo cuando la cola
 * no despacha.
 *
 * Los avisos de cola no son de una marca. Van a la **marca más vieja de cada
 * dueño** (la primera de `app.notification_brands()`), que es la que la
 * campana muestra igual porque lista todas las del dueño.
 */
import {
  QUEUE_ACTIVE_MARGIN_MINUTES,
  QUEUE_HEALTH_EVERY_MS,
  QUEUE_WAITING_ALERT_MINUTES,
  describeNotification,
  queueAlertBucket,
  type NotificationSettings,
} from "@fastgram/core";
import {
  readQueueHealth,
  withoutCompany,
  type Database,
  type NotificationBrandRow,
  type QueueHealthRow,
} from "@fastgram/db";

import type { Notifier } from "./notifier.js";

export interface QueueHealthDeps {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly queueSchema: string;
  readonly notifier: Notifier;
}

/** La marca más vieja de cada dueño (la lista ya viene por `created_at`). */
export function homeBrandsOf(
  brands: readonly NotificationBrandRow[],
): NotificationBrandRow[] {
  const seen = new Set<string>();
  const out: NotificationBrandRow[] = [];
  for (const brand of brands) {
    if (seen.has(brand.ownerUserId)) continue;
    seen.add(brand.ownerUserId);
    out.push(brand);
  }
  return out;
}

export async function readQueueProblems(
  deps: Pick<QueueHealthDeps, "db" | "appRole" | "queueSchema">,
  nowMs: number,
): Promise<QueueHealthRow[]> {
  return withoutCompany(
    deps.db,
    (tx) =>
      readQueueHealth(tx, {
        schema: deps.queueSchema,
        waitingMinutes: QUEUE_WAITING_ALERT_MINUTES,
        activeMarginMinutes: QUEUE_ACTIVE_MARGIN_MINUTES,
        // Tres vueltas hacia atrás: un fallo no se pierde si una vuelta se
        // saltea; la repetición la descarta el cubo de la clave.
        failedSince: new Date(nowMs - 3 * QUEUE_HEALTH_EVERY_MS),
      }),
    deps.appRole === undefined ? {} : { role: deps.appRole },
  );
}

export async function checkQueueHealth(
  deps: QueueHealthDeps,
  brands: readonly NotificationBrandRow[],
  nowMs: number,
  settings: NotificationSettings,
): Promise<{ readonly problems: number; readonly written: number }> {
  const problems = await readQueueProblems(deps, nowMs);
  let written = 0;
  if (problems.length === 0) return { problems: 0, written };
  for (const home of homeBrandsOf(brands)) {
    for (const p of problems) {
      const draft = describeNotification({
        kind: "queue",
        queue: p.queue,
        problem: p.kind,
        count: p.count,
        oldest: p.oldest,
        bucket: queueAlertBucket(p.kind, nowMs),
      });
      if (await deps.notifier.write(home.companyId, draft, settings)) written += 1;
    }
  }
  return { problems: problems.length, written };
}
