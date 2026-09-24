/**
 * De los hechos en la base a los avisos — `P5-NOTIF-004`, `P3-OAUTH-005/011`.
 *
 * ## Por qué mirar la base y no enganchar cada handler
 *
 * Los hechos que se avisan ya quedan escritos: un post llega a `POSTED`,
 * `FAILED` o `IN_USER_INBOX`; el piloto guarda su corrida con cuántas
 * rechazó; una campaña pasa a `REVIEW` o `FAILED`. Mirar esas filas —en vez de
 * poner una llamada en cada camino que las escribe— cubre **todos** los
 * productores, incluidos los que no son handlers del worker (la API marca
 * posts publicados a mano; el barrido vence `AWAITING_RECONNECT` a `FAILED`),
 * y un camino nuevo no se queda sin aviso por olvido.
 *
 * La ventana ({@link NOTIFICATION_EVENTS_LOOKBACK_MS}) se solapa entre
 * vueltas a propósito; lo que ya se avisó lo descarta el índice único de
 * `dedupe_key` (`0028`). Es también lo que hace que un worker que estuvo
 * caído avise, al volver, lo que pasó en las últimas horas.
 */
import {
  NOTIFICATION_EVENTS_LOOKBACK_MS,
  assessConnectionHealth,
  dailySummaryWindow,
  describeNotification,
  type NotificationSettings,
} from "@fastgram/core";
import {
  findRecentAutopilotRejections,
  listConnectionsForHealth,
  listRecentCampaignEvents,
  listRecentPostEvents,
  readDailySummaryCounts,
  withCompany,
  type Database,
  type NotificationBrandRow,
  type Transaction,
} from "@fastgram/db";

import type { Notifier } from "./notifier.js";

export interface DetectorDeps {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly notifier: Notifier;
}

function inBrand<T>(
  deps: DetectorDeps,
  companyId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withCompany(
    deps.db,
    companyId,
    fn,
    deps.appRole === undefined ? {} : { role: deps.appRole },
  );
}

/** Posts, piloto y campañas de una marca. Devuelve cuántos avisos nuevos escribió. */
export async function detectBrandEvents(
  deps: DetectorDeps,
  brand: NotificationBrandRow,
  nowMs: number,
  settings: NotificationSettings,
): Promise<number> {
  const since = new Date(nowMs - NOTIFICATION_EVENTS_LOOKBACK_MS);
  const scope = { companyId: brand.companyId };
  const facts = await inBrand(deps, brand.companyId, async (tx) => ({
    posts: await listRecentPostEvents(tx, scope, since),
    autopilot: await findRecentAutopilotRejections(tx, scope, since),
    campaigns: await listRecentCampaignEvents(tx, scope, since),
  }));

  let written = 0;
  const write = async (draft: Parameters<Notifier["write"]>[1]): Promise<void> => {
    if (await deps.notifier.write(brand.companyId, draft, settings)) written += 1;
  };

  for (const post of facts.posts) {
    if (
      post.status !== "POSTED" &&
      post.status !== "FAILED" &&
      post.status !== "IN_USER_INBOX"
    )
      continue;
    await write(
      describeNotification({
        kind: "post",
        brand: brand.name,
        postId: post.id,
        status: post.status,
        platform: post.platform,
        username: post.connectionUsername,
        errorMessage: post.errorMessage,
      }),
    );
  }
  if (facts.autopilot !== null) {
    await write(
      describeNotification({
        kind: "autopilot_rejected",
        brand: brand.name,
        rejected: facts.autopilot.rejected,
        runAt: facts.autopilot.lastRunAt,
      }),
    );
  }
  for (const campaign of facts.campaigns) {
    if (campaign.status !== "REVIEW" && campaign.status !== "FAILED") continue;
    await write(
      describeNotification({
        kind: "campaign",
        brand: brand.name,
        automationId: campaign.id,
        name: campaign.name,
        status: campaign.status,
      }),
    );
  }
  return written;
}

/**
 * Conexiones vencidas o por vencer. Una vencida se recuerda **una vez por
 * día** (la clave lleva el día UTC) mientras siga vencida: es la que frena
 * las publicaciones. Una por vencer, una vez por fecha de vencimiento.
 */
export async function detectConnectionHealth(
  deps: DetectorDeps,
  brand: NotificationBrandRow,
  nowMs: number,
  settings: NotificationSettings,
): Promise<number> {
  const rows = await inBrand(deps, brand.companyId, (tx) =>
    listConnectionsForHealth(tx, { companyId: brand.companyId }),
  );
  const today = new Date(nowMs).toISOString().slice(0, 10);
  let written = 0;
  for (const row of rows) {
    const health = assessConnectionHealth(row, nowMs);
    if (health.state === "ok") continue;
    const username = row.displayName ?? row.platformUsername;
    const draft =
      health.state === "expired"
        ? describeNotification({
            kind: "connection_expired",
            brand: brand.name,
            connectionId: row.id,
            platform: row.platform,
            username,
            reason: row.status === "active" ? health.reason : row.status,
            sinceDay: today,
          })
        : describeNotification({
            kind: "connection_expiring",
            brand: brand.name,
            connectionId: row.id,
            platform: row.platform,
            username,
            deadline: health.deadline,
          });
    if (await deps.notifier.write(brand.companyId, draft, settings)) written += 1;
  }
  return written;
}

/**
 * El resumen del día anterior, a partir de la hora configurada **local de la
 * marca**. Un día sin nada (todo en cero) no se avisa: sería ruido.
 */
export async function detectDailySummary(
  deps: DetectorDeps,
  brand: NotificationBrandRow,
  nowMs: number,
  settings: NotificationSettings,
): Promise<boolean> {
  const window = dailySummaryWindow(nowMs, brand.timezone, settings.dailySummaryHour);
  if (window === null) return false;
  const counts = await inBrand(deps, brand.companyId, (tx) =>
    readDailySummaryCounts(
      tx,
      { companyId: brand.companyId },
      { from: new Date(window.fromMs), to: new Date(window.toMs) },
    ),
  );
  const total =
    counts.posted +
    counts.failed +
    counts.draftsWaiting +
    counts.scheduledNext24h +
    counts.queuedSuggestions;
  if (total === 0) return false;
  return deps.notifier.write(
    brand.companyId,
    describeNotification({
      kind: "daily_summary",
      brand: brand.name,
      day: window.day,
      ...counts,
    }),
    settings,
  );
}
