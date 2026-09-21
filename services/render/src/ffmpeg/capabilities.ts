/**
 * Sondeo de capacidades del binario de FFmpeg.
 *
 * ── La trampa ────────────────────────────────────────────────────────────────
 * Documentada en `services/vision/app/frames.py` y en `docs/HANDOFF.md` §7:
 * muchos builds de FFmpeg vienen SIN `drawtext` (necesita libfreetype). Cuando
 * falta, ffmpeg escribe "Filter not found", produce CERO frames y **sale con
 * código 0**.
 *
 * Verificado en esta máquina el 2026-09-21:
 *
 *     $ ffmpeg -filters | grep drawtext
 *     (sin salida, exit 1)
 *     $ ffmpeg -version | grep libfreetype
 *     (sin salida)
 *
 * ffmpeg 9.0.1 de Homebrew, compilado sin `--enable-libfreetype`.
 *
 * Decisión: **el pipeline de texto nunca usa `drawtext`**, ni siquiera donde
 * está disponible. El texto se compone con `sharp` a PNG RGBA y se superpone
 * con `overlay`. Además de evitar la trampa, da mejor tipografía (Pango: kerning,
 * shaping, wrap) y hace que el render no dependa del build de ffmpeg que haya
 * en cada máquina. `hasDrawtext` se conserva sólo como diagnóstico.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RenderError } from "../errors.js";

const execFileAsync = promisify(execFile);

export interface FfmpegCapabilities {
  readonly available: boolean;
  readonly version: string;
  readonly filters: ReadonlySet<string>;
  readonly encoders: ReadonlySet<string>;
  /** Sólo diagnóstico: el pipeline no lo usa aunque esté. */
  readonly hasDrawtext: boolean;
  readonly hasOverlay: boolean;
  readonly hasChromakey: boolean;
  readonly hasColorkey: boolean;
  /** `zscale` (libzimg) es lo único que linealiza PQ/HLG de verdad. */
  readonly hasZscale: boolean;
  readonly hasTonemap: boolean;
  readonly hasColorspace: boolean;
}

export const FFMPEG_BIN = process.env["RENDER_FFMPEG_PATH"] ?? "ffmpeg";
export const FFPROBE_BIN = process.env["RENDER_FFPROBE_PATH"] ?? "ffprobe";

function parseNames(output: string, columnIndex: number): Set<string> {
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const name = parts[columnIndex];
    if (name !== undefined && /^[A-Za-z][A-Za-z0-9_]*$/.test(name)) names.add(name);
  }
  return names;
}

let cached: FfmpegCapabilities | null = null;

export async function probeCapabilities(force = false): Promise<FfmpegCapabilities> {
  if (cached !== null && !force) return cached;
  try {
    const [version, filters, encoders] = await Promise.all([
      execFileAsync(FFMPEG_BIN, ["-hide_banner", "-version"], { maxBuffer: 4_000_000 }),
      execFileAsync(FFMPEG_BIN, ["-hide_banner", "-filters"], { maxBuffer: 8_000_000 }),
      execFileAsync(FFMPEG_BIN, ["-hide_banner", "-encoders"], { maxBuffer: 8_000_000 }),
    ]);
    const filterNames = parseNames(filters.stdout, 1);
    const encoderNames = parseNames(encoders.stdout, 1);
    cached = {
      available: true,
      version: (version.stdout.split("\n")[0] ?? "").trim(),
      filters: filterNames,
      encoders: encoderNames,
      hasDrawtext: filterNames.has("drawtext"),
      hasOverlay: filterNames.has("overlay"),
      hasChromakey: filterNames.has("chromakey"),
      hasColorkey: filterNames.has("colorkey"),
      hasZscale: filterNames.has("zscale"),
      hasTonemap: filterNames.has("tonemap"),
      hasColorspace: filterNames.has("colorspace"),
    };
    return cached;
  } catch (cause) {
    cached = {
      available: false,
      version: "",
      filters: new Set(),
      encoders: new Set(),
      hasDrawtext: false,
      hasOverlay: false,
      hasChromakey: false,
      hasColorkey: false,
      hasZscale: false,
      hasTonemap: false,
      hasColorspace: false,
    };
    void cause;
    return cached;
  }
}

export function resetCapabilitiesCache(): void {
  cached = null;
}

export function requireFfmpeg(caps: FfmpegCapabilities): void {
  if (!caps.available) {
    throw new RenderError("ffmpeg_unavailable", "ffmpeg no está disponible en el PATH");
  }
}

export function requireFilters(
  caps: FfmpegCapabilities,
  needed: readonly string[],
): void {
  requireFfmpeg(caps);
  const missing = needed.filter((name) => !caps.filters.has(name));
  if (missing.length > 0) {
    throw new RenderError(
      "render_capability_missing",
      "el build de ffmpeg no trae un filtro que el pipeline necesita",
      { details: { missing } },
    );
  }
}

/**
 * Qué filtro de croma usar. `chromakey` opera en YUV y `colorkey` en RGB; se
 * prefiere `chromakey` porque tolera mejor la compresión de video.
 */
export function chromaFilterName(caps: FfmpegCapabilities): "chromakey" | "colorkey" {
  if (caps.hasChromakey) return "chromakey";
  if (caps.hasColorkey) return "colorkey";
  throw new RenderError(
    "render_capability_missing",
    "el build de ffmpeg no trae ni chromakey ni colorkey",
    { details: { missing: ["chromakey", "colorkey"] } },
  );
}

/** Estrategia de texto. Siempre la misma: sharp. Ver el encabezado del archivo. */
export const TEXT_STRATEGY = "sharp-overlay" as const;
