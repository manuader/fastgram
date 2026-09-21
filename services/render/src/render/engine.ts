/**
 * Orquestación del build. El orden de los pasos no es casual:
 *
 *   1. validar el payload            → `bad_request`
 *   2. verificar el grant firmado    → `media_grant_invalid`
 *   3. validar TODAS las URLs        → `media_url_not_allowed`
 *   4. recién ahí resolver media, normalizar y encodear
 *
 * `FR-070` es explícito: "Una URL arbitraria se rechaza con `400 bad_request`
 * **antes de iniciar el build**". Los pasos 1–3 no tocan la red ni el disco ni
 * ffmpeg.
 *
 * El servicio es SIN ESTADO: todo lo que necesita llega en el request o en la
 * configuración. La cache es un acelerador, nunca una fuente de verdad.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { RenderError } from "../errors.js";
import {
  buildPayloadSchema,
  collectMediaReferences,
  type BuildPayload,
  type ContentType,
} from "../domain/payload.js";
import { computeCacheKeys, type CacheKeys } from "../domain/hash.js";
import {
  assertAllMediaAllowed,
  mediaGrantSchema,
  verifyGrant,
  type MediaPolicyConfig,
  type VerifiedGrant,
} from "../media/urlPolicy.js";
import { probeCapabilities, type FfmpegCapabilities } from "../ffmpeg/capabilities.js";
import { probeMedia } from "../ffmpeg/probe.js";
import { normalizeMedia } from "../ffmpeg/normalize.js";
import { runFfmpeg } from "../ffmpeg/run.js";
import type { CacheStore } from "../cache/store.js";
import type { FontLoaderOptions } from "./fontLoader.js";
import { renderTextOverlay } from "./textLayer.js";
import { renderSlideBase, renderSlideWithText } from "./slideshow.js";
import {
  planGreenScreenBase,
  planTextOverlayPass,
  planVideoHookBase,
  planWallOfTextBase,
  type FfmpegPlan,
  type SourceGeometry,
} from "./formats.js";

/** Descarga (o localiza) una URL ya autorizada y devuelve una ruta local. */
export type MediaResolver = (
  url: string,
  role: "image" | "video" | "audio",
) => Promise<string>;

export interface RenderEngineConfig {
  readonly cache: CacheStore;
  readonly policy: MediaPolicyConfig;
  readonly fonts: FontLoaderOptions;
  readonly resolveMedia: MediaResolver;
  /** `false` salta `NFR-014`. Sólo para tests con media ya normalizada. */
  readonly normalizeInputs: boolean;
  /** Dejar pasar HDR sin tone mapping cuando el build no puede hacerlo. */
  readonly allowUntonemappedHdr: boolean;
  readonly capabilities?: FfmpegCapabilities;
}

export type CacheState = "hit" | "miss";

export interface RenderArtifact {
  readonly kind: "video" | "image";
  readonly path: string;
  readonly bytes: number;
  readonly index: number;
}

export interface RenderOutput {
  readonly type: ContentType;
  readonly keys: CacheKeys;
  readonly artifacts: readonly RenderArtifact[];
  readonly cache: { readonly base: CacheState; readonly build: CacheState };
  /** Cosas que salieron bien pero el llamador debería saber. */
  readonly warnings: readonly string[];
}

export const renderRequestSchema = z
  .object({
    payload: buildPayloadSchema,
    grant: mediaGrantSchema.optional(),
  })
  .strict();

export type RenderRequestInput = z.input<typeof renderRequestSchema>;

/** Pasos 1–3: todo lo que se puede rechazar sin gastar un byte de IO. */
export function validateRequest(
  raw: unknown,
  policy: MediaPolicyConfig,
): { payload: BuildPayload; grant: VerifiedGrant | null; keys: CacheKeys } {
  const parsed = renderRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RenderError("bad_request", "el payload de build no es válido", {
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  }
  const grant = parsed.data.grant === undefined ? null : verifyGrant(parsed.data.grant, policy);
  const payload = parsed.data.payload;
  assertAllMediaAllowed(collectMediaReferences(payload), policy, grant);
  return { payload, grant, keys: computeCacheKeys(payload) };
}

async function geometryOf(localPath: string): Promise<SourceGeometry> {
  const info = await probeMedia(localPath);
  if (info.width === null || info.height === null) {
    throw new RenderError("unsupported_media_format", "el medio no declara dimensiones", {
      details: { path: path.basename(localPath) },
    });
  }
  return {
    width: info.width,
    height: info.height,
    durationSeconds: info.durationSeconds,
    hasAudio: info.hasAudio,
  };
}

export async function renderBuild(
  raw: unknown,
  config: RenderEngineConfig,
): Promise<RenderOutput> {
  const { payload, keys } = validateRequest(raw, config.policy);
  const caps = config.capabilities ?? (await probeCapabilities());
  const warnings: string[] = [];

  const workDir = await mkdtemp(path.join(tmpdir(), "fastgram-render-"));
  try {
    if (payload.type === "slideshow") {
      return await renderSlideshowBuild(payload, keys, config, warnings);
    }
    return await renderVideoBuild(payload, keys, config, caps, workDir, warnings);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function renderSlideshowBuild(
  payload: Extract<BuildPayload, { type: "slideshow" }>,
  keys: CacheKeys,
  config: RenderEngineConfig,
  warnings: string[],
): Promise<RenderOutput> {
  const artifacts: RenderArtifact[] = [];
  let baseState: CacheState = "hit";
  let buildState: CacheState = "hit";

  for (const [index, slide] of payload.slides.entries()) {
    const finalKey = `${keys.buildKey}-${index}`;
    const cachedFinal = await config.cache.get(finalKey, "jpg");
    if (cachedFinal !== null) {
      artifacts.push({ kind: "image", path: cachedFinal.path, bytes: cachedFinal.bytes, index });
      continue;
    }
    buildState = "miss";

    const baseKey = `${keys.mediaKey}-${index}`;
    let basePng: Buffer;
    const cachedBase = await config.cache.get(baseKey, "png");
    if (cachedBase !== null) {
      basePng = await readFile(cachedBase.path);
    } else {
      baseState = "miss";
      const localPath = await config.resolveMedia(slide.image.url, "image");
      basePng = await renderSlideBase(payload, index, localPath);
      await config.cache.putBuffer(baseKey, "png", basePng);
    }

    const rendered = await renderSlideWithText(payload, index, basePng, config.fonts);
    if (rendered.hasUnverifiedFont) {
      warnings.push(`slide ${index}: se renderizó con una fuente no verificada`);
    }
    const entry = await config.cache.putBuffer(finalKey, "jpg", rendered.jpeg);
    artifacts.push({ kind: "image", path: entry.path, bytes: entry.bytes, index });
  }

  return {
    type: payload.type,
    keys,
    artifacts,
    cache: { base: baseState, build: buildState },
    warnings,
  };
}

async function renderVideoBuild(
  payload: Exclude<BuildPayload, { type: "slideshow" }>,
  keys: CacheKeys,
  config: RenderEngineConfig,
  caps: FfmpegCapabilities,
  workDir: string,
  warnings: string[],
): Promise<RenderOutput> {
  const cachedFinal = await config.cache.get(keys.buildKey, "mp4");
  if (cachedFinal !== null) {
    return {
      type: payload.type,
      keys,
      artifacts: [{ kind: "video", path: cachedFinal.path, bytes: cachedFinal.bytes, index: 0 }],
      cache: { base: "hit", build: "hit" },
      warnings,
    };
  }

  let baseState: CacheState = "hit";
  let basePath: string;
  let hasAudio: boolean;

  const cachedBase = await config.cache.get(keys.mediaKey, "mp4");
  if (cachedBase !== null) {
    basePath = cachedBase.path;
    hasAudio = (await probeMedia(basePath)).hasAudio;
  } else {
    baseState = "miss";
    const built = await buildBase(payload, config, caps, workDir, warnings);
    const adopted = await config.cache.adopt(keys.mediaKey, "mp4", built.outputPath);
    basePath = adopted.path;
    hasAudio = built.plan.hasAudio;
  }

  const canvas = payload.canvas;
  const overlay = await renderTextOverlay(payload.texts, canvas, config.fonts);
  if (overlay.hasUnverifiedFont) {
    warnings.push("el overlay se renderizó con una fuente no verificada");
  }
  const overlayPath = path.join(workDir, "overlay.png");
  await writeFile(overlayPath, overlay.png);

  const finalPath = path.join(workDir, "final.mp4");
  const overlayPlan = planTextOverlayPass(basePath, overlayPath, finalPath, hasAudio, caps);
  await runFfmpeg(overlayPlan.args, { expectOutput: finalPath });
  const adoptedFinal = await config.cache.adopt(keys.buildKey, "mp4", finalPath);

  return {
    type: payload.type,
    keys,
    artifacts: [
      { kind: "video", path: adoptedFinal.path, bytes: adoptedFinal.bytes, index: 0 },
    ],
    cache: { base: baseState, build: "miss" },
    warnings,
  };
}

async function prepareVideo(
  url: string,
  config: RenderEngineConfig,
  caps: FfmpegCapabilities,
  workDir: string,
  name: string,
  warnings: string[],
): Promise<string> {
  const localPath = await config.resolveMedia(url, "video");
  if (!config.normalizeInputs) return localPath;
  const normalizedPath = path.join(workDir, `${name}.normalized.mp4`);
  const result = await normalizeMedia(localPath, normalizedPath, caps, {
    allowUntonemappedHdr: config.allowUntonemappedHdr,
  });
  if (result.toneMapping === "unavailable") {
    warnings.push(`${name}: HDR sin tone mapping (este build de ffmpeg no trae zscale)`);
  } else if (result.toneMapping === "approximate") {
    warnings.push(`${name}: conversión de gama aproximada (BT.2020 SDR → BT.709)`);
  }
  return normalizedPath;
}

async function buildBase(
  payload: Exclude<BuildPayload, { type: "slideshow" }>,
  config: RenderEngineConfig,
  caps: FfmpegCapabilities,
  workDir: string,
  warnings: string[],
): Promise<{ outputPath: string; plan: FfmpegPlan }> {
  const outputPath = path.join(workDir, "base.mp4");

  if (payload.type === "wall-of-text") {
    const videoPath = await prepareVideo(payload.video.url, config, caps, workDir, "video", warnings);
    const audioPath = await config.resolveMedia(payload.audio.url, "audio");
    const plan = planWallOfTextBase(
      payload,
      { videoPath, audioPath, outputPath, video: await geometryOf(videoPath) },
      caps,
    );
    await runFfmpeg(plan.args, { expectOutput: outputPath });
    return { outputPath, plan };
  }

  if (payload.type === "green-screen") {
    const backgroundPath = await config.resolveMedia(payload.image.url, "image");
    const videoPath = await prepareVideo(payload.video.url, config, caps, workDir, "video", warnings);
    const backgroundInfo = await probeMedia(backgroundPath);
    if (backgroundInfo.width === null || backgroundInfo.height === null) {
      throw new RenderError("unsupported_media_format", "la imagen de fondo no declara dimensiones");
    }
    const plan = planGreenScreenBase(
      payload,
      {
        backgroundPath,
        videoPath,
        outputPath,
        background: { width: backgroundInfo.width, height: backgroundInfo.height },
        video: await geometryOf(videoPath),
      },
      caps,
    );
    await runFfmpeg(plan.args, { expectOutput: outputPath });
    return { outputPath, plan };
  }

  const hookPath = await prepareVideo(payload.hookVideo.url, config, caps, workDir, "hook", warnings);
  const demoPath = await prepareVideo(payload.demoVideo.url, config, caps, workDir, "demo", warnings);
  const audioPath = await config.resolveMedia(payload.audio.url, "audio");
  const plan = planVideoHookBase(
    payload,
    {
      hookPath,
      demoPath,
      audioPath,
      outputPath,
      hook: await geometryOf(hookPath),
      demo: await geometryOf(demoPath),
    },
    caps,
  );
  await runFfmpeg(plan.args, { expectOutput: outputPath });
  return { outputPath, plan };
}
