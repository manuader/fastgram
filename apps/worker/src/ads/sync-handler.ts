/**
 * `ads-sync` — sprint 9 (R), `D-21`: sync de insights y **guardia de topes**
 * de las campañas pagas, cada {@link ADS_SYNC_INTERVAL_MINUTES} minutos
 * (`ADS_SYNC_CRON`; el porqué del número está en `core/ads/guard.ts`: límite
 * BUC de `ads_insights` del tier de desarrollo).
 *
 * ## Qué hace una vuelta
 *
 * 1. Las marcas con cuenta publicitaria activa (`app.ads_sync_brands()`,
 *    `SECURITY DEFINER`, sin tenant).
 * 2. Por marca, con **su** scope (RLS): descifra el token, corre
 *    `syncAndGuard` (el mismo código que `POST /ads/sync` de la API) y, si
 *    Meta dijo que el token no sirve más, marca la cuenta `expired`.
 * 3. Cada corte (o corte fallido) se avisa con el sistema existente
 *    (`notifications/notifier.ts`: campana + ntfy/Telegram), categoría
 *    `ad_spend_cap`. El aviso va **después** de la transacción de la marca:
 *    un INSERT fallido no puede deshacer la pausa (misma regla que `notify`).
 *
 * Todas las marcas en el mismo job, en serie: en uso personal son pocas y una
 * vuelta son unas pocas llamadas por campaña. Una marca que falla no corta a
 * las otras, y el job no lanza: la próxima vuelta es el reintento.
 *
 * ## Reintentos
 *
 * - `rate_limited` / token caído: `syncAndGuard` deja de pedir insights para
 *   esa marca en esta vuelta pero **sigue evaluando topes** con lo guardado.
 * - Transitorios (5xx, timeout): la campaña queda con `last_sync_error` y se
 *   reintenta a los 30 min. No hay reintento más rápido a propósito: repetir
 *   en segundos contra un límite BUC lo empeora.
 */
import {
  ADS_SYNC_INTERVAL_MINUTES,
  describeAdCapEvent,
  syncAndGuard,
  type AdsSyncStore,
  type GuardEvent,
  type NotificationDraft,
} from "@fastgram/core";
import {
  adAccountRepository,
  adsSyncStore,
  listAdsSyncBrands,
  withCompany,
  withoutCompany,
  type Database,
} from "@fastgram/db";
import type {
  AdsPlatform,
  Clock,
  JobContext,
  JobHandler,
  TokenCipher,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";

export interface AdsSyncDeps {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly clock: Clock;
  readonly logger: BuildLogger;
  readonly cipher: TokenCipher;
  /** `meta` = Marketing API; `fake` = modo demo (sin gasto posible). */
  readonly platforms: { readonly meta: AdsPlatform; readonly fake: AdsPlatform };
  /** El notifier del worker (`notifier.write`). `false` si no escribió. */
  readonly notify: (companyId: string, draft: NotificationDraft) => Promise<boolean>;
}

export interface AdsSyncSummary {
  readonly brands: number;
  readonly synced: number;
  readonly paused: number;
  readonly pauseFailed: number;
  readonly failedBrands: number;
}

export function createAdsSyncHandler(deps: AdsSyncDeps): JobHandler<unknown> {
  return async (_job: JobContext<unknown>) => {
    await runAdsSync(deps);
  };
}

export async function runAdsSync(deps: AdsSyncDeps): Promise<AdsSyncSummary> {
  const role = deps.appRole === undefined ? {} : { role: deps.appRole };
  const brands = await withoutCompany(deps.db, (tx) => listAdsSyncBrands(tx));
  let synced = 0;
  let paused = 0;
  let pauseFailed = 0;
  let failedBrands = 0;

  for (const brand of brands) {
    const companyId = brand.companyId;
    let events: readonly GuardEvent[] = [];
    let currency = "USD";
    try {
      const out = await withCompany(
        deps.db,
        companyId,
        async (tx) => {
          const scope = { companyId };
          const account = await adAccountRepository.load(tx, scope);
          if (
            account?.status !== "active" ||
            account.adAccountId === null ||
            account.currency === null
          )
            return null;
          const platform =
            account.provider === "fake" ? deps.platforms.fake : deps.platforms.meta;
          let accessToken = "demo";
          if (account.provider !== "fake") {
            if (account.accessToken === null) return null;
            accessToken = await deps.cipher.decrypt(account.accessToken);
          }
          const store: AdsSyncStore = adsSyncStore(tx, scope);
          const now = deps.clock.now();
          const result = await syncAndGuard({
            store,
            platform,
            auth: { accessToken, adAccountId: account.adAccountId },
            now,
            timeZone: account.timezoneName,
            currency: account.currency,
          });
          if (result.stoppedEarly === "unauthorized")
            await adAccountRepository.setStatus(tx, scope, "expired", now);
          return { result, currency: account.currency };
        },
        role,
      );
      if (out === null) continue;
      events = out.result.events;
      currency = out.currency;
      synced += out.result.synced;
      if (out.result.errors.length > 0 || out.result.stoppedEarly !== null) {
        deps.logger.warn(
          {
            companyId,
            errors: out.result.errors.map((e) => e.reason),
            stoppedEarly: out.result.stoppedEarly,
          },
          "ads-sync: insights incompletos (la guardia evaluó con lo guardado)",
        );
      }
    } catch (error: unknown) {
      failedBrands += 1;
      deps.logger.error(
        { companyId, err: error instanceof Error ? error.name : "unknown" },
        "ads-sync: la marca falló; la próxima vuelta reintenta",
      );
      continue;
    }

    for (const event of events) {
      if (event.paused) paused += 1;
      else pauseFailed += 1;
      try {
        await deps.notify(companyId, describeAdCapEvent(brand.name, event, currency));
      } catch (error: unknown) {
        deps.logger.warn(
          {
            companyId,
            campaignId: event.campaignId,
            err: error instanceof Error ? error.name : "unknown",
          },
          "ads-sync: no se pudo escribir el aviso del corte",
        );
      }
      deps.logger.info(
        {
          companyId,
          campaignId: event.campaignId,
          breach: event.breach,
          paused: event.paused,
        },
        event.paused
          ? "ads-sync: campaña pausada por tope"
          : "ads-sync: tope alcanzado y la pausa falló",
      );
    }
  }
  return { brands: brands.length, synced, paused, pauseFailed, failedBrands };
}

export { ADS_SYNC_INTERVAL_MINUTES };
