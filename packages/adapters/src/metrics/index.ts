/**
 * Adaptadores de `SocialMetrics` — `PU-AUTO-004` (`= P3-METRIC-001`).
 *
 * Se importan por el subpath `@fastgram/adapters/metrics`.
 *
 * **TikTok no tiene adaptador, a propósito.** Leer métricas de un video pide
 * `POST https://open.tiktokapis.com/v2/video/query/` con el scope
 * **`video.list`** y los `video_ids` del video publicado
 * (https://developers.tiktok.com/doc/tiktok-api-v2-video-query, campos
 * `view_count`, `like_count`, `comment_count`, `share_count`; hasta 20 ids).
 * Hoy la conexión pide `user.info.basic` + `video.upload` (Upload → borrador,
 * `D-10`), y lo que guarda el publicador es el `publish_id` del borrador, no
 * el id del video: el video recién existe cuando el creador lo termina en la
 * app, y la API de estado sólo da `publicaly_available_post_id` tras
 * moderación. Sumar `video.list` sin tener el id del video no alcanza, así que
 * no se pide ni se implementa. Los posts de TikTok quedan fuera del sync y la
 * pantalla lo dice.
 */
export {
  InstagramMetrics,
  INSTAGRAM_METRICS_CAPABILITIES,
  type InstagramMetricsConfig,
} from "./instagram.js";
export {
  ThreadsMetrics,
  THREADS_METRICS_CAPABILITIES,
  type ThreadsMetricsConfig,
} from "./threads.js";
export {
  FacebookReelsMetrics,
  FACEBOOK_METRICS_CAPABILITIES,
  facebookLikes,
  facebookSocialAction,
  type FacebookMetricsConfig,
} from "./facebook.js";
export {
  XMetrics,
  X_METRICS_CAPABILITIES,
  X_POST_READ_USD,
  type XMetricsConfig,
} from "./x.js";
export { META_INSIGHTS_CONCURRENCY } from "./meta-insights.js";
export type { MetricsFetch } from "./shared.js";
