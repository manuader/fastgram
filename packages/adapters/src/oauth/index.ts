/**
 * OAuth de plataformas — `PU-PUB-002`, `P3-OAUTH-002`, `PU-LATER-001/002`. Ver
 * `meta.ts`, `tiktok-x.ts`, `youtube.ts` y `linkedin.ts` para los endpoints y sus citas.
 */
import type { OAuthClient, OAuthPlatform } from "@fastgram/ports";

import {
  FacebookPagesOAuthClient,
  InstagramOAuthClient,
  ThreadsOAuthClient,
} from "./meta.js";
import { TikTokOAuthClient, XOAuthClient } from "./tiktok-x.js";
import { YouTubeOAuthClient } from "./youtube.js";
import { LinkedInOAuthClient } from "./linkedin.js";
import type { OAuthFetch } from "./http.js";

export {
  DEFAULT_OAUTH_TIMEOUT_MS,
  OAuthHttp,
  errorCodesOf,
  type OAuthFetch,
  type OAuthHttpConfig,
} from "./http.js";
export {
  FacebookPagesOAuthClient,
  InstagramOAuthClient,
  ThreadsOAuthClient,
  type MetaClientConfig,
} from "./meta.js";
export { TikTokOAuthClient, XOAuthClient, type TikTokXClientConfig } from "./tiktok-x.js";
export {
  YouTubeOAuthClient,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  YOUTUBE_CHANNELS_URL,
  type YouTubeClientConfig,
} from "./youtube.js";
export {
  LinkedInOAuthClient,
  LINKEDIN_DEFAULT_VERSION,
  LINKEDIN_ORG_SCOPES,
  linkedinPersonUrn,
  type LinkedInClientConfig,
} from "./linkedin.js";
export { MemoryOAuthStateLedger } from "./memory-state-ledger.js";

export interface OAuthClientsConfig {
  /** Default: `globalThis.fetch`, resuelto en cada llamada. */
  readonly fetch?: OAuthFetch;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  /** Ver `MetaClientConfig.graphVersion`. */
  readonly graphVersion?: string;
  /** Ver `LinkedInClientConfig.linkedinVersion`. */
  readonly linkedinVersion?: string;
}

/** Un cliente por plataforma de `OAUTH_PLATFORMS`. */
export function createOAuthClients(
  config: OAuthClientsConfig = {},
): Readonly<Record<OAuthPlatform, OAuthClient>> {
  return {
    instagram: new InstagramOAuthClient(config),
    tiktok: new TikTokOAuthClient(config),
    x: new XOAuthClient(config),
    threads: new ThreadsOAuthClient(config),
    facebook: new FacebookPagesOAuthClient(config),
    youtube: new YouTubeOAuthClient(config),
    linkedin: new LinkedInOAuthClient(config),
  };
}
