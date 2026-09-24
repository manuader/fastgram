/**
 * YouTube Shorts — `PU-LATER-001`: un video vertical (o cuadrado) de hasta 3
 * minutos, subido con `videos.insert` por el protocolo **resumable**.
 *
 * Documentación, consultada el 2026-09-24:
 *  - https://developers.google.com/youtube/v3/docs/videos/insert
 *    · `POST https://www.googleapis.com/upload/youtube/v3/videos`; scopes
 *      `youtube.upload` (entre otros); *"Accepted Media MIME types: video/*,
 *      application/octet-stream"*; hasta 256 GB.
 *    · Cuota: *"100 calls per day. A call to this method has a quota cost of
 *      1 unit in the Video Uploads quota bucket"*. La guarda de instalación
 *      está en `packages/core/src/publishing/guards.ts` (regla 4).
 *    · **Sin auditoría**: *"All videos uploaded via the `videos.insert`
 *      endpoint from unverified API projects created after 28 July 2020 will
 *      be restricted to private viewing mode."* El `privacyStatus` que se
 *      pide acá se respeta recién con el proyecto auditado; la pantalla lo
 *      avisa (Integrations y Connections).
 *    · Errores del método: `uploadLimitExceeded` (400, *"The channel's daily
 *      video upload limit has been reached"*), `invalidTitle`,
 *      `invalidDescription`, `forbiddenPrivacySetting` (403),
 *      `mediaBodyRequired`… — https://developers.google.com/youtube/v3/docs/errors ,
 *      donde también está `quotaExceeded` (403) y la forma
 *      `{"error":{"code":…,"errors":[{"reason":…}]}}`.
 *  - https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
 *    · Paso 1: `POST …/videos?uploadType=resumable&part=snippet,status` con
 *      `Content-Type: application/json; charset=UTF-8`,
 *      `X-Upload-Content-Length`, `X-Upload-Content-Type` y el recurso en el
 *      cuerpo → `200 OK` con la URI de la sesión en `Location`.
 *    · Paso 2: `PUT` a esa URI con los bytes → `201 Created` (o `200 OK`) con
 *      el recurso del video.
 *    · `308 Resume Incomplete` con `Range: bytes=0-N`: se sigue desde N+1
 *      con `Content-Range`. Un 5xx: se pregunta el estado con un `PUT` vacío
 *      y `Content-Range` de la forma `bytes *` + `/TOTAL` (sin espacios). `404`: la sesión venció, **no hay
 *      video**, se empieza de nuevo.
 *  - https://developers.google.com/youtube/v3/docs/videos
 *    · `snippet.title`: *"Maximum 100 characters"*, sin `<` ni `>`;
 *      `snippet.description`: *"Maximum 5000 bytes"*, sin `<` ni `>`.
 *    · `status.privacyStatus`: `private | public | unlisted`.
 *    · `status.containsSyntheticMedia`: la etiqueta de contenido alterado o
 *      sintético → `supportsAiLabel: true`.
 *    · `status.uploadStatus`: `deleted | failed | processed | rejected | uploaded`.
 *  - Qué es un Short: *"Videos uploaded on or after October 15, 2024 with a
 *    square or vertical aspect ratio up to three minutes in length will be
 *    categorized as Shorts"* — https://support.google.com/youtube/answer/15424877
 *
 * ## Decisiones
 *
 * - **Se valida el Short antes de subir**: ancho ≤ alto y ≤ 180 s, con los
 *   datos del render (`PublishMedia.width/height/durationSeconds`) y, si no
 *   vinieron, leyendo el MP4 (`mp4-probe.ts`). Si no se puede saber, **no se
 *   sube**: cada intento gasta una de las 100 subidas del día.
 * - Devuelve `processing` (no `published`): el video queda `uploaded` y YouTube
 *   lo procesa. El watcher de 72 h (`getStatus`) lo pasa a `published` cuando
 *   está `processed`, o a `failed` si queda `failed`/`rejected`.
 * - `selfDeclaredMadeForKids` **no** se manda: es una declaración legal del
 *   canal y la decide el dueño en YouTube Studio, no esta app.
 * - Sin permalink: la API no devuelve una URL y no se arma una a mano.
 * - `<` y `>` se sacan del título y la descripción (la API los rechaza); lo
 *   que salió queda en `publishedCaption`.
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
  retryAfterOf,
  serverError,
  str,
  transportError,
  type CallPhase,
  type HttpResult,
  type PublisherFetch,
} from "../shared/http.js";
import { probeMp4 } from "./mp4-probe.js";

const SOURCE = "SocialPublisher/youtube";

/** *"up to three minutes in length"*. */
export const YOUTUBE_SHORTS_MAX_SECONDS = 180;
export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX_BYTES = 5000;
export const YOUTUBE_PRIVACY_STATUSES = ["public", "unlisted", "private"] as const;
export type YouTubePrivacyStatus = (typeof YOUTUBE_PRIVACY_STATUSES)[number];

export function isYouTubePrivacyStatus(v: string): v is YouTubePrivacyStatus {
  return (YOUTUBE_PRIVACY_STATUSES as readonly string[]).includes(v);
}

export interface YouTubeShortsPublisherConfig {
  readonly fetch?: PublisherFetch;
  /** Default `https://www.googleapis.com`. */
  readonly apiBase?: string;
  /**
   * `status.privacyStatus` que se pide. Default `public`: la estrategia no
   * tiene un campo de privacidad y un Short privado no sirve para crecer.
   * **Sin auditoría del proyecto de Google queda privado igual.**
   */
  readonly privacyStatus?: YouTubePrivacyStatus;
  /** Tope de lo que se baja para subir. Default 512 MB. */
  readonly maxMediaBytes?: number;
  readonly requestTimeoutMs?: number;
  /** El `PUT` de los bytes. Default 10 min. */
  readonly uploadTimeoutMs?: number;
  /** Vueltas de reanudación (308 / 5xx) antes de rendirse. Default 3. */
  readonly maxResumeAttempts?: number;
}

export const YOUTUBE_SHORTS_CAPABILITIES: SocialPublishCapabilities = {
  platform: "youtube",
  provider: "youtube-data-api-v3-resumable",
  accountTypes: ["oauth"],
  mediaKinds: ["video"],
  captionLimits: {
    caption: YOUTUBE_TITLE_MAX,
    description: YOUTUBE_DESCRIPTION_MAX_BYTES,
  },
  postingModes: [],
  // `PrivacyLevel` es el enum de TikTok (FR-060); el de YouTube es
  // configuración del publicador (`privacyStatus`).
  privacyLevels: [],
  supportsAiLabel: true,
  supportsPartnershipDisclosure: false,
  supportsAutoAddMusic: false,
  supportsCaptionGeneration: false,
  supportsNativeScheduling: false,
  requiredAccountKinds: [],
  // Se suben los bytes: alcanza la URL firmada del bucket, sin túnel.
  mediaSource: "private_url",
};

const ANGLES = /[<>]/g;

function sanitize(text: string): string {
  return text.replace(ANGLES, "").trim();
}

/** Los `reason` de `error.errors[]` (y `error.status`, por si viene sólo eso). */
export function youtubeReasons(json: unknown): string[] {
  const errors = field(json, "error", "errors");
  const out: string[] = [];
  if (Array.isArray(errors)) {
    for (const e of errors as unknown[]) {
      const r = str(e, "reason");
      if (r !== undefined) out.push(r);
    }
  }
  const status = str(json, "error", "status");
  if (status !== undefined) out.push(status);
  return out;
}

/**
 * Error de YouTube → resultado o `PortError`. Los códigos HTTP y `reason` son
 * los de https://developers.google.com/youtube/v3/docs/errors .
 */
export function classifyYouTubeError(
  result: HttpResult,
  phase: CallPhase,
): PortError | PublishStatus {
  const reasons = youtubeReasons(result.json);
  const cause = { status: result.status, reasons };
  if (result.status === 401) {
    return new PortError("unauthorized", "The account needs to be reconnected.", {
      source: SOURCE,
      cause,
    });
  }
  if (reasons.includes("quotaExceeded")) {
    return failed(
      "post_limit_exceeded",
      "The Google project used up today's YouTube upload quota. Try again tomorrow.",
    );
  }
  if (reasons.includes("uploadLimitExceeded")) {
    return failed(
      "post_limit_exceeded",
      "This YouTube channel reached its daily upload limit. Try again tomorrow.",
    );
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
  if (reasons.includes("forbiddenPrivacySetting")) {
    return failed("unknown", "YouTube didn't accept the privacy setting for this video.");
  }
  if (reasons.includes("invalidTitle") || reasons.includes("invalidDescription")) {
    return failed("unknown", "YouTube rejected the title or description of this video.");
  }
  if (result.status === 403) {
    return failed(
      "permissions_missing",
      "Permissions Missing — reconnect YouTube and approve all requested permissions.",
    );
  }
  return failed("unsupported_media", "YouTube rejected this video.");
}

type Api =
  | { readonly kind: "ok"; readonly result: HttpResult }
  | { readonly kind: "outcome"; readonly status: PublishStatus };

export class YouTubeShortsPublisher implements SocialPublisher {
  readonly #fetch: PublisherFetch;
  readonly #base: string;
  readonly #privacy: YouTubePrivacyStatus;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #uploadTimeoutMs: number;
  readonly #maxResume: number;
  readonly #idempotency = new IdempotencyCache();

  constructor(config: YouTubeShortsPublisherConfig = {}) {
    this.#fetch = config.fetch ?? ((url, init) => fetch(url, init));
    this.#base = (config.apiBase ?? "https://www.googleapis.com").replace(/\/$/, "");
    this.#privacy = config.privacyStatus ?? "public";
    this.#maxBytes = config.maxMediaBytes ?? 512 * 1024 * 1024;
    this.#timeoutMs = config.requestTimeoutMs ?? 60_000;
    this.#uploadTimeoutMs = config.uploadTimeoutMs ?? 600_000;
    this.#maxResume = Math.max(1, config.maxResumeAttempts ?? 3);
  }

  capabilities(): SocialPublishCapabilities {
    return YOUTUBE_SHORTS_CAPABILITIES;
  }

  async getAccountOptions(_account: PublishAccountRef): Promise<AccountPublishOptions> {
    return {
      allowedPrivacyLevels: [],
      directPostingAvailable: false,
      maxVideoDurationSeconds: YOUTUBE_SHORTS_MAX_SECONDS,
    };
  }

  async publish(request: PublishRequest): Promise<PublishStatus> {
    assertPublishable(request, YOUTUBE_SHORTS_CAPABILITIES, SOURCE);
    const token = requireToken(request, SOURCE);
    return this.#idempotency.run(request.idempotencyKey, () =>
      this.#publish(request, token),
    );
  }

  async #publish(request: PublishRequest, token: string): Promise<PublishStatus> {
    const [url, ...rest] = request.media.urls;
    if (url === undefined || rest.length > 0)
      return failed("unsupported_media", "A YouTube Short is a single video.");

    const title = sanitize(request.caption);
    if (title.length === 0)
      return failed("unknown", "A YouTube video needs a title: write a caption.");
    const description =
      request.description === undefined ? undefined : sanitize(request.description);
    if (
      description !== undefined &&
      new TextEncoder().encode(description).byteLength > YOUTUBE_DESCRIPTION_MAX_BYTES
    ) {
      return failed(
        "unknown",
        `The description is longer than YouTube allows (${String(YOUTUBE_DESCRIPTION_MAX_BYTES)} bytes).`,
      );
    }

    const { bytes, contentType } = await downloadBytes(this.#fetch, url, {
      source: SOURCE,
      timeoutMs: this.#timeoutMs,
      maxBytes: this.#maxBytes,
    });
    const notShort = this.#shortsProblem(request, bytes);
    if (notShort !== null) return failed("unsupported_media", notShort);

    const mediaType = contentType.startsWith("video/")
      ? (contentType.split(";")[0] ?? contentType)
      : "video/mp4";

    // Paso 1 · abrir la sesión resumable. Si falla, no hay video.
    const init = await this.#api(
      `${this.#base}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(bytes.byteLength),
          "X-Upload-Content-Type": mediaType,
        },
        body: JSON.stringify({
          snippet: {
            title,
            ...(description === undefined || description === "" ? {} : { description }),
          },
          status: {
            privacyStatus: this.#privacy,
            ...(request.aiGenerated === undefined
              ? {}
              : { containsSyntheticMedia: request.aiGenerated }),
          },
        }),
      },
      "prepare",
      this.#timeoutMs,
    );
    if (init.kind === "outcome") return init.status;
    const session = init.result.headers.get("location");
    if (session === null || session === "")
      throw contractViolation(SOURCE, "sesión resumable sin Location");

    // Paso 2 · los bytes. Terminar la subida crea el video: es `deliver`.
    const id = await this.#upload(session, token, bytes, mediaType);
    if (typeof id !== "string") return id;
    return {
      kind: "processing",
      externalPostId: id,
      ...(title === request.caption ? {} : { publishedCaption: title }),
    };
  }

  /** `null` si es un Short; si no, el motivo (seguro de mostrar). */
  #shortsProblem(request: PublishRequest, bytes: Uint8Array): string | null {
    const known = {
      width: request.media.width,
      height: request.media.height,
      durationSeconds: request.media.durationSeconds,
    };
    const probe =
      known.width === undefined ||
      known.height === undefined ||
      known.durationSeconds === undefined
        ? probeMp4(bytes)
        : null;
    const width = known.width ?? probe?.width ?? null;
    const height = known.height ?? probe?.height ?? null;
    const duration = known.durationSeconds ?? probe?.durationSeconds ?? null;
    if (width === null || height === null || duration === null) {
      return "We couldn't read this video's details, so it can't be checked as a YouTube Short.";
    }
    if (width > height) return "A YouTube Short has to be vertical or square.";
    if (duration > YOUTUBE_SHORTS_MAX_SECONDS)
      return "A YouTube Short can be up to 3 minutes long.";
    return null;
  }

  /**
   * `PUT` de los bytes, con reanudación documentada. Devuelve el id del video
   * o un resultado fallido; lanza entrega incierta si no se puede saber.
   */
  async #upload(
    session: string,
    token: string,
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<string | PublishStatus> {
    const total = bytes.byteLength;
    let offset = 0;
    for (let attempt = 0; attempt < this.#maxResume; attempt += 1) {
      let result: HttpResult | null;
      try {
        result = await call(
          this.#fetch,
          session,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": mediaType,
              ...(offset === 0
                ? {}
                : {
                    "Content-Range": `bytes ${String(offset)}-${String(total - 1)}/${String(total)}`,
                  }),
            },
            body: offset === 0 ? bytes : bytes.subarray(offset),
          },
          { source: SOURCE, phase: "deliver", timeoutMs: this.#uploadTimeoutMs },
        );
      } catch {
        // Timeout o corte: no se sabe cuánto llegó. Se pregunta.
        result = null;
      }
      if (result === null || result.status >= 500) {
        result = await this.#queryStatus(session, token, total);
      }
      if (result.status === 200 || result.status === 201) {
        const id = str(result.json, "id");
        if (id === undefined) throw contractViolation(SOURCE, "video sin id");
        return id;
      }
      if (result.status === 308) {
        offset = nextOffset(result.headers.get("range"));
        continue;
      }
      if (result.status === 404) {
        // *"Session expired; start new resumable upload"*: no quedó video.
        throw new PortError("provider_unavailable", "The upload session expired.", {
          source: SOURCE,
          cause: { status: 404 },
        });
      }
      const outcome = classifyYouTubeError(result, "deliver");
      if (outcome instanceof PortError) throw outcome;
      return outcome;
    }
    throw transportError(
      "provider_unavailable",
      "The upload didn't finish after several attempts.",
      { source: SOURCE, phase: "deliver" },
    );
  }

  /** `PUT` vacío con `Content-Range` de la forma `bytes *` + `/TOTAL` (sin espacios). Si tampoco contesta, incierto. */
  async #queryStatus(session: string, token: string, total: number): Promise<HttpResult> {
    let result: HttpResult;
    try {
      result = await call(
        this.#fetch,
        session,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Range": `bytes */${String(total)}`,
          },
        },
        { source: SOURCE, phase: "deliver", timeoutMs: this.#timeoutMs },
      );
    } catch (error) {
      throw error instanceof PortError
        ? error
        : transportError("provider_unavailable", "The platform could not be reached.", {
            source: SOURCE,
            phase: "deliver",
          });
    }
    if (result.status >= 500)
      throw serverError(result, { source: SOURCE, phase: "deliver" });
    return result;
  }

  async #api(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    phase: CallPhase,
    timeoutMs: number,
  ): Promise<Api> {
    const result = await call(this.#fetch, url, init, {
      source: SOURCE,
      phase,
      timeoutMs,
    });
    if (result.status >= 200 && result.status < 300) return { kind: "ok", result };
    const outcome = classifyYouTubeError(result, phase);
    if (outcome instanceof PortError) throw outcome;
    return { kind: "outcome", status: outcome };
  }

  /**
   * `videos.list?part=status&id=…` (1 unidad) —
   * https://developers.google.com/youtube/v3/docs/videos/list
   */
  async getStatus(ref: PublishRef): Promise<PublishStatus | null> {
    const token = requireToken(ref, SOURCE);
    const q = new URLSearchParams({ part: "status", id: ref.externalPostId });
    const res = await this.#api(
      `${this.#base}/youtube/v3/videos?${q.toString()}`,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      "prepare",
      this.#timeoutMs,
    );
    if (res.kind === "outcome") return null;
    const items = field(res.result.json, "items");
    if (!Array.isArray(items)) throw contractViolation(SOURCE, "videos.list sin items");
    const video = (items as unknown[])[0];
    if (video === undefined) return null;
    const id = str(video, "id") ?? ref.externalPostId;
    switch (str(video, "status", "uploadStatus")) {
      case "processed":
        return { kind: "published", externalPostId: id };
      case "uploaded":
        return { kind: "processing", externalPostId: id };
      case "failed":
      case "rejected":
        return {
          ...failed(
            "unsupported_media",
            "YouTube couldn't process or rejected this video.",
          ),
          externalPostId: id,
        };
      case "deleted":
        return null;
      default:
        return { kind: "processing", externalPostId: id };
    }
  }

  async cancel(_ref: PublishRef): Promise<CancelOutcome> {
    return NOT_CANCELLABLE;
  }

  /** Las métricas van por `SocialMetrics` (`adapters/metrics/youtube.ts`). */
  async fetchMetrics(refs: readonly PublishRef[]): Promise<readonly PostMetrics[]> {
    return metricsNotImplemented(refs, SOURCE);
  }
}

/** `Range: bytes=0-N` → N+1. Sin `Range`, no llegó nada: desde 0. */
export function nextOffset(range: string | null): number {
  const m = range === null ? null : /bytes=\d+-(\d+)/.exec(range);
  return m?.[1] === undefined ? 0 : Number(m[1]) + 1;
}
