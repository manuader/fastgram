/**
 * Qué adaptadores de métricas se montan — `PU-AUTO-004`.
 *
 * Instagram, Threads y Facebook se montan siempre que haya tokens (leer no
 * cuesta plata; sin el scope de insights, el sync lo dice por post con
 * `metrics_permission_missing`). YouTube también (`videos.list`, 1 unidad de
 * la cuota general, no de la de subidas). **X sólo con `METRICS_X_ENABLED=true`**:
 * leer cuesta US$0,005 por post (`adapters/metrics/x.ts`), y un costo así no
 * se prende por default. TikTok no tiene adaptador (ver
 * `packages/adapters/src/metrics/index.ts`).
 *
 * | Variable | Default | Qué |
 * |---|---|---|
 * | `METRICS_X_ENABLED` | `false` | `true` lee `public_metrics` de X una vez por día por post |
 * | `PUBLISH_INSTAGRAM_GRAPH_HOST` | `https://graph.instagram.com` | el mismo host que publica |
 * | `PUBLISH_META_GRAPH_VERSION` | `v26.0` | Instagram y Facebook |
 * | `PUBLISH_THREADS_API_VERSION` | `v1.0` | Threads |
 */
import {
  FacebookReelsMetrics,
  InstagramMetrics,
  ThreadsMetrics,
  XMetrics,
  YouTubeMetrics,
} from "@fastgram/adapters/metrics";
import type { SocialMetrics } from "@fastgram/ports";

export type MetricsEnv = Readonly<Record<string, string | undefined>>;

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value.trim();

export function xMetricsEnabled(env: MetricsEnv): boolean {
  return nonEmpty(env["METRICS_X_ENABLED"])?.toLowerCase() === "true";
}

export function createMetricsAdapters(
  env: MetricsEnv,
): Readonly<Record<string, SocialMetrics>> {
  const metaVersion = nonEmpty(env["PUBLISH_META_GRAPH_VERSION"]);
  const igHost = nonEmpty(env["PUBLISH_INSTAGRAM_GRAPH_HOST"]);
  const threadsVersion = nonEmpty(env["PUBLISH_THREADS_API_VERSION"]);
  return {
    instagram: new InstagramMetrics({
      ...(igHost === undefined ? {} : { host: igHost }),
      ...(metaVersion === undefined ? {} : { apiVersion: metaVersion }),
    }),
    threads: new ThreadsMetrics(
      threadsVersion === undefined ? {} : { apiVersion: threadsVersion },
    ),
    facebook: new FacebookReelsMetrics(
      metaVersion === undefined ? {} : { apiVersion: metaVersion },
    ),
    youtube: new YouTubeMetrics(),
    ...(xMetricsEnabled(env) ? { x: new XMetrics() } : {}),
  };
}
