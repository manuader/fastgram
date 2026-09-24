/**
 * Qué publicadores se montan — `PU-PUB-003…006`.
 *
 * Los cinco adaptadores reales (`@fastgram/adapters/publishers`) se montan
 * **sólo si hay de dónde sacar tokens** (`ConnectionTokens`): sin eso, cada
 * post fallaría en la plataforma con `unauthorized` y quedaría en
 * `AWAITING_RECONNECT` por una razón que no es de la cuenta. Sin tokens el mapa
 * queda vacío y el handler falla la fila con `provider_unavailable`, que es lo
 * que hacía antes y es verdad.
 *
 * Nunca se monta `MemorySocialPublisher`: marcaría posts como `POSTED` con un
 * permalink inventado (ver la historia en `handlers.ts`).
 *
 * Configuración por entorno (todas opcionales; los defaults salen de la doc
 * citada en cada adaptador):
 *
 * | Variable | Default | Qué |
 * |---|---|---|
 * | `PUBLISH_INSTAGRAM_GRAPH_HOST` | `https://graph.instagram.com` | `graph.facebook.com` si la cuenta entró por Facebook Login |
 * | `PUBLISH_META_GRAPH_VERSION` | `v26.0` | Instagram y Facebook |
 * | `PUBLISH_THREADS_API_VERSION` | `v1.0` | Threads |
 * | `PUBLISH_X_ALLOW_LINKS` | `false` | `true` deja las URLs en el texto (US$0,20 por post en vez de 0,015) |
 * | `PUBLISH_YOUTUBE_PRIVACY` | `public` | `public`, `unlisted` o `private`. **Sin la auditoría del proyecto de Google, YouTube deja todo privado igual** |
 * | `PUBLISH_LINKEDIN_VERSION` | `202609` | `LinkedIn-Version` (YYYYMM) de la Posts API; cada versión dura al menos un año |
 */
import {
  FacebookReelsPublisher,
  InstagramPublisher,
  LinkedInPublisher,
  ThreadsPublisher,
  TikTokInboxPublisher,
  XPublisher,
  YouTubeShortsPublisher,
  isYouTubePrivacyStatus,
} from "@fastgram/adapters/publishers";
import { createLocalOAuthKit } from "@fastgram/adapters";
import { publicMediaUrlsFromEnv } from "@fastgram/adapters/public-media";
import { createConnectionTokens } from "@fastgram/core";
import { connectionTokenStore, withCompany, type Database } from "@fastgram/db";
import type { Clock, ConnectionTokens, SocialPublisher, Storage } from "@fastgram/ports";

import { createStorageFingerprinter, type ContentFingerprinter } from "./fingerprint.js";
import type { MediaResolverDeps } from "./media.js";
import {
  createFfmpegSlideshowReelComposer,
  type SlideshowReelComposer,
} from "./slideshow-reel.js";

export type PublishingEnv = Readonly<Record<string, string | undefined>>;

export const PUBLISHERS_UNMOUNTED_WHY =
  "no hay implementación de ConnectionTokens montada: sin tokens no se puede " +
  "publicar, así que los posts que lleguen a su hora fallan con provider_unavailable";

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value.trim();

export function createRealPublishers(
  env: PublishingEnv,
): Readonly<Record<string, SocialPublisher>> {
  const metaVersion = nonEmpty(env["PUBLISH_META_GRAPH_VERSION"]);
  const igHost = nonEmpty(env["PUBLISH_INSTAGRAM_GRAPH_HOST"]);
  const threadsVersion = nonEmpty(env["PUBLISH_THREADS_API_VERSION"]);
  const allowLinks = nonEmpty(env["PUBLISH_X_ALLOW_LINKS"])?.toLowerCase() === "true";
  const ytPrivacy = nonEmpty(env["PUBLISH_YOUTUBE_PRIVACY"])?.toLowerCase();
  const linkedinVersion = nonEmpty(env["PUBLISH_LINKEDIN_VERSION"]);

  return {
    instagram: new InstagramPublisher({
      ...(igHost === undefined ? {} : { host: igHost }),
      ...(metaVersion === undefined ? {} : { apiVersion: metaVersion }),
    }),
    threads: new ThreadsPublisher(
      threadsVersion === undefined ? {} : { apiVersion: threadsVersion },
    ),
    facebook: new FacebookReelsPublisher(
      metaVersion === undefined ? {} : { apiVersion: metaVersion },
    ),
    x: new XPublisher({ allowLinks }),
    tiktok: new TikTokInboxPublisher(),
    // Un valor que no es de la API se ignora (default `public`) en vez de
    // mandarlo y gastar una subida en un 400.
    youtube: new YouTubeShortsPublisher(
      ytPrivacy !== undefined && isYouTubePrivacyStatus(ytPrivacy)
        ? { privacyStatus: ytPrivacy }
        : {},
    ),
    linkedin: new LinkedInPublisher(
      linkedinVersion !== undefined && /^\d{6}$/.test(linkedinVersion)
        ? { apiVersion: linkedinVersion }
        : {},
    ),
  };
}

export function publishersFor(
  tokens: ConnectionTokens | null,
  env: PublishingEnv,
): Readonly<Record<string, SocialPublisher>> {
  return tokens === null ? {} : createRealPublishers(env);
}

/** Todo lo que el lado de publicación del worker necesita, armado en `main.ts`. */
export interface PublishingMount {
  readonly publishers: Readonly<Record<string, SocialPublisher>>;
  readonly tokens: ConnectionTokens | null;
  /** `null` = las URLs de `contents.files` se pasan tal cual. */
  readonly media: MediaResolverDeps | null;
  readonly fingerprinter: ContentFingerprinter | null;
  /** `PUBLISH_X_ALLOW_LINKS` (sprint 7): la caption derivada de X conserva las URLs. */
  readonly allowXLinks?: boolean;
  /** Sprint 7: Reel de Instagram desde un slideshow (`FFMPEG_PATH` o `ffmpeg`). */
  readonly slideshowReels?: SlideshowReelComposer | null;
}

/**
 * El montaje de `main.ts`: tokens de `@fastgram/core` (`createConnectionTokens`,
 * del agente de OAuth) sobre el `ConnectionTokenStore` de `@fastgram/db` y el
 * kit local (clave + `integrations.json` en `FASTGRAM_HOME`), media pública
 * por el túnel (`FASTGRAM_PUBLIC_URL`; sin túnel, `public_media_unavailable`)
 * y huellas sobre el storage real.
 */
export function mountPublishing(deps: {
  readonly db: Database;
  readonly appRole: string | undefined;
  readonly storage: Storage;
  readonly clock: Clock;
  readonly env: PublishingEnv;
}): PublishingMount {
  const kit = createLocalOAuthKit(deps.env);
  const tokens: ConnectionTokens = createConnectionTokens({
    withStore: (companyId, fn) =>
      withCompany(
        deps.db,
        companyId,
        (tx) => fn(connectionTokenStore(tx)),
        deps.appRole === undefined ? {} : { role: deps.appRole },
      ),
    cipher: kit.cipher,
    clients: kit.clients,
    integrations: kit.integrations,
    now: () => new Date(deps.clock.nowMs()),
  });
  return {
    publishers: publishersFor(tokens, deps.env),
    tokens,
    media: { storage: deps.storage, publicMedia: publicMediaUrlsFromEnv(deps.env) },
    fingerprinter: createStorageFingerprinter(deps.storage),
    allowXLinks: nonEmpty(deps.env["PUBLISH_X_ALLOW_LINKS"])?.toLowerCase() === "true",
    slideshowReels: createFfmpegSlideshowReelComposer({
      storage: deps.storage,
      ffmpeg: nonEmpty(deps.env["FFMPEG_PATH"]) ?? "ffmpeg",
    }),
  };
}
