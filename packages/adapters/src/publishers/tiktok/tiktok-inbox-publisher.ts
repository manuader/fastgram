/**
 * TikTok — `PU-PUB-006` (`= P3-OAUTH-002`), `D-10`: **Upload como borrador**
 * al inbox del creador (`IN_USER_INBOX`), nunca Direct Post. Sin auditoría,
 * TikTok publica todo Direct Post como privado, y la guía de uso declara
 * *not acceptable* la herramienta para publicar en cuentas propias.
 *
 * Documentación, consultada el 2026-09-24:
 *  - Video, inbox: https://developers.tiktok.com/doc/content-posting-api-reference-upload-video
 *    · `POST https://open.tiktokapis.com/v2/post/publish/inbox/video/init/`,
 *      `Authorization: Bearer`, `Content-Type: application/json; charset=UTF-8`,
 *      cuerpo `{"source_info":{"source":"FILE_UPLOAD","video_size":…,
 *      "chunk_size":…,"total_chunk_count":…}}` → `data.publish_id`,
 *      `data.upload_url` (vale 1 h).
 *    · `PUT <upload_url>` con `Content-Type: video/mp4` y
 *      `Content-Range: bytes {first}-{last}/{total}`.
 *    · 6 requests/min por token; errores `spam_risk_too_many_pending_share`,
 *      `access_token_invalid`, `scope_not_authorized` (`video.upload`),
 *      `rate_limit_exceeded`, `url_ownership_unverified`.
 *    · El init de inbox **no** lleva `post_info`: el título y la descripción
 *      los pone el creador en la app al terminar el borrador.
 *  - Trozos: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
 *    · 5 MB ≤ trozo ≤ 64 MB; el último puede llegar a 128 MB; < 5 MB va entero;
 *      `total_chunk_count = floor(video_size / chunk_size)`; 1…1000 trozos;
 *      secuenciales; 206 por trozo intermedio, 201 al completar.
 *  - Fotos: https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
 *    · `POST /v2/post/publish/content/init/` con `post_info.title` (≤ 90) y
 *      `post_info.description` (≤ 4000), `source_info.source = "PULL_FROM_URL"`,
 *      `photo_images` (hasta 35), `photo_cover_index`, `post_mode =
 *      "MEDIA_UPLOAD"`, `media_type = "PHOTO"` → `{"data":{"publish_id":"…"}}`.
 *      `privacy_level` es «Required for DIRECT POST»: con `MEDIA_UPLOAD` no va.
 *    · Las URLs tienen que ser de un **dominio verificado** por la app.
 *  - Estado: https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
 *    · `POST /v2/post/publish/status/fetch/` `{"publish_id":"…"}` →
 *      `data.status` ∈ `PROCESSING_UPLOAD | PROCESSING_DOWNLOAD |
 *      SEND_TO_USER_INBOX | PUBLISH_COMPLETE | FAILED`, `data.fail_reason`,
 *      `error.code = "ok"`. En el flujo de upload, `PUBLISH_COMPLETE` es que
 *      el creador tocó la notificación y publicó.
 *
 * **No verificado**: si el Upload tiene un tope diario propio aparte de las 5
 * subidas pendientes por 24 h; y el permalink (sólo da
 * `publicaly_available_post_id` tras moderación y la doc no arma la URL).
 */
import {
  PortError,
  type AccountPublishOptions,
  type CancelOutcome,
  type PostMetrics,
  type PublishAccountRef,
  type PublishFailureReason,
  type PublishRef,
  type PublishRequest,
  type PublishStatus,
  type SocialPublishCapabilities,
  type SocialPublisher,
} from "@fastgram/ports";

import {
  IdempotencyCache,
  NOT_CANCELLABLE,
  assertPublishable,
  failed,
  metricsNotImplemented,
  pollUntil,
  requireToken,
} from "../shared/base.js";
import {
  call,
  contractViolation,
  downloadBytes,
  realSleep,
  retryAfterOf,
  serverError,
  str,
  transportError,
  type CallPhase,
  type HttpResult,
  type PublisherFetch,
  type Sleep,
} from "../shared/http.js";

const SOURCE = "SocialPublisher/tiktok";

const MB = 1024 * 1024;
/** «at least 5 MB but no greater than 64 MB». */
export const TIKTOK_MIN_CHUNK = 5 * MB;
export const TIKTOK_MAX_CHUNK = 64 * MB;
/** «up to 35» fotos. */
export const TIKTOK_MAX_PHOTOS = 35;

export interface TikTokInboxPublisherConfig {
  readonly fetch?: PublisherFetch;
  readonly sleep?: Sleep;
  /** Default `https://open.tiktokapis.com`. */
  readonly apiBase?: string;
  /** Default 10 MB (dentro de 5…64 MB). */
  readonly chunkBytes?: number;
  /** Default 1 GB. */
  readonly maxMediaBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Cuánto se mira el estado antes de devolver `processing`. Default 30 s. */
  readonly statusWaitMs?: number;
}

export const TIKTOK_INBOX_CAPABILITIES: SocialPublishCapabilities = {
  platform: "tiktok",
  provider: "tiktok-content-posting-inbox",
  accountTypes: ["oauth"],
  mediaKinds: ["video", "image", "carousel", "slideshow"],
  captionLimits: { caption: 90, description: 4_000 },
  // D-10: sólo inbox. Sin `direct`, así que sin niveles de privacidad.
  postingModes: ["inbox"],
  privacyLevels: [],
  supportsAiLabel: false,
  supportsPartnershipDisclosure: false,
  supportsAutoAddMusic: false,
  supportsCaptionGeneration: false,
  supportsNativeScheduling: false,
  requiredAccountKinds: [],
  mediaSource: "public_url",
  mediaSourceByKind: { video: "private_url" },
};

/** Planifica los trozos según la guía de transferencia. */
export function planChunks(
  size: number,
  preferred: number,
): { readonly chunkSize: number; readonly count: number } {
  if (size < TIKTOK_MIN_CHUNK) return { chunkSize: size, count: 1 };
  const chunkSize = Math.min(
    Math.max(preferred, TIKTOK_MIN_CHUNK),
    TIKTOK_MAX_CHUNK,
    size,
  );
  return { chunkSize, count: Math.max(1, Math.floor(size / chunkSize)) };
}

type TikTokStatus =
  | "PROCESSING_UPLOAD"
  | "PROCESSING_DOWNLOAD"
  | "SEND_TO_USER_INBOX"
  | "PUBLISH_COMPLETE"
  | "FAILED";

export class TikTokInboxPublisher implements SocialPublisher {
  readonly #fetch: PublisherFetch;
  readonly #sleep: Sleep;
  readonly #base: string;
  readonly #chunkBytes: number;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #statusWaitMs: number;
  readonly #idempotency = new IdempotencyCache();

  constructor(config: TikTokInboxPublisherConfig = {}) {
    this.#fetch = config.fetch ?? ((url, init) => fetch(url, init));
    this.#sleep = config.sleep ?? realSleep;
    this.#base = (config.apiBase ?? "https://open.tiktokapis.com").replace(/\/$/, "");
    this.#chunkBytes = config.chunkBytes ?? 10 * MB;
    this.#maxBytes = config.maxMediaBytes ?? 1024 * MB;
    this.#timeoutMs = config.requestTimeoutMs ?? 60_000;
    this.#pollIntervalMs = config.pollIntervalMs ?? 5_000;
    this.#statusWaitMs = config.statusWaitMs ?? 30_000;
  }

  capabilities(): SocialPublishCapabilities {
    return TIKTOK_INBOX_CAPABILITIES;
  }

  async getAccountOptions(_account: PublishAccountRef): Promise<AccountPublishOptions> {
    // Direct Post no se usa (D-10). La Creator Info API sólo hace falta para
    // `direct`; no se consulta.
    return { allowedPrivacyLevels: [], directPostingAvailable: false };
  }

  async publish(request: PublishRequest): Promise<PublishStatus> {
    assertPublishable(request, TIKTOK_INBOX_CAPABILITIES, SOURCE);
    if (request.postingMode === "direct") {
      throw new PortError("bad_request", "Only inbox (draft) posting is enabled.", {
        source: SOURCE,
      });
    }
    const description = request.description ?? "";
    if ([...description].length > 4_000) {
      throw new PortError(
        "bad_request",
        "The description is longer than 4000 characters.",
        {
          source: SOURCE,
        },
      );
    }
    const token = requireToken(request, SOURCE);
    return this.#idempotency.run(request.idempotencyKey, () =>
      request.media.kind === "video"
        ? this.#publishVideo(request, token)
        : this.#publishPhotos(request, token),
    );
  }

  async #publishVideo(request: PublishRequest, token: string): Promise<PublishStatus> {
    const url = request.media.urls[0] ?? "";
    const { bytes, contentType } = await downloadBytes(this.#fetch, url, {
      source: SOURCE,
      timeoutMs: this.#timeoutMs,
      maxBytes: this.#maxBytes,
    });
    const size = bytes.byteLength;
    const { chunkSize, count } = planChunks(size, this.#chunkBytes);

    const init = await this.#api("/v2/post/publish/inbox/video/init/", token, "prepare", {
      source_info: {
        source: "FILE_UPLOAD",
        video_size: size,
        chunk_size: chunkSize,
        total_chunk_count: count,
      },
    });
    if (init.kind === "outcome") return init.status;
    const publishId = str(init.json, "data", "publish_id");
    const uploadUrl = str(init.json, "data", "upload_url");
    if (publishId === undefined || uploadUrl === undefined)
      throw contractViolation(SOURCE, "init sin publish_id/upload_url");

    const videoType =
      ["video/mp4", "video/quicktime", "video/webm"].find((t) =>
        contentType.startsWith(t),
      ) ?? "video/mp4";

    for (let i = 0; i < count; i += 1) {
      const first = i * chunkSize;
      // El último trozo se lleva el resto («can be greater than chunk_size»).
      const last = i === count - 1 ? size - 1 : first + chunkSize - 1;
      const res = await call(
        this.#fetch,
        uploadUrl,
        {
          method: "PUT",
          headers: {
            "Content-Type": videoType,
            "Content-Range": `bytes ${String(first)}-${String(last)}/${String(size)}`,
          },
          body: bytes.subarray(first, last + 1),
        },
        {
          source: SOURCE,
          // El último trozo es el que entrega: después TikTok lo manda al inbox.
          phase: i === count - 1 ? "deliver" : "prepare",
          timeoutMs: this.#timeoutMs,
        },
      );
      if (res.status !== 201 && res.status !== 206) {
        const outcome = classifyTikTokError(res, i === count - 1 ? "deliver" : "prepare");
        if (outcome instanceof PortError) throw outcome;
        return outcome;
      }
    }

    return this.#settle(publishId, token);
  }

  async #publishPhotos(request: PublishRequest, token: string): Promise<PublishStatus> {
    const urls = request.media.urls;
    if (urls.length > TIKTOK_MAX_PHOTOS) {
      return failed(
        "unsupported_media",
        `A photo post on this platform takes up to ${String(TIKTOK_MAX_PHOTOS)} photos.`,
      );
    }
    const init = await this.#api("/v2/post/publish/content/init/", token, "deliver", {
      post_info: {
        title: request.caption,
        ...(request.description === undefined
          ? {}
          : { description: request.description }),
      },
      source_info: {
        source: "PULL_FROM_URL",
        photo_images: urls,
        photo_cover_index: 0,
      },
      post_mode: "MEDIA_UPLOAD",
      media_type: "PHOTO",
    });
    if (init.kind === "outcome") return init.status;
    const publishId = str(init.json, "data", "publish_id");
    if (publishId === undefined)
      throw contractViolation(SOURCE, "content/init sin publish_id");
    return this.#settle(publishId, token);
  }

  /**
   * Mira el estado un rato. Lo normal es terminar en `SEND_TO_USER_INBOX`; si
   * sigue procesando, se devuelve `processing` con el `publish_id` y el
   * watcher del worker (`P3-PUB-004`) lo sigue hasta 72 h.
   */
  async #settle(publishId: string, token: string): Promise<PublishStatus> {
    const { value } = await pollUntil(
      () => this.#fetchStatus(publishId, token).catch(() => null),
      (s) =>
        s !== null &&
        s.status !== "PROCESSING_UPLOAD" &&
        s.status !== "PROCESSING_DOWNLOAD",
      {
        intervalMs: this.#pollIntervalMs,
        timeoutMs: this.#statusWaitMs,
        sleep: this.#sleep,
      },
    );
    if (value === null) return { kind: "processing", externalPostId: publishId };
    const status = statusFrom(publishId, value.status, value.failReason);
    if (
      status.kind === "failed" &&
      (value.failReason === "internal" ||
        value.failReason === "video_pull_failed" ||
        value.failReason === "photo_pull_failed")
    ) {
      // «This is a retryable error» / error de conexión bajando la media: no
      // llegó nada al inbox, así que se puede volver a intentar.
      throw new PortError(
        "provider_unavailable",
        "The platform couldn't receive the media.",
        {
          source: SOURCE,
          cause: { failReason: value.failReason },
        },
      );
    }
    return status;
  }

  async #fetchStatus(
    publishId: string,
    token: string,
  ): Promise<{ readonly status: TikTokStatus; readonly failReason?: string } | null> {
    const res = await this.#api("/v2/post/publish/status/fetch/", token, "prepare", {
      publish_id: publishId,
    });
    if (res.kind === "outcome") return null;
    const status = str(res.json, "data", "status");
    if (
      status !== "PROCESSING_UPLOAD" &&
      status !== "PROCESSING_DOWNLOAD" &&
      status !== "SEND_TO_USER_INBOX" &&
      status !== "PUBLISH_COMPLETE" &&
      status !== "FAILED"
    )
      throw contractViolation(SOURCE, "status desconocido");
    const failReason = str(res.json, "data", "fail_reason");
    return { status, ...(failReason === undefined ? {} : { failReason }) };
  }

  async #api(
    path: string,
    token: string,
    phase: CallPhase,
    body: unknown,
  ): Promise<
    | { readonly kind: "ok"; readonly json: unknown }
    | { readonly kind: "outcome"; readonly status: PublishStatus }
  > {
    const result = await call(
      this.#fetch,
      `${this.#base}${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify(body),
      },
      { source: SOURCE, phase, timeoutMs: this.#timeoutMs },
    );
    const code = str(result.json, "error", "code");
    if (
      result.status >= 200 &&
      result.status < 300 &&
      (code === undefined || code === "ok")
    )
      return { kind: "ok", json: result.json };
    const outcome = classifyTikTokError(result, phase);
    if (outcome instanceof PortError) throw outcome;
    return { kind: "outcome", status: outcome };
  }

  async getStatus(ref: PublishRef): Promise<PublishStatus | null> {
    const token = requireToken(ref, SOURCE);
    try {
      const found = await this.#fetchStatus(ref.externalPostId, token);
      return found === null
        ? null
        : statusFrom(ref.externalPostId, found.status, found.failReason);
    } catch (error: unknown) {
      // `invalid_publish_id`: la plataforma no lo conoce.
      if (error instanceof PortError && error.code === "not_found") return null;
      throw error;
    }
  }

  async cancel(_ref: PublishRef): Promise<CancelOutcome> {
    return NOT_CANCELLABLE;
  }

  async fetchMetrics(refs: readonly PublishRef[]): Promise<readonly PostMetrics[]> {
    return metricsNotImplemented(refs, SOURCE);
  }
}

/** `data.status` → el estado neutral del puerto. */
function statusFrom(
  publishId: string,
  status: TikTokStatus,
  failReason: string | undefined,
): PublishStatus {
  switch (status) {
    case "SEND_TO_USER_INBOX":
      // FR-060: **no es un error**; falta que el creador pulse Post en la app.
      return { kind: "in_user_inbox", externalPostId: publishId };
    case "PUBLISH_COMPLETE":
      return { kind: "published", externalPostId: publishId };
    case "FAILED": {
      if (failReason === "publish_cancelled")
        return { kind: "cancelled", externalPostId: publishId };
      const [reason, message] = failReasonOf(failReason);
      return { kind: "failed", externalPostId: publishId, failure: { reason, message } };
    }
    default:
      return { kind: "processing", externalPostId: publishId };
  }
}

/** `fail_reason` documentados → motivo neutral + mensaje seguro. */
function failReasonOf(failReason: string | undefined): [PublishFailureReason, string] {
  switch (failReason) {
    case "file_format_check_failed":
    case "duration_check_failed":
    case "frame_rate_check_failed":
    case "picture_size_check_failed":
      return ["unsupported_media", "The platform rejected this media file."];
    case "spam_risk_too_many_posts":
      return [
        "post_limit_exceeded",
        "The account reached the platform's daily posting limit.",
      ];
    case "auth_removed":
      return [
        "permissions_missing",
        "The account removed this app's access. Reconnect it.",
      ];
    default:
      return ["unknown", "The platform rejected this post."];
  }
}

/**
 * Errores del envelope `error.code` (tablas de las tres páginas de la
 * cabecera). Un 401 `access_token_invalid` va a `AWAITING_RECONNECT`.
 */
export function classifyTikTokError(
  result: HttpResult,
  phase: CallPhase,
): PortError | PublishStatus {
  const code = str(result.json, "error", "code");
  const cause = { status: result.status, code };
  switch (code) {
    case "access_token_invalid":
      return new PortError("unauthorized", "The account needs to be reconnected.", {
        source: SOURCE,
        cause,
      });
    case "scope_not_authorized":
      return failed(
        "permissions_missing",
        "The connected account is missing a permission. Reconnect it.",
      );
    case "rate_limit_exceeded":
      return transportError(
        "rate_limited",
        "The platform asked to slow down.",
        { source: SOURCE, phase: "prepare" },
        cause,
        retryAfterOf(result.headers),
      );
    case "spam_risk_too_many_pending_share":
    case "spam_risk_too_many_posts":
      return failed(
        "post_limit_exceeded",
        "The account reached the platform's daily posting limit.",
      );
    case "privacy_level_option_mismatch":
      return failed(
        "privacy_level_not_allowed",
        "This privacy level isn't available for the account.",
      );
    case "invalid_publish_id":
    case "token_not_authorized_for_specified_publish_id":
      return new PortError("not_found", "The platform doesn't know this post.", {
        source: SOURCE,
        cause,
      });
    case "url_ownership_unverified":
      return failed("unknown", "The media address isn't verified with the platform.");
    default:
      break;
  }
  if (result.status >= 500 || code === "internal_error")
    return serverError(result, { source: SOURCE, phase });
  if (result.status === 429)
    return transportError(
      "rate_limited",
      "The platform asked to slow down.",
      { source: SOURCE, phase: "prepare" },
      cause,
    );
  if (result.status === 401)
    return new PortError("unauthorized", "The account needs to be reconnected.", {
      source: SOURCE,
      cause,
    });
  return failed("unknown", "The platform rejected this post.");
}
