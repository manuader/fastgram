/**
 * Auto-slot desde el worker — `PU-AUTO-002` (`PU-CAL-001` sin la ruta).
 *
 * Misma decisión que `POST /content/:id/autoschedule`: `planAutoSlots` de
 * `core` sobre lo ocupado en **todas** las marcas del dueño (separación entre
 * marcas, §5.3), con el lock por dueño **antes** de leer
 * (`calendarLocks.lockOwner`), y cada marca hermana leída con su propio scope.
 *
 * ## Sólo slots planificados, nunca posts
 *
 * La ruta crea un `Post` directo cuando la red tiene una conexión activa
 * única. Acá no: la pieza recién aceptada está en `BUILDING`, y el barrido de
 * publicación (`publishing-sweep`, `convertSlots`) es quien convierte un slot
 * en post **cuando la pieza ya está `CREATED`** y la marca tiene la conexión.
 * Reusar ese camino evita una tercera copia de «crear el post y su job de
 * publicación» (la API tiene `schedulePostsInTx`; el barrido, la suya). El
 * handler del piloto encola el barrido de la marca después de aprobar.
 */
import {
  AUTO_SLOT_HORIZON_DAYS,
  planAutoSlots,
  type OccupiedSlot,
  type SlotStrategy,
  type StrategyNetwork,
} from "@fastgram/core";
import {
  CALENDAR_IDLE_POST_STATUSES,
  calendarLocks,
  plannedSlotRepository,
  postCalendar,
  withCompany,
  type Database,
  type Executor,
  type Transaction,
} from "@fastgram/db";

const DAY_MS = 86_400_000;

export interface ScheduledSlot {
  readonly network: StrategyNetwork;
  readonly atMs: number;
}

/** Lo ocupado de una marca en `[from, to)`: posts no terminales y slots planificados. */
export async function occupiedOf(
  exec: Executor,
  brandId: string,
  fromMs: number,
  toMs: number,
): Promise<OccupiedSlot[]> {
  const scope = { companyId: brandId };
  const range = { fromMs, toMs, limit: 5000 };
  const out: OccupiedSlot[] = [];
  const posts = await postCalendar.listInRange(exec, scope, {
    ...range,
    excludeStatuses: [...CALENDAR_IDLE_POST_STATUSES],
  });
  for (const post of posts) {
    out.push({
      brandId,
      network: post.platform,
      atMs: (post.postedAt ?? post.scheduledAtUtc).getTime(),
    });
  }
  for (const slot of await plannedSlotRepository.listInRange(exec, scope, range)) {
    out.push({ brandId, network: slot.network, atMs: slot.scheduledAtUtc.getTime() });
  }
  return out;
}

/**
 * Agenda `contentId` en el próximo horario libre de cada red activa. Corre en
 * `tx` (la de la aceptación), con el scope de la marca.
 */
export async function scheduleForAutopilot(
  tx: Transaction,
  args: {
    readonly db: Database;
    readonly appRole: string | undefined;
    readonly companyId: string;
    /** Clave del lock y de "las marcas del dueño". */
    readonly ownerKey: string;
    /** Las otras marcas del mismo dueño (sin la propia). */
    readonly siblings: readonly string[];
    readonly contentId: string;
    readonly strategy: SlotStrategy;
    readonly nowMs: number;
  },
): Promise<ScheduledSlot[]> {
  // Primero el lock, después cualquier lectura (ver `calendarLocks.lockOwner`).
  await calendarLocks.lockOwner(tx, args.ownerKey);

  const fromMs = args.nowMs - DAY_MS;
  const toMs = args.nowMs + (AUTO_SLOT_HORIZON_DAYS + 2) * DAY_MS;
  const occupied = await occupiedOf(tx, args.companyId, fromMs, toMs);
  for (const brandId of args.siblings) {
    occupied.push(
      ...(await withCompany(
        args.db,
        brandId,
        (other) => occupiedOf(other, brandId, fromMs, toMs),
        args.appRole === undefined ? {} : { role: args.appRole },
      )),
    );
  }

  const outcomes = planAutoSlots({
    strategy: args.strategy,
    brandId: args.companyId,
    contentId: args.contentId,
    nowMs: args.nowMs,
    occupied,
  });

  const scheduled: ScheduledSlot[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind !== "slot") continue;
    await plannedSlotRepository.create(
      tx,
      { companyId: args.companyId },
      {
        contentId: args.contentId,
        network: outcome.slot.network,
        scheduledAtUtc: new Date(outcome.slot.atMs),
      },
    );
    scheduled.push({ network: outcome.slot.network, atMs: outcome.slot.atMs });
  }
  return scheduled;
}
