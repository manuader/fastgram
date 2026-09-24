/**
 * `metrics-sync` — `PU-AUTO-004` (`= P3-METRIC-001`), PRD §9.5 #10, `FR-120`,
 * `NFR-016`. La cola existía en el catálogo desde el principio y no tenía
 * handler: las métricas de los posts quedaban en 0 para siempre.
 *
 * ## Dos payloads, como el piloto
 *
 * - `{}` — **el barrido del cron** (cada hora, `METRICS_SYNC_CRON`). Pide las
 *   marcas con trabajo (`app.metrics_sync_brands`, `SECURITY DEFINER`: sólo
 *   ids) y encola una corrida por marca con clave por hora. Sin cola (tests),
 *   corre cada marca en el mismo job.
 * - `{companyId}` — **una marca**: sincroniza sus posts debidos y, si tiene
 *   el auto-tune prendido y le toca (semanal), ajusta el mix.
 *
 * Una corrida por marca y no todas en el job del cron: el catálogo le da 120 s
 * a cada job, y una marca con 100 posts debidos en tres redes de Meta (un GET
 * por post, 4 en vuelo, 20 s de timeout) puede pasarlos sola.
 *
 * ## Qué es «debido» y qué se escribe
 *
 * La política está en `core` (`isMetricsSyncDue`): 1 h en las primeras 48 h,
 * 24 h después, 24 h siempre en X (cobra), ventana de 30 días. Por post:
 *
 * - vino → `writeMetrics`: valores, `metricsSyncedAt`, y en `metricsMissing`
 *   las que la red no dio (su 0 no es un dato, `NFR-016`).
 * - la plataforma no lo conoce → `not_found_on_platform`.
 * - existe pero sin métricas → `metrics_unavailable`.
 * - token vencido o revocado → `metrics_reconnect_required`.
 * - sin el scope de insights (conexión anterior a este sprint) →
 *   `metrics_permission_missing`.
 *
 * Un error **nunca** borra lo último bueno: `markError` no toca los números
 * ni `metricsSyncedAt`. Un transitorio (límite, timeout, 5xx) no escribe
 * nada y el post sigue debido: lo retoma la próxima hora. El job no se relanza
 * por eso: reintentarlo en 5 min volvería a leer todo lo que ya se leyó.
 *
 * TikTok (y cualquier red sin adaptador montado, como X sin
 * `METRICS_X_ENABLED`) no se toca: el post queda pre-sync, que es verdad.
 */
import {
  DEFAULT_BLITZ_PREFERENCES,
  MIX_FORMATS,
  MIX_FORMAT_WEIGHT_FIELD,
  isMetricsSyncDue,
  isMixTuningDue,
  metricsWindowStartMs,
  proposeFormatWeights,
  selectMixSamples,
  type FormatWeights,
  type MixFormat,
} from "@fastgram/core";
import {
  blitzPreferencesRepository,
  metricsStore,
  mixTuningStore,
  withCompany,
  withoutCompany,
  type AnalyticsPostRow,
  type Database,
  type MetricsSyncPostRow,
  type PostMetricColumn,
  type Transaction,
} from "@fastgram/db";
import {
  isPortError,
  type Clock,
  type ConnectionTokens,
  type JobContext,
  type JobHandler,
  type JobSpec,
  type Queue,
  type SocialMetrics,
} from "@fastgram/ports";
import { JOB_QUEUES } from "@fastgram/core";

import type { BuildLogger } from "../content/build-handler.js";

/** Códigos estables de `posts.metricsErrorCode`. La web los traduce. */
export const METRICS_ERROR_CODES = [
  "metrics_reconnect_required",
  "metrics_permission_missing",
  "metrics_unavailable",
  "not_found_on_platform",
] as const;
export type MetricsErrorCode = (typeof METRICS_ERROR_CODES)[number];

/** Posts por marca que se miran en una corrida. 30 días × 5 redes × 3/día ≈ 450. */
export const METRICS_SYNC_POSTS_PER_BRAND = 1000;
/** Posts medidos que se leen para el auto-tune (luego `selectMixSamples` elige). */
const MIX_CANDIDATES_LIMIT = 1000;

export interface MetricsSyncDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  /** Por `posts.platform`. Una red ausente no se sincroniza. */
  readonly adapters: Readonly<Record<string, SocialMetrics>>;
  /** `null` = sin tokens: nada se puede leer, sólo corre el auto-tune. */
  readonly tokens: ConnectionTokens | null;
  /** Para repartir el barrido en un job por marca. Sin ella, todo en línea. */
  readonly queue?: Queue | undefined;
}

export interface BrandSyncResult {
  readonly due: number;
  readonly synced: number;
  readonly errors: Readonly<Partial<Record<MetricsErrorCode, number>>>;
  /** Transitorios: quedaron debidos para la próxima hora. */
  readonly deferred: number;
  /** Posts de redes sin adaptador (TikTok, X apagado). */
  readonly unsupported: number;
}

export type MixTuningRun =
  | { readonly kind: "off" }
  | { readonly kind: "not_due" }
  | { readonly kind: "ran"; readonly outcome: string };

function parsePayload(payload: unknown): { companyId?: string } | null {
  if (payload === null || payload === undefined) return {};
  if (typeof payload !== "object") return null;
  const companyId = (payload as Record<string, unknown>)["companyId"];
  if (companyId === undefined) return {};
  return typeof companyId === "string" && companyId.length > 0 ? { companyId } : null;
}

export function metricsSyncJob(
  companyId: string,
  nowMs: number,
): JobSpec<{ companyId: string }> {
  const hour = Math.floor(nowMs / 3_600_000);
  return {
    queue: JOB_QUEUES.metricsSync,
    payload: { companyId },
    // Una corrida por marca por hora: dos barridos en la misma hora (reinicio
    // del worker) no duplican lecturas, que en X se pagan.
    options: { singletonKey: `${JOB_QUEUES.metricsSync}:${companyId}:${String(hour)}` },
  };
}

function errorCodeFor(error: unknown): MetricsErrorCode | "transient" {
  if (!isPortError(error)) return "transient";
  switch (error.code) {
    case "unauthorized":
    case "not_found":
      return "metrics_reconnect_required";
    case "forbidden":
      return "metrics_permission_missing";
    case "provider_contract_violation":
    case "bad_request":
      return "metrics_unavailable";
    default:
      return "transient";
  }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function weightsOf(row: {
  slideshowWeight: number;
  wallOfTextWeight: number;
  greenScreenWeight: number;
  videoHookWeight: number;
}): FormatWeights {
  const out = {} as Record<MixFormat, number>;
  for (const f of MIX_FORMATS) out[f] = row[MIX_FORMAT_WEIGHT_FIELD[f]];
  return out;
}

function metricOrNull(row: AnalyticsPostRow, m: PostMetricColumn): number | null {
  return row.metricsMissing.includes(m) ? null : row[m];
}

export function createMetricsSyncHandler(deps: MetricsSyncDeps): JobHandler<unknown> {
  const inCompany = <T>(
    companyId: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> =>
    withCompany(
      deps.db,
      companyId,
      fn,
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );

  async function syncBrand(companyId: string, nowMs: number): Promise<BrandSyncResult> {
    const scope = { companyId };
    const since = new Date(metricsWindowStartMs(nowMs));
    const all = await inCompany(companyId, (tx) =>
      metricsStore.listSyncable(tx, scope, since, METRICS_SYNC_POSTS_PER_BRAND),
    );

    let unsupported = 0;
    const due: MetricsSyncPostRow[] = [];
    for (const post of all) {
      const adapter = deps.adapters[post.platform];
      if (adapter === undefined) {
        unsupported += 1;
        continue;
      }
      if (
        isMetricsSyncDue(
          {
            postedAtMs: post.postedAt.getTime(),
            syncedAtMs: post.metricsSyncedAt?.getTime() ?? null,
            costPerPostReadUsd: adapter.capabilities().costPerPostReadUsd,
          },
          nowMs,
        )
      ) {
        due.push(post);
      }
    }

    const errors: Partial<Record<MetricsErrorCode, number>> = {};
    let synced = 0;
    let deferred = 0;
    const markError = async (ids: readonly string[], code: MetricsErrorCode) => {
      if (ids.length === 0) return;
      await inCompany(companyId, (tx) => metricsStore.markError(tx, scope, ids, code));
      errors[code] = (errors[code] ?? 0) + ids.length;
    };

    if (deps.tokens === null) {
      return { due: due.length, synced, errors, deferred: due.length, unsupported };
    }

    const byConnection = new Map<string, MetricsSyncPostRow[]>();
    for (const post of due) {
      const list = byConnection.get(post.connectionId) ?? [];
      list.push(post);
      byConnection.set(post.connectionId, list);
    }

    for (const [connectionId, group] of byConnection) {
      const first = group[0];
      const adapter = first === undefined ? undefined : deps.adapters[first.platform];
      if (adapter === undefined) continue;

      let token: string;
      try {
        token = await deps.tokens.getAccessToken(connectionId, scope);
      } catch (error: unknown) {
        const code = errorCodeFor(error);
        if (code === "transient") deferred += group.length;
        else
          await markError(
            group.map((p) => p.id),
            code,
          );
        continue;
      }

      for (const batch of chunks(group, adapter.capabilities().maxBatch)) {
        const byExternal = new Map(batch.map((p) => [p.externalPostId, p.id]));
        let result;
        try {
          result = await adapter.fetch({
            account: { accessToken: token },
            externalPostIds: [...byExternal.keys()],
          });
        } catch (error: unknown) {
          const code = errorCodeFor(error);
          deps.logger.warn(
            {
              companyId,
              platform: adapter.capabilities().platform,
              code: isPortError(error) ? error.code : "unknown",
            },
            "metrics-sync: la plataforma no devolvió métricas",
          );
          if (code === "transient") {
            deferred += batch.length;
          } else {
            await markError(
              batch.map((p) => p.id),
              code,
            );
          }
          // Un error de sesión o de permiso es de la conexión entera: no se
          // insiste con el resto de sus lotes.
          if (
            code === "metrics_reconnect_required" ||
            code === "metrics_permission_missing"
          ) {
            const rest = group.filter((p) => !batch.includes(p)).map((p) => p.id);
            await markError(rest, code);
            break;
          }
          continue;
        }

        const syncedAt = new Date(deps.clock.nowMs());
        const wrote = await inCompany(companyId, async (tx) => {
          let n = 0;
          for (const item of result.items) {
            const postId = byExternal.get(item.externalPostId);
            if (postId === undefined) continue;
            const values: Partial<Record<PostMetricColumn, number>> = {};
            if (item.views !== undefined) values.views = item.views;
            if (item.likes !== undefined) values.likes = item.likes;
            if (item.comments !== undefined) values.comments = item.comments;
            if (item.shares !== undefined) values.shares = item.shares;
            if (await metricsStore.writeMetrics(tx, scope, postId, { values, syncedAt }))
              n += 1;
          }
          return n;
        });
        synced += wrote;
        const idsOf = (externals: readonly string[]) =>
          externals.flatMap((e) => {
            const id = byExternal.get(e);
            return id === undefined ? [] : [id];
          });
        await markError(idsOf(result.missing), "not_found_on_platform");
        await markError(idsOf(result.unavailable), "metrics_unavailable");
      }
    }

    return { due: due.length, synced, errors, deferred, unsupported };
  }

  /**
   * El auto-tune, **todo en una transacción**: leer pesos con lock, proponer,
   * escribir pesos, registrar el cambio y la corrida. Si algo falla, no queda
   * un ajuste registrado que no se aplicó (ni al revés).
   */
  async function tuneBrand(companyId: string, nowMs: number): Promise<MixTuningRun> {
    const scope = { companyId };
    return inCompany(companyId, async (tx) => {
      const settings = await mixTuningStore.find(tx, scope);
      if (settings === null || !settings.enabled) return { kind: "off" } as const;
      if (!isMixTuningDue(settings.lastRunAt?.getTime() ?? null, nowMs))
        return { kind: "not_due" } as const;

      const rows = await mixTuningStore.listMeasured(
        tx,
        scope,
        // Las "últimas N por formato" se buscan en 90 días: con el tope
        // anti-bot (3 por red y día) alcanza de sobra para 20 por formato.
        new Date(nowMs - 90 * 86_400_000),
        MIX_CANDIDATES_LIMIT,
      );
      const samples = selectMixSamples(
        rows.map((r) => ({
          format: r.contentType,
          network: r.platform,
          postedAtMs: r.postedAt.getTime(),
          syncedAtMs: r.metricsSyncedAt?.getTime() ?? null,
          views: metricOrNull(r, "views"),
          likes: metricOrNull(r, "likes"),
          comments: metricOrNull(r, "comments"),
          shares: metricOrNull(r, "shares"),
        })),
        nowMs,
      );
      const locked = await mixTuningStore.lockWeights(tx, scope);
      const current = weightsOf(locked ?? DEFAULT_BLITZ_PREFERENCES);
      const outcome = proposeFormatWeights(current, samples);
      const at = new Date(nowMs);

      if (outcome.kind === "changed") {
        const patch = {
          slideshowWeight: outcome.to.slideshow,
          wallOfTextWeight: outcome.to["wall-of-text"],
          greenScreenWeight: outcome.to["green-screen"],
          videoHookWeight: outcome.to["video-hook"],
        };
        // Mismo patrón que `persistAngleWeights` de la API: `update` del campo
        // que cambia, y `upsert` con defaults sólo si la marca no tiene fila
        // (un `upsert` a secas le pisaría el resto de sus preferencias).
        const updated = await blitzPreferencesRepository.update(
          tx,
          scope,
          companyId,
          patch,
        );
        if (updated === null) {
          await blitzPreferencesRepository.upsert(tx, scope, {
            ...DEFAULT_BLITZ_PREFERENCES,
            ...patch,
            angleWeights: {},
            textStyleWeights: {},
          });
        }
        await mixTuningStore.recordAdjustment(tx, scope, {
          actor: "autotune",
          from: outcome.from,
          to: outcome.to,
          stats: outcome.stats,
          at,
        });
      }
      const label = outcome.kind === "changed" ? "changed" : outcome.reason;
      await mixTuningStore.recordRun(tx, scope, { at, outcome: label });
      return { kind: "ran", outcome: label } as const;
    });
  }

  async function runBrand(companyId: string, jobId: string): Promise<void> {
    const nowMs = deps.clock.nowMs();
    const sync = await syncBrand(companyId, nowMs);
    const tune = await tuneBrand(companyId, nowMs);
    deps.logger.info(
      { jobId, companyId, ...sync, mixTuning: tune },
      "metrics-sync de la marca",
    );
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const job = parsePayload(ctx.payload);
    if (job === null) {
      deps.logger.error({ jobId: ctx.jobId }, "payload de metrics-sync inválido");
      return;
    }
    if (job.companyId !== undefined) {
      await runBrand(job.companyId, ctx.jobId);
      return;
    }

    // Barrido: sólo ids de marca, sin tenant (ver `0018`).
    const nowMs = deps.clock.nowMs();
    const brands = await withoutCompany(
      deps.db,
      (tx) => metricsStore.syncBrands(tx, new Date(metricsWindowStartMs(nowMs))),
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );
    const queue = deps.queue;
    if (queue !== undefined) {
      for (const companyId of brands)
        await queue.enqueue(metricsSyncJob(companyId, nowMs));
      deps.logger.info(
        { jobId: ctx.jobId, marcas: brands.length },
        "barrido de metrics-sync",
      );
      return;
    }
    for (const companyId of brands) await runBrand(companyId, ctx.jobId);
  };
}
