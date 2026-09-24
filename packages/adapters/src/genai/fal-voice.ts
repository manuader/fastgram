/**
 * `SpeechGen` + `TalkingAvatar` + `CharacterSwap` contra la cola de fal —
 * sprint 8 (agente L), `P4-FORMAT-002`, `P4-INFL-011`.
 *
 * Mismo protocolo que `../fal/client.ts` (verificado el 2026-09-24 contra
 * `https://fal.ai/docs/documentation/model-apis/inference/queue`):
 *
 * - Enviar = `POST https://queue.fal.run/{endpoint_id}` con `Authorization:
 *   Key $FAL_KEY` → `request_id`, `status_url`, `response_url`. Se usan esas
 *   URLs tal cual, y sólo si son del mismo origen (la key viaja en ellas).
 * - Estado = `GET status_url` → `IN_QUEUE | IN_PROGRESS | COMPLETED`; un
 *   `COMPLETED` con `error` es un fallo.
 * - Resultado = `GET response_url`: `audio` (TTS) o `video` (OmniHuman, Wan),
 *   más `duration` en OmniHuman («as used for billing»).
 * - `content_policy_violation` (422) es el filtro de contenido: un resultado
 *   (`nsfw`), no un error.
 *
 * Qué se manda y cuánto cuesta: `fal-voice-catalog.ts`.
 *
 * «Test connection» es el mismo de imagen/video: la Platform API de precios
 * (`GET https://api.fal.ai/v1/models/pricing?endpoint_id=…`), que exige key y
 * no genera nada.
 */
import {
  PortError,
  type CharacterSwap,
  type CharacterSwapModelSpec,
  type CharacterSwapRequest,
  type GenCostEstimate,
  type GenCredentialCheck,
  type GenEndpoint,
  type GenJobHandle,
  type GenListPrice,
  type GenSubmission,
  type SpeechGen,
  type SpeechModelSpec,
  type SpeechRequest,
  type TalkingAvatar,
  type TalkingAvatarModelSpec,
  type TalkingAvatarRequest,
  type VoiceJobState,
} from "@fastgram/ports";

import {
  defaultGenFetch,
  genError,
  genHttp,
  isRecord,
  joinUrl,
  malformed,
  numeric,
  safeProviderMessage,
  trustedProviderUrl,
  type GenFetch,
  type GenHttpResponse,
} from "./http.js";
import {
  FAL_AVATAR_MODELS,
  FAL_SPEECH_MODELS,
  FAL_SWAP_MODELS,
  type FalAvatarEntry,
  type FalSpeechEntry,
  type FalSwapEntry,
} from "./fal-voice-catalog.js";

const SOURCE = "GenAi/fal-voice";
/** Un nombre o id de voz: letras, números, `_`, `-` y espacios. */
const VOICE_ID = /^[A-Za-z0-9][A-Za-z0-9_ -]{0,63}$/;
const PLATFORM_BASE_URL = "https://api.fal.ai/v1";
/**
 * Sin fps del video de origen se estima con 60: el tope habitual de un
 * celular. Es a propósito el caso caro (un clip de 30 fps cuesta la mitad):
 * el estimado alimenta el tope mensual y contar de más es lo seguro.
 */
export const SWAP_ASSUMED_FPS = 60;

export interface FalVoiceClientConfig extends GenEndpoint {
  readonly platformBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetch?: GenFetch;
  readonly now?: () => number;
}

export class FalVoiceClient implements SpeechGen, TalkingAvatar, CharacterSwap {
  readonly provider = "fal";
  readonly #baseUrl: string;
  readonly #platformBaseUrl: string;
  readonly #auth: string;
  readonly #timeoutMs: number;
  readonly #fetch: GenFetch;
  readonly #now: () => number;

  constructor(config: FalVoiceClientConfig) {
    const key = config.apiKey.trim();
    if (key.length === 0) {
      throw new PortError("unauthorized", "A fal API key is required", {
        source: SOURCE,
      });
    }
    this.#baseUrl = config.baseUrl;
    this.#platformBaseUrl = config.platformBaseUrl ?? PLATFORM_BASE_URL;
    this.#auth = `Key ${key}`;
    this.#timeoutMs = config.timeoutMs ?? 30_000;
    this.#fetch = config.fetch ?? defaultGenFetch;
    this.#now = config.now ?? Date.now;
  }

  // ── catálogos ──

  speechModels(): readonly SpeechModelSpec[] {
    return FAL_SPEECH_MODELS.map((m) => m.spec);
  }

  avatarModels(): readonly TalkingAvatarModelSpec[] {
    return FAL_AVATAR_MODELS.map((m) => m.spec);
  }

  swapModels(): readonly CharacterSwapModelSpec[] {
    return FAL_SWAP_MODELS.map((m) => m.spec);
  }

  // ── voz ──

  async estimateSpeech(request: SpeechRequest): Promise<GenCostEstimate> {
    const entry = this.#speech(request);
    const { usd, basis } = entry.price(request.text.trim().length);
    return listEstimate(usd, basis, entry.spec.listPrice);
  }

  async generateSpeech(request: SpeechRequest): Promise<GenSubmission> {
    const entry = this.#speech(request);
    return await this.#submit(
      entry.spec.id,
      entry.body({
        text: request.text.trim(),
        voice: request.voice,
        languageCode: entry.spec.languageCode ? request.languageCode : undefined,
      }),
    );
  }

  // ── talking avatar ──

  async estimateAvatar(request: TalkingAvatarRequest): Promise<GenCostEstimate> {
    const entry = this.#avatar(request);
    const { usd, basis } = entry.price(request.audioSeconds);
    return listEstimate(usd, basis, entry.spec.listPrice);
  }

  async generateAvatar(request: TalkingAvatarRequest): Promise<GenSubmission> {
    const entry = this.#avatar(request);
    requireFileInput(request.imageUrl, "image");
    requireFileInput(request.audioUrl, "audio");
    return await this.#submit(
      entry.spec.id,
      entry.body({
        imageUrl: request.imageUrl,
        audioUrl: request.audioUrl,
        resolution: request.resolution,
        prompt: entry.spec.promptSupported ? request.prompt : undefined,
      }),
    );
  }

  // ── character swap ──

  async estimateSwap(request: CharacterSwapRequest): Promise<GenCostEstimate> {
    const entry = this.#swap(request);
    const { usd, basis } = entry.price({
      seconds: request.videoSeconds,
      fps: request.fps ?? SWAP_ASSUMED_FPS,
      resolution: request.resolution,
    });
    return listEstimate(
      usd,
      request.fps === undefined ? `${basis}; fps unknown, assumed 60` : basis,
      entry.spec.listPrice,
    );
  }

  async generateSwap(request: CharacterSwapRequest): Promise<GenSubmission> {
    const entry = this.#swap(request);
    requireFileInput(request.imageUrl, "image");
    requireFileInput(request.videoUrl, "video");
    return await this.#submit(
      entry.spec.id,
      entry.body({
        imageUrl: request.imageUrl,
        videoUrl: request.videoUrl,
        resolution: request.resolution,
      }),
    );
  }

  // ── común ──

  async pollVoice(handle: GenJobHandle): Promise<VoiceJobState> {
    const statusUrl = trustedProviderUrl(handle.statusUrl, this.#baseUrl, SOURCE);
    const res = await this.#call("GET", statusUrl);
    if (!res.ok) throw translate(res);
    if (!isRecord(res.json)) throw malformed(SOURCE, "status is not an object");
    const status = res.json["status"];
    if (status === "IN_QUEUE") return { status: "queued" };
    if (status === "IN_PROGRESS") return { status: "in_progress" };
    if (status !== "COMPLETED")
      throw malformed(SOURCE, `unknown status ${String(status)}`);
    const error = res.json["error"];
    if (error !== undefined && error !== null) {
      return {
        status: "failed",
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
        return { status: "nsfw", message: CONTENT_POLICY_MESSAGE };
      }
      if (
        result.status >= 500 ||
        result.status === 401 ||
        result.status === 403 ||
        result.status === 404
      ) {
        throw translate(result);
      }
      return {
        status: "failed",
        message: safeProviderMessage(firstDetailMessage(result), "Generation failed"),
      };
    }
    return parseVoiceResult(result.json);
  }

  async checkVoiceCredentials(model: string): Promise<GenCredentialCheck> {
    const known = [
      ...FAL_SPEECH_MODELS.map((m) => m.spec.id),
      ...FAL_AVATAR_MODELS.map((m) => m.spec.id),
      ...FAL_SWAP_MODELS.map((m) => m.spec.id),
    ];
    if (!known.includes(model)) throw unknownModel(model);
    const started = this.#now();
    const url = `${joinUrl(this.#platformBaseUrl, "models/pricing")}?endpoint_id=${encodeURIComponent(model)}`;
    const res = await this.#call("GET", url);
    if (!res.ok) throw translate(res);
    if (!isRecord(res.json) || !Array.isArray(res.json["prices"])) {
      throw malformed(SOURCE, "pricing without prices");
    }
    return { latencyMs: Math.max(0, this.#now() - started), probe: "pricing endpoint" };
  }

  #speech(request: SpeechRequest): FalSpeechEntry {
    const entry = FAL_SPEECH_MODELS.find((m) => m.spec.id === request.model);
    if (entry === undefined) throw unknownModel(request.model);
    const text = request.text.trim();
    if (text.length === 0) throw bad("The script is empty");
    if (text.length > entry.spec.maxChars) {
      throw bad(
        `This voice model reads at most ${String(entry.spec.maxChars)} characters`,
      );
    }
    // Las voces documentadas son ejemplos (el campo es texto libre): se
    // acepta cualquier id con forma de id, nada que parezca otra cosa.
    if (request.voice !== undefined && !VOICE_ID.test(request.voice)) {
      throw bad("That doesn't look like a voice id");
    }
    if (request.languageCode !== undefined && !/^[a-z]{2}$/.test(request.languageCode)) {
      throw bad("Use a two-letter language code (ISO 639-1)");
    }
    return entry;
  }

  #avatar(request: TalkingAvatarRequest): FalAvatarEntry {
    const entry = FAL_AVATAR_MODELS.find((m) => m.spec.id === request.model);
    if (entry === undefined) throw unknownModel(request.model);
    const resolution = entry.spec.resolutions.find((r) => r.id === request.resolution);
    if (resolution === undefined) throw bad("This model does not offer that resolution");
    if (!Number.isFinite(request.audioSeconds) || request.audioSeconds <= 0) {
      throw bad("The audio length is unknown");
    }
    if (request.audioSeconds > resolution.maxAudioSeconds) {
      throw bad(
        `At ${resolution.id} the audio must be under ${String(resolution.maxAudioSeconds)} seconds`,
      );
    }
    return entry;
  }

  #swap(request: CharacterSwapRequest): FalSwapEntry {
    const entry = FAL_SWAP_MODELS.find((m) => m.spec.id === request.model);
    if (entry === undefined) throw unknownModel(request.model);
    if (!entry.spec.resolutions.includes(request.resolution)) {
      throw bad("This model does not offer that resolution");
    }
    if (!Number.isFinite(request.videoSeconds) || request.videoSeconds <= 0) {
      throw bad("The source video length is unknown");
    }
    if (
      request.fps !== undefined &&
      (!Number.isFinite(request.fps) || request.fps <= 0)
    ) {
      throw bad("The source video frame rate is invalid");
    }
    return entry;
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
  "The input or the result was flagged by fal's content policy filter";

function bad(message: string): PortError {
  return new PortError("bad_request", message, { source: SOURCE });
}

/** Una URL https pública o un data URI: lo único que fal puede leer. */
function requireFileInput(value: string, what: string): void {
  if (value.startsWith("data:") && value.includes(";base64,")) return;
  if (value.startsWith("https://")) return;
  throw bad(`The ${what} must be a public https URL or a data URI`);
}

function listEstimate(
  usd: number,
  basis: string,
  listPrice: GenListPrice | null,
): GenCostEstimate {
  return {
    usd,
    source: "price_list",
    basis,
    ...(listPrice === null ? {} : { sourceUrl: listPrice.sourceUrl }),
  };
}

function unknownModel(model: string): PortError {
  return new PortError(
    "bad_request",
    `"${model.slice(0, 80)}" is not in FastGram's verified fal voice catalog`,
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

/** `{audio}` o `{video, duration?}` → la salida. */
export function parseVoiceResult(json: unknown): VoiceJobState {
  if (!isRecord(json)) throw malformed(SOURCE, "result is not an object");
  const file = isRecord(json["video"])
    ? json["video"]
    : isRecord(json["audio"])
      ? json["audio"]
      : null;
  if (file === null || typeof file["url"] !== "string" || file["url"] === "") {
    throw malformed(SOURCE, "result without media");
  }
  const billed = numeric(json["duration"]);
  const durationMs = numeric(json["duration_ms"]);
  const mediaSeconds = durationMs !== null && durationMs > 0 ? durationMs / 1000 : billed;
  return {
    status: "completed",
    output: {
      url: file["url"],
      ...(typeof file["content_type"] === "string"
        ? { contentType: file["content_type"] }
        : {}),
    },
    ...(billed === null || billed <= 0 ? {} : { billedSeconds: billed }),
    ...(mediaSeconds === null || mediaSeconds <= 0 ? {} : { mediaSeconds }),
  };
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
