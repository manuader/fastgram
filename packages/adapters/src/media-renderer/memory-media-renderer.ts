/**
 * `MediaRenderer` en memoria — PRD `FR-070`, `NFR-014`, `ERR-P11`, IMPL
 * ADR-007 e IMPL §5.
 *
 * **Acá no hay FFmpeg y no se encodea nada.** El artefacto que vuelve son
 * bytes sintéticos derivados del fingerprint. El papel es el de `MemoryStorage`
 * para `Storage`: correr las diez aserciones de contrato sin un motor de
 * render, y darle a `apps/worker` algo contra qué testear el pipeline de build
 * sin CPU ni media real.
 *
 * **Pero una parte sí es real y es la que más vale.** `fingerprint` está
 * implementado de verdad, porque el contrato no se lo puede saltear: IMPL §5
 * prescribe cachear por hash del payload y el ADR-007 pone el CPU de render
 * como driver de costo. Un `fingerprint` inestable hace que el cache nunca
 * acierte —plata que se va sin que nadie lo note— y uno que colisione sirve el
 * render equivocado. Acá está resuelto con SHA-256 sobre una serialización
 * **canónica** (claves ordenadas) del job más la versión del motor. Lo de las
 * claves ordenadas no es paranoia: `core` arma el payload con spreads, y dos
 * spreads en distinto orden producen el mismo objeto con distinto
 * `JSON.stringify`. Sin canonicalizar, el cache fallaría de forma intermitente
 * y por una razón invisible en el diff.
 *
 * La versión del motor entra en el hash por la razón de `P2-RENDER-011`: un
 * upgrade que mueva la tipografía **debe** invalidar el cache en vez de servir
 * frames viejos. Acá es un string cualquiera inyectable, porque este adaptador
 * no tiene motor.
 *
 * La validación de `FR-070` también es real: `num_images` contra
 * `images.length`, el tope de slides, y `fontSize` dentro de su rango. Es la
 * parte del puerto que no depende del motor, así que conviene que sea idéntica
 * en los dos adaptadores — y por eso vive en `job-rules.ts`, compartida con
 * `HttpMediaRenderer`, en vez de copiada acá. Lo mismo la serialización
 * canónica del fingerprint.
 *
 * **Lo que NO hay acá, y hay que buscarlo en el adaptador real:** `contentType`
 * de salida por formato, duración del video producido, y todo lo que `probe`
 * responde. `probe`, `normalize` y `thumbnail` leen un registro de media
 * sembrado en el constructor: no hay inspección de archivo, y las dimensiones
 * que devuelven son las que el llamador declaró.
 */

import { createHash } from "node:crypto";
import {
  PortError,
  type Clock,
  type MediaProbe,
  type MediaRenderer,
  type NormalizeRequest,
  type RenderedMedia,
  type RenderJob,
  type RenderResult,
  type ThumbnailRequest,
} from "@fastgram/ports";
import { systemClock } from "../clock/index.js";
import { assertJobIsValid, canonicalize, canvasOf } from "./job-rules.js";

const SOURCE = "MediaRenderer/memory";

/**
 * Media type del artefacto sintético. **A propósito no es `video/mp4` ni
 * `image/png`**: los bytes no son un MP4 ni un PNG, y declarar que lo son
 * haría que un test creyera estar verificando un encoder. Quien necesite un
 * content type concreto lo inyecta.
 */
const SYNTHETIC_CONTENT_TYPE = "application/x-fastgram-memory-render";

/** Versión de motor por defecto. Es una etiqueta, no una versión de FFmpeg. */
const SYNTHETIC_ENGINE_VERSION = "memory-0";

/**
 * Lo que este adaptador "sabe" de una URL de media. Se siembra entero: no hay
 * ffprobe detrás, así que cada campo es una afirmación del llamador.
 */
export interface MemoryMediaSource {
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly durationSeconds?: number;
  readonly hasAudio?: boolean;
  readonly isHdr?: boolean;
  readonly isFastStart?: boolean;
}

export interface MemoryMediaRendererOptions {
  readonly clock?: Clock;
  /** Entra al fingerprint. Cambiarla invalida el cache, que es el punto. */
  readonly engineVersion?: string;
  /** URL → lo que `probe`, `normalize` y `thumbnail` responden por ella. */
  readonly media?: Readonly<Record<string, MemoryMediaSource>>;
  readonly contentType?: string;
}

export class MemoryMediaRenderer implements MediaRenderer {
  readonly #clock: Clock;
  readonly #engineVersion: string;
  readonly #media: Map<string, MemoryMediaSource>;
  readonly #contentType: string;

  constructor(options: MemoryMediaRendererOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#engineVersion = options.engineVersion ?? SYNTHETIC_ENGINE_VERSION;
    this.#media = new Map(Object.entries(options.media ?? {}));
    this.#contentType = options.contentType ?? SYNTHETIC_CONTENT_TYPE;
  }

  fingerprint(job: RenderJob): string {
    // El motor entra **antes** que el job para que dos motores distintos no
    // puedan producir el mismo prefijo por casualidad al canonicalizar.
    const canonical = canonicalize({ engine: this.#engineVersion, job });
    return createHash("sha256").update(canonical).digest("hex");
  }

  async render(job: RenderJob): Promise<RenderResult> {
    const startedAt = this.#clock.nowMs();
    assertJobIsValid(job, SOURCE);

    const canvas = canvasOf(job, SOURCE);
    const fingerprint = this.fingerprint(job);
    // El artefacto es el propio fingerprint en bytes: determinista, no vacío,
    // y obvio al mirarlo en un test que no salió de ningún encoder.
    const body = new TextEncoder().encode(fingerprint);

    return {
      body: once(body),
      contentType: this.#contentType,
      sizeBytes: body.byteLength,
      width: canvas.width,
      height: canvas.height,
      fingerprint,
      renderMs: this.#clock.nowMs() - startedAt,
    };
  }

  async probe(url: string): Promise<MediaProbe> {
    const source = this.#require(url);
    return {
      contentType: source.contentType,
      width: source.width,
      height: source.height,
      ...(source.durationSeconds === undefined
        ? {}
        : { durationSeconds: source.durationSeconds }),
      hasAudio: source.hasAudio ?? false,
      isHdr: source.isHdr ?? false,
      isFastStart: source.isFastStart ?? false,
    };
  }

  async normalize(request: NormalizeRequest): Promise<RenderedMedia> {
    const source = this.#require(request.url);
    if (request.targetContentType.length === 0) {
      throw new PortError("bad_request", "targetContentType is required", {
        source: SOURCE,
      });
    }

    // `NFR-014` normaliza el contenedor y el rango dinámico; las dimensiones
    // no se tocan, así que salen tal cual del origen.
    const body = new TextEncoder().encode(
      `normalized:${request.targetContentType}:${request.url}`,
    );
    return {
      body: once(body),
      contentType: request.targetContentType,
      sizeBytes: body.byteLength,
      width: source.width,
      height: source.height,
      ...(source.durationSeconds === undefined
        ? {}
        : { durationSeconds: source.durationSeconds }),
    };
  }

  async thumbnail(request: ThumbnailRequest): Promise<RenderedMedia> {
    const source = this.#require(request.url);
    if (!Number.isFinite(request.maxWidth) || request.maxWidth <= 0) {
      throw new PortError("bad_request", "maxWidth must be positive", { source: SOURCE });
    }
    const atSeconds = request.atSeconds;
    if (
      atSeconds !== undefined &&
      source.durationSeconds !== undefined &&
      atSeconds > source.durationSeconds
    ) {
      throw new PortError("bad_request", "atSeconds is past the end of the media", {
        source: SOURCE,
      });
    }

    // IMPL §5: «Nunca servir el master para un preview». Achicar, nunca
    // agrandar: un `maxWidth` mayor que el original no estira el thumbnail.
    const width = Math.min(source.width, Math.floor(request.maxWidth));
    const scale = source.width === 0 ? 1 : width / source.width;
    const height = Math.max(1, Math.round(source.height * scale));
    const body = new TextEncoder().encode(`thumb:${String(width)}:${request.url}`);

    return {
      body: once(body),
      contentType: this.#contentType,
      sizeBytes: body.byteLength,
      width,
      height,
    };
  }

  #require(url: string): MemoryMediaSource {
    const source = this.#media.get(url);
    if (source === undefined) {
      // `ERR-P11`: «We couldn't read this video's details». Una URL que este
      // adaptador no tiene sembrada es exactamente el caso de una URL que no
      // resuelve, y el contrato lo pide como `not_found`, no como excepción
      // cruda.
      throw new PortError("not_found", "media not found", { source: SOURCE });
    }
    return source;
  }
}

function once(body: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield body;
  })();
}
