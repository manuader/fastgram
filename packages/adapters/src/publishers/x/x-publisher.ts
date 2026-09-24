/**
 * X — `PU-PUB-005`: posts con texto, hasta 4 imágenes o 1 video, por la API v2
 * (pago por uso).
 *
 * Documentación, consultada el 2026-09-24:
 *  - Subida de media, en cuatro pasos (no hay subida simple en v2: «Do not
 *    send `command=INIT` … to `POST /2/media/upload`. Those command-style
 *    parameters were the previous upload protocol»):
 *    https://docs.x.com/x-api/media/quickstart/media-upload-chunked
 *    · `POST https://api.x.com/2/media/upload/initialize` JSON
 *      `{media_type, total_bytes, media_category}` →
 *      `{"data":{"id":"…","media_key":"…","expires_after_secs":86400}}`
 *    · `POST /2/media/upload/{id}/append` multipart `segment_index`, `media`;
 *      trozos de **5 MB como máximo**.
 *    · `POST /2/media/upload/{id}/finalize` → `data.processing_info`
 *      (`state`: `pending | in_progress | succeeded | failed`, `check_after_secs`).
 *    · `GET /2/media/upload?command=STATUS&media_id={id}`.
 *  - Crear el post: `POST https://api.x.com/2/tweets`
 *    `{"text":"…","media":{"media_ids":["…"]}}` → `201`
 *    `{"data":{"id":"…","text":"…"}}`; «up to 4 photos, 1 animated GIF, or 1
 *    video». Scopes: `tweet.write`, `users.read`, `tweet.read`, `media.write`.
 *    https://docs.x.com/x-api/posts/create-post
 *  - Estado: `GET /2/tweets/{id}`; un post inexistente responde **200** con
 *    `errors[].type = https://api.x.com/2/problems/resource-not-found`.
 *    https://docs.x.com/x-api/posts/get-post-by-id
 *  - 280 caracteres (ponderados: URL = 23, emoji = 2):
 *    https://docs.x.com/fundamentals/counting-characters
 *  - Precio: «Post: Create» US$0,015; «Post: Create (with URL)» **US$0,200**:
 *    https://docs.x.com/x-api/getting-started/pricing
 *
 * ## Links: fuera por defecto
 *
 * Un post con URL cuesta ~13 veces más. Con `allowLinks: false` (default) las
 * URLs `http(s)://…` y `www.…` se **sacan del texto** antes de publicar, y la
 * copy que salió queda en `publishedCaption` (la del usuario sigue en
 * `caption`). **No verificado**: si X cobra también como «with URL» un dominio
 * pelado (`ejemplo.com`) que autolinkea; no se toca, porque sacarlo rompería
 * texto normal («Node.js»).
 *
 * **No verificado**: el permalink. La doc no lo arma; no se inventa uno.
 * El conteo de caracteres de `assertPublishable` es por code point, no
 * ponderado: un texto con muchos emojis puede pasar acá y rebotar en X
 * (sale como `failed`, no se reintenta).
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

const SOURCE = "SocialPublisher/x";

/** «up to 4 photos». */
export const X_MAX_PHOTOS = 4;
/** «chunks limited to 5 MB maximum». Se usa un poco menos. */
export const X_CHUNK_BYTES_DEFAULT = 4 * 1024 * 1024;

export interface XPublisherConfig {
  readonly fetch?: PublisherFetch;
  readonly sleep?: Sleep;
  /** Default `https://api.x.com`. */
  readonly apiBase?: string;
  /** Default `false`: sin links en el texto (ver cabecera). */
  readonly allowLinks?: boolean;
  readonly chunkBytes?: number;
  /** Tope de lo que se baja para subir. Default 512 MB. */
  readonly maxMediaBytes?: number;
  readonly requestTimeoutMs?: number;
  /** Cuánto se espera el procesamiento de un video. Default 180 s. */
  readonly processingTimeoutMs?: number;
}

export const X_CAPABILITIES: SocialPublishCapabilities = {
  platform: "x",
  provider: "x-api-v2",
  accountTypes: ["oauth"],
  mediaKinds: ["text", "image", "video", "carousel", "slideshow"],
  captionLimits: { caption: 280 },
  postingModes: [],
  privacyLevels: [],
  supportsAiLabel: false,
  supportsPartnershipDisclosure: false,
  supportsAutoAddMusic: false,
  supportsCaptionGeneration: false,
  supportsNativeScheduling: false,
  requiredAccountKinds: [],
  mediaSource: "private_url",
};

const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/giu;

/** Saca las URLs y colapsa los espacios que quedan. */
export function stripLinks(text: string): string {
  return text
    .replace(URL_PATTERN, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export class XPublisher implements SocialPublisher {
  readonly #fetch: PublisherFetch;
  readonly #sleep: Sleep;
  readonly #base: string;
  readonly #allowLinks: boolean;
  readonly #chunkBytes: number;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #processingTimeoutMs: number;
  readonly #idempotency = new IdempotencyCache();

  constructor(config: XPublisherConfig = {}) {
    this.#fetch = config.fetch ?? ((url, init) => fetch(url, init));
    this.#sleep = config.sleep ?? realSleep;
    this.#base = (config.apiBase ?? "https://api.x.com").replace(/\/$/, "");
    this.#allowLinks = config.allowLinks ?? false;
    this.#chunkBytes = Math.min(
      config.chunkBytes ?? X_CHUNK_BYTES_DEFAULT,
      5 * 1024 * 1024,
    );
    this.#maxBytes = config.maxMediaBytes ?? 512 * 1024 * 1024;
    this.#timeoutMs = config.requestTimeoutMs ?? 60_000;
    this.#processingTimeoutMs = config.processingTimeoutMs ?? 180_000;
  }

  capabilities(): SocialPublishCapabilities {
    return X_CAPABILITIES;
  }

  async getAccountOptions(_account: PublishAccountRef): Promise<AccountPublishOptions> {
    return { allowedPrivacyLevels: [], directPostingAvailable: false };
  }

  async publish(request: PublishRequest): Promise<PublishStatus> {
    assertPublishable(request, X_CAPABILITIES, SOURCE);
    const token = requireToken(request, SOURCE);
    return this.#idempotency.run(request.idempotencyKey, () =>
      this.#publish(request, token),
    );
  }

  async #publish(request: PublishRequest, token: string): Promise<PublishStatus> {
    const { kind, urls } = request.media;
    if (kind === "video" && urls.length !== 1)
      return failed("unsupported_media", "A post on this platform takes a single video.");
    if (kind !== "video" && kind !== "text" && urls.length > X_MAX_PHOTOS)
      return failed(
        "unsupported_media",
        `A post on this platform takes up to ${String(X_MAX_PHOTOS)} photos.`,
      );

    const mediaIds: string[] = [];
    if (kind !== "text") {
      for (const url of urls) {
        const uploaded = await this.#upload(
          url,
          kind === "video" ? "video" : "image",
          token,
        );
        if (typeof uploaded !== "string") return uploaded;
        mediaIds.push(uploaded);
      }
    }

    const text = this.#allowLinks ? request.caption : stripLinks(request.caption);
    const created = await this.#api("POST", "/2/tweets", token, "deliver", {
      json: {
        text,
        ...(mediaIds.length === 0 ? {} : { media: { media_ids: mediaIds } }),
      },
    });
    if (created.kind === "outcome") return created.status;
    const id = str(created.json, "data", "id");
    if (id === undefined) throw contractViolation(SOURCE, "create post sin data.id");
    return {
      kind: "published",
      externalPostId: id,
      ...(text === request.caption ? {} : { publishedCaption: text }),
    };
  }

  /** initialize → append × N → finalize → (status). Devuelve el media id. */
  async #upload(
    url: string,
    kind: "video" | "image",
    token: string,
  ): Promise<string | PublishStatus> {
    const { bytes, contentType } = await downloadBytes(this.#fetch, url, {
      source: SOURCE,
      timeoutMs: this.#timeoutMs,
      maxBytes: this.#maxBytes,
    });
    const mediaType = contentType.startsWith(kind === "video" ? "video/" : "image/")
      ? (contentType.split(";")[0] ?? contentType)
      : kind === "video"
        ? "video/mp4"
        : "image/jpeg";

    const init = await this.#api("POST", "/2/media/upload/initialize", token, "prepare", {
      json: {
        media_type: mediaType,
        total_bytes: bytes.byteLength,
        media_category: kind === "video" ? "tweet_video" : "tweet_image",
      },
    });
    if (init.kind === "outcome") return init.status;
    const mediaId = str(init.json, "data", "id");
    if (mediaId === undefined) throw contractViolation(SOURCE, "initialize sin data.id");

    for (
      let offset = 0, segment = 0;
      offset < bytes.byteLength;
      offset += this.#chunkBytes, segment += 1
    ) {
      const form = new FormData();
      form.set("segment_index", String(segment));
      form.set(
        "media",
        new Blob([bytes.subarray(offset, offset + this.#chunkBytes)], {
          type: mediaType,
        }),
      );
      const appended = await this.#api(
        "POST",
        `/2/media/upload/${encodeURIComponent(mediaId)}/append`,
        token,
        "prepare",
        { form },
      );
      if (appended.kind === "outcome") return appended.status;
    }

    const finalized = await this.#api(
      "POST",
      `/2/media/upload/${encodeURIComponent(mediaId)}/finalize`,
      token,
      "prepare",
      { json: {} },
    );
    if (finalized.kind === "outcome") return finalized.status;

    let info = field(finalized.json, "data", "processing_info");
    let waited = 0;
    while (info !== undefined && info !== null) {
      const state = str(info, "state");
      if (state === "succeeded") break;
      if (state === "failed")
        return failed(
          "unsupported_media",
          "The platform couldn't process this media file.",
        );
      if (waited >= this.#processingTimeoutMs) {
        throw new PortError("timeout", "The platform is still processing the media.", {
          source: SOURCE,
        });
      }
      const afterSecs = Number(str(info, "check_after_secs") ?? "1");
      const delay = Math.max(1, Number.isFinite(afterSecs) ? afterSecs : 1) * 1000;
      await this.#sleep(delay);
      waited += delay;
      const status = await this.#api(
        "GET",
        `/2/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`,
        token,
        "prepare",
      );
      if (status.kind === "outcome") return status.status;
      info = field(status.json, "data", "processing_info");
    }
    return mediaId;
  }

  async #api(
    method: "GET" | "POST",
    path: string,
    token: string,
    phase: CallPhase,
    body?: { readonly json?: unknown; readonly form?: FormData },
  ): Promise<
    | { readonly kind: "ok"; readonly json: unknown }
    | { readonly kind: "outcome"; readonly status: PublishStatus }
  > {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let payload: string | FormData | undefined;
    if (body?.json !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body.json);
    } else if (body?.form !== undefined) {
      payload = body.form;
    }
    const result = await call(
      this.#fetch,
      `${this.#base}${path}`,
      { method, headers, ...(payload === undefined ? {} : { body: payload }) },
      { source: SOURCE, phase, timeoutMs: this.#timeoutMs },
    );
    if (result.status >= 200 && result.status < 300)
      return { kind: "ok", json: result.json };
    const outcome = classifyXError(result, phase);
    if (outcome instanceof PortError) throw outcome;
    return { kind: "outcome", status: outcome };
  }

  async getStatus(ref: PublishRef): Promise<PublishStatus | null> {
    const token = requireToken(ref, SOURCE);
    const res = await this.#api(
      "GET",
      `/2/tweets/${encodeURIComponent(ref.externalPostId)}`,
      token,
      "prepare",
    );
    if (res.kind === "outcome") return null;
    // Documentado: un inexistente viene en 200 con `errors` y sin `data`.
    const id = str(res.json, "data", "id");
    if (id === undefined) return null;
    return { kind: "published", externalPostId: id };
  }

  async cancel(_ref: PublishRef): Promise<CancelOutcome> {
    return NOT_CANCELLABLE;
  }

  async fetchMetrics(refs: readonly PublishRef[]): Promise<readonly PostMetrics[]> {
    return metricsNotImplemented(refs, SOURCE);
  }
}

/**
 * Errores de X: `errors[]` con `type`, `title`, `detail` (create-post). Por
 * código HTTP, que es lo que la doc documenta:
 *  - 401 → `unauthorized` (volver a conectar → `AWAITING_RECONNECT`).
 *  - 429 → `rate_limited` (el pedido no se procesó: seguro en las dos fases).
 *  - 5xx → transitorio / incierto según la fase.
 *  - 403 → rechazo definitivo (la doc da «video too long» como ejemplo).
 *  - 400 → rechazo definitivo; en la subida, la media.
 */
export function classifyXError(
  result: HttpResult,
  phase: CallPhase,
): PortError | PublishStatus {
  const cause = { status: result.status, type: str(result.json, "type") };
  if (result.status === 401) {
    return new PortError("unauthorized", "The account needs to be reconnected.", {
      source: SOURCE,
      cause,
    });
  }
  if (result.status === 429) {
    const retryAfter = retryAfterOf(result.headers);
    return transportError(
      "rate_limited",
      "The platform asked to slow down.",
      { source: SOURCE, phase: "prepare" },
      cause,
      retryAfter,
    );
  }
  if (result.status >= 500) return serverError(result, { source: SOURCE, phase });
  if (phase === "prepare")
    return failed("unsupported_media", "The platform rejected this media file.");
  return failed("unknown", "The platform rejected this post.");
}
