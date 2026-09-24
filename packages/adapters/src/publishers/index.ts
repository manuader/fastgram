/**
 * Publicadores reales por plataforma — `PU-PUB-003…006`, `PU-LATER-001/002`.
 *
 * Se importan por el subpath `@fastgram/adapters/publishers` (el `exports`
 * del paquete publica `./*`), así el índice general del paquete no cambia.
 */
export {
  InstagramPublisher,
  INSTAGRAM_CAPABILITIES,
  INSTAGRAM_CAROUSEL_MAX,
  type InstagramPublisherConfig,
} from "./instagram/instagram-publisher.js";
export {
  ThreadsPublisher,
  THREADS_CAPABILITIES,
  THREADS_CAROUSEL_MAX,
  type ThreadsPublisherConfig,
} from "./threads/threads-publisher.js";
export {
  FacebookReelsPublisher,
  FACEBOOK_REELS_CAPABILITIES,
  type FacebookReelsPublisherConfig,
} from "./facebook/facebook-reels-publisher.js";
export {
  XPublisher,
  X_CAPABILITIES,
  stripLinks,
  type XPublisherConfig,
} from "./x/x-publisher.js";
export {
  TikTokInboxPublisher,
  TIKTOK_INBOX_CAPABILITIES,
  planChunks,
  type TikTokInboxPublisherConfig,
} from "./tiktok/tiktok-inbox-publisher.js";
export {
  YouTubeShortsPublisher,
  YOUTUBE_SHORTS_CAPABILITIES,
  YOUTUBE_SHORTS_MAX_SECONDS,
  YOUTUBE_PRIVACY_STATUSES,
  isYouTubePrivacyStatus,
  type YouTubePrivacyStatus,
  type YouTubeShortsPublisherConfig,
} from "./youtube/youtube-shorts-publisher.js";
export { probeMp4, type Mp4Probe } from "./youtube/mp4-probe.js";
export {
  LinkedInPublisher,
  LINKEDIN_CAPABILITIES,
  LINKEDIN_API_VERSION_DEFAULT,
  escapeLittleText,
  type LinkedInPublisherConfig,
} from "./linkedin/linkedin-publisher.js";
export {
  UnavailablePublicMediaUrls,
  UnavailableConnectionTokens,
} from "./unavailable.js";
export type { PublisherFetch, Sleep } from "./shared/http.js";
