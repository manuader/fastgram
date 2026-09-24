/**
 * `ImageGen` + `VideoGen` contra la cola de fal — `PU-MODEL-003`/`004`/`005`.
 *
 * Verificado el 2026-09-24 contra
 * `https://fal.ai/docs/documentation/model-apis/inference/queue`:
 *
 * - Enviar = `POST https://queue.fal.run/{endpoint_id}` con
 *   `Authorization: Key $FAL_KEY`; responde `request_id`, `status_url`,
 *   `response_url` y `cancel_url`. Se usan esas URLs tal cual.
 * - Estado = `GET status_url` → `IN_QUEUE | IN_PROGRESS | COMPLETED`. Un
 *   pedido que falló llega `COMPLETED` **con** `error` y `error_type`.
 * - Resultado = `GET response_url`; la forma es la del modelo (`images[]`,
 *   `video`). FLUX devuelve además `has_nsfw_concepts[]`, y «images flagged as
 *   unsafe are returned as black images»: esas se descartan.
 * - Errores del modelo (`/docs/documentation/model-apis/errors`): `detail[]`
 *   con `type`; `content_policy_violation` (422, no reintentable) es el filtro
 *   de contenido. Concurrencia: `429` (`/model-apis/concurrency-limits`),
 *   aunque por la cola los pedidos esperan en vez de rechazarse.
 * - «Server errors are never billed» (`/model-apis/pricing`).
 *
 * «Test connection» llama a la Platform API de precios
 * (`GET https://api.fal.ai/v1/models/pricing?endpoint_id=…`), que exige key
 * y no genera nada (`/docs/platform-apis/v1/models/pricing`).
 */
import {
  PortError,
  type GenCostEstimate,
  type GenCredentialCheck,
  type GenEndpoint,
  type GenJobHandle,
  type GenJobState,
  type GenModelSpec,
  type GenOutput,
  type GenSubmission,
  type ImageGen,
  type ImageGenRequest,
  type VideoGen,
  type VideoGenRequest,
} from "@fastgram/ports";

import {
  defaultGenFetch,
  genError,
  genHttp,
  isRecord,
  joinUrl,
  malformed,
  safeProviderMessage,
  trustedProviderUrl,
  type GenFetch,
  type GenHttpResponse,
} from "../genai/http.js";
import { checkImageRequest, checkVideoRequest } from "../genai/spec.js";
import {
  FAL_MODELS,
  type FalPricedImageEntry,
  type FalPricedVideoEntry,
} from "./catalog.js";

const SOURCE = "GenAi/fal";

/** La base de la cola, documentada. */
export const FAL_QUEUE_BASE_URL = "https://queue.fal.run";
/** La Platform API (precios), documentada. */
export const FAL_PLATFORM_BASE_URL = "https://api.fal.ai/v1";

export interface FalClientConfig extends GenEndpoint {
  readonly platformBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetch?: GenFetch;
  readonly now?: () => number;
}

export class FalClient implements ImageGen, VideoGen {
  readonly provider = "fal";
  readonly #baseUrl: string;
  readonly #platformBaseUrl: string;
  readonly #auth: string;
  readonly #timeoutMs: number;
  readonly #fetch: GenFetch;
  readonly #now: () => number;

  constructor(config: FalClientConfig) {
    const key = config.apiKey.trim();
    if (key.length === 0) {
      throw new PortError("unauthorized", "A fal API key is required", {
        source: SOURCE,
      });
    }
    this.#baseUrl = config.baseUrl;
    this.#platformBaseUrl = config.platformBaseUrl ?? FAL_PLATFORM_BASE_URL;
    this.#auth = `Key ${key}`;
    this.#timeoutMs = config.timeoutMs ?? 30_000;
    this.#fetch = config.fetch ?? defaultGenFetch;
    this.#now = config.now ?? Date.now;
  }

  models(): readonly GenModelSpec[] {
    return FAL_MODELS.map((m) => m.spec);
  }

  estimateImage(request: ImageGenRequest): Promise<GenCostEstimate> {
    const entry = this.#image(request);
    const { usd, basis } = entry.price({
      n: request.n ?? 1,
      aspectRatio: request.aspectRatio,
    });
    return Promise.resolve(listEstimate(usd, basis, entry.spec));
  }

  estimateVideo(request: VideoGenRequest): Promise<GenCostEstimate> {
    const entry = this.#video(request);
    const { usd, basis } = entry.price({ durationSeconds: request.durationSeconds });
    return Promise.resolve(listEstimate(usd, basis, entry.spec));
  }

  generateImage(request: ImageGenRequest): Promise<GenSubmission> {
    const entry = this.#image(request);
    return this.#submit(entry.spec.id, entry.body(request));
  }

  generateVideo(request: VideoGenRequest): Promise<GenSubmission> {
    const entry = this.#video(request);
    return this.#submit(entry.spec.id, entry.body(request));
  }

  async poll(handle: GenJobHandle): Promise<GenJobState> {
    const statusUrl = trustedProviderUrl(handle.statusUrl, this.#baseUrl, SOURCE);
    const res = await this.#call("GET", statusUrl);
    if (!res.ok) throw translate(res);
    if (!isRecord(res.json)) throw malformed(SOURCE, "status is not an object");
    const status = res.json["status"];
    if (status === "IN_QUEUE") return { status: "queued", outputs: [] };
    if (status === "IN_PROGRESS") return { status: "in_progress", outputs: [] };
    if (status !== "COMPLETED")
      throw malformed(SOURCE, `unknown status ${String(status)}`);

    const error = res.json["error"];
    if (error !== undefined && error !== null) {
      return {
        status: "failed",
        outputs: [],
        message: safeProviderMessage(error, "Generation failed"),
      };
    }

    const responseUrl = trustedProviderUrl(
      handle.responseUrl ?? res.json["response_url"],
      this.#baseUrl,
      SOURCE,
    );
    const result = await this.#call("GET", responseUrl);
    if (!result.ok) {
      if (isContentPolicy(result)) {
        return { status: "nsfw", outputs: [], message: CONTENT_POLICY_MESSAGE };
      }
      if (result.status >= 500) throw translate(result);
      if (result.status === 401 || result.status === 403 || result.status === 404) {
        throw translate(result);
      }
      return {
        status: "failed",
        outputs: [],
        message: safeProviderMessage(firstDetailMessage(result), "Generation failed"),
      };
    }
    return parseResult(result.json);
  }

  async checkCredentials(model: string): Promise<GenCredentialCheck> {
    if (!FAL_MODELS.some((m) => m.spec.id === model)) throw unknownModel(model);
    const started = this.#now();
    const url = `${joinUrl(this.#platformBaseUrl, "models/pricing")}?endpoint_id=${encodeURIComponent(model)}`;
    const res = await this.#call("GET", url);
    if (!res.ok) throw translate(res);
    if (!isRecord(res.json) || !Array.isArray(res.json["prices"])) {
      throw malformed(SOURCE, "pricing without prices");
    }
    return { latencyMs: Math.max(0, this.#now() - started), probe: "pricing endpoint" };
  }

  #image(request: ImageGenRequest): FalPricedImageEntry {
    const entry = FAL_MODELS.find((m) => m.spec.id === request.model);
    if (entry?.spec.kind !== "image") throw unknownModel(request.model);
    checkImageRequest(entry.spec, request, SOURCE);
    return entry as FalPricedImageEntry;
  }

  #video(request: VideoGenRequest): FalPricedVideoEntry {
    const entry = FAL_MODELS.find((m) => m.spec.id === request.model);
    if (entry?.spec.kind !== "video") throw unknownModel(request.model);
    checkVideoRequest(entry.spec, request, SOURCE);
    return entry as FalPricedVideoEntry;
  }

  async #submit(model: string, body: Record<string, unknown>): Promise<GenSubmission> {
    const res = await this.#call("POST", joinUrl(this.#baseUrl, model), body);
    if (!res.ok) {
      if (isContentPolicy(res)) {
        return { kind: "rejected", status: "nsfw", message: CONTENT_POLICY_MESSAGE };
      }
      throw translate(res);
    }
    if (!isRecord(res.json)) throw malformed(SOURCE, "submission is not an object");
    const requestId = res.json["request_id"];
    if (typeof requestId !== "string" || requestId.length === 0) {
      throw malformed(SOURCE, "submission without request_id");
    }
    return {
      kind: "accepted",
      handle: {
        requestId,
        statusUrl: trustedProviderUrl(res.json["status_url"], this.#baseUrl, SOURCE),
        responseUrl: trustedProviderUrl(res.json["response_url"], this.#baseUrl, SOURCE),
      },
    };
  }

  #call(
    method: "GET" | "POST",
    url: string,
    body?: Record<string, unknown>,
  ): Promise<GenHttpResponse> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: this.#auth,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return genHttp(
      this.#fetch,
      url,
      body === undefined
        ? { method, headers }
        : { method, headers, body: JSON.stringify(body) },
      { timeoutMs: this.#timeoutMs, source: SOURCE },
    );
  }
}

const CONTENT_POLICY_MESSAGE =
  "The prompt or the result was flagged by fal's content policy filter";

function listEstimate(usd: number, basis: string, spec: GenModelSpec): GenCostEstimate {
  return {
    usd,
    source: "price_list",
    basis,
    ...(spec.listPrice === null ? {} : { sourceUrl: spec.listPrice.sourceUrl }),
  };
}

function unknownModel(model: string): PortError {
  return new PortError(
    "bad_request",
    `"${model.slice(0, 80)}" is not in FastGram's verified fal catalog`,
    { source: SOURCE },
  );
}

function details(res: GenHttpResponse): readonly Record<string, unknown>[] {
  if (!isRecord(res.json)) return [];
  const detail = res.json["detail"];
  return Array.isArray(detail) ? detail.filter(isRecord) : [];
}

function isContentPolicy(res: GenHttpResponse): boolean {
  return details(res).some((d) => d["type"] === "content_policy_violation");
}

function firstDetailMessage(res: GenHttpResponse): unknown {
  const first = details(res)[0];
  if (first !== undefined) return first["msg"];
  return isRecord(res.json) ? res.json["detail"] : undefined;
}

/** La salida del modelo → las URLs, sin las imágenes que fal marcó. */
export function parseResult(json: unknown): GenJobState {
  if (!isRecord(json)) throw malformed(SOURCE, "result is not an object");
  const outputs: GenOutput[] = [];
  const flags = Array.isArray(json["has_nsfw_concepts"]) ? json["has_nsfw_concepts"] : [];
  const images = json["images"];
  let flagged = 0;
  if (Array.isArray(images)) {
    images.forEach((item: unknown, i: number) => {
      if (flags[i] === true) {
        flagged += 1;
        return;
      }
      if (isRecord(item) && typeof item["url"] === "string") {
        outputs.push({
          url: item["url"],
          ...(typeof item["content_type"] === "string"
            ? { contentType: item["content_type"] }
            : {}),
        });
      }
    });
  }
  const video = json["video"];
  if (isRecord(video) && typeof video["url"] === "string") {
    outputs.push({
      url: video["url"],
      ...(typeof video["content_type"] === "string"
        ? { contentType: video["content_type"] }
        : {}),
    });
  }
  if (outputs.length === 0 && flagged > 0) {
    return { status: "nsfw", outputs: [], message: CONTENT_POLICY_MESSAGE };
  }
  if (outputs.length === 0) throw malformed(SOURCE, "result without media");
  return { status: "completed", outputs };
}

function translate(res: GenHttpResponse): PortError {
  const s = res.status;
  if (s === 401) return genError("unauthorized", "fal rejected the API key", SOURCE, res);
  if (s === 403)
    return genError("forbidden", "fal refused the request for this key", SOURCE, res);
  if (s === 404) {
    return genError("not_found", "fal does not know that model or request", SOURCE, res);
  }
  if (s === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    return new PortError("rate_limited", "fal's concurrency limit was reached", {
      source: SOURCE,
      cause: `HTTP 429: ${res.text}`,
      ...(Number.isFinite(retryAfter) && retryAfter > 0
        ? { retryAfterSeconds: retryAfter }
        : {}),
    });
  }
  if (s === 504) return genError("timeout", "fal timed out", SOURCE, res);
  if (s >= 500)
    return genError("provider_unavailable", "fal is unavailable", SOURCE, res);
  return genError("bad_request", "fal rejected the request", SOURCE, res);
}
