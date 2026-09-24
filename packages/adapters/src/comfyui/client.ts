/**
 * `ImageGen` + `VideoGen` contra un ComfyUI local — `PU-LATER-003`,
 * `docs/PLAN-USO-PERSONAL.md` §4 («ComfyUI (API HTTP)»).
 *
 * Rutas usadas, todas de https://docs.comfy.org/development/comfyui-server/comms_routes
 * (verificado el 2026-09-24):
 *
 * - `POST /prompt` — «submit a prompt to the queue». Valida y encola,
 *   «returning either a `prompt_id` and `number` (the position in the
 *   queue), or `error` and `node_errors` if validation fails». En `server.py`
 *   el fallo de validación es un `400` con `{ error, node_errors }`, y cada
 *   error es `{ type, message, details, extra_info }` (`execution.py`,
 *   `validate_prompt`). El cuerpo es `{ prompt, client_id }`, como en
 *   `script_examples/websockets_api_example.py`.
 * - `GET /history/{prompt_id}` — «retrieve the queue history for a specific
 *   prompt». Devuelve `{}` mientras no terminó, y `{ [prompt_id]: { prompt,
 *   outputs, status } }` al terminar (`execution.py`, `task_done`).
 * - `GET /view?filename=&subfolder=&type=` — «view an image»; `404` si el
 *   archivo no está (`server.py`). La descarga la hace el worker con la URL
 *   que devuelve {@link ComfyUiClient.poll}.
 * - `POST /upload/image` — «upload an image». Multipart con `image`,
 *   `overwrite`, `subfolder` y `type`; responde `{ name, subfolder, type }`
 *   (`server.py`, `image_upload`). Para la imagen de entrada.
 * - `GET /system_stats` — «retrieve information about the system (python
 *   version, devices, vram etc)». Es el «Test connection»: no genera nada y
 *   pesa mucho menos que `/object_info` («details of all node types»).
 *
 * `/ws` («WebSocket endpoint for real-time communication») daría progreso,
 * pero el worker ya hace polling con backoff para los otros proveedores y un
 * socket abierto por job no entra en ese ciclo. Se usa `/history`.
 *
 * ## Costo
 *
 * Cero: corre en la máquina del usuario. La estimación es `usd: 0` y el tope
 * mensual no se consume (`fitsBudget` deja pasar lo gratis).
 *
 * ## Errores
 *
 * - No se pudo conectar → `provider_unavailable` («¿está corriendo?»).
 * - `400` de `/prompt` (nodo faltante, input inválido, workflow sin salida)
 *   → `bad_request` con el primer error legible (nodo, tipo, mensaje).
 * - La ejecución falló (`status_str: "error"`) → estado `failed` con el
 *   `exception_message` del mensaje `execution_error`, no un error de
 *   transporte: el pedido se aceptó y terminó mal.
 */
import { randomUUID } from "node:crypto";

import {
  PortError,
  type ComfyWorkflowConfig,
  type GenCostEstimate,
  type GenCredentialCheck,
  type GenJobHandle,
  type GenJobState,
  type GenMediaKind,
  type GenModelSpec,
  type GenSubmission,
  type ImageGen,
  type ImageGenRequest,
  type VideoGen,
  type VideoGenRequest,
} from "@fastgram/ports";

import { ALL_RATIOS } from "../genai/spec.js";
import {
  collectFiles,
  contentTypeOf,
  injectWorkflow,
  missingRef,
  numberInput,
  pickFiles,
  sizeForAspect,
  viewUrl,
  type ComfyInjection,
} from "./workflow.js";

const SOURCE = "GenAi/comfyui";

/** «The server runs at http://127.0.0.1:8188 by default» (comms_overview). */
export const COMFYUI_DEFAULT_BASE_URL = "http://127.0.0.1:8188";

export const COMFYUI_DOCS_URL =
  "https://docs.comfy.org/development/comfyui-server/comms_routes";

/** Tope de la imagen de entrada que se baja para subirla. Sanidad, no producto. */
const MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024;
/** Cuánto del cuerpo se guarda para el `cause` (va al log, no a la UI). */
const CAUSE_BODY_CHARS = 300;

export type ComfyFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ComfyUiClientConfig {
  readonly baseUrl: string;
  /**
   * La tarea y su workflow. Sin ellos el cliente sólo sirve para «Test
   * connection» (`checkCredentials`).
   */
  readonly task?: GenMediaKind;
  readonly workflow?: ComfyWorkflowConfig;
  /** Nombre del workflow en el registro: es el «modelo» que ve la UI. */
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetch?: ComfyFetch;
  readonly now?: () => number;
  /** Para la semilla. Default `Math.random`. */
  readonly random?: () => number;
}

interface HttpResult {
  readonly status: number;
  readonly ok: boolean;
  readonly json: unknown;
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Una línea corta y sin nada raro, apta para la UI. */
function line(value: unknown, max = 240): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class ComfyUiClient implements ImageGen, VideoGen {
  readonly provider = "comfyui";
  readonly #baseUrl: string;
  readonly #task: GenMediaKind | undefined;
  readonly #workflow: ComfyWorkflowConfig | undefined;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #fetch: ComfyFetch;
  readonly #now: () => number;
  readonly #random: () => number;

  constructor(config: ComfyUiClientConfig) {
    this.#baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    this.#task = config.task;
    this.#workflow = config.workflow;
    this.#model = config.model ?? "comfyui-workflow";
    this.#timeoutMs = config.timeoutMs ?? 30_000;
    this.#fetch = config.fetch ?? ((url, init) => fetch(url, init));
    this.#now = config.now ?? Date.now;
    this.#random = config.random ?? Math.random;
  }

  /** La ficha del workflow configurado: una sola, de la clase de su tarea. */
  models(): readonly GenModelSpec[] {
    const wf = this.#workflow;
    const task = this.#task;
    if (wf === undefined || task === undefined) return [];
    const sized = wf.width !== undefined && wf.height !== undefined;
    return [
      {
        id: this.#model,
        label: this.#model,
        kind: task,
        // Sin tamaño marcado, el tamaño es el del workflow y no se elige.
        aspectRatios: sized ? ALL_RATIOS : [],
        aspectFromImage: !sized,
        counts: [1],
        durationsSeconds:
          task === "video" && wf.durationSeconds !== undefined
            ? [wf.durationSeconds]
            : [],
        promptRequired: true,
        imageInput: wf.image === undefined ? "none" : "required",
        maxReferenceImages: 0,
        docsUrl: COMFYUI_DOCS_URL,
        listPrice: null,
      },
    ];
  }

  estimateImage(request: ImageGenRequest): Promise<GenCostEstimate> {
    this.#spec("image", request.model);
    return Promise.resolve(FREE);
  }

  estimateVideo(request: VideoGenRequest): Promise<GenCostEstimate> {
    this.#spec("video", request.model);
    return Promise.resolve(FREE);
  }

  async generateImage(request: ImageGenRequest): Promise<GenSubmission> {
    const spec = this.#spec("image", request.model);
    if ((request.n ?? 1) !== 1) {
      throw bad("A ComfyUI workflow makes one run per request");
    }
    if ((request.referenceImageUrls ?? []).length > 0) {
      throw bad("This workflow does not take reference images");
    }
    return this.#submit(spec, request.prompt, request.aspectRatio, undefined);
  }

  async generateVideo(request: VideoGenRequest): Promise<GenSubmission> {
    const spec = this.#spec("video", request.model);
    if (!spec.durationsSeconds.includes(request.durationSeconds)) {
      throw bad(`This workflow makes ${spec.durationsSeconds.join(", ")} second videos`);
    }
    return this.#submit(spec, request.prompt, request.aspectRatio, request.imageUrl);
  }

  async poll(handle: GenJobHandle): Promise<GenJobState> {
    const url = this.#trusted(handle.statusUrl);
    const res = await this.#call(url, { method: "GET" });
    if (!res.ok) throw translate(res, this.#baseUrl);
    if (!isRecord(res.json)) throw malformed("history is not an object");
    const entry = res.json[handle.requestId];
    // `{}`: todavía en la cola o corriendo (el historial se escribe al terminar).
    if (entry === undefined) return { status: "in_progress", outputs: [] };
    if (!isRecord(entry)) throw malformed("history entry is not an object");

    const status = isRecord(entry["status"]) ? entry["status"] : {};
    const messages = Array.isArray(status["messages"]) ? status["messages"] : [];
    if (status["status_str"] === "error") {
      return { status: "failed", outputs: [], message: executionError(messages) };
    }
    if (messages.some((m) => Array.isArray(m) && m[0] === "execution_interrupted")) {
      return { status: "canceled", outputs: [] };
    }

    const kind = this.#task ?? "image";
    const all = collectFiles(entry["outputs"]);
    const files = pickFiles(all, kind);
    if (files.length === 0) {
      return {
        status: "failed",
        outputs: [],
        message:
          all.length === 0
            ? "The workflow finished without saving anything. Add a Save node to it."
            : `The workflow finished but saved no ${kind} file.`,
      };
    }
    return {
      status: "completed",
      outputs: files.map((f) => {
        const contentType = contentTypeOf(f.filename);
        return {
          url: viewUrl(this.#baseUrl, f),
          ...(contentType === null ? {} : { contentType }),
        };
      }),
    };
  }

  /** `GET /system_stats`: el servidor contesta y es un ComfyUI. */
  async checkCredentials(): Promise<GenCredentialCheck> {
    const started = this.#now();
    const res = await this.#call(`${this.#baseUrl}/system_stats`, { method: "GET" });
    if (!res.ok) throw translate(res, this.#baseUrl);
    if (!isRecord(res.json) || !isRecord(res.json["system"])) {
      throw new PortError(
        "provider_contract_violation",
        "That URL answers, but not like a ComfyUI server",
        { source: SOURCE, cause: "system_stats without system" },
      );
    }
    return { latencyMs: Math.max(0, this.#now() - started), probe: "system_stats" };
  }

  /* ---------------------------------------------------------------------- */

  #spec(kind: GenMediaKind, model: string): GenModelSpec {
    const spec = this.models()[0];
    if (spec === undefined) {
      throw bad("No ComfyUI workflow is set up for this task");
    }
    if (spec.kind !== kind) throw bad(`The ComfyUI workflow is not a ${kind} workflow`);
    if (model !== spec.id) {
      throw bad(`"${model.slice(0, 80)}" is not the configured ComfyUI workflow`);
    }
    return spec;
  }

  async #submit(
    spec: GenModelSpec,
    prompt: string,
    aspectRatio: ImageGenRequest["aspectRatio"],
    imageUrl: string | undefined,
  ): Promise<GenSubmission> {
    const wf = this.#workflow;
    if (wf === undefined) throw bad("No ComfyUI workflow is set up for this task");
    if (prompt.trim().length === 0) throw bad("A prompt is required");

    // Un `models.json` editado a mano puede apuntar a un nodo que ya no está.
    for (const ref of [wf.prompt, wf.width, wf.height, wf.seed, wf.image]) {
      if (ref === undefined) continue;
      const missing = missingRef(wf.workflow, ref);
      if (missing !== null)
        throw bad(`${missing}. Update the workflow in Settings → Models.`);
    }

    let size: ComfyInjection["size"];
    if (wf.width !== undefined && wf.height !== undefined) {
      if (!spec.aspectRatios.includes(aspectRatio)) {
        throw bad(`This workflow does not support the ${aspectRatio} aspect ratio`);
      }
      const w = numberInput(wf.workflow, wf.width) ?? 1024;
      const h = numberInput(wf.workflow, wf.height) ?? 1024;
      size = sizeForAspect(aspectRatio, { width: w, height: h });
    }

    let imageName: string | undefined;
    const hasImage = imageUrl !== undefined && imageUrl.trim() !== "";
    if (wf.image !== undefined) {
      if (!hasImage) throw bad("This workflow needs a start image");
      imageName = await this.#uploadImage(imageUrl.trim());
    } else if (hasImage) {
      throw bad("This workflow does not take a start image");
    }

    const injection: ComfyInjection = {
      prompt: prompt.trim(),
      ...(size === undefined ? {} : { size }),
      // Una semilla nueva por pedido: el workflow guardado trae una fija, y
      // repetirla daría la misma imagen cada vez.
      ...(wf.seed === undefined ? {} : { seed: Math.floor(this.#random() * 2 ** 32) }),
      ...(imageName === undefined ? {} : { imageName }),
    };
    const body = JSON.stringify({
      prompt: injectWorkflow(wf, injection),
      client_id: randomUUID(),
    });
    const res = await this.#call(`${this.#baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
    });
    if (!res.ok) throw translate(res, this.#baseUrl);
    if (!isRecord(res.json)) throw malformed("prompt answer is not an object");
    const promptId = res.json["prompt_id"];
    if (typeof promptId !== "string" || promptId.length === 0) {
      throw malformed("prompt answer without prompt_id");
    }
    return {
      kind: "accepted",
      handle: {
        requestId: promptId,
        statusUrl: `${this.#baseUrl}/history/${encodeURIComponent(promptId)}`,
      },
    };
  }

  /**
   * Baja la imagen de entrada (Media Bank: MinIO local o R2) y la sube con
   * `POST /upload/image`. Devuelve el valor para el input de `LoadImage`.
   */
  async #uploadImage(imageUrl: string): Promise<string> {
    let source: URL;
    try {
      source = new URL(imageUrl);
    } catch {
      throw bad("The start image URL is not a URL");
    }
    if (source.protocol !== "https:" && source.protocol !== "http:") {
      throw bad("The start image URL must be http(s)");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    let bytes: ArrayBuffer;
    let type: string;
    try {
      const res = await this.#fetch(source.toString(), {
        method: "GET",
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new PortError("bad_request", "The start image could not be downloaded", {
          source: SOURCE,
          cause: `HTTP ${String(res.status)}`,
        });
      }
      type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
      bytes = await res.arrayBuffer();
    } catch (error) {
      if (error instanceof PortError) throw error;
      throw new PortError("bad_request", "The start image could not be downloaded", {
        source: SOURCE,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!type.startsWith("image/")) throw bad("The start image is not an image");
    if (bytes.byteLength > MAX_INPUT_IMAGE_BYTES)
      throw bad("The start image is too large");

    const ext = type === "image/jpeg" ? "jpg" : (type.split("/")[1] ?? "png");
    const form = new FormData();
    form.append(
      "image",
      new Blob([bytes], { type }),
      `fastgram-${randomUUID()}.${ext.replace(/[^a-z0-9]/gi, "")}`,
    );
    form.append("type", "input");
    const res = await this.#call(`${this.#baseUrl}/upload/image`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) throw translate(res, this.#baseUrl);
    if (!isRecord(res.json) || typeof res.json["name"] !== "string") {
      throw malformed("upload answer without name");
    }
    const subfolder =
      typeof res.json["subfolder"] === "string" ? res.json["subfolder"] : "";
    // `LoadImage` recibe la ruta relativa a `input/`: con subcarpeta, `sub/nombre`.
    return subfolder === "" ? res.json["name"] : `${subfolder}/${res.json["name"]}`;
  }

  /** Sólo se sigue una URL del mismo origen que la base configurada. */
  #trusted(value: string): string {
    try {
      const url = new URL(value);
      if (url.origin === new URL(this.#baseUrl).origin) return url.toString();
    } catch {
      // cae abajo
    }
    throw malformed("status url on another origin");
  }

  async #call(url: string, init: RequestInit): Promise<HttpResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.#fetch(url, { ...init, signal: controller.signal });
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new PortError("timeout", "ComfyUI did not answer in time", {
            source: SOURCE,
            cause,
          });
        }
        throw new PortError(
          "provider_unavailable",
          `ComfyUI is not reachable at ${this.#baseUrl}. Is it running?`,
          { source: SOURCE, cause },
        );
      }
      const text = await response.text().catch(() => "");
      let json: unknown = null;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return {
        status: response.status,
        ok: response.ok,
        json,
        text: text.slice(0, CAUSE_BODY_CHARS),
      };
    } catch (error) {
      if (error instanceof PortError) throw error;
      throw new PortError(
        controller.signal.aborted ? "timeout" : "provider_unavailable",
        controller.signal.aborted
          ? "ComfyUI did not answer in time"
          : `ComfyUI is not reachable at ${this.#baseUrl}. Is it running?`,
        { source: SOURCE, cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

const FREE: GenCostEstimate = {
  usd: 0,
  source: "price_list",
  basis: "Runs on your own ComfyUI: no charge",
};

function bad(message: string): PortError {
  return new PortError("bad_request", message, { source: SOURCE });
}

function malformed(why: string): PortError {
  return new PortError(
    "provider_contract_violation",
    "ComfyUI answered something unexpected",
    { source: SOURCE, cause: why },
  );
}

/** Un error de `validate_prompt` (`{ type, message, details }`) en una línea. */
function describeError(error: unknown): string {
  if (!isRecord(error)) return "";
  const message = line(error["message"]);
  const details = line(error["details"]);
  return details !== "" && details !== message ? `${message}: ${details}` : message;
}

/**
 * El `400` de `/prompt` → una frase legible: el error general y, si hay, el
 * primer error del primer nodo con su id y su `class_type`.
 */
export function describeValidationFailure(json: unknown): string {
  if (!isRecord(json)) return "ComfyUI rejected the workflow";
  const general = describeError(json["error"]);
  let node = "";
  const nodeErrors = json["node_errors"];
  if (isRecord(nodeErrors)) {
    for (const [id, value] of Object.entries(nodeErrors)) {
      if (!isRecord(value) || !Array.isArray(value["errors"])) continue;
      const first = describeError(value["errors"][0]);
      if (first === "") continue;
      const classType =
        typeof value["class_type"] === "string"
          ? ` (${line(value["class_type"], 60)})`
          : "";
      node = `node ${line(id, 40)}${classType}: ${first}`;
      break;
    }
  }
  const parts = [general, node].filter((p) => p !== "");
  const text = parts.length === 0 ? "ComfyUI rejected the workflow" : parts.join(" — ");
  return line(`ComfyUI rejected the workflow: ${text}`, 300);
}

/** El `execution_error` de los mensajes del historial, en una línea. */
function executionError(messages: readonly unknown[]): string {
  for (const m of messages) {
    if (!Array.isArray(m) || m[0] !== "execution_error" || !isRecord(m[1])) continue;
    const data = m[1];
    const node =
      typeof data["node_id"] === "string" || typeof data["node_id"] === "number"
        ? `node ${String(data["node_id"])}`
        : "";
    const type =
      typeof data["node_type"] === "string" ? ` (${line(data["node_type"], 60)})` : "";
    const why = line(data["exception_message"]);
    const where = node === "" ? "" : `${node}${type}: `;
    return line(`ComfyUI failed at ${where}${why === "" ? "unknown error" : why}`, 300);
  }
  return "ComfyUI failed while running the workflow";
}

function translate(res: HttpResult, baseUrl: string): PortError {
  const s = res.status;
  const cause = `HTTP ${String(s)}: ${res.text}`;
  if (s === 400) {
    return new PortError("bad_request", describeValidationFailure(res.json), {
      source: SOURCE,
      cause,
    });
  }
  if (s === 404) {
    return new PortError(
      "not_found",
      `${baseUrl} does not answer like a ComfyUI server (or the file is gone)`,
      { source: SOURCE, cause },
    );
  }
  if (s === 401 || s === 403) {
    return new PortError("unauthorized", "ComfyUI refused the request", {
      source: SOURCE,
      cause,
    });
  }
  if (s >= 500) {
    return new PortError("provider_unavailable", "ComfyUI had an internal error", {
      source: SOURCE,
      cause,
    });
  }
  return new PortError("bad_request", "ComfyUI rejected the request", {
    source: SOURCE,
    cause,
  });
}
