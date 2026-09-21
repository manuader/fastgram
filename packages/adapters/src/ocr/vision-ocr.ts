/**
 * Adaptador `Ocr` contra `services/vision` — ADR-002, ADR-011, `INT-016`,
 * `FR-011.3`, `AI-016`.
 *
 * ADR-002 aísla el único componente que no es TypeScript «detrás de HTTP y de
 * los puertos `Ocr` / `Asr`». Esto es ese cliente HTTP, y nada más: no conoce
 * PaddleOCR, no sabe cuántos frames conviene muestrear y no decide qué hacer
 * cuando el OCR no encuentra nada.
 *
 * ## El desajuste que hay que resolver, y no se puede tapar
 *
 * **El puerto pasa bytes; `services/vision` recibe una URL.**
 *
 * El puerto es explícito sobre por qué: `FR-011` y `DATA-032` dicen que «los
 * binarios de terceros **no se persisten**: se procesan en memoria y se
 * descartan», y por eso `OcrImageRequest` lleva `bytes` y no una clave de
 * storage — «para que esa regla no pueda romperse por accidente».
 *
 * Pero `app/models.py` define `OcrRequest.url` y `app/main.py` descarga ese
 * objeto con `httpx` antes de leerlo. Las dos decisiones son defendibles por
 * separado; juntas no cierran.
 *
 * **Lo que hace este adaptador mientras tanto:** publica los bytes en un
 * servidor HTTP efímero de loopback ({@link loopbackPublisher}), de un solo
 * uso y en memoria, y le pasa esa URL al servicio. Nada se persiste, así que
 * `DATA-032` se respeta. **Pero exige que `services/vision` pueda alcanzar al
 * proceso que llama**, lo cual es cierto en desarrollo y deja de serlo apenas
 * el servicio corre en otro contenedor o en otra máquina.
 *
 * **La solución de verdad es un endpoint que reciba bytes** —`POST /ocr` con
 * `multipart/form-data` o con el cuerpo crudo—, y es un cambio en
 * `services/vision`, no acá. Queda como {@link OcrBytesPublisher} para que el
 * día que exista, reemplazarlo sea una línea.
 *
 * ## `AI-016`: degrada, no aborta — quién hace qué
 *
 * La regla es del **consumidor**, no del adaptador, y la diferencia importa:
 *
 * - `status: "ok"` y `status: "partial"` devuelven resultado. `partial` puede
 *   traer texto de algunos frames y ninguno de otros: eso es degradar bien.
 * - Que el servicio esté caído, saturado o que la media sea ilegible **lanza**
 *   un `PortError`. El adaptador no puede devolver «texto vacío» en ese caso:
 *   `JV-1` no podría distinguir «la imagen no tenía texto» de «el OCR no
 *   funcionó», y §25.3 lo marca como dependencia dura. Quien llama atrapa y
 *   degrada a `partial` — eso es `P1-VISION-005`.
 */

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  PortError,
  type DetectedLanguage,
  type Ocr,
  type OcrBlock,
  type OcrImageRequest,
  type OcrResult,
  type OcrVideoFrame,
  type OcrVideoRequest,
  type OcrVideoResult,
} from "@fastgram/ports";

const SOURCE = "Ocr/vision";

/** `NFR-013`. El servicio infiere por extensión, así que acá se valida antes. */
const IMAGE_TYPES = new Map<string, string>([
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

/** Las extensiones que `main.py` reconoce como video (`_VIDEO_SUFFIXES`). */
const VIDEO_TYPES = new Map<string, string>([
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
  ["video/webm", ".webm"],
]);

/**
 * Publica bytes en una URL que `services/vision` pueda descargar, y la libera
 * después. Ver el desajuste explicado arriba.
 */
export interface OcrBytesPublisher {
  publish(
    bytes: Uint8Array,
    contentType: string,
    extension: string,
  ): Promise<{ url: string; release: () => Promise<void> }>;
}

export interface VisionOcrConfig {
  /** `VISION_SERVICE_URL`. */
  readonly baseUrl: string;
  readonly publisher: OcrBytesPublisher;
  /** Default 60 s: cargar el modelo la primera vez es lento. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export class VisionOcr implements Ocr {
  readonly #baseUrl: string;
  readonly #config: VisionOcrConfig;
  readonly #fetch: typeof fetch;

  constructor(config: VisionOcrConfig) {
    if (config.baseUrl.length === 0) {
      throw new PortError("bad_request", "Vision service URL is not configured", {
        source: SOURCE,
      });
    }
    this.#config = config;
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.#fetch = config.fetch ?? ((input, init) => fetch(input, init));
  }

  async recognizeImage(request: OcrImageRequest): Promise<OcrResult> {
    const extension = IMAGE_TYPES.get(request.contentType.toLowerCase());
    if (extension === undefined) {
      throw new PortError(
        "bad_request",
        `Unsupported image content type: ${request.contentType}`,
        { source: SOURCE },
      );
    }

    const started = Date.now();
    const response = await this.#call(request.bytes, request.contentType, extension, {});
    const blocks = plain(toBlocks(response.blocks));

    return {
      text: joinBlocks(blocks),
      blocks,
      languages: toLanguages(response.detected_language),
      latencyMs: Date.now() - started,
    };
  }

  async recognizeVideoFrames(request: OcrVideoRequest): Promise<OcrVideoResult> {
    const extension = VIDEO_TYPES.get(request.contentType.toLowerCase());
    if (extension === undefined) {
      throw new PortError(
        "bad_request",
        `Unsupported video content type: ${request.contentType}`,
        { source: SOURCE },
      );
    }

    const started = Date.now();
    const response = await this.#call(request.bytes, request.contentType, extension, {
      ...(request.maxFrames === undefined ? {} : { max_frames: request.maxFrames }),
    });

    const timed = toBlocks(response.blocks);
    const languages = toLanguages(response.detected_language);
    const latencyMs = Date.now() - started;

    /**
     * El texto agregado sale de los bloques **ya deduplicados por el
     * servicio** (`service._dedupe`), no de concatenar los frames.
     *
     * El puerto exige que un overlay que dura tres segundos no cuente tres
     * veces, y `service.py` ya lo resuelve conservando la primera aparición
     * con su `at_second`. Reconstruir el texto sumando frames volvería a
     * introducir la repetición que el servicio acaba de sacar.
     */
    return {
      text: joinBlocks(plain(timed)),
      frames: toFrames(timed, languages, latencyMs),
      languages,
      latencyMs,
    };
  }

  async #call(
    bytes: Uint8Array,
    contentType: string,
    extension: string,
    extra: Record<string, unknown>,
  ): Promise<VisionResponse> {
    const published = await this.#config.publisher.publish(bytes, contentType, extension);
    try {
      const response = await this.#post({ url: published.url, ...extra });
      if (response.status === "failed") {
        // Ver la nota de `AI-016` en la cabecera: devolver texto vacío acá
        // haría indistinguible «no había texto» de «el OCR no funcionó».
        throw new PortError(
          "provider_unavailable",
          "Text recognition failed for this media",
          { source: SOURCE, cause: response.reason },
        );
      }
      return response;
    } finally {
      // Siempre, incluso si el servicio falló: los bytes no sobreviven a la
      // llamada (`DATA-032`).
      await published.release();
    }
  }

  async #post(body: Record<string, unknown>): Promise<VisionResponse> {
    const controller = new AbortController();
    const timeoutMs = this.#config.timeoutMs ?? 60_000;
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new PortError("timeout", "The text recognition service timed out", {
          source: SOURCE,
          cause,
        });
      }
      throw new PortError(
        "provider_unavailable",
        "The text recognition service is unreachable",
        {
          source: SOURCE,
          cause,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw await translate(response);

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new PortError(
        "provider_contract_violation",
        "The text recognition service returned a malformed response",
        { source: SOURCE, cause },
      );
    }
    return assertShape(json);
  }
}

/* ------------------------------------------------------------------------ *
 * Publicación de bytes
 * ------------------------------------------------------------------------ */

/**
 * Servidor HTTP efímero en loopback. Ver el desajuste en la cabecera.
 *
 * Un servidor por llamada, en `127.0.0.1`, con una ruta de 32 bytes
 * aleatorios y que se cierra en cuanto la petición termina. Los bytes viven
 * en una variable y se van con ella.
 *
 * **No sirve si `services/vision` corre en otro host o en otro contenedor.**
 * Para eso hay que pasar un {@link OcrBytesPublisher} que publique donde el
 * servicio pueda llegar, o —mejor— que el servicio acepte bytes.
 */
export function loopbackPublisher(host = "127.0.0.1"): OcrBytesPublisher {
  return {
    publish: async (bytes, contentType, extension) => {
      const path = `/${randomBytes(32).toString("hex")}${extension}`;
      const server: Server = createServer((req, res) => {
        if (req.url !== path) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": String(bytes.byteLength),
        });
        res.end(Buffer.from(bytes));
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, host, resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        throw new PortError(
          "provider_unavailable",
          "Could not publish the media locally",
          {
            source: SOURCE,
          },
        );
      }
      const { port } = address as AddressInfo;

      return {
        url: `http://${host}:${String(port)}${path}`,
        release: () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => {
              resolve();
            });
          }),
      };
    },
  };
}

/* ------------------------------------------------------------------------ *
 * Forma de la respuesta — `app/models.py`
 * ------------------------------------------------------------------------ */

interface VisionBlock {
  readonly text?: unknown;
  readonly confidence?: unknown;
  readonly box?: unknown;
  readonly at_second?: unknown;
}

interface VisionResponse {
  readonly status: string;
  readonly blocks: readonly VisionBlock[];
  readonly detected_language?: unknown;
  readonly reason?: unknown;
  readonly frames_analysed?: unknown;
}

function assertShape(json: unknown): VisionResponse {
  if (typeof json !== "object" || json === null) {
    throw violation("response is not an object");
  }
  const candidate = json as { status?: unknown; blocks?: unknown };
  if (typeof candidate.status !== "string") {
    throw violation("response has no status");
  }
  if (candidate.blocks !== undefined && !Array.isArray(candidate.blocks)) {
    throw violation("blocks is not an array");
  }
  return {
    ...(json as VisionResponse),
    blocks: (candidate.blocks ?? []) as readonly VisionBlock[],
  };
}

/** El bloque del puerto más el instante del que salió, que el puerto no lleva. */
interface TimedBlock {
  readonly block: OcrBlock;
  readonly atSecond: number;
}

function toBlocks(blocks: readonly VisionBlock[]): TimedBlock[] {
  const out: TimedBlock[] = [];
  for (const block of blocks) {
    if (typeof block.text !== "string" || block.text.length === 0) continue;
    const confidence = typeof block.confidence === "number" ? block.confidence : 0;
    const box = toBox(block.box);
    out.push({
      block: {
        text: block.text,
        confidence: Math.min(1, Math.max(0, confidence)),
        ...(box === null ? {} : { box }),
      },
      // `null` en una imagen; el puerto no tiene dónde ponerlo y en ese camino
      // tampoco se usa.
      atSecond: typeof block.at_second === "number" ? Math.max(0, block.at_second) : 0,
    });
  }
  return out;
}

/** `models.py` la manda como tupla `[x, y, ancho, alto]` en píxeles. */
function toBox(
  value: unknown,
): { x: number; y: number; width: number; height: number } | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [x, y, width, height] = value as unknown[];
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return null;
  }
  return { x, y, width, height };
}

/**
 * `models.py` devuelve `detected_language: str | None` y **ninguna confianza**.
 *
 * El puerto pide `DetectedLanguage[]` ordenado por confianza. Con un solo
 * candidato y sin número, cualquier valor que se ponga es inventado; se usa 1
 * porque `FR-011.3` sólo consume el primero y un 1 en una lista de uno no
 * afirma nada que el servicio no haya afirmado. **Si `services/vision` empieza
 * a reportar confianza, esto tiene que dejar de ser una constante** — está
 * anotado en el reporte de la tarea.
 */
function toLanguages(detected: unknown): DetectedLanguage[] {
  if (typeof detected !== "string" || detected.length === 0) return [];
  return [{ code: detected, confidence: 1 }];
}

function joinBlocks(blocks: readonly OcrBlock[]): string {
  // `OcrResponse.full_text` del servicio une con "\n". Se replica para que el
  // texto que ve `JV-1` sea el mismo por los dos caminos.
  return blocks.map((b) => b.text).join("\n");
}

function plain(timed: readonly TimedBlock[]): OcrBlock[] {
  return timed.map((t) => t.block);
}

/**
 * Reconstruye los frames a partir de `at_second`.
 *
 * El servicio devuelve una lista plana ya deduplicada, con el `at_second` de
 * la **primera** aparición de cada texto. Agrupar por ese valor da, para cada
 * instante muestreado, el texto que apareció por primera vez ahí — que es lo
 * que `P1-VISION-003` necesita para saber cuándo entra un overlay.
 */
function toFrames(
  timed: readonly TimedBlock[],
  languages: readonly DetectedLanguage[],
  latencyMs: number,
): OcrVideoFrame[] {
  const bySecond = new Map<number, OcrBlock[]>();
  for (const { block, atSecond } of timed) {
    const bucket = bySecond.get(atSecond);
    if (bucket === undefined) bySecond.set(atSecond, [block]);
    else bucket.push(block);
  }

  return [...bySecond.entries()]
    .sort(([a], [b]) => a - b)
    .map(([atSeconds, frameBlocks]) => ({
      atSeconds,
      text: joinBlocks(frameBlocks),
      blocks: frameBlocks,
      languages,
      latencyMs,
    }));
}

/* ------------------------------------------------------------------------ *
 * Errores
 * ------------------------------------------------------------------------ */

function violation(what: string): PortError {
  return new PortError(
    "provider_contract_violation",
    "The text recognition service broke its contract",
    { source: SOURCE, cause: what },
  );
}

async function translate(response: Response): Promise<PortError> {
  const cause = await response.text().catch(() => "");
  const status = response.status;

  if (status === 503) {
    // `main.py` devuelve 503 mientras el motor no está listo.
    return new PortError(
      "provider_unavailable",
      "The text recognition service is not ready",
      {
        source: SOURCE,
        cause,
      },
    );
  }
  if (status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    return new PortError(
      "rate_limited",
      "The text recognition service is throttling requests",
      Number.isFinite(retryAfter) && retryAfter >= 0
        ? { source: SOURCE, cause, retryAfterSeconds: Math.ceil(retryAfter) }
        : { source: SOURCE, cause },
    );
  }
  if (status === 408 || status === 504) {
    return new PortError("timeout", "The text recognition service timed out", {
      source: SOURCE,
      cause,
    });
  }
  if (status >= 500) {
    return new PortError("provider_unavailable", "The text recognition service failed", {
      source: SOURCE,
      cause,
    });
  }
  // 422 es la validación de FastAPI; 400/413 son media fuera de límites.
  return new PortError("bad_request", "The text recognition service rejected the media", {
    source: SOURCE,
    cause,
  });
}
