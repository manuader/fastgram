/**
 * LinkedIn — `PU-LATER-002`: posts de un perfil (`w_member_social`) o de una
 * Página (`w_organization_social`) con video, una imagen o varias imágenes,
 * por la Posts API versionada.
 *
 * Documentación, consultada el 2026-09-24 (versión `202609`):
 *  - Posts API — https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 *    · `POST https://api.linkedin.com/rest/posts` con `LinkedIn-Version:
 *      YYYYMM` y `X-Restli-Protocol-Version: 2.0.0` (*"All APIs require"*
 *      los dos) → `201` y el id en el header `x-restli-id`
 *      (`urn:li:share:…` o `urn:li:ugcPost:…`).
 *    · Cuerpo: `author`, `commentary`, `visibility: PUBLIC`,
 *      `distribution{feedDistribution: MAIN_FEED, targetEntities: [],
 *      thirdPartyDistributionChannels: []}`, `content.media{id}`,
 *      `lifecycleState: PUBLISHED`, `isReshareDisabledByAuthor: false`.
 *    · Orgánico: imagen, video, documento y **MultiImage** sí; **Carousel
 *      no** (*"Organic carousel is currently not supported"*). Por eso un
 *      slideshow/carrusel sale como MultiImage.
 *    · Permalink documentado: *"`https://www.linkedin.com/feed/update/urn:li:ugcPost:<id>/`"*.
 *    · Errores: 401 `EMPTY_ACCESS_TOKEN`, 403 `ACCESS_DENIED`, 422, 429
 *      `TOO_MANY_REQUESTS`, 5xx.
 *  - `commentary` es texto `little`: *"All reserved characters need to be
 *    escaped with a backslash"*: `| { } @ [ ] ( ) < > # \ * _ ~` —
 *    https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format
 *    Tope de 3 000 caracteres — ver `PLATFORM_FIELD_LIMITS` en core. **No
 *    verificado**: si LinkedIn cuenta el texto antes o después de escapar; se
 *    cuenta la copy del usuario.
 *  - Videos API — https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
 *    · `POST /rest/videos?action=initializeUpload` `{initializeUploadRequest:
 *      {owner, fileSizeBytes, uploadCaptions: false, uploadThumbnail: false}}`
 *      → `value.video`, `value.uploadToken`, `value.uploadInstructions[]`
 *      (`uploadUrl`, `firstByte`, `lastByte`).
 *    · `PUT` de cada parte a su `uploadUrl` (`application/octet-stream`),
 *      **sin** token (*"The upload call shouldn't include an OAuth token"*, en
 *      la de Assets) → header `etag`.
 *    · `POST /rest/videos?action=finalizeUpload` `{finalizeUploadRequest:
 *      {video, uploadToken, uploadedPartIds}}` con los ETags en orden.
 *    · `GET /rest/videos/{urn}` → `status`: `PROCESSING | PROCESSING_FAILED |
 *      AVAILABLE | WAITING_UPLOAD`.
 *    · *"Length: Three seconds to 30 minutes. File size: Between 75kb and
 *      500MB. File format: MP4."*
 *  - Images API — https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
 *    · `POST /rest/images?action=initializeUpload` `{initializeUploadRequest:
 *      {owner}}` → `value.uploadUrl`, `value.image`.
 *    · Subida: `PUT` **con** el token (*"The upload call requires a valid
 *      OAuth token in the 'Authorization' header"*) —
 *      https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/vector-asset-api
 *    · JPG, GIF, PNG; menos de 36 152 320 píxeles.
 *    · Con **sólo** `w_member_social` no se puede hacer `GET /rest/images`
 *      (*"tokens with only w_member_social permissions would be unable to
 *      perform a GET call"*): se consulta el estado y, si da 403, se sigue sin
 *      esperar.
 *  - MultiImage — https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api
 *    · `content.multiImage.images[{id}]`, *"minimum of 2 images and maximum
 *      of 20 images"*, sólo orgánico.
 *  - Límite de «Share on LinkedIn»: 150 requests por miembro por día —
 *    https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin
 *    Muy por encima del tope propio de la estrategia (24 como máximo).
 *
 * ## TODO documentado (no implementado)
 *
 * **Documento PDF como «carrusel»**: la Documents API permite posts
 * orgánicos con `w_member_social` (`POST /rest/documents?action=initializeUpload`,
 * PDF/PPT/DOC, hasta 100 MB y 300 páginas, `content.media{id, title}` con
 * `title` obligatorio) —
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api
 * Es el formato que en LinkedIn se ve como carrusel deslizable. Pide armar un
 * PDF con los slides (render nuevo) y un tipo de media que el puerto no
 * tiene; queda para cuando se decida.
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
  downloadBytes,
  field,
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

const SOURCE = "SocialPublisher/linkedin";

/** Ver `LINKEDIN_DEFAULT_VERSION` en `oauth/linkedin.ts`: la misma. */
export const LINKEDIN_API_VERSION_DEFAULT = "202609";
export const LINKEDIN_COMMENTARY_MAX = 3000;
export const LINKEDIN_MULTI_IMAGE_MIN = 2;
export const LINKEDIN_MULTI_IMAGE_MAX = 20;
export const LINKEDIN_VIDEO_MIN_BYTES = 75 * 1024;
export const LINKEDIN_VIDEO_MAX_BYTES = 500 * 1024 * 1024;
export const LINKEDIN_VIDEO_MIN_SECONDS = 3;
export const LINKEDIN_VIDEO_MAX_SECONDS = 30 * 60;

export interface LinkedInPublisherConfig {
  readonly fetch?: PublisherFetch;
  readonly sleep?: Sleep;
  /** Default `https://api.linkedin.com`. */
  readonly apiBase?: string;
  /** `LinkedIn-Version`. Default {@link LINKEDIN_API_VERSION_DEFAULT}. */
  readonly apiVersion?: string;
  readonly requestTimeoutMs?: number;
  /** Cuánto se espera a que el video o las imágenes queden `AVAILABLE`. Default 180 s. */
  readonly processingTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export const LINKEDIN_CAPABILITIES: SocialPublishCapabilities = {
  platform: "linkedin",
  provider: "linkedin-posts-api",
  accountTypes: ["oauth"],
  mediaKinds: ["video", "image", "carousel", "slideshow"],
  captionLimits: { caption: LINKEDIN_COMMENTARY_MAX },
  postingModes: [],
  privacyLevels: [],
  supportsAiLabel: false,
  supportsPartnershipDisclosure: false,
  supportsAutoAddMusic: false,
  supportsCaptionGeneration: false,
  supportsNativeScheduling: false,
  requiredAccountKinds: [],
  // Se suben los bytes: alcanza la URL firmada del bucket.
  mediaSource: "private_url",
};

/** Los reservados de `little`, escapados con `\`. */
const LITTLE_RESERVED = /[|{}@[\]()<>#\\*_~]/g;

export function escapeLittleText(text: string): string {
  return text.replace(LITTLE_RESERVED, (c) => `\\${c}`);
}

/** El autor de la Posts API: el URN guardado, o un id pelado de perfil. */
export function authorUrnOf(platformUserId: string): string {
  return platformUserId.startsWith("urn:li:")
    ? platformUserId
    : `urn:li:person:${platformUserId}`;
}

/** Errores por código HTTP (la tabla de la Posts API y las de media). */
export function classifyLinkedInError(
  result: HttpResult,
  phase: CallPhase,
): PortError | PublishStatus {
  const cause = { status: result.status, code: str(result.json, "code") };
  if (result.status === 401) {
    return new PortError("unauthorized", "The account needs to be reconnected.", {
      source: SOURCE,
      cause,
    });
  }
  if (result.status === 429) {
    return transportError(
      "rate_limited",
      "The platform asked to slow down.",
      { source: SOURCE, phase: "prepare" },
      cause,
      retryAfterOf(result.headers),
    );
  }
  if (result.status >= 500) return serverError(result, { source: SOURCE, phase });
  if (result.status === 403) {
    return failed(
      "permissions_missing",
      "Permissions Missing — reconnect LinkedIn and approve all requested permissions.",
    );
  }
  if (phase === "prepare")
    return failed("unsupported_media", "LinkedIn rejected this media file.");
  return failed("unknown", "LinkedIn rejected this post.");
}

type Api =
  | { readonly kind: "ok"; readonly result: HttpResult }
  | { readonly kind: "outcome"; readonly status: PublishStatus };

export class LinkedInPublisher implements SocialPublisher {
  readonly #fetch: PublisherFetch;
  readonly #sleep: Sleep;
  readonly #base: string;
  readonly #version: string;
  readonly #timeoutMs: number;
  readonly #processingTimeoutMs: number;
  readonly #pollMs: number;
  readonly #idempotency = new IdempotencyCache();

  constructor(config: LinkedInPublisherConfig = {}) {
    this.#fetch = config.fetch ?? ((url, init) => fetch(url, init));
    this.#sleep = config.sleep ?? realSleep;
    this.#base = (config.apiBase ?? "https://api.linkedin.com").replace(/\/$/, "");
    this.#version = config.apiVersion ?? LINKEDIN_API_VERSION_DEFAULT;
    this.#timeoutMs = config.requestTimeoutMs ?? 60_000;
    this.#processingTimeoutMs = config.processingTimeoutMs ?? 180_000;
    this.#pollMs = config.pollIntervalMs ?? 3_000;
  }

  capabilities(): SocialPublishCapabilities {
    return LINKEDIN_CAPABILITIES;
  }

  async getAccountOptions(_account: PublishAccountRef): Promise<AccountPublishOptions> {
    return {
      allowedPrivacyLevels: [],
      directPostingAvailable: false,
      maxVideoDurationSeconds: LINKEDIN_VIDEO_MAX_SECONDS,
    };
  }

  async publish(request: PublishRequest): Promise<PublishStatus> {
    assertPublishable(request, LINKEDIN_CAPABILITIES, SOURCE);
    const token = requireToken(request, SOURCE);
    const author = authorUrnOf(requirePlatformUserId(request.account, SOURCE));
    return this.#idempotency.run(request.idempotencyKey, () =>
      this.#publish(request, token, author),
    );
  }

  async #publish(
    request: PublishRequest,
    token: string,
    author: string,
  ): Promise<PublishStatus> {
    const { kind, urls } = request.media;
    let content: Record<string, unknown>;
    if (kind === "video") {
      const [url, ...rest] = urls;
      if (url === undefined || rest.length > 0)
        return failed("unsupported_media", "A LinkedIn post takes a single video.");
      const video = await this.#uploadVideo(url, request, token, author);
      if (typeof video !== "string") return video;
      content = { media: { id: video } };
    } else {
      if (urls.length > LINKEDIN_MULTI_IMAGE_MAX)
        return failed(
          "unsupported_media",
          `A LinkedIn post takes up to ${String(LINKEDIN_MULTI_IMAGE_MAX)} images.`,
        );
      const images: string[] = [];
      for (const url of urls) {
        const image = await this.#uploadImage(url, token, author);
        if (typeof image !== "string") return image;
        images.push(image);
      }
      const [only] = images;
      content =
        images.length === 1 && only !== undefined
          ? { media: { id: only } }
          : { multiImage: { images: images.map((id) => ({ id })) } };
    }

    const created = await this.#api("POST", "/rest/posts", token, "deliver", {
      author,
      commentary: escapeLittleText(request.caption),
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content,
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    });
    if (created.kind === "outcome") return created.status;
    const id = created.result.headers.get("x-restli-id");
    if (id === null || id === "") throw contractViolation(SOURCE, "post sin x-restli-id");
    return {
      kind: "published",
      externalPostId: id,
      permalink: `https://www.linkedin.com/feed/update/${id}/`,
    };
  }

  /** initializeUpload → PUT de cada parte → finalizeUpload → esperar AVAILABLE. */
  async #uploadVideo(
    url: string,
    request: PublishRequest,
    token: string,
    owner: string,
  ): Promise<string | PublishStatus> {
    const duration = request.media.durationSeconds;
    if (
      duration !== undefined &&
      (duration < LINKEDIN_VIDEO_MIN_SECONDS || duration > LINKEDIN_VIDEO_MAX_SECONDS)
    ) {
      return failed(
        "unsupported_media",
        "A LinkedIn video has to be between 3 seconds and 30 minutes long.",
      );
    }
    const { bytes } = await downloadBytes(this.#fetch, url, {
      source: SOURCE,
      timeoutMs: this.#timeoutMs,
      maxBytes: LINKEDIN_VIDEO_MAX_BYTES,
    });
    if (bytes.byteLength < LINKEDIN_VIDEO_MIN_BYTES)
      return failed("unsupported_media", "The video file is too small for LinkedIn.");

    const init = await this.#api(
      "POST",
      "/rest/videos?action=initializeUpload",
      token,
      "prepare",
      {
        initializeUploadRequest: {
          owner,
          fileSizeBytes: bytes.byteLength,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      },
    );
    if (init.kind === "outcome") return init.status;
    const value = field(init.result.json, "value");
    const video = str(value, "video");
    const uploadToken = str(value, "uploadToken") ?? "";
    const instructions = field(value, "uploadInstructions");
    if (video === undefined || !Array.isArray(instructions) || instructions.length === 0)
      throw contractViolation(SOURCE, "initializeUpload de video sin instrucciones");

    const etags: string[] = [];
    for (const part of instructions as unknown[]) {
      const uploadUrl = str(part, "uploadUrl");
      const first = Number(str(part, "firstByte"));
      const last = Number(str(part, "lastByte"));
      if (uploadUrl === undefined || !Number.isInteger(first) || !Number.isInteger(last))
        throw contractViolation(SOURCE, "instrucción de subida incompleta");
      const put = await call(
        this.#fetch,
        uploadUrl,
        {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: bytes.subarray(first, last + 1),
        },
        { source: SOURCE, phase: "prepare", timeoutMs: this.#timeoutMs },
      );
      if (put.status < 200 || put.status >= 300) {
        const outcome = classifyLinkedInError(put, "prepare");
        if (outcome instanceof PortError) throw outcome;
        return outcome;
      }
      const etag = put.headers.get("etag");
      if (etag === null) throw contractViolation(SOURCE, "parte subida sin ETag");
      etags.push(etag);
    }

    const finalized = await this.#api(
      "POST",
      "/rest/videos?action=finalizeUpload",
      token,
      "prepare",
      { finalizeUploadRequest: { video, uploadToken, uploadedPartIds: etags } },
    );
    if (finalized.kind === "outcome") return finalized.status;

    const ready = await this.#waitAvailable(
      `/rest/videos/${encodeURIComponent(video)}`,
      token,
    );
    if (ready !== null) return ready;
    return video;
  }

  async #uploadImage(
    url: string,
    token: string,
    owner: string,
  ): Promise<string | PublishStatus> {
    const { bytes, contentType } = await downloadBytes(this.#fetch, url, {
      source: SOURCE,
      timeoutMs: this.#timeoutMs,
      maxBytes: 100 * 1024 * 1024,
    });
    const init = await this.#api(
      "POST",
      "/rest/images?action=initializeUpload",
      token,
      "prepare",
      { initializeUploadRequest: { owner } },
    );
    if (init.kind === "outcome") return init.status;
    const uploadUrl = str(init.result.json, "value", "uploadUrl");
    const image = str(init.result.json, "value", "image");
    if (uploadUrl === undefined || image === undefined)
      throw contractViolation(SOURCE, "initializeUpload de imagen sin uploadUrl/image");

    const put = await call(
      this.#fetch,
      uploadUrl,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": contentType.startsWith("image/")
            ? (contentType.split(";")[0] ?? contentType)
            : "application/octet-stream",
        },
        body: bytes,
      },
      { source: SOURCE, phase: "prepare", timeoutMs: this.#timeoutMs },
    );
    if (put.status < 200 || put.status >= 300) {
      const outcome = classifyLinkedInError(put, "prepare");
      if (outcome instanceof PortError) throw outcome;
      return outcome;
    }

    const ready = await this.#waitAvailable(
      `/rest/images/${encodeURIComponent(image)}`,
      token,
    );
    if (ready !== null) return ready;
    return image;
  }

  /**
   * Espera `AVAILABLE`. `null` = listo (o no se puede saber: un 403 de un
   * token con sólo `w_member_social`, ver la cabecera). Un
   * `PROCESSING_FAILED` es un resultado fallido.
   */
  async #waitAvailable(path: string, token: string): Promise<PublishStatus | null> {
    let forbidden = false;
    const { value, timedOut } = await pollUntil(
      async () => {
        const res = await call(
          this.#fetch,
          `${this.#base}${path}`,
          { method: "GET", headers: this.#headers(token) },
          { source: SOURCE, phase: "prepare", timeoutMs: this.#timeoutMs },
        );
        if (res.status === 403) {
          forbidden = true;
          return "AVAILABLE";
        }
        if (res.status < 200 || res.status >= 300) {
          const outcome = classifyLinkedInError(res, "prepare");
          if (outcome instanceof PortError) throw outcome;
          return "PROCESSING_FAILED";
        }
        return str(res.json, "status") ?? "PROCESSING";
      },
      (s) => s === "AVAILABLE" || s === "PROCESSING_FAILED",
      {
        intervalMs: this.#pollMs,
        timeoutMs: this.#processingTimeoutMs,
        sleep: this.#sleep,
      },
    );
    if (forbidden || value === "AVAILABLE") return null;
    if (value === "PROCESSING_FAILED")
      return failed("unsupported_media", "LinkedIn couldn't process this media file.");
    if (timedOut) {
      throw new PortError("timeout", "LinkedIn is still processing the media.", {
        source: SOURCE,
      });
    }
    return null;
  }

  #headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "LinkedIn-Version": this.#version,
      "X-Restli-Protocol-Version": "2.0.0",
    };
  }

  async #api(
    method: "GET" | "POST",
    path: string,
    token: string,
    phase: CallPhase,
    json?: unknown,
  ): Promise<Api> {
    const headers = this.#headers(token);
    if (json !== undefined) headers["Content-Type"] = "application/json";
    const result = await call(
      this.#fetch,
      `${this.#base}${path}`,
      { method, headers, ...(json === undefined ? {} : { body: JSON.stringify(json) }) },
      { source: SOURCE, phase, timeoutMs: this.#timeoutMs },
    );
    if (result.status >= 200 && result.status < 300) return { kind: "ok", result };
    const outcome = classifyLinkedInError(result, phase);
    if (outcome instanceof PortError) throw outcome;
    return { kind: "outcome", status: outcome };
  }

  /** `GET /rest/posts/{urn codificado}`. Un 404 es `null`. */
  async getStatus(ref: PublishRef): Promise<PublishStatus | null> {
    const token = requireToken(ref, SOURCE);
    const res = await call(
      this.#fetch,
      `${this.#base}/rest/posts/${encodeURIComponent(ref.externalPostId)}`,
      { method: "GET", headers: this.#headers(token) },
      { source: SOURCE, phase: "prepare", timeoutMs: this.#timeoutMs },
    );
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) {
      const outcome = classifyLinkedInError(res, "prepare");
      if (outcome instanceof PortError) throw outcome;
      return null;
    }
    const state = str(res.json, "lifecycleState");
    if (state === "PUBLISH_FAILED")
      return {
        ...failed("unknown", "LinkedIn couldn't publish this post."),
        externalPostId: ref.externalPostId,
      };
    if (state === "PUBLISH_REQUESTED" || state === "DRAFT")
      return { kind: "processing", externalPostId: ref.externalPostId };
    return {
      kind: "published",
      externalPostId: ref.externalPostId,
      permalink: `https://www.linkedin.com/feed/update/${ref.externalPostId}/`,
    };
  }

  async cancel(_ref: PublishRef): Promise<CancelOutcome> {
    return NOT_CANCELLABLE;
  }

  /**
   * Sin métricas: leer los posts de un miembro pide `r_member_social`,
   * *"restricted and is available to approved users only"* (Posts API).
   */
  async fetchMetrics(refs: readonly PublishRef[]): Promise<readonly PostMetrics[]> {
    return metricsNotImplemented(refs, SOURCE);
  }
}
