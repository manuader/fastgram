/**
 * Configuración del motor de reels. Separada de `src/config.ts` para no tocar
 * el esquema compartido del servicio: todo es opcional y tiene default.
 */
import { z } from "zod";
import { ASR_TIMEOUT_MS, type AsrConfig } from "./asr.js";

const reelEnvSchema = z.object({
  /**
   * Motor de subtítulos. `whisper` necesita `RENDER_REEL_ASR_MODEL` apuntando
   * a un ggml multilingüe (p. ej. `ggml-small.bin`); sin modelo, los reels
   * salen sin subtítulos y con un aviso.
   */
  RENDER_REEL_ASR_ENGINE: z.enum(["none", "whisper", "parakeet"]).default("whisper"),
  RENDER_REEL_ASR_BIN: z.string().min(1).optional(),
  RENDER_REEL_ASR_MODEL: z.string().min(1).optional(),
  /**
   * Presupuesto de un render (cola incluida). 10 min: un reel de 60 s en
   * `delivery` con la Mac cargada midió varios minutos (ver ADR del sprint 9).
   */
  RENDER_REEL_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  /** Renders de reel esperando detrás del que corre. Más, y se rechaza. */
  RENDER_REEL_QUEUE_MAX: z.coerce.number().int().min(0).max(20).default(3),
  /** Chrome por render (~250 MB cada uno). 1 en una Mac de 16 GB compartida. */
  RENDER_REEL_WORKERS: z.coerce.number().int().min(1).max(4).default(1),
  /** Tope de un clip recortado embebido como data URI en la preview. */
  RENDER_REEL_PREVIEW_INLINE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(12 * 1024 * 1024),
});

export interface ReelConfig {
  readonly asr: AsrConfig;
  readonly timeoutMs: number;
  readonly queueMax: number;
  readonly workers: number;
  readonly previewInlineMaxBytes: number;
}

export function reelConfigFromEnv(
  source: Record<string, string | undefined> = process.env,
): ReelConfig {
  const env = reelEnvSchema.parse(source);
  const engine = env.RENDER_REEL_ASR_ENGINE;
  const bin =
    env.RENDER_REEL_ASR_BIN ?? (engine === "parakeet" ? "parakeet-mlx" : "whisper-cli");
  return {
    asr: {
      engine,
      bin,
      model: env.RENDER_REEL_ASR_MODEL ?? null,
      timeoutMs: ASR_TIMEOUT_MS,
    },
    timeoutMs: env.RENDER_REEL_TIMEOUT_MS,
    queueMax: env.RENDER_REEL_QUEUE_MAX,
    workers: env.RENDER_REEL_WORKERS,
    previewInlineMaxBytes: env.RENDER_REEL_PREVIEW_INLINE_MAX_BYTES,
  };
}
