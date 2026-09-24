/**
 * Los barridos de notificaciones del worker — `P5-NOTIF-001…004`,
 * `P1-OBS-005`. Tres timers del proceso, **no** jobs de pg-boss:
 *
 * | Vuelta | Cada | Qué hace |
 * |---|---|---|
 * | eventos | 30 s | posts, piloto y campañas por marca (`detectors.ts`) y despacha el push (`delivery.ts`) |
 * | lenta | 15 min | conexiones vencidas/por vencer y resumen diario |
 * | cola | 5 min | cola atascada y dead-letter (`queue-health.ts`) |
 *
 * ## Por qué timers y no colas con cron
 *
 * 1. La salud de la cola no puede depender de la cola (ver `queue-health.ts`).
 * 2. Agregar colas toca `JOB_QUEUES` en `core/jobs/queues.ts` y el catálogo,
 *    compartidos con los otros agentes del sprint; y los barridos son
 *    idempotentes por la `dedupe_key`, así que no necesitan la entrega
 *    exactamente-una-vez de pg-boss.
 *
 * Con más de un worker (VPS con réplicas) cada réplica correría los timers:
 * la campana no duplica (índice único) pero el push podría salir dos veces.
 * Para la instalación personal (un worker, D-06) no pasa. Está en el reporte.
 *
 * Una vuelta nunca se solapa consigo misma (bandera `running`) y un error en
 * una marca no corta las demás: se loguea y sigue.
 */
import {
  NOTIFICATION_EVENTS_EVERY_MS,
  NOTIFICATION_SLOW_SWEEP_EVERY_MS,
  QUEUE_HEALTH_EVERY_MS,
} from "@fastgram/core";
import {
  listNotificationBrands,
  withoutCompany,
  type Database,
  type NotificationBrandRow,
} from "@fastgram/db";
import type { Clock } from "@fastgram/ports";
import type { sendNtfy, sendTelegram } from "@fastgram/adapters";

import type { BuildLogger } from "../content/build-handler.js";
import { deliverPendingPushes } from "./delivery.js";
import {
  detectBrandEvents,
  detectConnectionHealth,
  detectDailySummary,
} from "./detectors.js";
import type { Notifier } from "./notifier.js";
import { checkQueueHealth } from "./queue-health.js";

export interface MonitorDeps {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly clock: Clock;
  readonly notifier: Notifier;
  readonly queueSchema: string;
  readonly sendNtfy: typeof sendNtfy;
  readonly sendTelegram: typeof sendTelegram;
  readonly webBaseUrl: string;
  /**
   * Qué marcas barrer. Default: todas las vivas (`app.notification_brands()`).
   * Los tests lo acotan a las suyas: la base de test es compartida.
   */
  readonly listBrands?: () => Promise<NotificationBrandRow[]>;
}

export interface NotificationMonitor {
  /** Una vuelta de cada barrido, en orden. Para tests y para el arranque. */
  runOnce(): Promise<void>;
  stop(): void;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

export function createNotificationMonitor(deps: MonitorDeps): {
  events(): Promise<void>;
  slow(): Promise<void>;
  queue(): Promise<void>;
} {
  const brands = (): Promise<NotificationBrandRow[]> =>
    deps.listBrands?.() ??
    withoutCompany(
      deps.db,
      (tx) => listNotificationBrands(tx),
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );

  return {
    async events() {
      const nowMs = deps.clock.nowMs();
      const settings = await deps.notifier.settings();
      for (const brand of await brands()) {
        try {
          await detectBrandEvents(deps, brand, nowMs, settings);
          await deliverPendingPushes(deps, brand.companyId, nowMs, settings);
        } catch (error: unknown) {
          deps.logger.error(
            { companyId: brand.companyId, err: errText(error) },
            "notificaciones: falló la vuelta de eventos de una marca",
          );
        }
      }
    },
    async slow() {
      const nowMs = deps.clock.nowMs();
      const settings = await deps.notifier.settings();
      for (const brand of await brands()) {
        try {
          await detectConnectionHealth(deps, brand, nowMs, settings);
          await detectDailySummary(deps, brand, nowMs, settings);
        } catch (error: unknown) {
          deps.logger.error(
            { companyId: brand.companyId, err: errText(error) },
            "notificaciones: falló la vuelta lenta de una marca",
          );
        }
      }
    },
    async queue() {
      const nowMs = deps.clock.nowMs();
      const settings = await deps.notifier.settings();
      const out = await checkQueueHealth(deps, await brands(), nowMs, settings);
      if (out.problems > 0) {
        deps.logger.warn({ ...out }, "salud de la cola: hay jobs atascados o fallidos");
      }
    },
  };
}

/** Arranca los tres timers. `unref`: no mantienen vivo el proceso al apagar. */
export function startNotificationMonitor(deps: MonitorDeps): NotificationMonitor {
  const sweeps = createNotificationMonitor(deps);
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let stopped = false;

  const every = (
    name: string,
    ms: number,
    fn: () => Promise<void>,
  ): (() => Promise<void>) => {
    let running = false;
    const tick = async (): Promise<void> => {
      if (running || stopped) return;
      running = true;
      try {
        await fn();
      } catch (error: unknown) {
        deps.logger.error(
          { sweep: name, err: errText(error) },
          "notificaciones: falló un barrido",
        );
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void tick(), ms);
    timer.unref();
    timers.push(timer);
    return tick;
  };

  const events = every("events", NOTIFICATION_EVENTS_EVERY_MS, sweeps.events);
  const slow = every("slow", NOTIFICATION_SLOW_SWEEP_EVERY_MS, sweeps.slow);
  const queue = every("queue", QUEUE_HEALTH_EVERY_MS, sweeps.queue);

  return {
    async runOnce() {
      await events();
      await slow();
      await queue();
    },
    stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
    },
  };
}
