/**
 * Montar la lectura de referencias de Inspiration — `F-041`.
 *
 * Se monta **sólo donde se monta `media-import`** (quien llama lo decide en
 * `main.ts`): usa el mismo `yt-dlp` y el mismo FFmpeg (para convertir la
 * miniatura a JPEG), leídos de las mismas variables (`YTDLP_PATH`,
 * `FFMPEG_PATH`). Sin ellos los jobs esperan en la cola y la referencia queda
 * `pending`, que es verdad.
 *
 * El texto en pantalla sale del OCR de `services/vision` si
 * `VISION_SERVICE_URL` está configurada; las etiquetas (y el texto, si no hay
 * OCR) de la tarea `vision` del registro de modelos, **releída en cada
 * job** (cambiarla en Settings → Models aplica sin reiniciar). Sin la tarea
 * completa → `null` y la referencia se guarda sin texto en pantalla. No cae a
 * las `LLM_*`: un modelo de texto rechazaría la imagen. Nunca se loguea una key.
 */
import {
  OpenAiVisionTagger,
  VisionOcr,
  loopbackPublisher,
  type FetchLike,
} from "@fastgram/adapters";
import {
  REFERENCE_VISION_SYSTEM_PROMPT,
  REFERENCE_VISION_USER_PROMPT,
  extractJsonObject,
  openAiEndpoint,
  parseReferenceVision,
  resolveLlmConfig,
  type SecretEnv,
} from "@fastgram/core";
import type { ClipTagger, ModelRegistry, Ocr } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { YtDlpReferenceReader, type ReferenceReader } from "./reference-reader.js";

export interface InspirationMount {
  readonly reader: ReferenceReader;
  /** El lector de la miniatura, por job. `null` = sin modelo de visión. */
  readonly vision: () => Promise<ClipTagger | null>;
  /**
   * OCR de verdad con `services/vision` (`VISION_SERVICE_URL`), o `null`.
   * Usa `loopbackPublisher`: exige que el servicio alcance a este proceso
   * (cierto en la Mac; ver la cabecera de `vision-ocr.ts`).
   */
  readonly ocr: Ocr | null;
}

export interface InspirationMountConfig {
  readonly env: SecretEnv;
  readonly registry: ModelRegistry;
  readonly logger: BuildLogger;
  /** Sólo tests. */
  readonly fetch?: FetchLike;
}

export function mountInspiration(config: InspirationMountConfig): InspirationMount {
  const ytdlp = config.env["YTDLP_PATH"]?.trim() || "yt-dlp";
  const ffmpeg = config.env["FFMPEG_PATH"]?.trim() || "ffmpeg";
  const visionUrl = config.env["VISION_SERVICE_URL"]?.trim() ?? "";
  return {
    ocr:
      visionUrl === ""
        ? null
        : new VisionOcr({ baseUrl: visionUrl, publisher: loopbackPublisher() }),
    reader: new YtDlpReferenceReader({
      binary: ytdlp,
      ...(ffmpeg === "ffmpeg" ? {} : { ffmpegLocation: ffmpeg }),
    }),
    async vision() {
      let snapshot;
      try {
        snapshot = await config.registry.read();
      } catch (error: unknown) {
        config.logger.warn(
          { reason: error instanceof Error ? error.message : String(error) },
          "no se pudo leer el registro de modelos: referencia sin OCR",
        );
        return null;
      }
      const resolved = resolveLlmConfig("vision", snapshot, null, config.env);
      if (resolved === null) return null;
      return new OpenAiVisionTagger({
        endpoint: openAiEndpoint(resolved.baseUrl, "chat/completions"),
        apiKey: resolved.apiKey,
        model: resolved.model,
        systemPrompt: REFERENCE_VISION_SYSTEM_PROMPT,
        userPrompt: REFERENCE_VISION_USER_PROMPT,
        // Devuelve un `ClipTags` con `onScreenText` de más: ver
        // `core/src/inspiration/reference-vision.ts`.
        parse: (text) => parseReferenceVision(extractJsonObject(text)),
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      });
    },
  };
}
