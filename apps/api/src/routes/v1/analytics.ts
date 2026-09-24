/**
 * `/analytics` — `P3-ANALYT-001` (`FR-120`, selector de rango), `P3-ANALYT-002`
 * (`F-171` por red, `F-172` por tipo), `PU-AUTO-004` (auto-tune del mix).
 *
 *   GET  /analytics/summary?days&brands   totales, desglose y top posts
 *   GET  /analytics/mix                   pesos de formato, auto-tune e historial
 *   PUT  /analytics/mix/autotune          prende o apaga el auto-tune de la marca
 *   POST /analytics/sync                  encola un `metrics-sync` de la marca activa
 *
 * `POST /analytics/posts` (el lote de `P3-METRIC-002`) sigue en `posts.ts`.
 *
 * ## `NFR-016` de punta a punta
 *
 * Las columnas `views`/`likes`/`comments`/`shares` de un post nunca
 * sincronizado son **0 por default**, no datos. El resumen (`summarizeAnalytics`
 * de `core`) no los suma y los cuenta en `pendingSync`; una métrica que la red
 * no dio (`posts.metricsMissing`) viaja como `null`. Así se cumple el criterio 2
 * de `FR-120`: *«un post recién publicado no se muestra como "0 views" sin
 * indicar que está pre-sync»*.
 *
 * ## "Todas las marcas"
 *
 * Igual que `GET /calendar?brands=all`: en modo personal, la lista de marcas
 * del dueño sale de `workspaceDirectory` (sin tenant, sólo lista) y **cada
 * marca se lee con su propio scope** (`runScoped`), así que RLS aplica marca
 * por marca.
 */
import {
  ANALYTICS_RANGE_MAX_DAYS,
  METRICS_SYNC_ISSUES,
  analyticsSummaryQuerySchema,
  mixAutotuneRequestSchema,
  type AnalyticsMix,
  type AnalyticsSummary,
  type FastgramMode,
  type FormatWeights,
  type MetricsSyncIssue,
  type MixAutotune,
} from "@fastgram/contracts";
import {
  DEFAULT_BLITZ_PREFERENCES,
  JOB_QUEUES,
  MIX_FORMATS,
  MIX_FORMAT_WEIGHT_FIELD,
  summarizeAnalytics,
  type AnalyticsPostInput,
} from "@fastgram/core";
import {
  blitzPreferencesRepository,
  companyRepository,
  metricsStore,
  mixTuningStore,
  withoutCompany,
  workspaceDirectory,
  type AnalyticsPostRow,
  type ContentMixAutotuneRow,
  type Database,
  type FormatMixAdjustmentRow,
  type PostMetricColumn,
} from "@fastgram/db";
import { METRICS_PLATFORMS } from "@fastgram/ports";
import type { FastifyRequest } from "fastify";

import { ownerOrFail, runScoped } from "../../auth/scope.js";
import { data } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const DAY_MS = 86_400_000;
/** Tope de posts por marca en un resumen. 90 días × 5 redes × 3/día = 1350. */
export const ANALYTICS_POSTS_PER_BRAND_MAX = 2000;
/** Ajustes del mix que se devuelven. */
export const MIX_ADJUSTMENTS_LIMIT = 20;

/** El orden de las tarjetas: el de `D-09`, y `reddit` al final (F-171). */
const NETWORK_ORDER = [
  "instagram",
  "tiktok",
  "x",
  "threads",
  "facebook",
  "youtube",
  "linkedin",
  "reddit",
];
/** El orden de `F-172`. */
const FORMAT_ORDER = [
  "slideshow",
  "wall-of-text",
  "green-screen",
  "video-hook",
  "custom",
];

const TUNING_OUTCOMES = new Set<string>([
  "changed",
  "single_active_format",
  "insufficient_data",
  "no_significant_difference",
]);

interface Brand {
  readonly id: string;
  readonly name: string;
}

function metricOrNull(row: AnalyticsPostRow, m: PostMetricColumn): number | null {
  return row.metricsMissing.includes(m) ? null : row[m];
}

function toInput(brandId: string, row: AnalyticsPostRow): AnalyticsPostInput {
  return {
    postId: row.id,
    brandId,
    network: row.platform,
    format: row.contentType,
    postedAtMs: row.postedAt.getTime(),
    syncedAtMs: row.metricsSyncedAt?.getTime() ?? null,
    views: metricOrNull(row, "views"),
    likes: metricOrNull(row, "likes"),
    comments: metricOrNull(row, "comments"),
    shares: metricOrNull(row, "shares"),
    postUrl: row.postUrl,
    caption: row.caption,
  };
}

function toAutotune(row: ContentMixAutotuneRow | null): MixAutotune {
  const outcome = row?.lastOutcome ?? null;
  return {
    enabled: row?.enabled ?? false,
    lastRunAt: row?.lastRunAt?.getTime() ?? null,
    lastOutcome:
      outcome !== null && TUNING_OUTCOMES.has(outcome)
        ? (outcome as MixAutotune["lastOutcome"])
        : null,
  };
}

/** Un jsonb de pesos a la forma del contrato. Lo que falte o no sea entero, 0. */
function weightsFromJson(value: unknown): FormatWeights {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const pick = (k: string): number => {
    const v = record[k];
    return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100 ? v : 0;
  };
  return {
    slideshow: pick("slideshow"),
    "wall-of-text": pick("wall-of-text"),
    "green-screen": pick("green-screen"),
    "video-hook": pick("video-hook"),
  };
}

/** Las muestras por formato de `stats` (`FormatStat[]` de `core`). */
function samplesFromStats(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(value)) return out;
  for (const s of value as unknown[]) {
    if (typeof s !== "object" || s === null) continue;
    const { format, samples } = s as Record<string, unknown>;
    if (typeof format === "string" && typeof samples === "number" && samples >= 0)
      out[format] = Math.round(samples);
  }
  return out;
}

function toAdjustment(row: FormatMixAdjustmentRow): AnalyticsMix["adjustments"][number] {
  return {
    _id: row.id,
    actor: "autotune",
    from: weightsFromJson(row.fromWeights),
    to: weightsFromJson(row.toWeights),
    createdAt: row.createdAt.getTime(),
    samples: samplesFromStats(row.stats),
  };
}

function homeCompanyOf(request: FastifyRequest): string {
  return request.auth.homeCompanyId ?? request.auth.companyId;
}

/** Las marcas del resumen: la de la request, o todas las del dueño (modo personal). */
async function brandsFor(
  db: Database,
  appRole: string | undefined,
  mode: FastgramMode,
  request: FastifyRequest,
  which: "current" | "all",
): Promise<Brand[]> {
  const companyId = request.auth.companyId;
  if (mode !== "personal" || which === "current") {
    const company = await runScoped(db, companyId, appRole, (tx) =>
      companyRepository.load(tx, { companyId }),
    );
    return [{ id: companyId, name: company?.name ?? "" }];
  }
  return withoutCompany(db, async (tx) => {
    const owner = await ownerOrFail(tx, homeCompanyOf(request));
    const all = await workspaceDirectory.list(tx, owner);
    return all.map((w) => ({ id: w.id, name: w.name }));
  });
}

export function registerAnalyticsRoutes(app: ZodApp): void {
  const { db, clock, appRole } = app.deps;
  const mode: FastgramMode = app.deps.mode ?? "standard";

  // ── GET /analytics/summary ──
  app.get(
    "/analytics/summary",
    { schema: { querystring: analyticsSummaryQuerySchema } },
    async (request) => {
      const { days, brands: which } = request.query;
      const toMs = clock.nowMs();
      const fromMs = toMs - Math.min(days, ANALYTICS_RANGE_MAX_DAYS) * DAY_MS;
      const brands = await brandsFor(db, appRole, mode, request, which);

      const inputs: AnalyticsPostInput[] = [];
      const issues = new Map<MetricsSyncIssue, number>();
      const known = new Set<string>(METRICS_SYNC_ISSUES);
      let truncated = false;
      // Marca por marca, cada una con su scope: RLS aplica en cada lectura.
      for (const brand of brands) {
        const rows = await runScoped(db, brand.id, appRole, (tx) =>
          metricsStore.listForAnalytics(
            tx,
            { companyId: brand.id },
            {
              from: new Date(fromMs),
              to: new Date(toMs),
              limit: ANALYTICS_POSTS_PER_BRAND_MAX,
            },
          ),
        );
        truncated ||= rows.length >= ANALYTICS_POSTS_PER_BRAND_MAX;
        for (const row of rows) {
          inputs.push(toInput(brand.id, row));
          const code = row.metricsErrorCode;
          if (code !== null && known.has(code)) {
            const c = code as MetricsSyncIssue;
            issues.set(c, (issues.get(c) ?? 0) + 1);
          }
        }
      }

      const summary = summarizeAnalytics(inputs, {
        networkOrder: NETWORK_ORDER,
        formatOrder: FORMAT_ORDER,
      });
      const supported = new Set<string>(METRICS_PLATFORMS);
      const unsupportedNetworks = summary.byNetwork
        .map((r) => r.key)
        .filter((n) => !supported.has(n));

      const body: AnalyticsSummary = {
        range: { from: fromMs, to: toMs, days },
        brands,
        totals: summary.totals,
        byNetwork: [...summary.byNetwork],
        byFormat: [...summary.byFormat],
        topPosts: summary.topPosts.map((p) => ({
          _id: p.postId,
          brandId: p.brandId,
          network: p.network,
          format: p.format,
          postedAt: p.postedAtMs,
          views: p.views,
          likes: p.likes,
          comments: p.comments,
          shares: p.shares,
          engagementRate: p.engagementRate,
          ...(p.postUrl === null ? {} : { postUrl: p.postUrl }),
          ...(p.caption === null ? {} : { caption: p.caption }),
        })),
        lastSyncedAt: summary.lastSyncedAtMs,
        syncIssues: METRICS_SYNC_ISSUES.flatMap((code) => {
          const count = issues.get(code) ?? 0;
          return count > 0 ? [{ code, count }] : [];
        }),
        unsupportedNetworks,
        truncated,
      };
      return data(body);
    },
  );

  // ── GET /analytics/mix ──
  app.get("/analytics/mix", async (request) => {
    const companyId = request.auth.companyId;
    const scope = { companyId };
    const body = await request.tx(async (tx): Promise<AnalyticsMix> => {
      const prefs = await blitzPreferencesRepository.findById(tx, scope, companyId);
      const source = prefs ?? DEFAULT_BLITZ_PREFERENCES;
      const weights = {} as Record<(typeof MIX_FORMATS)[number], number>;
      for (const f of MIX_FORMATS) weights[f] = source[MIX_FORMAT_WEIGHT_FIELD[f]];
      const autotune = await mixTuningStore.find(tx, scope);
      const adjustments = await mixTuningStore.listAdjustments(
        tx,
        scope,
        MIX_ADJUSTMENTS_LIMIT,
      );
      return {
        weights,
        autotune: toAutotune(autotune),
        adjustments: adjustments.map(toAdjustment),
      };
    });
    return data(body);
  });

  // ── PUT /analytics/mix/autotune ──
  app.put(
    "/analytics/mix/autotune",
    { schema: { body: mixAutotuneRequestSchema } },
    async (request) => {
      const scope = { companyId: request.auth.companyId };
      const row = await request.tx((tx) =>
        mixTuningStore.setEnabled(tx, scope, request.body.enabled),
      );
      return data(toAutotune(row));
    },
  );

  // ── POST /analytics/sync ──
  app.post("/analytics/sync", async (request, reply) => {
    const queue = app.deps.queue;
    if (queue === undefined) {
      return reply.status(503).send({
        error: {
          code: "service_unavailable",
          message: "Syncing is temporarily unavailable.",
        },
      });
    }
    const companyId = request.auth.companyId;
    // Una por marca por minuto: el botón apretado dos veces no duplica
    // lecturas (en X se pagan). La clave es otra que la del cron (por hora),
    // así que un pedido a mano no queda tapado por la corrida programada.
    const minute = Math.floor(clock.nowMs() / 60_000);
    const job = await queue.enqueue({
      queue: JOB_QUEUES.metricsSync,
      payload: { companyId },
      options: {
        singletonKey: `${JOB_QUEUES.metricsSync}:manual:${companyId}:${String(minute)}`,
      },
    });
    return reply.status(202).send(data({ queued: job.created }));
  });
}
