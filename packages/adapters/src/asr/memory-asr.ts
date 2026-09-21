/**
 * `Asr` en memoria — PRD `INT-015`, `AI-016`, `D-03`, IMPL ADR-012.
 *
 * **Esto no transcribe nada.** No hay motor acá: el "audio" es un contenedor
 * sintético de este adaptador (ver {@link encodeMemorySpeech}) y lo que vuelve
 * es lo que el llamador metió. El papel es el mismo que `MemoryStorage` cumple
 * para `Storage` y `MemoryIdentity` para `Identity`:
 *
 * 1. **Correr la suite de contrato de `Asr` sin motor.** `INT-015` difiere el
 *    ASR a Fase 2 (`D-03`) y exige que el sistema funcione completo sin él, así
 *    que la implementación real no existe todavía y sus cuatro aserciones nunca
 *    habían corrido. Que corran contra algo hace que el día que aparezca el
 *    adaptador real, la suite ya esté probada.
 *
 * 2. **Tests de la etapa de enriquecimiento de `AI-016`** sin descargar media
 *    ni gastar minutos de transcripción.
 *
 * **Lo que sí es lógica propia y vale la pena testear**, porque un motor real
 * la va a necesitar igual: ordenar los segmentos, componer `text` a partir de
 * ellos —el contrato exige que cada segmento aparezca en el texto completo—,
 * recortar por `maxDurationSeconds`, y **no dejar que `languageHint` pise el
 * idioma detectado**. Ese último punto es el guardarraíl de `AI-016`: la pista
 * desempata, no impone. Un adaptador que tratara el hint como parámetro de
 * salida estaría a un paso de traducir.
 *
 * Nada de lo de acá describe a ningún proveedor: ni formatos de audio
 * soportados, ni límites de duración, ni latencias.
 */

import {
  PortError,
  type Asr,
  type Clock,
  type TranscribeRequest,
  type Transcript,
  type TranscriptSegment,
} from "@fastgram/ports";
import { systemClock } from "../clock/index.js";

const SOURCE = "Asr/memory";

/**
 * Confianza que se reporta cuando el contenedor no declara ninguna. Es un
 * valor del adaptador, no una medición: acá no hay detector de idioma que
 * pueda dudar. `1` deja claro en los tests que la duda no se simuló.
 */
const SYNTHETIC_LANGUAGE_CONFIDENCE = 1;

/** Un segmento tal como se escribe en el contenedor sintético. */
export interface MemorySpeechSegment {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text: string;
  readonly confidence?: number;
}

/**
 * El "audio" que entiende este adaptador: un JSON en UTF-8. Se llama `speech`
 * y no `audio` a propósito — no hay señal, hay habla ya escrita.
 */
export interface MemorySpeech {
  /** BCP-47. Es lo que `INT-015` pide devolver para alimentar `toneOfVoice`. */
  readonly language?: string;
  readonly languageConfidence?: number;
  readonly segments: readonly MemorySpeechSegment[];
  /** Si falta, se deriva del último segmento. */
  readonly durationSeconds?: number;
}

export interface MemoryAsrOptions {
  readonly clock?: Clock;
  /**
   * Tipos de media que este adaptador acepta. El default cubre cualquier
   * `audio/*` y `video/*`; se puede acotar para testear el rechazo de un
   * formato concreto sin que el test dependa de qué soporta un motor real.
   */
  readonly acceptsContentType?: (contentType: string) => boolean;
}

/** Arma el contenedor sintético. Es la forma prevista de construir fixtures. */
export function encodeMemorySpeech(speech: MemorySpeech): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(speech));
}

function defaultAcceptsContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.startsWith("audio/") || normalized.startsWith("video/");
}

export class MemoryAsr implements Asr {
  readonly #clock: Clock;
  readonly #accepts: (contentType: string) => boolean;

  constructor(options: MemoryAsrOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#accepts = options.acceptsContentType ?? defaultAcceptsContentType;
  }

  async transcribe(request: TranscribeRequest): Promise<Transcript> {
    const startedAt = this.#clock.nowMs();

    if (!this.#accepts(request.contentType)) {
      // `bad_request` y no `provider_contract_violation`: el que se equivocó
      // fue quien mandó un PDF a transcribir, no el motor.
      throw new PortError(
        "bad_request",
        "media has no audio track this adapter can read",
        { source: SOURCE },
      );
    }

    const speech = parseSpeech(request.bytes);
    const language = speech.language ?? request.languageHint;
    if (language === undefined || language.length === 0) {
      throw new PortError("bad_request", "no language could be determined", {
        source: SOURCE,
      });
    }

    const ordered = [...speech.segments].sort((a, b) => a.startSeconds - b.startSeconds);
    for (const segment of ordered) {
      if (
        !Number.isFinite(segment.startSeconds) ||
        !Number.isFinite(segment.endSeconds) ||
        segment.startSeconds < 0 ||
        segment.endSeconds < segment.startSeconds
      ) {
        throw new PortError("bad_request", "segment with impossible timing", {
          source: SOURCE,
        });
      }
    }

    const cutoff = request.maxDurationSeconds;
    const kept =
      cutoff === undefined
        ? ordered
        : ordered.filter((segment) => segment.endSeconds <= cutoff);

    const segments: TranscriptSegment[] = kept.map((segment) => ({
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      text: segment.text,
      ...(segment.confidence === undefined ? {} : { confidence: segment.confidence }),
    }));

    // El texto se **compone** a partir de los segmentos en vez de guardarse
    // aparte: el contrato exige que cada segmento aparezca en el texto
    // completo, y dos campos independientes se desincronizan en cuanto uno se
    // recorta por `maxDurationSeconds`.
    const text = segments
      .map((segment) => segment.text.trim())
      .filter((piece) => piece.length > 0)
      .join(" ");

    // Con `maxDurationSeconds` la duración es la de **lo transcrito**, no la
    // del archivo: quien pidió el recorte para acotar el coste por ítem
    // necesita saber cuánto quedó cubierto.
    const transcribedEnd = segments.at(-1)?.endSeconds ?? 0;
    const durationSeconds =
      cutoff === undefined
        ? Math.max(speech.durationSeconds ?? 0, transcribedEnd)
        : transcribedEnd;

    return {
      text,
      segments,
      language,
      languageConfidence: speech.languageConfidence ?? SYNTHETIC_LANGUAGE_CONFIDENCE,
      durationSeconds,
      latencyMs: this.#clock.nowMs() - startedAt,
    };
  }
}

function parseSpeech(bytes: Uint8Array): MemorySpeech {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PortError("bad_request", "media has no audio track this adapter can read", {
      source: SOURCE,
    });
  }
  if (parsed === null || typeof parsed !== "object" || !("segments" in parsed)) {
    throw new PortError("bad_request", "media has no audio track this adapter can read", {
      source: SOURCE,
    });
  }
  const speech = parsed as MemorySpeech;
  if (!Array.isArray(speech.segments)) {
    throw new PortError("bad_request", "media has no audio track this adapter can read", {
      source: SOURCE,
    });
  }
  return speech;
}
