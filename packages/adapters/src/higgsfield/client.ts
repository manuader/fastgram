/**
 * `ImageGen` + `VideoGen` contra Higgsfield — `PU-MODEL-003`/`004`/`005`.
 *
 * Todo lo de acá está en la documentación oficial (verificada el 2026-09-24);
 * cada regla cita su página:
 *
 * - Base `https://api.higgsfield.ai`, header
 *   `Authorization: Key {KEY_ID}:{KEY_SECRET}` (`/docs/authentication`).
 * - Enviar = `POST {base}/{endpoint_id}` con el JSON del modelo; responde
 *   `{status, request_id, status_url, cancel_url}` y **hay que usar esas
 *   URLs**, no armarlas (`/docs/concepts/requests`).
 * - Estado = `GET status_url`: `queued | in_progress | completed | failed |
 *   nsfw | canceled`; con `completed`, `images[].url` o `video.url`
 *   (`/docs/api-reference/requests/get-request-status`).
 * - Costo = `POST {base}/estimate/{endpoint_id}` con **los mismos**
 *   parámetros → `{credits, usd}` como cadenas
 *   (`/docs/concepts/billing-and-retention`). `failed` y `nsfw` no se cobran.
 * - Errores (`/docs/concepts/errors`): 400 parámetros **o tope de
 *   concurrencia**, 401 credenciales, 403 sin créditos, 404 modelo o pedido,
 *   422 validación, 423 modelo bloqueado, 500, 503 modelo no disponible.
 *   El tope de concurrencia no tiene código propio: es un 400 con
 *   «Maximum number of concurrent requests (4) has been reached»
 *   (`/docs/concepts/rate-limits`). Es el único caso en que se mira el
 *   texto, y sólo para decidir si es reintentable: equivocarse ahí da un
 *   `bad_request` (no se reintenta) en vez de un `rate_limited`.
 * - **Un `POST` de generación no se reintenta** después de un timeout ambiguo:
 *   «submissions do not currently accept an idempotency key». Este adaptador
 *   no reintenta nada; la política es de quien llama.
 * - Los resultados duran «at least seven days»: quien llama los copia.
 *
 * Webhooks (`hf_webhook`) no se usan: piden un endpoint HTTPS público y el
 * polling es el camino de recuperación que la doc igual recomienda tener.
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
  numeric,
  roundUsd,
  safeProviderMessage,
  trustedProviderUrl,
  type GenFetch,
  type GenHttpResponse,
} from "../genai/http.js";
import {
  checkImageRequest,
  checkVideoRequest,
  type ImageModelEntry,
  type VideoModelEntry,
} from "../genai/spec.js";
import { HIGGSFIELD_MODELS, Z_IMAGE_PROMPT_MAX } from "./catalog.js";

const SOURCE = "GenAi/higgsfield";

/** La base documentada. Editable en Settings (para un proxy o un test). */
export const HIGGSFIELD_BASE_URL = "https://api.higgsfield.ai";

export interface HiggsfieldClientConfig extends GenEndpoint {
  /** Por llamada HTTP. Default 30 s (el ejemplo de polling de la doc usa 30). */
  readonly timeoutMs?: number;
  readonly fetch?: GenFetch;
  readonly now?: () => number;
}

const STATUSES = new Set([
  "queued",
  "in_progress",
  "completed",
  "failed",
  "nsfw",
  "canceled",
]);

export class HiggsfieldClient implements ImageGen, VideoGen {
  readonly provider = "higgsfield";
  readonly #baseUrl: string;
  readonly #auth: string;
  readonly #timeoutMs: number;
  readonly #fetch: GenFetch;
  readonly #now: () => number;

  constructor(config: HiggsfieldClientConfig) {
    const key = config.apiKey.trim();
    // `Key {id}:{secret}`: sin los dos lados, cada llamada sería un 401.
    const sep = key.indexOf(":");
    if (sep <= 0 || sep === key.length - 1) {
      throw new PortError(
        "unauthorized",
        "Higgsfield credentials must look like KEY_ID:KEY_SECRET",
        { source: SOURCE },
      );
    }
    this.#baseUrl = config.baseUrl;
    this.#auth = `Key ${key}`;
    this.#timeoutMs = config.timeoutMs ?? 30_000;
    this.#fetch = config.fetch ?? defaultGenFetch;
    this.#now = config.now ?? Date.now;
  }

  models(): readonly GenModelSpec[] {
    return HIGGSFIELD_MODELS.map((m) => m.spec);
  }

  async estimateImage(request: ImageGenRequest): Promise<GenCostEstimate> {
    const entry = this.#image(request);
    return this.#estimate(entry.spec.id, entry.body(request));
  }

  async estimateVideo(request: VideoGenRequest): Promise<GenCostEstimate> {
    const entry = this.#video(request);
    return this.#estimate(entry.spec.id, entry.body(request));
  }

  async generateImage(request: ImageGenRequest): Promise<GenSubmission> {
    const entry = this.#image(request);
    return this.#submit(entry.spec.id, entry.body(request));
  }

  async generateVideo(request: VideoGenRequest): Promise<GenSubmission> {
    const entry = this.#video(request);
    return this.#submit(entry.spec.id, entry.body(request));
  }

  async poll(handle: GenJobHandle): Promise<GenJobState> {
    const url = trustedProviderUrl(handle.statusUrl, this.#baseUrl, SOURCE);
    const res = await this.#call("GET", url);
    if (!res.ok) throw translate(res);
    return parseStatus(res.json);
  }

  /**
   * «Test connection»: el estimador del modelo con un prompt mínimo. Está
   * autenticado (401 con credenciales malas) y **no genera ni cobra**.
   */
  async checkCredentials(model: string): Promise<GenCredentialCheck> {
    const entry = HIGGSFIELD_MODELS.find((m) => m.spec.id === model);
    if (entry === undefined) throw unknownModel(model);
    const started = this.#now();
    if (entry.spec.kind === "image") {
      await this.estimateImage({
        model,
        prompt: "test",
        aspectRatio: entry.spec.aspectRatios[0] ?? "1:1",
        n: entry.spec.counts[0] ?? 1,
      });
    } else if (entry.spec.imageInput !== "required") {
      await this.estimateVideo({
        model,
        prompt: "test",
        aspectRatio: entry.spec.aspectRatios[0] ?? "16:9",
        durationSeconds: entry.spec.durationsSeconds[0] ?? 5,
      });
    } else {
      // Un image-to-video pide una imagen real para estimar, y inventar una
      // URL no prueba nada: se prueban las credenciales con el estimador del
      // ejemplo de la doc (SOUL V2, `/docs/concepts/billing-and-retention`).
      await this.#estimate("higgsfield-ai/soul/v2/standard", { prompt: "test" });
    }
    return { latencyMs: Math.max(0, this.#now() - started), probe: "estimate endpoint" };
  }

  #image(request: ImageGenRequest): ImageModelEntry {
    const entry = HIGGSFIELD_MODELS.find((m) => m.spec.id === request.model);
    if (entry?.spec.kind !== "image") throw unknownModel(request.model);
    checkImageRequest(entry.spec, request, SOURCE);
    if (entry.spec.id === "z-image/turbo" && request.prompt.length > Z_IMAGE_PROMPT_MAX) {
      throw genError(
        "bad_request",
        `Z-Image Turbo takes prompts of at most ${String(Z_IMAGE_PROMPT_MAX)} characters`,
        SOURCE,
      );
    }
    return entry as ImageModelEntry;
  }

  #video(request: VideoGenRequest): VideoModelEntry {
    const entry = HIGGSFIELD_MODELS.find((m) => m.spec.id === request.model);
    if (entry?.spec.kind !== "video") throw unknownModel(request.model);
    checkVideoRequest(entry.spec, request, SOURCE);
    return entry as VideoModelEntry;
  }

  async #estimate(
    model: string,
    body: Record<string, unknown>,
  ): Promise<GenCostEstimate> {
    const res = await this.#call(
      "POST",
      joinUrl(this.#baseUrl, `estimate/${model}`),
      body,
    );
    if (!res.ok) throw translate(res);
    if (!isRecord(res.json)) throw malformed(SOURCE, "estimate is not an object");
    const usd = numeric(res.json["usd"]);
    const credits = numeric(res.json["credits"]);
    if (usd === null || usd < 0) throw malformed(SOURCE, "estimate without usd");
    return {
      usd: roundUsd(usd),
      source: "provider",
      basis:
        credits === null
          ? "Higgsfield estimate for this account"
          : `Higgsfield estimate: ${String(credits)} credits`,
      sourceUrl: "https://docs.higgsfield.ai/docs/concepts/billing-and-retention",
      ...(credits === null ? {} : { credits }),
    };
  }

  async #submit(model: string, body: Record<string, unknown>): Promise<GenSubmission> {
    const res = await this.#call("POST", joinUrl(this.#baseUrl, model), body);
    if (!res.ok) throw translate(res);
    if (!isRecord(res.json)) throw malformed(SOURCE, "submission is not an object");
    const requestId = res.json["request_id"];
    if (typeof requestId !== "string" || requestId.length === 0) {
      throw malformed(SOURCE, "submission without request_id");
    }
    const statusUrl = trustedProviderUrl(res.json["status_url"], this.#baseUrl, SOURCE);
    return { kind: "accepted", handle: { requestId, statusUrl } };
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

function unknownModel(model: string): PortError {
  return new PortError(
    "bad_request",
    `"${model.slice(0, 80)}" is not in FastGram's verified Higgsfield catalog`,
    { source: SOURCE },
  );
}

/** El estado documentado → el del puerto. */
export function parseStatus(json: unknown): GenJobState {
  if (!isRecord(json)) throw malformed(SOURCE, "status is not an object");
  const status = json["status"];
  if (typeof status !== "string" || !STATUSES.has(status)) {
    throw malformed(SOURCE, `unknown status ${String(status)}`);
  }
  const typed = status as GenJobState["status"];
  if (typed === "completed") {
    const outputs: GenOutput[] = [];
    const images = json["images"];
    if (Array.isArray(images)) {
      for (const item of images) {
        if (isRecord(item) && typeof item["url"] === "string")
          outputs.push({ url: item["url"] });
      }
    }
    const video = json["video"];
    if (isRecord(video) && typeof video["url"] === "string")
      outputs.push({ url: video["url"] });
    if (outputs.length === 0) throw malformed(SOURCE, "completed without outputs");
    return { status: typed, outputs };
  }
  if (typed === "failed") {
    return {
      status: typed,
      outputs: [],
      message: safeProviderMessage(json["error"], "Generation failed"),
    };
  }
  if (typed === "nsfw") {
    return {
      status: typed,
      outputs: [],
      message: "The prompt or the result was rejected by Higgsfield's content moderation",
    };
  }
  return { status: typed, outputs: [] };
}

/** Un HTTP no-2xx → `PortError`, con la tabla de `/docs/concepts/errors`. */
function translate(res: GenHttpResponse): PortError {
  const detail = isRecord(res.json) ? res.json["detail"] : undefined;
  switch (res.status) {
    case 400:
      if (typeof detail === "string" && /concurrent requests/i.test(detail)) {
        return genError(
          "rate_limited",
          "Higgsfield's concurrent request limit was reached",
          SOURCE,
          res,
        );
      }
      return genError("bad_request", "Higgsfield rejected the request", SOURCE, res);
    case 401:
      return genError("unauthorized", "Higgsfield rejected the credentials", SOURCE, res);
    case 403:
      return genError(
        "quota_exceeded",
        "The Higgsfield account has no credits left",
        SOURCE,
        res,
      );
    case 404:
      return genError(
        "not_found",
        "Higgsfield does not know that model or request for this account",
        SOURCE,
        res,
      );
    case 422:
      return genError("bad_request", "Higgsfield rejected the parameters", SOURCE, res);
    case 429:
      // No está en su tabla de errores, pero un 429 no puede ser otra cosa.
      return genError(
        "rate_limited",
        "Higgsfield is rate limiting requests",
        SOURCE,
        res,
      );
    case 423:
    case 503:
      return genError(
        "provider_unavailable",
        "That Higgsfield model is not available right now",
        SOURCE,
        res,
      );
    default:
      if (res.status >= 500) {
        return genError("provider_unavailable", "Higgsfield is unavailable", SOURCE, res);
      }
      return genError("bad_request", "Higgsfield rejected the request", SOURCE, res);
  }
}
