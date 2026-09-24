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
 *
 * ## Personajes (Soul ID) — `PU-LATER-004`, `FR-080`
 *
 * Verificado en la doc el 2026-09-24, cada paso con su página:
 *
 * - **Subir una foto** (`/docs/concepts/file-uploads`): `POST
 *   {base}/files/generate-upload-url` con `{content_type}` → `{public_url,
 *   upload_url, content_type, upload_headers}`; después `PUT upload_url` con
 *   los bytes y **exactamente** `upload_headers`. «Do not send Higgsfield API
 *   credentials to the presigned storage URL»: ese `PUT` va sin
 *   `Authorization`. El `upload_url` vence en una hora.
 * - **Crear el personaje** (`/docs/models/soul-id/create-character`): `POST
 *   {base}/v1/custom-references` con `{name, model_version, input_images:
 *   [{type: "image_url", image_url}]}` (1–100 imágenes, nombre ≤ 100) →
 *   `{id, name, model_version, status, thumbnail_url, created_at,
 *   in_progress_at, fail_reason}`. Estados: `not_ready | queued |
 *   in_progress | completed | failed`. Estado = `GET
 *   {base}/v1/custom-references/{id}`.
 * - **Generar con el personaje** (`/docs/models/soul-2/generate`): SOUL V2
 *   acepta `custom_reference_id` (uuid de un personaje `completed`) y
 *   `custom_reference_strength` (0–1, «must be >0 with
 *   custom_reference_id»). Por eso el personaje se crea con `model_version:
 *   "v2"`: la doc dice que el id se usa con el SOUL de su misma versión.
 *
 * Lo que la doc **no** dice y por eso no se hace: el precio de crear un
 * personaje (no hay estimador documentado para `custom-references`), ni un
 * endpoint de video o talking head con el personaje (el índice
 * `docs/llms.txt` no lista ninguno).
 */
import {
  PortError,
  type GenAspectRatio,
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

/**
 * El `PUT` de los bytes a la URL firmada del storage de Higgsfield. Aparte de
 * {@link GenFetch} porque es otro host, otro método y un cuerpo binario, y
 * porque **no lleva la credencial**.
 */
export type HiggsfieldUploadFetch = (
  input: string,
  init: {
    method: "PUT";
    headers: Record<string, string>;
    body: Uint8Array;
    signal?: AbortSignal;
  },
) => Promise<Response>;

const defaultUploadFetch: HiggsfieldUploadFetch = (input, init) =>
  fetch(input, init as RequestInit);

export interface HiggsfieldClientConfig extends GenEndpoint {
  /** Por llamada HTTP. Default 30 s (el ejemplo de polling de la doc usa 30). */
  readonly timeoutMs?: number;
  readonly fetch?: GenFetch;
  readonly uploadFetch?: HiggsfieldUploadFetch;
  readonly now?: () => number;
}

/** `/docs/concepts/file-uploads`: los tipos de imagen que acepta la subida. */
export const HIGGSFIELD_UPLOAD_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

/** `/docs/models/soul-id/create-character`: `input_images` 1–100, nombre ≤ 100. */
export const HIGGSFIELD_CHARACTER_LIMITS = {
  minImages: 1,
  maxImages: 100,
  maxNameLength: 100,
} as const;

/** El modelo con el que se genera con un personaje (`/docs/models/soul-2/generate`). */
export const HIGGSFIELD_CHARACTER_IMAGE_MODEL = "higgsfield-ai/soul/v2/standard";

export type HiggsfieldCharacterStatus =
  "not_ready" | "queued" | "in_progress" | "completed" | "failed";

const CHARACTER_STATUSES: ReadonlySet<string> = new Set([
  "not_ready",
  "queued",
  "in_progress",
  "completed",
  "failed",
]);

export interface HiggsfieldCharacter {
  readonly id: string;
  readonly status: HiggsfieldCharacterStatus;
  /** Link del proveedor: expira como cualquier resultado. No se persiste. */
  readonly thumbnailUrl: string | null;
  /** Una línea apta para la UI, nunca el cuerpo crudo. */
  readonly failReason: string | null;
}

export interface HiggsfieldCharacterImageRequest {
  readonly characterId: string;
  readonly prompt: string;
  readonly aspectRatio: GenAspectRatio;
  /** `batch_size` de SOUL V2: 1 o 4. */
  readonly n: number;
  /** `custom_reference_strength`, (0, 1]. Default 1 (el de la doc). */
  readonly strength?: number;
}

/** SOUL V2 (`/docs/models/soul-2/generate`) ∩ los formatos de la app. */
export const HIGGSFIELD_CHARACTER_ASPECT_RATIOS: readonly GenAspectRatio[] = [
  "9:16",
  "3:4",
  "1:1",
  "4:3",
  "16:9",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  readonly #uploadFetch: HiggsfieldUploadFetch;
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
    this.#uploadFetch = config.uploadFetch ?? defaultUploadFetch;
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

  // ── Personajes (Soul ID) ── ver la cabecera ──

  /**
   * Sube una foto al storage de Higgsfield y devuelve su `public_url`, que es
   * lo que acepta `input_images`. Las fotos de referencia viven en nuestro
   * storage (MinIO local, sin URL pública): por eso se suben acá y no se
   * pasa una URL nuestra.
   */
  async uploadImage(input: {
    readonly body: Uint8Array;
    readonly contentType: string;
  }): Promise<string> {
    const contentType = input.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!(HIGGSFIELD_UPLOAD_IMAGE_TYPES as readonly string[]).includes(contentType)) {
      throw genError(
        "bad_request",
        "Higgsfield only takes JPEG, PNG, WebP or GIF reference photos",
        SOURCE,
      );
    }
    const res = await this.#call(
      "POST",
      joinUrl(this.#baseUrl, "files/generate-upload-url"),
      { content_type: contentType },
    );
    if (!res.ok) throw translate(res);
    if (!isRecord(res.json)) throw malformed(SOURCE, "upload url is not an object");
    const uploadUrl = httpsUrl(res.json["upload_url"], "upload_url");
    const publicUrl = httpsUrl(res.json["public_url"], "public_url");
    const headers: Record<string, string> = {};
    const declared = res.json["upload_headers"];
    if (isRecord(declared)) {
      for (const [k, v] of Object.entries(declared)) {
        if (typeof v === "string") headers[k] = v;
      }
    }
    // La credencial no viaja al storage, aunque el proveedor la pidiera.
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === "authorization") delete headers[k];
    }
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
      headers["Content-Type"] = contentType;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    let put: Response;
    try {
      put = await this.#uploadFetch(uploadUrl, {
        method: "PUT",
        headers,
        body: input.body,
        signal: controller.signal,
      });
    } catch (cause) {
      throw new PortError(
        controller.signal.aborted ? "timeout" : "provider_unavailable",
        "Could not upload the reference photo to Higgsfield",
        { source: SOURCE, cause },
      );
    } finally {
      clearTimeout(timer);
    }
    if (!put.ok) {
      throw new PortError(
        put.status >= 500 ? "provider_unavailable" : "bad_request",
        "Higgsfield's storage rejected the reference photo",
        { source: SOURCE, cause: `HTTP ${String(put.status)}` },
      );
    }
    return publicUrl;
  }

  /**
   * `POST /v1/custom-references`. **No se reintenta**: como un envío de
   * generación, no acepta clave de idempotencia; quien llama guarda el id
   * apenas vuelve y, en una reentrega, hace polling en vez de crear otro.
   */
  async createCharacter(input: {
    readonly name: string;
    readonly imageUrls: readonly string[];
  }): Promise<HiggsfieldCharacter> {
    const name = input.name.trim().slice(0, HIGGSFIELD_CHARACTER_LIMITS.maxNameLength);
    const n = input.imageUrls.length;
    if (name.length === 0) {
      throw genError("bad_request", "The character needs a name", SOURCE);
    }
    if (
      n < HIGGSFIELD_CHARACTER_LIMITS.minImages ||
      n > HIGGSFIELD_CHARACTER_LIMITS.maxImages
    ) {
      throw genError(
        "bad_request",
        `Higgsfield takes ${String(HIGGSFIELD_CHARACTER_LIMITS.minImages)}–${String(HIGGSFIELD_CHARACTER_LIMITS.maxImages)} reference photos`,
        SOURCE,
      );
    }
    const res = await this.#call("POST", joinUrl(this.#baseUrl, "v1/custom-references"), {
      name,
      model_version: "v2",
      input_images: input.imageUrls.map((url) => ({ type: "image_url", image_url: url })),
    });
    if (!res.ok) throw translate(res);
    return parseCharacter(res.json);
  }

  /** `GET /v1/custom-references/{id}`. */
  async getCharacter(id: string): Promise<HiggsfieldCharacter> {
    if (!UUID_RE.test(id)) throw genError("bad_request", "Not a character id", SOURCE);
    const res = await this.#call(
      "GET",
      joinUrl(this.#baseUrl, `v1/custom-references/${id}`),
    );
    if (!res.ok) throw translate(res);
    return parseCharacter(res.json);
  }

  /** El estimador de SOUL V2 con **los mismos** parámetros que el envío. */
  async estimateCharacterImage(
    request: HiggsfieldCharacterImageRequest,
  ): Promise<GenCostEstimate> {
    return this.#estimate(HIGGSFIELD_CHARACTER_IMAGE_MODEL, characterImageBody(request));
  }

  async generateCharacterImage(
    request: HiggsfieldCharacterImageRequest,
  ): Promise<GenSubmission> {
    return this.#submit(HIGGSFIELD_CHARACTER_IMAGE_MODEL, characterImageBody(request));
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

function httpsUrl(value: unknown, what: string): string {
  if (typeof value !== "string") throw malformed(SOURCE, `missing ${what}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw malformed(SOURCE, `unparseable ${what}`);
  }
  if (url.protocol !== "https:") throw malformed(SOURCE, `${what} is not https`);
  return url.toString();
}

/** La respuesta de `custom-references` → el personaje. */
export function parseCharacter(json: unknown): HiggsfieldCharacter {
  if (!isRecord(json)) throw malformed(SOURCE, "character is not an object");
  const id = json["id"];
  const status = json["status"];
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw malformed(SOURCE, "character without a uuid id");
  }
  if (typeof status !== "string" || !CHARACTER_STATUSES.has(status)) {
    throw malformed(SOURCE, `unknown character status ${String(status)}`);
  }
  const thumb = json["thumbnail_url"];
  const typed = status as HiggsfieldCharacterStatus;
  return {
    id,
    status: typed,
    thumbnailUrl: typeof thumb === "string" && thumb.length > 0 ? thumb : null,
    failReason:
      typed === "failed"
        ? safeProviderMessage(
            json["fail_reason"],
            "Higgsfield could not train the character",
          )
        : null,
  };
}

function characterImageBody(r: HiggsfieldCharacterImageRequest): Record<string, unknown> {
  if (!UUID_RE.test(r.characterId)) {
    throw genError("bad_request", "Not a character id", SOURCE);
  }
  if (!HIGGSFIELD_CHARACTER_ASPECT_RATIOS.includes(r.aspectRatio)) {
    throw genError(
      "bad_request",
      `SOUL V2 supports ${HIGGSFIELD_CHARACTER_ASPECT_RATIOS.join(", ")}`,
      SOURCE,
    );
  }
  if (r.n !== 1 && r.n !== 4) {
    throw genError("bad_request", "SOUL V2 makes 1 or 4 images per request", SOURCE);
  }
  const prompt = r.prompt.trim();
  if (prompt.length === 0) throw genError("bad_request", "Write a prompt", SOURCE);
  const strength = r.strength ?? 1;
  // «must be >0 with custom_reference_id»; y el esquema lo acota a 0–1.
  if (!(strength > 0 && strength <= 1)) {
    throw genError(
      "bad_request",
      "Character strength must be above 0 and at most 1",
      SOURCE,
    );
  }
  return {
    prompt,
    aspect_ratio: r.aspectRatio,
    batch_size: r.n,
    custom_reference_id: r.characterId,
    custom_reference_strength: strength,
  };
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
