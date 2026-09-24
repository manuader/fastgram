/**
 * Facebook Pages · Reels — `PU-PUB-004`.
 *
 * Documentación, consultada el 2026-09-24:
 * https://developers.facebook.com/docs/video-api/guides/reels-publishing
 *
 *  1. Iniciar: `POST https://graph.facebook.com/<ver>/<PAGE_ID>/video_reels`
 *     con `{"upload_phase":"start","access_token":"…"}` →
 *     `{"video_id":"…","upload_url":"https://rupload.facebook.com/video-upload/…"}`.
 *  2. Subir: `POST https://rupload.facebook.com/video-upload/<ver>/<VIDEO_ID>`
 *     con `Authorization: OAuth <token>` y, para un archivo alojado, el header
 *     `file_url: <https_url>` → `{"success": true}`. Por eso
 *     `mediaSource: "public_url"`: la plataforma baja el archivo.
 *  3. Estado: `GET /<VIDEO_ID>?fields=status` →
 *     `{"status":{"video_status":"processing","uploading_phase":{"status":"complete"},
 *     "processing_phase":{…},"publishing_phase":{…}}}`; `video_status` ∈
 *     `error | expired | processing | ready | uploading | upload_failed |
 *     upload_complete`.
 *  4. Publicar: `POST /<PAGE_ID>/video_reels` con `upload_phase=finish`,
 *     `video_id`, `video_state=PUBLISHED`, `description` → `{"success": true}`.
 *
 * Token: **de Página** (`pages_manage_posts`, capacidad `CREATE_CONTENT`).
 * Tope: «30 API-published posts within a 24-hour moving period».
 * Versión: `v26.0` es la más nueva (changelog de la Graph API); la guía usa
 * `v25.0` en los ejemplos. Configurable.
 *
 * **No verificado**: el permalink del reel. El nodo Video, tal como lo
 * devolvió la doc, no lista `permalink_url`; no se inventa una URL, así que el
 * post queda sin `postUrl`.
 */
import {
  PortError,
  type AccountPublishOptions,
  type CancelOutcome,
  type PostMetrics,
  type PublishAccountRef,
  type PublishRef,
  type PublishRequest,
  type PublishStatus,
  type SocialPublishCapabilities,
  type SocialPublisher,
} from "@fastgram/ports";

import { classifyGraphError } from "../meta/graph-errors.js";
import { graphCall, type GraphClientConfig } from "../meta/graph-client.js";
import {
  IdempotencyCache,
  NOT_CANCELLABLE,
  assertPublishable,
  failed,
  metricsNotImplemented,
  pollUntil,
  requirePlatformUserId,
  requireToken,
} from "../shared/base.js";
import {
  call,
  contractViolation,
  field,
  realSleep,
  str,
  type PublisherFetch,
  type Sleep,
} from "../shared/http.js";

const SOURCE = "SocialPublisher/facebook";

export interface FacebookReelsPublisherConfig {
  readonly fetch?: PublisherFetch;
  readonly sleep?: Sleep;
  /** Default `https://graph.facebook.com`. */
  readonly host?: string;
  /** Default `https://rupload.facebook.com`. */
  readonly uploadHost?: string;
  /** Default `v26.0`. */
  readonly apiVersion?: string;
  readonly requestTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Cuánto se espera a que la subida por `file_url` termine. Default 120 s. */
  readonly uploadTimeoutMs?: number;
  /** Cuánto se espera a que el reel figure publicado tras `finish`. Default 60 s. */
  readonly publishWaitMs?: number;
}

export const FACEBOOK_REELS_CAPABILITIES: SocialPublishCapabilities = {
  platform: "facebook",
  provider: "facebook-reels",
  accountTypes: ["oauth"],
  mediaKinds: ["video"],
  // La guía no publica un tope de `description`. Se toma el de Instagram, que
  // es la misma familia de producto, como techo conservador. NO VERIFICADO.
  captionLimits: { caption: 2_200 },
  postingModes: [],
  privacyLevels: [],
  supportsAiLabel: false,
  supportsPartnershipDisclosure: false,
  supportsAutoAddMusic: false,
  supportsCaptionGeneration: false,
  supportsNativeScheduling: false,
  requiredAccountKinds: ["page"],
  mediaSource: "public_url",
};

type ReelState =
  | { readonly kind: "uploading" }
  | { readonly kind: "uploaded" }
  | { readonly kind: "published" }
  | { readonly kind: "processing" }
  | { readonly kind: "error" }
  | { readonly kind: "expired" };

export class FacebookReelsPublisher implements SocialPublisher {
  readonly #client: GraphClientConfig;
  readonly #fetch: PublisherFetch;
  readonly #sleep: Sleep;
  readonly #uploadBase: string;
  readonly #timeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #uploadTimeoutMs: number;
  readonly #publishWaitMs: number;
  readonly #idempotency = new IdempotencyCache();

  constructor(config: FacebookReelsPublisherConfig = {}) {
    const version = config.apiVersion ?? "v26.0";
    this.#fetch = config.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = config.requestTimeoutMs ?? 30_000;
    this.#client = {
      fetch: this.#fetch,
      base: `${(config.host ?? "https://graph.facebook.com").replace(/\/$/, "")}/${version}`,
      source: SOURCE,
      timeoutMs: this.#timeoutMs,
      tokenPlacement: "json",
    };
    this.#uploadBase = `${(config.uploadHost ?? "https://rupload.facebook.com").replace(/\/$/, "")}/video-upload/${version}`;
    this.#sleep = config.sleep ?? realSleep;
    this.#pollIntervalMs = config.pollIntervalMs ?? 5_000;
    this.#uploadTimeoutMs = config.uploadTimeoutMs ?? 120_000;
    this.#publishWaitMs = config.publishWaitMs ?? 60_000;
  }

  capabilities(): SocialPublishCapabilities {
    return FACEBOOK_REELS_CAPABILITIES;
  }

  async getAccountOptions(_account: PublishAccountRef): Promise<AccountPublishOptions> {
    return { allowedPrivacyLevels: [], directPostingAvailable: false };
  }

  async publish(request: PublishRequest): Promise<PublishStatus> {
    assertPublishable(request, FACEBOOK_REELS_CAPABILITIES, SOURCE);
    const token = requireToken(request, SOURCE);
    const pageId = requirePlatformUserId(request.account, SOURCE);
    return this.#idempotency.run(request.idempotencyKey, () =>
      this.#publish(request, token, pageId),
    );
  }

  async #publish(
    request: PublishRequest,
    token: string,
    pageId: string,
  ): Promise<PublishStatus> {
    // 1 · iniciar la sesión de subida.
    const start = await graphCall(this.#client, {
      method: "POST",
      path: `/${pageId}/video_reels`,
      token,
      phase: "prepare",
      params: { upload_phase: "start" },
    });
    if (start.kind === "outcome") return start.status;
    const videoId = str(start.json, "video_id");
    if (videoId === undefined) throw contractViolation(SOURCE, "start sin video_id");

    // 2 · que la plataforma baje el archivo alojado.
    // La URL se arma con el patrón de la doc y no con el `upload_url` de la
    // respuesta: el token viaja en ese pedido, y sólo va a un host configurado.
    const uploadUrl = `${this.#uploadBase}/${encodeURIComponent(videoId)}`;
    const upload = await call(
      this.#fetch,
      uploadUrl,
      {
        method: "POST",
        headers: {
          Authorization: `OAuth ${token}`,
          file_url: request.media.urls[0] ?? "",
        },
      },
      { source: SOURCE, phase: "prepare", timeoutMs: this.#timeoutMs },
    );
    if (upload.status < 200 || upload.status >= 300) {
      const outcome = classifyGraphError(upload, { source: SOURCE, phase: "prepare" });
      if (outcome.kind === "throw") throw outcome.error;
      return outcome.status;
    }
    if (field(upload.json, "success") !== true)
      throw contractViolation(SOURCE, "upload sin success");

    // 3 · esperar a que la subida termine (bajar el archivo lleva su tiempo).
    const uploaded = await pollUntil(
      () => this.#state(videoId, token),
      (s) => s.kind !== "uploading",
      {
        intervalMs: this.#pollIntervalMs,
        timeoutMs: this.#uploadTimeoutMs,
        sleep: this.#sleep,
      },
    );
    if (uploaded.timedOut) {
      throw new PortError("timeout", "The platform is still receiving the video.", {
        source: SOURCE,
      });
    }
    if (uploaded.value.kind === "error")
      return failed("unsupported_media", "The platform couldn't process this video.");
    if (uploaded.value.kind === "expired")
      throw new PortError("provider_unavailable", "The upload session expired.", {
        source: SOURCE,
      });

    // 4 · publicar. Es el paso que entrega.
    const finish = await graphCall(this.#client, {
      method: "POST",
      path: `/${pageId}/video_reels`,
      token,
      phase: "deliver",
      params: {
        upload_phase: "finish",
        video_id: videoId,
        video_state: "PUBLISHED",
        ...(request.caption.length === 0 ? {} : { description: request.caption }),
      },
    });
    if (finish.kind === "outcome") return finish.status;
    if (field(finish.json, "success") !== true)
      throw contractViolation(SOURCE, "finish sin success");

    // El procesamiento y la publicación siguen del lado de la plataforma. Se
    // espera un rato; si no terminó, queda `processing` y el watcher lo sigue.
    const after = await pollUntil(
      () => this.#state(videoId, token).catch((): ReelState => ({ kind: "processing" })),
      (s) => s.kind === "published" || s.kind === "error",
      {
        intervalMs: this.#pollIntervalMs,
        timeoutMs: this.#publishWaitMs,
        sleep: this.#sleep,
      },
    );
    if (after.value.kind === "published")
      return { kind: "published", externalPostId: videoId };
    if (after.value.kind === "error")
      return failed("unsupported_media", "The platform couldn't process this video.");
    return { kind: "processing", externalPostId: videoId };
  }

  async #state(videoId: string, token: string): Promise<ReelState> {
    const res = await graphCall(this.#client, {
      method: "GET",
      path: `/${videoId}`,
      token,
      phase: "prepare",
      params: { fields: "status" },
    });
    if (res.kind === "outcome") return { kind: "error" };
    return reelStateOf(res.json);
  }

  async getStatus(ref: PublishRef): Promise<PublishStatus | null> {
    const token = requireToken(ref, SOURCE);
    const res = await graphCall(this.#client, {
      method: "GET",
      path: `/${ref.externalPostId}`,
      token,
      phase: "prepare",
      params: { fields: "status" },
    });
    if (res.kind === "outcome") return null;
    const state = reelStateOf(res.json);
    switch (state.kind) {
      case "published":
        return { kind: "published", externalPostId: ref.externalPostId };
      case "error":
      case "expired":
        return {
          kind: "failed",
          externalPostId: ref.externalPostId,
          failure: {
            reason: "unsupported_media",
            message: "The platform couldn't process this video.",
          },
        };
      default:
        return { kind: "processing", externalPostId: ref.externalPostId };
    }
  }

  async cancel(_ref: PublishRef): Promise<CancelOutcome> {
    return NOT_CANCELLABLE;
  }

  async fetchMetrics(refs: readonly PublishRef[]): Promise<readonly PostMetrics[]> {
    return metricsNotImplemented(refs, SOURCE);
  }
}

/** Lee `status` de la respuesta documentada. */
export function reelStateOf(json: unknown): ReelState {
  const videoStatus = str(json, "status", "video_status");
  const phase = (name: string): string | undefined => str(json, "status", name, "status");
  const publishStatus = str(json, "status", "publishing_phase", "publish_status");
  const done = (s: string | undefined): boolean => s === "complete" || s === "completed";

  if (videoStatus === "error" || videoStatus === "upload_failed")
    return { kind: "error" };
  if (
    phase("uploading_phase") === "error" ||
    phase("processing_phase") === "error" ||
    phase("publishing_phase") === "error"
  )
    return { kind: "error" };
  if (videoStatus === "expired") return { kind: "expired" };
  if (publishStatus === "published" || done(phase("publishing_phase")))
    return { kind: "published" };
  const uploadingPhase = phase("uploading_phase");
  if (
    videoStatus === "uploading" ||
    (uploadingPhase !== undefined && !done(uploadingPhase))
  )
    return { kind: "uploading" };
  if (videoStatus === "upload_complete") return { kind: "uploaded" };
  if (videoStatus === "processing" || videoStatus === "ready")
    return { kind: "processing" };
  if (videoStatus === undefined)
    throw contractViolation(SOURCE, "status sin video_status");
  return { kind: "processing" };
}
