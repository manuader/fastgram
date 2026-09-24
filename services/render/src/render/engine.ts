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
import { engineVersion } from "./engineVersion.js";
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

/**
 * Extensión con la que el artefacto quedó guardado en la cache. Vive acá y no
 * en `http/` porque es una propiedad del artefacto, no del transporte: la capa
 * HTTP la traduce a `content-type`, en esa dirección y no en la otra.
 */
export type ArtifactExtension = "mp4" | "jpg";

export interface RenderArtifact {
  readonly kind: "video" | "image";
  readonly path: string;
  readonly bytes: number;
  readonly index: number;
  /**
   * La clave de cache con la que se recupera el archivo (`P2-RENDER-015`). Es
   * lo que la capa HTTP convierte en `href`; el motor no conoce URLs.
   */
  readonly cacheKey: string;
  readonly extension: ArtifactExtension;
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

/**
 * Pasos 1–3: todo lo que se puede rechazar sin gastar un byte de IO.
 *
 * **Ya no devuelve las claves de cache** (`P2-RENDER-016`). Las claves llevan
 * adentro la versión del motor, y esa versión incluye la de ffmpeg, que se
 * averigua sondeando el binario. Calcularlas acá obligaba a una de dos cosas
 * malas: o sondear ffmpeg antes de validar —y romper la promesa de que un
 * payload basura no toca el motor—, o dejar la versión de ffmpeg afuera de la
 * clave, que es el bug que `P2-RENDER-016` viene a cerrar. Calcular la clave
 * nunca fue parte de validar: sólo vivía acá.
 */
export function validateRequest(
  raw: unknown,
  policy: MediaPolicyConfig,
): { payload: BuildPayload; grant: VerifiedGrant | null } {
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
  const grant =
    parsed.data.grant === undefined ? null : verifyGrant(parsed.data.grant, policy);
  const payload = parsed.data.payload;
  assertAllMediaAllowed(collectMediaReferences(payload), policy, grant);
  return { payload, grant };
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
    ...(info.hasAlpha === true
      ? { hasAlpha: true, alphaDecoder: info.alphaDecoder ?? null }
      : {}),
  };
}

export async function renderBuild(
  raw: unknown,
  config: RenderEngineConfig,
): Promise<RenderOutput> {
  const { payload } = validateRequest(raw, config.policy);
  const caps = config.capabilities ?? (await probeCapabilities());
  // La versión del motor entra en las tres claves: si cambia el código, ffmpeg,
  // sharp o el registro de fuentes, el artefacto viejo deja de ser válido y la
  // cache lo tiene que saber (`P2-RENDER-016`).
  const keys = computeCacheKeys(payload, (await engineVersion(caps)).version);
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
      artifacts.push({
        kind: "image",
        path: cachedFinal.path,
        bytes: cachedFinal.bytes,
        index,
        cacheKey: cachedFinal.key,
        extension: "jpg",
      });
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
    artifacts.push({
      kind: "image",
      path: entry.path,
      bytes: entry.bytes,
      index,
      cacheKey: entry.key,
      extension: "jpg",
    });
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
      artifacts: [
        {
          kind: "video",
          path: cachedFinal.path,
          bytes: cachedFinal.bytes,
          index: 0,
          cacheKey: cachedFinal.key,
          extension: "mp4",
        },
      ],
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
  const overlayPlan = planTextOverlayPass(
    basePath,
    overlayPath,
    finalPath,
    hasAudio,
    caps,
  );
  await runFfmpeg(overlayPlan.args, { expectOutput: finalPath });
  const adoptedFinal = await config.cache.adopt(keys.buildKey, "mp4", finalPath);

  return {
    type: payload.type,
    keys,
    artifacts: [
      {
        kind: "video",
        path: adoptedFinal.path,
        bytes: adoptedFinal.bytes,
        index: 0,
        cacheKey: adoptedFinal.key,
        extension: "mp4",
      },
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
  /**
   * `PU-MEME-002`: si el video trae alfa, no se normaliza. La normalización
   * produce H.264 `yuv420p` y el alfa —todo el punto de un recorte— se pierde.
   * Sólo el foreground de `green-screen` lo pide.
   */
  preserveAlpha = false,
): Promise<string> {
  const localPath = await config.resolveMedia(url, "video");
  if (!config.normalizeInputs) return localPath;
  if (preserveAlpha && (await probeMedia(localPath)).hasAlpha === true) return localPath;
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

/**
 * Resuelve la pista de audio, o `null` si el payload eligió `No audio`
 * (`FR-053.1`). El `null` viaja hasta el plan de ffmpeg, que decide ahí qué
 * hacer con la ausencia; la razón de esa decisión está en `formats.ts`.
 */
async function resolveAudio(
  audio: { readonly url: string } | undefined,
  config: RenderEngineConfig,
): Promise<string | null> {
  if (audio === undefined) return null;
  return await config.resolveMedia(audio.url, "audio");
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
    const videoPath = await prepareVideo(
      payload.video.url,
      config,
      caps,
      workDir,
      "video",
      warnings,
    );
    const audioPath = await resolveAudio(payload.audio, config);
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
    const videoPath = await prepareVideo(
      payload.video.url,
      config,
      caps,
      workDir,
      "video",
      warnings,
      true,
    );
    const backgroundInfo = await probeMedia(backgroundPath);
    if (backgroundInfo.width === null || backgroundInfo.height === null) {
      throw new RenderError(
        "unsupported_media_format",
        "la imagen de fondo no declara dimensiones",
      );
    }
    // Sprint 7: la música de la marca, si la hay, se mezcla con el clip.
    const audioPath = await resolveAudio(payload.audio, config);
    const plan = planGreenScreenBase(
      payload,
      {
        backgroundPath,
        videoPath,
        audioPath,
        outputPath,
        background: { width: backgroundInfo.width, height: backgroundInfo.height },
        video: await geometryOf(videoPath),
      },
      caps,
    );
    await runFfmpeg(plan.args, { expectOutput: outputPath });
    return { outputPath, plan };
  }

  const hookPath = await prepareVideo(
    payload.hookVideo.url,
    config,
    caps,
    workDir,
    "hook",
    warnings,
  );
  const demoPath = await prepareVideo(
    payload.demoVideo.url,
    config,
    caps,
    workDir,
    "demo",
    warnings,
  );
  const audioPath = await resolveAudio(payload.audio, config);
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
