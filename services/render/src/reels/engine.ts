/**
 * `POST /reels/render` y `POST /reels/preview-html` — el motor de reels
 * (`PU-S9-009`, `D-20`).
 *
 * Mismo orden que `render/engine.ts` y por la misma razón (`FR-070`): validar
 * el spec, verificar el grant y **todas** las URLs antes de tocar red, disco o
 * Chrome. Recién después: bajar, recortar croma, transcribir, compilar la
 * composición y renderizarla con HyperFrames (`@hyperframes/producer`,
 * en proceso: da cancelación con `AbortSignal` y métricas por etapa).
 *
 * El resultado se valida con ffprobe (1080×1920, 30 fps, duración, audio)
 * antes de devolverse: un MP4 que HyperFrames dio por bueno pero que no es lo
 * pedido es un `render_failed`, no un artefacto.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type * as ProducerModule from "@hyperframes/producer";
import { RenderError } from "../errors.js";
import { canonicalJson } from "../domain/hash.js";
import {
  assertAllMediaAllowed,
  verifyGrant,
  type MediaPolicyConfig,
} from "../media/urlPolicy.js";
import {
  probeCapabilities,
  FFPROBE_BIN,
  type FfmpegCapabilities,
} from "../ffmpeg/capabilities.js";
import { engineVersion } from "../render/engineVersion.js";
import type { CacheStore } from "../cache/store.js";
import type { MediaResolver } from "../render/engine.js";
import {
  previewMode,
  projectMode,
  reelMediaReferences,
  resolveReelAssets,
  type AssetDeps,
} from "./assets.js";
import { compileReel } from "./compose/index.js";
import type { ReelConfig } from "./config.js";
import {
  REEL_MAX_CAPTION_WORDS,
  reelPreviewRequestSchema,
  reelRenderRequestSchema,
  type ReelCaptionWord,
  type ReelQuality,
  type ReelSpec,
} from "./spec.js";

const execFileAsync = promisify(execFile);

/** Versión de HyperFrames fijada en `package.json`: entra en la clave de cache. */
export const HYPERFRAMES_VERSION = "0.8.79";
/** Tolerancia de duración del MP4 contra el spec: un frame y medio. */
const DURATION_TOLERANCE_SEC = 0.05;

export interface ReelEngineDeps {
  readonly cache: CacheStore;
  readonly policy: MediaPolicyConfig;
  readonly resolveMedia: MediaResolver;
  readonly fontDir: string | null;
  readonly reel: ReelConfig;
  readonly capabilities?: FfmpegCapabilities;
}

export interface ReelRenderResult {
  readonly cacheKey: string;
  readonly path: string;
  readonly bytes: number;
  readonly cache: "hit" | "miss";
  readonly durationSec: number;
  readonly warnings: readonly string[];
  /** Subtítulos que transcribió este render (por capa), para guardarlos en el spec. */
  readonly captions: Readonly<Record<string, ReelCaptionWord[]>>;
  readonly timings: Readonly<Record<string, number>>;
}

function badRequest(
  issues: { path: (string | number)[]; message: string }[],
): RenderError {
  return new RenderError("bad_request", "el spec del reel no es válido", {
    details: {
      issues: issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    },
  });
}

function validate<T extends { spec: ReelSpec; grant?: unknown }>(
  schema: {
    safeParse(raw: unknown):
      | { success: true; data: T }
      | {
          success: false;
          error: { issues: { path: (string | number)[]; message: string }[] };
        };
  },
  raw: unknown,
  policy: MediaPolicyConfig,
): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw badRequest(parsed.error.issues);
  const data = parsed.data;
  const grant =
    data.grant === undefined
      ? null
      : verifyGrant(data.grant as Parameters<typeof verifyGrant>[0], policy);
  assertAllMediaAllowed(reelMediaReferences(data.spec), policy, grant);
  return data;
}

async function assetDeps(
  deps: ReelEngineDeps,
): Promise<AssetDeps & { caps: FfmpegCapabilities }> {
  const caps = deps.capabilities ?? (await probeCapabilities());
  return {
    cache: deps.cache,
    resolveMedia: deps.resolveMedia,
    caps,
    engineTag: (await engineVersion(caps)).version,
    fontDir: deps.fontDir,
    asr: deps.reel.asr,
  };
}

/** Clave del MP4: spec + calidad + motor (ffmpeg, código, fuentes) + HyperFrames. */
export function reelCacheKey(
  spec: ReelSpec,
  quality: ReelQuality,
  engineTag: string,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({ v: 1, spec, quality, engineTag, hyperframes: HYPERFRAMES_VERSION }),
    )
    .digest("hex");
}

interface ProbedOutput {
  width: number;
  height: number;
  fps: string;
  durationSec: number;
  hasAudio: boolean;
}

async function probeOutput(file: string): Promise<ProbedOutput> {
  const { stdout } = await execFileAsync(FFPROBE_BIN, [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type,width,height,r_frame_rate",
    "-of",
    "json",
    file,
  ]);
  const json = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: {
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }[];
  };
  const video = json.streams?.find((s) => s.codec_type === "video");
  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: video?.r_frame_rate ?? "0/0",
    durationSec: Number(json.format?.duration ?? "0"),
    hasAudio: json.streams?.some((s) => s.codec_type === "audio") ?? false,
  };
}

/** Lo que el MP4 tiene que cumplir. Pura: la fija el test. */
export function outputProblems(
  out: ProbedOutput,
  spec: ReelSpec,
  expectAudio: boolean,
): string[] {
  const problems: string[] = [];
  if (out.width !== spec.canvas.width || out.height !== spec.canvas.height) {
    problems.push(`size ${String(out.width)}x${String(out.height)}`);
  }
  if (out.fps !== `${String(spec.fps)}/1`) problems.push(`fps ${out.fps}`);
  if (Math.abs(out.durationSec - spec.durationSec) > DURATION_TOLERANCE_SEC) {
    problems.push(`duration ${String(out.durationSec)}`);
  }
  if (expectAudio && !out.hasAudio) problems.push("no audio stream");
  return problems;
}

type Producer = typeof ProducerModule;
let producerModule: Promise<Producer> | null = null;
/** Import perezoso: el bundle del productor pesa y el resto del servicio no lo usa. */
function producer(): Promise<Producer> {
  producerModule ??= import("@hyperframes/producer");
  return producerModule;
}

export async function renderReel(
  raw: unknown,
  deps: ReelEngineDeps,
  signal?: AbortSignal,
): Promise<ReelRenderResult> {
  const t0 = Date.now();
  const { spec, quality } = validate(reelRenderRequestSchema, raw, deps.policy);
  const ad = await assetDeps(deps);
  const cacheKey = reelCacheKey(spec, quality, ad.engineTag);
  const hit = await deps.cache.get(cacheKey, "mp4");
  if (hit !== null) {
    return {
      cacheKey,
      path: hit.path,
      bytes: hit.bytes,
      cache: "hit",
      durationSec: spec.durationSec,
      warnings: [],
      captions: {},
      timings: { totalMs: Date.now() - t0 },
    };
  }

  const warnings: string[] = [];
  const workDir = await mkdtemp(path.join(tmpdir(), "fastgram-reel-"));
  const projectDir = path.join(workDir, "project");
  await mkdir(projectDir, { recursive: true });
  try {
    const tAssets = Date.now();
    const { assets, captions } = await resolveReelAssets(
      spec,
      ad,
      projectMode(projectDir),
      workDir,
      warnings,
    );
    const assetsMs = Date.now() - tAssets;
    for (const words of Object.values(captions)) words.splice(REEL_MAX_CAPTION_WORDS);
    const compiled = compileReel(spec, assets);
    warnings.push(...compiled.warnings);
    await writeFile(path.join(projectDir, "index.html"), compiled.html);

    const out = path.join(workDir, "reel.mp4");
    const tRender = Date.now();
    const { createRenderJob, executeRenderJob } = await producer();
    const job = createRenderJob({
      fps: { num: spec.fps, den: 1 },
      // `delivery` = `high` del productor (lo mismo que `--quality delivery` del CLI).
      quality: quality === "draft" ? "draft" : "high",
      format: "mp4",
      entryFile: "index.html",
      workers: deps.reel.workers,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      } as never,
    });
    try {
      await executeRenderJob(job, projectDir, out, undefined, signal);
    } catch (error) {
      if (signal?.aborted === true) {
        throw new RenderError(
          "render_timeout",
          "el render del reel excedió su presupuesto",
          { cause: error },
        );
      }
      throw new RenderError("render_failed", "HyperFrames no pudo renderizar el reel", {
        cause: error,
        details: { stage: job.failedStage ?? job.currentStage },
      });
    }
    const renderMs = Date.now() - tRender;
    for (const w of job.warnings) warnings.push(`hyperframes: ${w.message ?? "warning"}`);

    const probed = await probeOutput(out);
    const expectAudio = /<audio /.test(compiled.html);
    const problems = outputProblems(probed, spec, expectAudio);
    if (problems.length > 0) {
      throw new RenderError("render_failed", "el MP4 del reel no es lo pedido", {
        details: { problems },
      });
    }
    const entry = await deps.cache.adopt(cacheKey, "mp4", out);
    return {
      cacheKey,
      path: entry.path,
      bytes: entry.bytes,
      cache: "miss",
      durationSec: probed.durationSec,
      warnings,
      captions,
      timings: {
        assetsMs,
        renderMs,
        totalMs: Date.now() - t0,
        ...(job.perfSummary?.stages === undefined
          ? {}
          : Object.fromEntries(
              Object.entries(job.perfSummary.stages).filter(
                (e): e is [string, number] => typeof e[1] === "number",
              ),
            )),
      },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

let runtimeScript: Promise<string> | null = null;
/**
 * El runtime de HyperFrames (el mismo que el productor inyecta al renderizar)
 * para que la preview haga seek de las mismas animaciones. Se lee del paquete
 * instalado: nada de CDN.
 */
function hyperframesRuntime(): Promise<string> {
  runtimeScript ??= (async () => {
    // `import.meta.resolve` y no `require.resolve`: el paquete sólo exporta la
    // condición `import`, y `require.resolve` tira ERR_PACKAGE_PATH_NOT_EXPORTED.
    const entry = fileURLToPath(import.meta.resolve("@hyperframes/producer"));
    const file = path.join(path.dirname(entry), "hyperframe.runtime.iife.js");
    return (await readFile(file, "utf8")).replace(/<\/script/gi, "<\\/script");
  })();
  return runtimeScript;
}

export interface ReelPreviewResult {
  readonly html: string;
  readonly durationSec: number;
  readonly warnings: readonly string[];
}

/**
 * La composición para el iframe del editor: el mismo `compileReel` que el
 * render, con los originales por URL, el clip recortado y las fuentes
 * embebidos, y el runtime de HyperFrames adentro (expone `window.__player`
 * con `play/pause/seek`).
 */
export async function previewReel(
  raw: unknown,
  deps: ReelEngineDeps,
): Promise<ReelPreviewResult> {
  const { spec } = validate(reelPreviewRequestSchema, raw, deps.policy);
  const ad = await assetDeps(deps);
  const warnings: string[] = [];
  const workDir = await mkdtemp(path.join(tmpdir(), "fastgram-reel-preview-"));
  try {
    const { assets } = await resolveReelAssets(
      spec,
      ad,
      previewMode(deps.reel.previewInlineMaxBytes, warnings),
      workDir,
      warnings,
    );
    const runtime = await hyperframesRuntime();
    const compiled = compileReel(spec, assets, {
      extraHead: `<script>${runtime}</script>`,
    });
    return {
      html: compiled.html,
      durationSec: compiled.durationSec,
      warnings: [...warnings, ...compiled.warnings],
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
