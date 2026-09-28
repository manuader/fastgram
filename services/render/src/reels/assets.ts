/**
 * De las URLs del spec a lo que necesita el compilador: archivos locales (para
 * el render), o URLs y data URIs (para la preview del editor), más duraciones,
 * clips recortados y subtítulos transcriptos.
 */
import { copyFile, mkdir, readFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CacheStore } from "../cache/store.js";
import type { FfmpegCapabilities } from "../ffmpeg/capabilities.js";
import { probeMedia, type MediaInfo } from "../ffmpeg/probe.js";
import type { MediaReference } from "../domain/payload.js";
import type { MediaResolver } from "../render/engine.js";
import { transcribe, type AsrConfig } from "./asr.js";
import { keyClip } from "./chroma.js";
import {
  fontKey,
  requiredFonts,
  type CompileAssets,
  type ResolvedMedia,
} from "./compose/index.js";
import type { ReelCaptionWord, ReelLayer, ReelSpec } from "./spec.js";

export interface AssetDeps {
  readonly cache: CacheStore;
  readonly resolveMedia: MediaResolver;
  readonly caps: FfmpegCapabilities;
  readonly engineTag: string;
  readonly fontDir: string | null;
  readonly asr: AsrConfig;
}

/** Las URLs del spec con su rol (el rol decide la política, `FR-070`). */
export function reelMediaReferences(spec: ReelSpec): MediaReference[] {
  const refs: MediaReference[] = [];
  spec.layers.forEach((layer, i) => {
    if (
      layer.kind === "background" &&
      (layer.fill.type === "image" || layer.fill.type === "video")
    ) {
      refs.push({
        url: layer.fill.url,
        role: layer.fill.type,
        path: ["spec", "layers", i, "fill", "url"],
      });
    } else if (layer.kind === "clip") {
      refs.push({ url: layer.url, role: "video", path: ["spec", "layers", i, "url"] });
    } else if (layer.kind === "image") {
      refs.push({ url: layer.url, role: "image", path: ["spec", "layers", i, "url"] });
    } else if (layer.kind === "audio") {
      // Música y voz: el audio sólo sale de la biblioteca de la marca (`FR-070`).
      refs.push({ url: layer.url, role: "audio", path: ["spec", "layers", i, "url"] });
    }
  });
  return refs;
}

const EXT_BY_FORMAT: readonly [RegExp, string][] = [
  [/webm|matroska/, "webm"],
  [/mov|mp4|m4a|3gp/, "mp4"],
  [/mp3/, "mp3"],
  [/wav/, "wav"],
  [/ogg/, "ogg"],
  [/png/, "png"],
  [/jpeg|jpg|mjpeg/, "jpg"],
  [/webp/, "webp"],
  [/gif/, "gif"],
];

/** Extensión real del archivo (el resolver lo baja sin extensión útil). */
export function extensionFor(info: MediaInfo, role: "image" | "video" | "audio"): string {
  const names = [...info.formatNames, info.videoCodec ?? ""].join(",");
  if (role === "audio" && /mp4|mov|m4a/.test(names)) return "m4a";
  for (const [pattern, ext] of EXT_BY_FORMAT) if (pattern.test(names)) return ext;
  return role === "image" ? "jpg" : role === "video" ? "mp4" : "m4a";
}

/** Cómo quiere cada modo que aparezca un archivo en el `src`. */
export interface SourceMode {
  /** Archivo original de una capa. `url` es la del spec. */
  original(layerId: string, localPath: string, ext: string, url: string): Promise<string>;
  /** Un derivado nuestro (clip recortado). `null` = no se puede mostrar. */
  derived(layerId: string, localPath: string, bytes: number): Promise<string | null>;
  font(key: string, localPath: string): Promise<string>;
}

/** Render: todo se enlaza dentro del proyecto temporal y el `src` es relativo. */
export function projectMode(projectDir: string): SourceMode {
  const place = async (rel: string, localPath: string): Promise<string> => {
    const target = path.join(projectDir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    if (!existsSync(target)) {
      // Symlink y no copia: un clip de 50 MB no se duplica. Si el FS no deja,
      // copia (el productor sirve el proyecto con su propio servidor de archivos).
      await symlink(localPath, target).catch(async () => copyFile(localPath, target));
    }
    return rel;
  };
  return {
    original: (id, local, ext) => place(`assets/${id}.${ext}`, local),
    derived: (id, local) => place(`assets/${id}.keyed.webm`, local),
    font: (key, local) => place(`fonts/${key}.ttf`, local),
  };
}

/**
 * Preview: los originales van por su URL (el navegador del editor los baja
 * directo del storage, como las miniaturas del picker); lo que sólo existe
 * acá —el clip recortado y las fuentes— va embebido como data URI.
 */
export function previewMode(inlineMaxBytes: number, warnings: string[]): SourceMode {
  const dataUri = async (local: string, mime: string): Promise<string> =>
    `data:${mime};base64,${(await readFile(local)).toString("base64")}`;
  return {
    original: async (_id, _local, _ext, url) => url,
    derived: async (id, local, bytes) => {
      if (bytes > inlineMaxBytes) {
        warnings.push(
          `clip ${id}: keyed preview too large to inline, showing the original`,
        );
        return null;
      }
      return dataUri(local, "video/webm");
    },
    font: (_key, local) => dataUri(local, "font/ttf"),
  };
}

interface Downloaded {
  readonly local: string;
  readonly info: MediaInfo;
  readonly ext: string;
}

/**
 * Resuelve todo. Los avisos (sin modelo de ASR, sin fuente, clip muy pesado
 * para la preview) no cortan el render: la pieza sale igual y se dice.
 */
export async function resolveReelAssets(
  spec: ReelSpec,
  deps: AssetDeps,
  mode: SourceMode,
  workDir: string,
  warnings: string[],
): Promise<{ assets: CompileAssets; captions: Record<string, ReelCaptionWord[]> }> {
  const visual = new Map<string, ResolvedMedia>();
  const sound = new Map<string, ResolvedMedia>();
  const fonts = new Map<string, string>();
  const captions = new Map<string, readonly ReelCaptionWord[]>();
  const localByLayer = new Map<string, Downloaded>();

  const download = async (
    url: string,
    role: "image" | "video" | "audio",
  ): Promise<Downloaded> => {
    const local = await deps.resolveMedia(url, role);
    const info = await probeMedia(local);
    return { local, info, ext: extensionFor(info, role) };
  };
  const media = (src: string, info: MediaInfo): ResolvedMedia => ({
    src,
    durationSec: info.durationSeconds,
    hasAudio: info.hasAudio,
  });

  for (const layer of spec.layers) {
    if (layer.kind === "background") {
      if (layer.fill.type !== "image" && layer.fill.type !== "video") continue;
      const d = await download(layer.fill.url, layer.fill.type);
      localByLayer.set(layer.id, d);
      visual.set(
        layer.id,
        media(await mode.original(layer.id, d.local, d.ext, layer.fill.url), d.info),
      );
    } else if (layer.kind === "image") {
      const d = await download(layer.url, "image");
      localByLayer.set(layer.id, d);
      visual.set(
        layer.id,
        media(await mode.original(layer.id, d.local, d.ext, layer.url), d.info),
      );
    } else if (layer.kind === "clip") {
      const d = await download(layer.url, "video");
      localByLayer.set(layer.id, d);
      const original = await mode.original(layer.id, d.local, d.ext, layer.url);
      let src = original;
      if (layer.chroma !== "none") {
        const keyed = await keyClip(
          d.local,
          layer.chroma,
          deps.cache,
          deps.caps,
          workDir,
          deps.engineTag,
        );
        if (keyed !== null)
          src = (await mode.derived(layer.id, keyed.path, keyed.bytes)) ?? original;
      }
      visual.set(layer.id, media(src, d.info));
      if (d.info.hasAudio) sound.set(layer.id, media(original, d.info));
    } else if (layer.kind === "audio") {
      const d = await download(layer.url, "audio");
      localByLayer.set(layer.id, d);
      sound.set(
        layer.id,
        media(await mode.original(layer.id, d.local, d.ext, layer.url), d.info),
      );
    }
  }

  for (const key of requiredFonts(spec)) {
    if (deps.fontDir === null) break;
    const file = path.join(deps.fontDir, `${key}.ttf`);
    if (!existsSync(file)) continue;
    fonts.set(key, await mode.font(key, file));
  }
  if (requiredFonts(spec).length > 0 && fonts.size === 0) {
    warnings.push(
      "no font directory (RENDER_FONT_DIR): text falls back to a system font",
    );
  }

  const resolved: Record<string, ReelCaptionWord[]> = {};
  for (const layer of spec.layers) {
    if (layer.kind !== "captions") continue;
    if (layer.words !== undefined) {
      captions.set(layer.id, layer.words);
      continue;
    }
    const source = spec.layers.find((l) => l.id === layer.sourceLayerId);
    const d = source === undefined ? undefined : localByLayer.get(source.id);
    if (source === undefined || d === undefined || !d.info.hasAudio) {
      // Sin audio no hay habla: sin subtítulos, que es lo que pide el brief.
      captions.set(layer.id, []);
      resolved[layer.id] = [];
      continue;
    }
    try {
      const out = await transcribe(
        d.local,
        spec.language ?? null,
        deps.asr,
        deps.cache,
        workDir,
      );
      const words = toReelTime(out.words, source, spec.durationSec);
      captions.set(layer.id, words);
      resolved[layer.id] = words;
    } catch (error) {
      warnings.push(
        `captions ${layer.id}: transcription unavailable (${error instanceof Error ? error.message.slice(0, 160) : "error"})`,
      );
      captions.set(layer.id, []);
    }
  }

  return { assets: { visual, sound, fonts, captions }, captions: resolved };
}

/** Tiempos del archivo → tiempos del reel, recortados a la ventana de la capa. */
export function toReelTime(
  words: readonly { text: string; start: number; end: number }[],
  source: ReelLayer,
  durationSec: number,
): ReelCaptionWord[] {
  const offset =
    source.kind === "clip" || source.kind === "audio" ? source.mediaStartSec : 0;
  const out: ReelCaptionWord[] = [];
  for (const w of words) {
    const start = source.start + (w.start - offset);
    const end = source.start + (w.end - offset);
    if (start < source.start - 1e-6 || start >= source.end || start >= durationSec)
      continue;
    out.push({
      text: w.text,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(Math.min(end, source.end, durationSec) * 1000) / 1000,
    });
  }
  return out.filter((w) => w.end > w.start);
}

export { fontKey };
