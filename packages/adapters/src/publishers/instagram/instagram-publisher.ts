/**
 * Instagram — `PU-PUB-003` (`= P3-SCHED-008`): reel, carrusel e imagen, por la
 * Content Publishing API con **Instagram Login** (sin Página de Facebook).
 *
 * Documentación, consultada el 2026-09-24:
 *  - Flujo: https://developers.facebook.com/docs/instagram-platform/content-publishing
 *    · contenedor: `POST /<IG_ID>/media` con `image_url` | `media_type=REELS` +
 *      `video_url` | `media_type=CAROUSEL` + `children` (hasta 10), `caption`.
 *      Respuesta `{ "id": "<IG_CONTAINER_ID>" }`.
 *    · hijos de carrusel: `is_carousel_item=true`.
 *    · estado: `GET /<IG_CONTAINER_ID>?fields=status_code` →
 *      `EXPIRED | ERROR | FINISHED | IN_PROGRESS | PUBLISHED`.
 *    · publicar: `POST /<IG_ID>/media_publish` con `creation_id` →
 *      `{ "id": "<IG_MEDIA_ID>" }`.
 *    · «We cURL media used in publishing attempts, so the media must be hosted
 *      on a publicly accessible server»: por eso `mediaSource: "public_url"`.
 *    · «JPEG is the only image format supported».
 *    · Host: Instagram Login usa `graph.instagram.com`; Facebook Login,
 *      `graph.facebook.com`. Ambos configurables.
 *  - Permalink: campo `permalink` de IG Media,
 *    https://developers.facebook.com/docs/instagram-platform/reference/instagram-media
 *  - Versión: la Graph API más nueva es `v26.0` (29/07/2026),
 *    https://developers.facebook.com/docs/graph-api/changelog — configurable.
 *  - Límite de caption 2 200: subcódigo 2207010 de
 *    https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes
 *
 * **No verificado**: que una cuenta con rol en una app en modo desarrollo
 * publique sin App Review (se confirma con la primera cuenta real, §11 del
 * plan). Y el tope oficial: la doc dice 100 por 24 h en una sección y 50 en
 * otra; el tope propio de la marca (default 3) está muy por debajo de los dos.
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

const SOURCE = "SocialPublisher/instagram";

/** «Carousels are limited to 10 images, videos, or a mix of the two». */
export const INSTAGRAM_CAROUSEL_MAX = 10;

export interface InstagramPublisherConfig {
  readonly fetch?: PublisherFetch;
  readonly sleep?: Sleep;
  /** Default `https://graph.instagram.com` (Instagram Login). */
  readonly host?: string;
  /** Default `v26.0`. */
  readonly apiVersion?: string;
  readonly requestTimeoutMs?: number;
  /** Cada cuánto se mira el contenedor. Default 5 s. */
  readonly pollIntervalMs?: number;
  /**
   * Cuánto se espera a que el contenedor quede `FINISHED`. Default 180 s: el
   * job de publicación tiene 300 s de timeout en el catálogo del worker.
   */
  readonly pollTimeoutMs?: number;
}

export const INSTAGRAM_CAPABILITIES: SocialPublishCapabilities = {
  platform: "instagram",
  provider: "instagram-graph",
  accountTypes: ["oauth"],
  mediaKinds: ["video", "image", "carousel", "slideshow"],
  captionLimits: { caption: 2_200 },
  postingModes: [],
  privacyLevels: [],
  // INT-002: la etiqueta IA sólo existe por la ruta Ayrshare, no por ésta.
  supportsAiLabel: false,
  supportsPartnershipDisclosure: false,
  supportsAutoAddMusic: false,
  supportsCaptionGeneration: false,
  supportsNativeScheduling: false,
  // Content Publishing: cuentas profesionales (Business o Creator).
  requiredAccountKinds: ["business", "creator"],
  mediaSource: "public_url",
};

type ContainerState = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

export class InstagramPublisher implements SocialPublisher {
  readonly #client: GraphClientConfig;
  readonly #sleep: Sleep;
  readonly #pollIntervalMs: number;
  readonly #pollTimeoutMs: number;
  readonly #idempotency = new IdempotencyCache();
  /**
   * Contenedores creados que todavía no se publicaron, por `idempotencyKey`.
   * Si el primer intento se quedó sin tiempo esperando el `FINISHED`, el
   * reintento sigue mirando **ese** contenedor en vez de crear otro.
   */
  readonly #pending = new Map<string, string>();

  constructor(config: InstagramPublisherConfig = {}) {
    this.#client = {
      fetch: config.fetch ?? ((url, init) => fetch(url, init)),
      base: `${(config.host ?? "https://graph.instagram.com").replace(/\/$/, "")}/${config.apiVersion ?? "v26.0"}`,
      source: SOURCE,
      timeoutMs: config.requestTimeoutMs ?? 30_000,
      tokenPlacement: "bearer",
    };
    this.#sleep = config.sleep ?? realSleep;
    this.#pollIntervalMs = config.pollIntervalMs ?? 5_000;
    this.#pollTimeoutMs = config.pollTimeoutMs ?? 180_000;
  }

  capabilities(): SocialPublishCapabilities {
    return INSTAGRAM_CAPABILITIES;
  }

  async getAccountOptions(_account: PublishAccountRef): Promise<AccountPublishOptions> {
    return { allowedPrivacyLevels: [], directPostingAvailable: false };
  }

  async publish(request: PublishRequest): Promise<PublishStatus> {
    assertPublishable(request, INSTAGRAM_CAPABILITIES, SOURCE);
    const token = requireToken(request, SOURCE);
    const igId = requirePlatformUserId(request.account, SOURCE);
    return this.#idempotency.run(request.idempotencyKey, () =>
      this.#publish(request, token, igId),
    );
  }

  async #publish(
    request: PublishRequest,
    token: string,
    igId: string,
  ): Promise<PublishStatus> {
    const urls = request.media.urls;
    if (urls.length > INSTAGRAM_CAROUSEL_MAX) {
      return failed(
        "unsupported_media",
        `Carousels on this platform take up to ${String(INSTAGRAM_CAROUSEL_MAX)} items.`,
      );
    }

    let containerId = this.#pending.get(request.idempotencyKey);
    if (containerId === undefined) {
      const created = await this.#createContainer(request, token, igId);
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
      // Nada se publicó: el contenedor sigue vivo (vence a las 24 h) y el
      // reintento lo retoma. Reintentable.
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
      // Un intento anterior ya lo publicó y se perdió la respuesta. **No** se
      // vuelve a llamar a `media_publish`: la doc no dice qué hace con un
      // contenedor ya publicado, y el riesgo es un duplicado. Salió, pero sin
      // el id del post (el contenedor no lo expone según la doc).
      this.#pending.delete(request.idempotencyKey);
      return { kind: "published" };
    }

    const published = await this.#graph(
      "POST",
      `/${igId}/media_publish`,
      token,
      "deliver",
      {
        creation_id: containerId,
      },
    );
    if (published.kind === "outcome") {
      this.#pending.delete(request.idempotencyKey);
      return published.status;
    }
    this.#pending.delete(request.idempotencyKey);
    const mediaId = str(published.json, "id");
    if (mediaId === undefined) throw contractViolation(SOURCE, "media_publish sin id");

    const permalink = await this.#permalink(mediaId, token);
    return {
      kind: "published",
      externalPostId: mediaId,
      ...(permalink === undefined ? {} : { permalink }),
    };
  }

  /** El contenedor del post (y los hijos si es carrusel). */
  async #createContainer(
    request: PublishRequest,
    token: string,
    igId: string,
  ): Promise<string | PublishStatus> {
    const urls = request.media.urls;
    const caption = request.caption;
    const kind = request.media.kind;

    let body: Record<string, string>;
    if (kind === "video") {
      const url = urls[0] ?? "";
      body = { media_type: "REELS", video_url: url, caption };
    } else if (urls.length === 1) {
      // Un slideshow de una sola imagen es una imagen: el carrusel pide 2–10.
      body = { image_url: urls[0] ?? "", caption };
    } else {
      const children: string[] = [];
      for (const url of urls) {
        const child = await this.#graph("POST", `/${igId}/media`, token, "prepare", {
          image_url: url,
          is_carousel_item: "true",
        });
        if (child.kind === "outcome") return child.status;
        const childId = str(child.json, "id");
        if (childId === undefined)
          throw contractViolation(SOURCE, "hijo de carrusel sin id");
        children.push(childId);
      }
      body = { media_type: "CAROUSEL", children: children.join(","), caption };
    }

    const container = await this.#graph("POST", `/${igId}/media`, token, "prepare", body);
    if (container.kind === "outcome") return container.status;
    const id = str(container.json, "id");
    if (id === undefined) throw contractViolation(SOURCE, "contenedor sin id");
    return id;
  }

  async #containerState(containerId: string, token: string): Promise<ContainerState> {
    const res = await this.#graph("GET", `/${containerId}`, token, "prepare", {
      fields: "status_code",
    });
    if (res.kind === "outcome") {
      // Un rechazo definitivo al consultar el estado no pasa en la práctica; si
      // pasa, el contenedor no sirve.
      return "ERROR";
    }
    const state = str(res.json, "status_code");
    if (
      state === "EXPIRED" ||
      state === "ERROR" ||
      state === "FINISHED" ||
      state === "IN_PROGRESS" ||
      state === "PUBLISHED"
    )
      return state;
    throw contractViolation(SOURCE, "status_code desconocido");
  }

  /** El permalink es un extra: si falla, el post salió igual. */
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
