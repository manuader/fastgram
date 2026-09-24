/**
 * `BackgroundRemoval` con fal BiRefNet v2 (video → video con alfa) —
 * `PU-MEME-002`, `PLAN-USO-PERSONAL` §4.
 *
 * ## Lo verificado, con su fuente (2026-09-24)
 *
 * - Endpoint `fal-ai/birefnet/v2/video`, entrada y salida:
 *   https://fal.ai/models/fal-ai/birefnet/v2/video/api
 *   · entrada: `video_url` (requerido; acepta **data URI base64**),
 *     `video_output_type` ∈ `X264 (.mp4)` (default), `VP9 (.webm)`,
 *     `PRORES4444 (.mov)`, `GIF (.gif)`; además `model`,
 *     `operating_resolution`, `video_quality`, `video_write_mode`,
 *     `refine_foreground`, `output_mask`, `sync_mode`, con defaults.
 *   · salida: `{ "video": { "url", "content_type", "file_name", "width",
 *     "height", "fps", "duration", "num_frames" }, "mask_video"? }`.
 * - Cola HTTP: https://fal.ai/docs/model-apis/model-endpoints/queue
 *   · `POST https://queue.fal.run/{endpoint}` con `Authorization: Key $FAL_KEY`
 *     → `{ request_id, response_url, status_url, cancel_url, queue_position }`;
 *   · `GET status_url` → `status` ∈ `IN_QUEUE`, `IN_PROGRESS`, `COMPLETED`;
 *   · `GET response_url` → la salida del modelo.
 *
 * Se pide **`VP9 (.webm)`**: el default (`X264`) no tiene canal alfa, que es
 * todo el punto. webm y no ProRes porque pesa una fracción y el navegador lo
 * reproduce con transparencia (el Media Bank lo previsualiza).
 *
 * ## Lo que no se infiere
 *
 * - Se usan `status_url` y `response_url` **tal como vienen** en el submit:
 *   la doc muestra rutas por endpoint, y armarlas a mano para un endpoint con
 *   subruta (`…/v2/video`) sería adivinar. Se exige que estén en el mismo
 *   origen que el submit: la key viaja en esas llamadas.
 * - La URL del resultado es de su CDN: se baja **sin** la key.
 * - El precio no está en la doc citada y no se escribe acá.
 */
import { readFile } from "node:fs/promises";

import {
  PortError,
  type BackgroundRemoval,
  type BackgroundRemovalInput,
  type BackgroundRemovalOutcome,
} from "@fastgram/ports";

const SOURCE = "BackgroundRemoval/fal-birefnet";

export type FalFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface FalBirefnetConfig {
  /** `https://queue.fal.run`. Lo valida `resolveBackgroundRemovalConfig` de core. */
  readonly baseUrl: string;
  /** `fal-ai/birefnet/v2/video`. */
  readonly endpoint: string;
  readonly apiKey: string;
  readonly fetch?: FalFetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  /** Tope de la espera en su cola. Default 15 min. */
  readonly timeoutMs?: number;
  /** Tope del resultado. Default 200 MB (un webm con alfa pesa más que el mp4 de entrada). */
  readonly maxResultBytes?: number;
  /** Sólo tests. */
  readonly readFile?: (path: string) => Promise<Uint8Array>;
  readonly now?: () => number;
}

const OUTPUT_TYPE = "VP9 (.webm)";
const REQUEST_TIMEOUT_MS = 60_000;

interface SubmitResponse {
  request_id?: unknown;
  status_url?: unknown;
  response_url?: unknown;
}

function httpError(status: number, what: string): PortError {
  const code =
    status === 401 || status === 403
      ? "unauthorized"
      : status === 429
        ? "rate_limited"
        : status === 404
          ? "not_found"
          : status === 422 || status === 400
            ? "bad_request"
            : status >= 500
              ? "provider_unavailable"
              : "bad_request";
  // Nunca el cuerpo: puede repetir el input (el video entero en base64).
  return new PortError(code, `fal ${what} answered HTTP ${status}`, { source: SOURCE });
}

export class FalBirefnetBackgroundRemoval implements BackgroundRemoval {
  readonly id = "fal-birefnet-v2-video";
  readonly #c: FalBirefnetConfig;
  readonly #fetch: FalFetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #origin: string;
  readonly #now: () => number;

  constructor(config: FalBirefnetConfig) {
    this.#c = config;
    this.#fetch = config.fetch ?? ((input, init) => fetch(input, init));
    this.#sleep =
      config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#origin = new URL(config.baseUrl).origin;
    this.#now = config.now ?? Date.now;
  }

  #auth(): Record<string, string> {
    return { authorization: `Key ${this.#c.apiKey}` };
  }

  async #call(
    url: string,
    init: Parameters<FalFetch>[1],
    what: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.#fetch(url, { ...init, signal: controller.signal });
    } catch (cause) {
      throw new PortError(
        controller.signal.aborted ? "timeout" : "provider_unavailable",
        `fal ${what} did not answer`,
        { source: SOURCE, cause },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #json(response: Response, what: string): Promise<Record<string, unknown>> {
    try {
      const value: unknown = await response.json();
      if (typeof value !== "object" || value === null) throw new Error("not an object");
      return value as Record<string, unknown>;
    } catch (cause) {
      throw new PortError(
        "provider_contract_violation",
        `fal ${what} returned invalid JSON`,
        {
          source: SOURCE,
          cause,
        },
      );
    }
  }

  /** Una URL de su cola, sólo en el mismo origen: ahí va la key. */
  #queueUrl(value: unknown, what: string): string {
    if (typeof value !== "string") {
      throw new PortError("provider_contract_violation", `fal submit has no ${what}`, {
        source: SOURCE,
      });
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch (cause) {
      throw new PortError("provider_contract_violation", `fal ${what} is not a URL`, {
        source: SOURCE,
        cause,
      });
    }
    if (url.origin !== this.#origin) {
      throw new PortError("provider_contract_violation", `fal ${what} points elsewhere`, {
        source: SOURCE,
      });
    }
    return url.toString();
  }

  async remove(input: BackgroundRemovalInput): Promise<BackgroundRemovalOutcome> {
    const bytes = await (this.#c.readFile ?? readFile)(input.path);
    const dataUri = `data:${input.contentType};base64,${Buffer.from(bytes).toString("base64")}`;

    // ── submit ──
    const submit = await this.#call(
      `${this.#origin}/${this.#c.endpoint}`,
      {
        method: "POST",
        headers: { ...this.#auth(), "content-type": "application/json" },
        body: JSON.stringify({ video_url: dataUri, video_output_type: OUTPUT_TYPE }),
      },
      "submit",
    );
    if (!submit.ok) throw httpError(submit.status, "submit");
    const queued = (await this.#json(submit, "submit")) as SubmitResponse;
    const statusUrl = this.#queueUrl(queued.status_url, "status_url");
    const responseUrl = this.#queueUrl(queued.response_url, "response_url");

    // ── poll ──
    const deadline = this.#now() + (this.#c.timeoutMs ?? 15 * 60_000);
    for (;;) {
      const s = await this.#call(
        statusUrl,
        { method: "GET", headers: this.#auth() },
        "status",
      );
      if (!s.ok) throw httpError(s.status, "status");
      const status = (await this.#json(s, "status"))["status"];
      if (status === "COMPLETED") break;
      if (status !== "IN_QUEUE" && status !== "IN_PROGRESS") {
        throw new PortError(
          "provider_contract_violation",
          "fal returned an unknown status",
          {
            source: SOURCE,
          },
        );
      }
      if (this.#now() >= deadline) {
        throw new PortError("timeout", "fal did not finish in time", { source: SOURCE });
      }
      await this.#sleep(this.#c.pollIntervalMs ?? 3_000);
    }

    // ── result ──
    const r = await this.#call(
      responseUrl,
      { method: "GET", headers: this.#auth() },
      "result",
    );
    if (!r.ok) throw httpError(r.status, "result");
    const result = await this.#json(r, "result");
    const video = result["video"];
    const url =
      typeof video === "object" && video !== null
        ? (video as Record<string, unknown>)["url"]
        : undefined;
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new PortError("provider_contract_violation", "fal result has no video URL", {
        source: SOURCE,
      });
    }

    // Del CDN, sin la key.
    const file = await this.#call(url, { method: "GET", headers: {} }, "download");
    if (!file.ok) throw httpError(file.status, "download");
    const max = this.#c.maxResultBytes ?? 200 * 1024 * 1024;
    const declared = Number(file.headers.get("content-length") ?? "0");
    if (declared > max) {
      throw new PortError("provider_contract_violation", "fal result is too large", {
        source: SOURCE,
      });
    }
    const body = new Uint8Array(await file.arrayBuffer());
    if (body.byteLength === 0 || body.byteLength > max) {
      throw new PortError(
        "provider_contract_violation",
        "fal result has an invalid size",
        {
          source: SOURCE,
        },
      );
    }
    return { kind: "alpha_video", body, contentType: "video/webm", extension: "webm" };
  }
}
