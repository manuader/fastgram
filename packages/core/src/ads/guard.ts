/**
 * Sync de insights y guardia de topes — sprint 9 (R), `D-21`: *"un job pausa
 * solo lo que llega al tope"*.
 *
 * Es un caso de uso con puertos, no I/O: la base entra por
 * {@link AdsSyncStore} (la implementa `@fastgram/db`) y Meta por
 * `AdsPlatform`. Lo corren el worker (cada {@link ADS_SYNC_INTERVAL_MINUTES})
 * y la API (`POST /ads/sync`, "sincronizar ahora"), con el mismo código.
 *
 * ## La política del corte
 *
 * - Gasto **≥** tope (total o de hoy en la zona de la cuenta) con la campaña
 *   `ACTIVE` → pausar la **campaña** en Meta (apaga todos sus conjuntos),
 *   marcarla `PAUSED` con el motivo, registrar la acción y avisar.
 * - Si pausar en Meta falla, **se avisa igual**, con severidad de error: el
 *   dueño tiene que pausarla a mano. Callar un corte fallido es lo único peor
 *   que no tener guardia.
 * - La guardia evalúa con lo último guardado aunque el sync de esta vuelta
 *   haya fallado: un 5xx de insights no puede apagar la guardia.
 * - No se reanuda sola al día siguiente: reanudar es una confirmación
 *   (`activation.ts`).
 *
 * ## Por qué cada 30 minutos
 *
 * Límite de Meta (Business Use Case, `ads_insights`, tier de desarrollo):
 * *"600 + 400 * Number of Active ads"* llamadas por cuenta por hora
 * (https://developers.facebook.com/docs/marketing-api/overview/rate-limiting).
 * Un sync es una llamada por campaña (`level=ad`, `time_increment=1`, más sus
 * páginas): dos vueltas por hora con diez campañas son ~60 llamadas, un décimo
 * del cupo más chico. Ir más rápido no mejora la guardia: el gasto aparece en
 * los insights con retraso (cuánto, la doc no lo dice: **sin verificar**).
 */
import type { AdInsightRow, AdsAuth, AdsPlatform } from "@fastgram/ports";
import { isAdsPlatformError } from "@fastgram/ports";

import type { SpendCaps } from "./caps.js";

export const ADS_SYNC_INTERVAL_MINUTES = 30;
/** A los 11 y 41: fuera de la hora en punto, donde caen los otros barridos. */
export const ADS_SYNC_CRON = "11,41 * * * *";
/** Una campaña pausada se sigue leyendo 48 h: el gasto llega tarde. */
export const ADS_SYNC_AFTER_PAUSE_MS = 48 * 3_600_000;

export type CapBreach = "daily_cap" | "total_cap";

export function capBreachOf(
  caps: SpendCaps,
  spentTodayMinor: number,
  spentTotalMinor: number,
): CapBreach | null {
  if (spentTotalMinor >= caps.totalCapMinor) return "total_cap";
  if (spentTodayMinor >= caps.dailyCapMinor) return "daily_cap";
  return null;
}

/** `YYYY-MM-DD` de `now` en la zona IANA de la cuenta (UTC si no es válida). */
export function dateInZone(now: Date, timeZone: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export type LocalCampaignStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";

export interface GuardCampaign {
  readonly id: string;
  readonly name: string;
  readonly status: LocalCampaignStatus;
  readonly platformCampaignId: string;
  readonly caps: SpendCaps;
  /** `YYYY-MM-DD`: desde cuándo pedir insights. */
  readonly startDate: string;
  readonly pausedAt: Date | null;
  /** Id de Meta del anuncio → id nuestro. */
  readonly adIdByPlatformId: Readonly<Record<string, string>>;
}

export function shouldSyncCampaign(c: GuardCampaign, now: Date): boolean {
  if (c.status === "ACTIVE") return true;
  if (c.status === "ARCHIVED" || c.pausedAt === null) return false;
  return now.getTime() - c.pausedAt.getTime() <= ADS_SYNC_AFTER_PAUSE_MS;
}

export interface StoredInsight extends Omit<AdInsightRow, "adId"> {
  /** Id nuestro del anuncio. */
  readonly adId: string;
}

export interface AdsSyncStore {
  listCampaigns(): Promise<readonly GuardCampaign[]>;
  /** Upsert por (anuncio, día): el último sync de un día pisa al anterior. */
  saveInsights(campaignId: string, rows: readonly StoredInsight[]): Promise<void>;
  spendOf(
    campaignId: string,
    today: string,
  ): Promise<{ readonly todayMinor: number; readonly totalMinor: number }>;
  /**
   * `ACTIVE` → `PAUSED` con el motivo, y la fila de auditoría. `false` si ya
   * no estaba `ACTIVE` (otra vuelta la pausó): así se avisa una sola vez.
   */
  markCapPaused(
    campaignId: string,
    breach: CapBreach,
    spend: { readonly todayMinor: number; readonly totalMinor: number },
    at: Date,
  ): Promise<boolean>;
  /** Pausar en Meta falló: queda registrado (la campaña sigue `ACTIVE`). */
  recordPauseFailure(
    campaignId: string,
    breach: CapBreach,
    reason: string,
    at: Date,
  ): Promise<void>;
  markSynced(campaignId: string, at: Date, errorReason: string | null): Promise<void>;
}

export interface GuardEvent {
  readonly campaignId: string;
  readonly campaignName: string;
  readonly breach: CapBreach;
  readonly spentMinor: number;
  readonly capMinor: number;
  /** `false`: el tope se pasó y Meta no aceptó la pausa. */
  readonly paused: boolean;
  /** `YYYY-MM-DD` de la zona de la cuenta: va en la clave del aviso. */
  readonly day: string;
}

export interface SyncAndGuardResult {
  readonly synced: number;
  readonly events: readonly GuardEvent[];
  readonly errors: readonly { readonly campaignId: string; readonly reason: string }[];
  /** Se cortó la vuelta (token caído o límite de Meta). */
  readonly stoppedEarly: string | null;
}

const reasonOf = (e: unknown): string =>
  isAdsPlatformError(e) ? e.reason : "unexpected_response";

export async function syncAndGuard(deps: {
  readonly store: AdsSyncStore;
  readonly platform: AdsPlatform;
  readonly auth: AdsAuth;
  readonly now: Date;
  readonly timeZone: string | null;
  readonly currency: string;
}): Promise<SyncAndGuardResult> {
  const { store, platform, auth, now } = deps;
  const today = dateInZone(now, deps.timeZone);
  const events: GuardEvent[] = [];
  const errors: { campaignId: string; reason: string }[] = [];
  let synced = 0;
  let stoppedEarly: string | null = null;

  for (const campaign of await store.listCampaigns()) {
    if (!shouldSyncCampaign(campaign, now)) continue;

    // 1. Insights (si todavía se puede hablar con Meta en esta vuelta).
    if (stoppedEarly === null) {
      try {
        const rows = await platform.getInsights(auth, {
          campaignId: campaign.platformCampaignId,
          since: campaign.startDate <= today ? campaign.startDate : today,
          until: today,
          currency: deps.currency,
        });
        const mapped: StoredInsight[] = [];
        for (const r of rows) {
          const adId = campaign.adIdByPlatformId[r.adId];
          if (adId !== undefined) mapped.push({ ...r, adId });
        }
        await store.saveInsights(campaign.id, mapped);
        await store.markSynced(campaign.id, now, null);
        synced += 1;
      } catch (e: unknown) {
        const reason = reasonOf(e);
        errors.push({ campaignId: campaign.id, reason });
        await store.markSynced(campaign.id, now, reason);
        if (reason === "unauthorized" || reason === "rate_limited") stoppedEarly = reason;
      }
    }

    // 2. Guardia, con lo último guardado.
    if (campaign.status !== "ACTIVE") continue;
    const spend = await store.spendOf(campaign.id, today);
    const breach = capBreachOf(campaign.caps, spend.todayMinor, spend.totalMinor);
    if (breach === null) continue;
    const base = {
      campaignId: campaign.id,
      campaignName: campaign.name,
      breach,
      spentMinor: breach === "total_cap" ? spend.totalMinor : spend.todayMinor,
      capMinor:
        breach === "total_cap"
          ? campaign.caps.totalCapMinor
          : campaign.caps.dailyCapMinor,
      day: today,
    };
    try {
      await platform.setStatus(auth, campaign.platformCampaignId, "PAUSED");
    } catch (e: unknown) {
      await store.recordPauseFailure(campaign.id, breach, reasonOf(e), now);
      events.push({ ...base, paused: false });
      continue;
    }
    if (await store.markCapPaused(campaign.id, breach, spend, now)) {
      events.push({ ...base, paused: true });
    }
  }
  return { synced, events, errors, stoppedEarly };
}
