/**
 * `BackgroundRemoval` por croma local — `PU-MEME-002`, `PLAN-USO-PERSONAL` §4
 * («FFmpeg chromakey local si el clip ya es verde (gratis, ya está en el render)»).
 *
 * No procesa nada: **detecta**. Si el borde del clip es verde croma, el render
 * ya sabe recortarlo (`services/render/src/render/formats.ts`,
 * `planGreenScreenBase` con `chromakey`/`colorkey`), así que re-encodear acá
 * sería gastar CPU para producir lo mismo con peor calidad. El resultado es el
 * color a recortar; quien llama marca el clip como `green-screen-video`.
 *
 * La decisión («¿cuánto verde es verde?») es de dominio y vive en `core`
 * (`greenScreenVerdict`); se inyecta porque `adapters` no importa `core`.
 */
import type {
  BackgroundRemoval,
  BackgroundRemovalInput,
  BackgroundRemovalOutcome,
  ClipInspector,
  RgbSample,
} from "@fastgram/ports";

export interface ChromaVerdict {
  readonly isGreen: boolean;
  readonly keyColor: string | null;
}

export interface ChromaKeyBackgroundRemovalConfig {
  readonly inspector: ClipInspector;
  readonly verdict: (samples: readonly RgbSample[]) => ChromaVerdict;
  /** Cuántos cuadros muestrear. Default 5. */
  readonly frames?: number;
}

export class ChromaKeyBackgroundRemoval implements BackgroundRemoval {
  readonly id = "chromakey-local";
  readonly #config: ChromaKeyBackgroundRemovalConfig;

  constructor(config: ChromaKeyBackgroundRemovalConfig) {
    this.#config = config;
  }

  async remove(input: BackgroundRemovalInput): Promise<BackgroundRemovalOutcome> {
    const samples = await this.#config.inspector.borderSamples(
      input.path,
      this.#config.frames ?? 5,
    );
    const v = this.#config.verdict(samples);
    if (!v.isGreen || v.keyColor === null) return { kind: "not_applicable" };
    return { kind: "chroma_key", keyColor: v.keyColor };
  }
}
