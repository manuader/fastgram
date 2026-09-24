/**
 * Threads — `PU-PUB-004`: texto, imagen, video y carrusel.
 *
 * Documentación, consultada el 2026-09-24:
 *  - https://developers.facebook.com/docs/threads/posts
 *    · contenedor: `POST https://graph.threads.net/v1.0/<THREADS_USER_ID>/threads`
 *      con `media_type` (`TEXT` | `IMAGE` | `VIDEO`), `text`, `image_url`,
 *      `video_url`, form-encoded con `access_token` (`curl -d …`).
 *    · carrusel: hijos con `is_carousel_item=true`, después
 *      `media_type=CAROUSEL` + `children` (mínimo 2, **máximo 20**).
 *    · publicar: `POST …/<THREADS_USER_ID>/threads_publish` con `creation_id`.
 *    · «It is recommended to wait on average 30 seconds before publishing»: acá
 *      se consulta el estado del contenedor en vez de esperar a ciegas.
 *  - https://developers.facebook.com/docs/threads/troubleshooting
 *    · estado: `GET /<CONTAINER_ID>?fields=status,error_message` →
 *      `EXPIRED | ERROR | FINISHED | IN_PROGRESS | PUBLISHED`; ejemplo
 *      `{ "status": "FINISHED", "id": "17889615691921648" }`.
 *    · tope: 250 publicaciones por 24 h (`threads_publishing_limit`).
 *  - https://developers.facebook.com/docs/threads/overview —
 *    «Text posts are limited to 500 characters».
 *  - https://developers.facebook.com/docs/threads/threads-media — `permalink`.
 *
 * **No verificado**: la clasificación de errores es la de la Graph API
 * general (`meta/graph-errors.ts`); la doc de Threads no publica una tabla de
 * códigos propia.
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
  graphCall,
  type GraphClientConfig,
  type GraphResponse,
} from "../meta/graph-client.js";
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
  contractViolation,
  realSleep,
  str,
  type CallPhase,
  type PublisherFetch,
  type Sleep,
} from "../shared/http.js";

const SOURCE = "SocialPublisher/threads";

export const THREADS_CAROUSEL_MAX = 20;

export interface ThreadsPublisherConfig {
  readonly fetch?: PublisherFetch;
  readonly sleep?: Sleep;
  /** Default `https://graph.threads.net`. */
  readonly host?: string;
  /** Default `v1.0`. */
  readonly apiVersion?: string;
  readonly requestTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
}

export const THREADS_CAPABILITIES: SocialPublishCapabilities = {
  platform: "threads",
  provider: "threads-graph",
  accountTypes: ["oauth"],
  mediaKinds: ["text", "image", "video", "carousel", "slideshow"],
  captionLimits: { caption: 500 },
  postingModes: [],
  privacyLevels: [],
  supportsAiLabel: false,
  supportsPartnershipDisclosure: false,
  supportsAutoAddMusic: false,
  supportsCaptionGeneration: false,
  supportsNativeScheduling: false,
  requiredAccountKinds: [],
  mediaSource: "public_url",
};

type ContainerState = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

export class ThreadsPublisher implements SocialPublisher {
  readonly #client: GraphClientConfig;
  readonly #sleep: Sleep;
  readonly #pollIntervalMs: number;
  readonly #pollTimeoutMs: number;
  readonly #idempotency = new IdempotencyCache();
  readonly #pending = new Map<string, string>();

  constructor(config: ThreadsPublisherConfig = {}) {
    this.#client = {
      fetch: config.fetch ?? ((url, init) => fetch(url, init)),
      base: `${(config.host ?? "https://graph.threads.net").replace(/\/$/, "")}/${config.apiVersion ?? "v1.0"}`,
      source: SOURCE,
      timeoutMs: config.requestTimeoutMs ?? 30_000,
      tokenPlacement: "form",
    };
    this.#sleep = config.sleep ?? realSleep;
    this.#pollIntervalMs = config.pollIntervalMs ?? 5_000;
    this.#pollTimeoutMs = config.pollTimeoutMs ?? 180_000;
  }

  capabilities(): SocialPublishCapabilities {
    return THREADS_CAPABILITIES;
  }

  async getAccountOptions(_account: PublishAccountRef): Promise<AccountPublishOptions> {
    return { allowedPrivacyLevels: [], directPostingAvailable: false };
  }

  async publish(request: PublishRequest): Promise<PublishStatus> {
    assertPublishable(request, THREADS_CAPABILITIES, SOURCE);
    const token = requireToken(request, SOURCE);
    const userId = requirePlatformUserId(request.account, SOURCE);
    return this.#idempotency.run(request.idempotencyKey, () =>
      this.#publish(request, token, userId),
    );
  }

  async #publish(
    request: PublishRequest,
    token: string,
    userId: string,
  ): Promise<PublishStatus> {
    if (request.media.urls.length > THREADS_CAROUSEL_MAX) {
      return failed(
        "unsupported_media",
        `Carousels on this platform take up to ${String(THREADS_CAROUSEL_MAX)} items.`,
      );
    }

    let containerId = this.#pending.get(request.idempotencyKey);
    if (containerId === undefined) {
      const created = await this.#createContainer(request, token, userId);
      if (typeof created !== "string") return created;
      containerId = created;
      this.#pending.set(request.idempotencyKey, containerId);
    }

    const { value: state, timedOut } = await pollUntil(
      () => this.#containerState(containerId, token),
      (s) => s !== "IN_PROGRESS",
      {
        intervalMs: this.#pollIntervalMs,
        timeoutMs: this.#pollTimeoutMs,
        sleep: this.#sleep,
      },
    );
    if (timedOut) {
      throw new PortError("timeout", "The platform is still processing the media.", {
        source: SOURCE,
      });
    }
    if (state === "EXPIRED") {
      this.#pending.delete(request.idempotencyKey);
      throw new PortError("provider_unavailable", "The media container expired.", {
        source: SOURCE,
      });
    }
    if (state === "ERROR") {
      this.#pending.delete(request.idempotencyKey);
      return failed(
        "unsupported_media",
        "The platform couldn't process this media file.",
      );
    }
    if (state === "PUBLISHED") {
      // Ver la nota igual en Instagram: no se vuelve a llamar a publish.
      this.#pending.delete(request.idempotencyKey);
      return { kind: "published" };
    }

    const published = await this.#graph(
      "POST",
      `/${userId}/threads_publish`,
      token,
      "deliver",
      {
        creation_id: containerId,
      },
    );
    this.#pending.delete(request.idempotencyKey);
    if (published.kind === "outcome") return published.status;
    const mediaId = str(published.json, "id");
    if (mediaId === undefined) throw contractViolation(SOURCE, "threads_publish sin id");

    const permalink = await this.#permalink(mediaId, token);
    return {
      kind: "published",
      externalPostId: mediaId,
      ...(permalink === undefined ? {} : { permalink }),
    };
  }

  async #createContainer(
    request: PublishRequest,
    token: string,
    userId: string,
  ): Promise<string | PublishStatus> {
    const { kind, urls } = request.media;
    const text = request.caption;
    let params: Record<string, string>;

    if (kind === "text") {
      params = { media_type: "TEXT", text };
    } else if (kind === "video") {
      params = { media_type: "VIDEO", video_url: urls[0] ?? "", text };
    } else if (urls.length === 1) {
      params = { media_type: "IMAGE", image_url: urls[0] ?? "", text };
    } else {
      const children: string[] = [];
      for (const url of urls) {
        const child = await this.#graph("POST", `/${userId}/threads`, token, "prepare", {
          media_type: "IMAGE",
          image_url: url,
          is_carousel_item: "true",
        });
        if (child.kind === "outcome") return child.status;
        const childId = str(child.json, "id");
        if (childId === undefined)
          throw contractViolation(SOURCE, "hijo de carrusel sin id");
        children.push(childId);
      }
      params = { media_type: "CAROUSEL", children: children.join(","), text };
    }

    const container = await this.#graph(
      "POST",
      `/${userId}/threads`,
      token,
      "prepare",
      params,
    );
    if (container.kind === "outcome") return container.status;
    const id = str(container.json, "id");
    if (id === undefined) throw contractViolation(SOURCE, "contenedor sin id");
    return id;
  }

  async #containerState(containerId: string, token: string): Promise<ContainerState> {
    const res = await this.#graph("GET", `/${containerId}`, token, "prepare", {
      fields: "status,error_message",
    });
    if (res.kind === "outcome") return "ERROR";
    const state = str(res.json, "status");
    if (
      state === "EXPIRED" ||
      state === "ERROR" ||
      state === "FINISHED" ||
      state === "IN_PROGRESS" ||
      state === "PUBLISHED"
    )
      return state;
    throw contractViolation(SOURCE, "status desconocido");
  }

  async #permalink(mediaId: string, token: string): Promise<string | undefined> {
    try {
      const res = await this.#graph("GET", `/${mediaId}`, token, "prepare", {
        fields: "permalink",
      });
      return res.kind === "ok" ? str(res.json, "permalink") : undefined;
    } catch {
      return undefined;
    }
  }

  #graph(
    method: "GET" | "POST",
    path: string,
    token: string,
    phase: CallPhase,
    params?: Record<string, string>,
  ): Promise<GraphResponse> {
    return graphCall(this.#client, {
      method,
      path,
      token,
      phase,
      ...(params === undefined ? {} : { params }),
    });
  }

  async getStatus(ref: PublishRef): Promise<PublishStatus | null> {
    const token = requireToken(ref, SOURCE);
    const res = await this.#graph("GET", `/${ref.externalPostId}`, token, "prepare", {
      fields: "id,permalink",
    });
    if (res.kind === "outcome") return null;
    const permalink = str(res.json, "permalink");
    return {
      kind: "published",
      externalPostId: ref.externalPostId,
      ...(permalink === undefined ? {} : { permalink }),
    };
  }

  async cancel(_ref: PublishRef): Promise<CancelOutcome> {
    return NOT_CANCELLABLE;
  }

  async fetchMetrics(refs: readonly PublishRef[]): Promise<readonly PostMetrics[]> {
    return metricsNotImplemented(refs, SOURCE);
  }
}
