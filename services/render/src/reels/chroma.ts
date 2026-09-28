/**
 * Croma del reel: el clip verde/azul se recorta con FFmpeg a un **webm VP9 con
 * alfa** antes de entrar a la composición.
 *
 * Por qué así y no de otra forma (medido en esta Mac, sprint 9):
 *  · Chrome no tiene un keyer: el recorte tiene que llegar hecho. HyperFrames
 *    extrae los frames del video con FFmpeg y, si la fuente tiene alfa, los saca
 *    en PNG; un webm VP9 con `alpha_mode=1` compuso limpio sobre el fondo en el
 *    render (frames mirados). La alternativa —secuencia PNG— no hizo falta.
 *  · Los parámetros del keyer son **los del render FFmpeg de siempre**
 *    (`green-screen`, `domain/payload.ts`: `#00FF00`, similitud 0,18, mezcla
 *    0,1) más `despill`, que el render viejo no tenía: sin él queda un halo verde
 *    en el pelo y los bordes. El mismo clip tiene que salir igual de limpio acá.
 *  · Trampa 55: en un webm VP9 con alfa ffprobe dice `yuv420p`; lo que delata
 *    el alfa es la tag `alpha_mode=1`, y para decodificarlo hay que forzar
 *    `-c:v libvpx-vp9` antes del `-i`.
 *
 * El resultado se cachea por hash del archivo + parámetros + versión de
 * ffmpeg: el mismo meme en diez reels se recorta una vez.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { CacheStore } from "../cache/store.js";
import { chromaFilterName, type FfmpegCapabilities } from "../ffmpeg/capabilities.js";
import { probeMedia, type MediaInfo } from "../ffmpeg/probe.js";
import { runFfmpeg } from "../ffmpeg/run.js";
import type { ReelChroma } from "./spec.js";

/** Los del render FFmpeg (`chromaKeySchema` en `domain/payload.ts`). */
export const REEL_KEYER = {
  green: { color: "0x00FF00", despill: "green" },
  blue: { color: "0x0000FF", despill: "blue" },
  similarity: 0.18,
  blend: 0.1,
} as const;

/** El recorte no necesita más que el lienzo: un clip 4K se baja a 1080 de ancho. */
const MAX_KEYED_WIDTH = 1080;
/** VP9: calidad constante; 30 es el punto donde el borde deja de mostrar bloques. */
const VP9_CRF = 30;
export const CHROMA_TIMEOUT_MS = 180_000;

export async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Los argumentos de ffmpeg del recorte. Pura: la fija el test. */
export function keyerArgs(
  input: string,
  output: string,
  chroma: Exclude<ReelChroma, "none">,
  info: Pick<MediaInfo, "width" | "hasAlpha" | "alphaDecoder">,
  caps: Pick<FfmpegCapabilities, "hasChromakey" | "hasColorkey" | "filters">,
): string[] {
  const filters: string[] = [];
  if (chroma === "green" || chroma === "blue") {
    const key = REEL_KEYER[chroma];
    const name = chromaFilterName(caps as FfmpegCapabilities);
    filters.push(
      `${name}=${key.color}:${String(REEL_KEYER.similarity)}:${String(REEL_KEYER.blend)}`,
    );
    if (caps.filters.has("despill")) filters.push(`despill=type=${key.despill}`);
  }
  if (info.width !== null && info.width > MAX_KEYED_WIDTH) {
    filters.push(`scale=${String(MAX_KEYED_WIDTH)}:-2`);
  }
  filters.push("format=yuva420p");
  const decoder =
    chroma === "alpha" && info.hasAlpha === true && info.alphaDecoder
      ? ["-c:v", info.alphaDecoder]
      : [];
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...decoder,
    "-i",
    input,
    "-an",
    "-vf",
    filters.join(","),
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    "yuva420p",
    "-auto-alt-ref",
    "0",
    "-b:v",
    "0",
    "-crf",
    String(VP9_CRF),
    "-deadline",
    "good",
    "-cpu-used",
    "4",
    "-row-mt",
    "1",
    "-metadata:s:v:0",
    "alpha_mode=1",
    output,
  ];
}

export interface KeyedClip {
  readonly path: string;
  readonly cacheKey: string;
  readonly cache: "hit" | "miss";
  readonly bytes: number;
}

/**
 * Devuelve el clip listo para la composición: webm con alfa. `none` no pasa
 * por acá (el clip va tal cual). Un `alpha` que ya es webm VP9 con alfa también
 * va tal cual; cualquier otro alfa (ProRes 4444) se pasa a VP9, que es lo que
 * se midió que HyperFrames compone bien.
 */
export async function keyClip(
  localPath: string,
  chroma: Exclude<ReelChroma, "none">,
  cache: CacheStore,
  caps: FfmpegCapabilities,
  workDir: string,
  engineTag: string,
): Promise<KeyedClip | null> {
  const info = await probeMedia(localPath);
  if (
    chroma === "alpha" &&
    info.hasAlpha === true &&
    info.alphaDecoder === "libvpx-vp9"
  ) {
    return null;
  }
  const digest = await fileSha256(localPath);
  const cacheKey = createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        digest,
        chroma,
        keyer: REEL_KEYER,
        crf: VP9_CRF,
        maxWidth: MAX_KEYED_WIDTH,
        despill: caps.filters.has("despill"),
        engine: engineTag,
      }),
    )
    .digest("hex");
  const hit = await cache.get(cacheKey, "webm");
  if (hit !== null) return { path: hit.path, cacheKey, cache: "hit", bytes: hit.bytes };
  const out = path.join(workDir, `keyed-${cacheKey.slice(0, 16)}.webm`);
  await runFfmpeg(keyerArgs(localPath, out, chroma, info, caps), {
    expectOutput: out,
    timeoutMs: CHROMA_TIMEOUT_MS,
  });
  const entry = await cache.adopt(cacheKey, "webm", out);
  return { path: entry.path, cacheKey, cache: "miss", bytes: entry.bytes };
}
