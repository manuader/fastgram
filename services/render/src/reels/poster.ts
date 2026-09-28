/**
 * `POST /reels/poster` y `POST /reels/image-stats` — sprint 9 (U), `PU-S9-014`.
 *
 * ## El póster: un cuadro, no un render
 *
 * La tarjeta de Blitz necesita ver el reel antes de aceptarlo, y un render
 * entero cuesta 40–130 s (reporte de P). El póster es **un** cuadro de la
 * misma composición que renderiza el motor (`compileReel`), capturado con
 * `hyperframes snapshot` en el instante en que el gancho ya entró: fuentes de
 * marca, colores, logo y fondo exactos, en ~8 s (medido: la mayor parte es
 * arrancar Chrome). Sin subtítulos: no se transcribe para un póster.
 *
 * Mismo orden que el render: validar el spec, el grant y todas las URLs antes
 * de tocar red o disco. Se cachea por spec + instante + motor.
 *
 * ## La luminancia: para elegir el logo
 *
 * El logo claro u oscuro se elige por código (`core/reels/look.ts`) con la
 * luminancia media de los píxeles **visibles** de cada archivo (ponderada por
 * el alfa: el fondo transparente de un PNG no cuenta). El worker no tiene
 * `sharp`; el render sí.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";

import { RenderError } from "../errors.js";
import { canonicalJson } from "../domain/hash.js";
import { assertAllMediaAllowed, verifyGrant } from "../media/urlPolicy.js";
import { probeCapabilities } from "../ffmpeg/capabilities.js";
import { engineVersion } from "../render/engineVersion.js";
import { projectMode, reelMediaReferences, resolveReelAssets } from "./assets.js";
import { compileReel } from "./compose/index.js";
import { HYPERFRAMES_VERSION, type ReelEngineDeps } from "./engine.js";
import {
  reelImageStatsRequestSchema,
  reelPosterRequestSchema,
  type ReelSpec,
} from "./spec.js";

const execFileAsync = promisify(execFile);

/** Ancho del póster: la tarjeta del deck no pasa de ~420 px (×2 para retina). */
export const REEL_POSTER_WIDTH = 720;
/** Tope del snapshot: arrancar Chrome en una Mac cargada midió hasta ~15 s. */
const SNAPSHOT_TIMEOUT_MS = 90_000;

function badRequest(issues: { path: (string | number)[]; message: string }[]): RenderError {
  return new RenderError("bad_request", "el pedido del reel no es válido", {
    details: {
      issues: issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    },
  });
}

/**
 * El instante del póster: cuando el gancho terminó de entrar (0,9 s después
 * de su inicio, lo que duran las animaciones de entrada), sin pasar el reel.
 */
export function defaultPosterSec(spec: Pick<ReelSpec, "layers" | "durationSec">): number {
  const hook = spec.layers.find((l) => l.id === "hook");
  const at = hook === undefined ? 1.2 : hook.start + 0.9;
  return Math.min(Math.max(0, spec.durationSec - 0.1), Math.round(at * 10) / 10);
}

let cliPath: string | null = null;
/** El binario del CLI de HyperFrames instalado (misma versión fijada que el productor). */
function hyperframesCli(): string {
  cliPath ??= path.join(
    path.dirname(fileURLToPath(import.meta.resolve("hyperframes/package.json"))),
    "bin",
    "hyperframes.mjs",
  );
  return cliPath;
}

export interface ReelPosterResult {
  readonly cacheKey: string;
  readonly path: string;
  readonly bytes: number;
  readonly cache: "hit" | "miss";
  readonly atSec: number;
  readonly warnings: readonly string[];
}

export async function posterReel(
  raw: unknown,
  deps: ReelEngineDeps,
): Promise<ReelPosterResult> {
  const parsed = reelPosterRequestSchema.safeParse(raw);
  if (!parsed.success) throw badRequest(parsed.error.issues);
  const { spec } = parsed.data;
  const grant =
    parsed.data.grant === undefined
      ? null
      : verifyGrant(parsed.data.grant as Parameters<typeof verifyGrant>[0], deps.policy);
  assertAllMediaAllowed(reelMediaReferences(spec), deps.policy, grant);

  const caps = deps.capabilities ?? (await probeCapabilities());
  const engineTag = (await engineVersion(caps)).version;
  const atSec = Math.min(parsed.data.atSec ?? defaultPosterSec(spec), spec.durationSec);
  const cacheKey = createHash("sha256")
    .update(
      canonicalJson({
        v: 1,
        kind: "poster",
        spec,
        atSec,
        width: REEL_POSTER_WIDTH,
        engineTag,
        hyperframes: HYPERFRAMES_VERSION,
      }),
    )
    .digest("hex");
  const hit = await deps.cache.get(cacheKey, "jpg");
  if (hit !== null) {
    return { cacheKey, path: hit.path, bytes: hit.bytes, cache: "hit", atSec, warnings: [] };
  }

  const warnings: string[] = [];
  const workDir = await mkdtemp(path.join(tmpdir(), "fastgram-reel-poster-"));
  const projectDir = path.join(workDir, "project");
  const outDir = path.join(workDir, "out");
  await mkdir(projectDir, { recursive: true });
  try {
    const { assets } = await resolveReelAssets(
      spec,
      {
        cache: deps.cache,
        resolveMedia: deps.resolveMedia,
        caps,
        engineTag,
        fontDir: deps.fontDir,
        asr: deps.reel.asr,
      },
      projectMode(projectDir),
      workDir,
      warnings,
      { transcribe: false },
    );
    const compiled = compileReel(spec, assets);
    warnings.push(...compiled.warnings);
    await writeFile(path.join(projectDir, "index.html"), compiled.html);
    try {
      await execFileAsync(
        process.execPath,
        [
          hyperframesCli(),
          "snapshot",
          projectDir,
          "--at",
          String(atSec),
          "--no-end",
          "-o",
          outDir,
          "--describe",
          "false",
        ],
        { timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      );
    } catch (error) {
      throw new RenderError("render_failed", "HyperFrames no pudo capturar el póster", {
        cause: error,
      });
    }
    const png = (await readdir(outDir)).find((f) => /^frame-.*\.png$/.test(f));
    if (png === undefined) {
      throw new RenderError("render_failed", "el snapshot no dejó el cuadro", {
        details: { stage: "snapshot" },
      });
    }
    const jpg = await sharp(path.join(outDir, png))
      .resize({ width: REEL_POSTER_WIDTH })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    const entry = await deps.cache.putBuffer(cacheKey, "jpg", jpg);
    return {
      cacheKey,
      path: entry.path,
      bytes: entry.bytes,
      cache: "miss",
      atSec,
      warnings,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** sRGB 0–255 → lineal (WCAG). */
function linear(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/**
 * Luminancia relativa media de los píxeles visibles (alfa > 0, ponderados por
 * el alfa), sobre una versión chica de la imagen. `null` si es toda
 * transparente.
 */
export async function visibleLuminance(file: string): Promise<number | null> {
  const { data, info } = await sharp(file)
    .resize({ width: 96, height: 96, fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  let weight = 0;
  for (let i = 0; i < info.width * info.height; i += 1) {
    const o = i * 4;
    const a = (data[o + 3] ?? 0) / 255;
    if (a <= 0) continue;
    const l =
      0.2126 * linear(data[o] ?? 0) +
      0.7152 * linear(data[o + 1] ?? 0) +
      0.0722 * linear(data[o + 2] ?? 0);
    sum += l * a;
    weight += a;
  }
  return weight === 0 ? null : Math.round((sum / weight) * 10_000) / 10_000;
}

export async function imageStats(
  raw: unknown,
  deps: ReelEngineDeps,
): Promise<{ readonly images: { url: string; luminance: number | null }[] }> {
  const parsed = reelImageStatsRequestSchema.safeParse(raw);
  if (!parsed.success) throw badRequest(parsed.error.issues);
  const grant =
    parsed.data.grant === undefined
      ? null
      : verifyGrant(parsed.data.grant as Parameters<typeof verifyGrant>[0], deps.policy);
  assertAllMediaAllowed(
    parsed.data.urls.map((url, i) => ({ url, role: "image" as const, path: ["urls", i] })),
    deps.policy,
    grant,
  );
  const images: { url: string; luminance: number | null }[] = [];
  for (const url of parsed.data.urls) {
    const local = await deps.resolveMedia(url, "image");
    let luminance: number | null;
    try {
      luminance = await visibleLuminance(local);
    } catch {
      // Un archivo que sharp no lee (un SVG raro, un video): sin dato, no error.
      luminance = null;
    }
    images.push({ url, luminance });
  }
  return { images };
}
