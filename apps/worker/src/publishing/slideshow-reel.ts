/**
 * Un slideshow publicado como **Reel** de Instagram — sprint 7, `F-158`
 * (`instagramSlideshowFormat: "reel"`), PRD:2486 («`reel` (renderizado a
 * video)»).
 *
 * La Content Publishing API de Instagram sólo hace Reels con `video_url`: no
 * arma un video desde imágenes. El render (`services/render`) tampoco: el
 * slideshow sale por `sharp` como imágenes sueltas. Así que, para una cuenta
 * OAuth, el Reel se compone **acá**, justo antes de publicar:
 *
 * 1. se bajan las slides del bucket (`Storage.get`), en orden;
 * 2. FFmpeg las encadena: {@link SLIDESHOW_REEL_SECONDS_PER_SLIDE} s cada una,
 *    escaladas y centradas sobre 1080×1920 (9:16, lo que Instagram recomienda
 *    para Reels), H.264 `yuv420p` a 30 fps con `faststart`, sin audio;
 * 3. el MP4 se sube a `derived/slideshow-reels/<contentId>-r<revision>.mp4` y se
 *    devuelve su URL canónica: el publicador la resuelve a URL pública como
 *    cualquier otra media.
 *
 * Es **idempotente por revisión**: si el objeto ya existe se reusa (un
 * reintento no vuelve a componer, y editar la pieza sube la revisión).
 *
 * Números nuestros, no del PRD ni de Meta: 3 s por slide y el lienzo 1080×1920.
 * Un slideshow de una sola slide da un Reel de 3 s, el mínimo que la guía de
 * Reels menciona (no verificado contra la API).
 *
 * Sin FFmpeg en la máquina la composición falla con `ENOENT` y el publicador
 * cierra el post con `slideshow_reel_unavailable`: el usuario elige carrusel o
 * instala FFmpeg (`FFMPEG_PATH`).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalObjectUrl } from "@fastgram/adapters";
import { PortError, type Storage } from "@fastgram/ports";

import { bucketBaseOf, keyFromCanonicalUrl } from "./media.js";

export const SLIDESHOW_REEL_SECONDS_PER_SLIDE = 3;
export const SLIDESHOW_REEL_WIDTH = 1080;
export const SLIDESHOW_REEL_HEIGHT = 1920;
/** Cuánto se le deja a FFmpeg: 20 slides × 3 s es un video de un minuto. */
export const SLIDESHOW_REEL_TIMEOUT_MS = 180_000;

export interface SlideshowReelInput {
  readonly contentId: string;
  readonly revision: number;
  /** URLs canónicas de las slides (`contents.files`), en orden. */
  readonly files: readonly string[];
}

export interface SlideshowReelComposer {
  /** La URL canónica del MP4 ya subido. Lanza si no se pudo componer. */
  compose(input: SlideshowReelInput): Promise<string>;
}

/** El motivo de un fallo al componer, para el `errorCode` del post. */
export class SlideshowReelError extends Error {
  override readonly name = "SlideshowReelError";
  constructor(
    readonly code: "slideshow_reel_unavailable" | "slideshow_reel_failed",
    message: string,
  ) {
    super(message);
  }
}

export function isSlideshowReelError(value: unknown): value is SlideshowReelError {
  return value instanceof SlideshowReelError;
}

export function slideshowReelKey(contentId: string, revision: number): string {
  return `derived/slideshow-reels/${contentId}-r${String(revision)}.mp4`;
}

/** Los argumentos de FFmpeg. Pura, para testear sin binario. */
export function slideshowReelArgs(
  inputs: readonly string[],
  output: string,
  secondsPerSlide: number = SLIDESHOW_REEL_SECONDS_PER_SLIDE,
): string[] {
  const W = SLIDESHOW_REEL_WIDTH;
  const H = SLIDESHOW_REEL_HEIGHT;
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const input of inputs) {
    args.push("-loop", "1", "-t", String(secondsPerSlide), "-i", input);
  }
  const chains = inputs.map(
    (_input, i) =>
      `[${String(i)}:v]scale=${String(W)}:${String(H)}:force_original_aspect_ratio=decrease,` +
      `pad=${String(W)}:${String(H)}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[v${String(i)}]`,
  );
  const concat = `${inputs.map((_x, i) => `[v${String(i)}]`).join("")}concat=n=${String(inputs.length)}:v=1:a=0[out]`;
  args.push(
    "-filter_complex",
    [...chains, concat].join(";"),
    "-map",
    "[out]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-movflags",
    "+faststart",
    output,
  );
  return args;
}

export type FfmpegRunner = (binary: string, args: readonly string[]) => Promise<void>;

const execFfmpeg: FfmpegRunner = (binary, args) =>
  new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      { timeout: SLIDESHOW_REEL_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error) => {
        if (error === null) resolve();
        else reject(error);
      },
    );
  });

async function readAll(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function extensionOf(key: string): string {
  const match = /\.(png|jpe?g|webp)$/i.exec(key);
  return match === null ? ".png" : `.${(match[1] ?? "png").toLowerCase()}`;
}

export function createFfmpegSlideshowReelComposer(deps: {
  readonly storage: Storage;
  readonly ffmpeg?: string;
  readonly run?: FfmpegRunner;
}): SlideshowReelComposer {
  const binary = deps.ffmpeg ?? "ffmpeg";
  const run = deps.run ?? execFfmpeg;

  return {
    async compose(input) {
      if (input.files.length === 0) {
        throw new SlideshowReelError(
          "slideshow_reel_failed",
          "This slideshow has no slides.",
        );
      }
      const key = slideshowReelKey(input.contentId, input.revision);
      if ((await deps.storage.head(key)) !== null) {
        return canonicalObjectUrl(deps.storage, key);
      }

      const base = await bucketBaseOf(deps.storage);
      const dir = await mkdtemp(join(tmpdir(), "fg-reel-"));
      try {
        const inputs: string[] = [];
        for (const [i, file] of input.files.entries()) {
          const slideKey = keyFromCanonicalUrl(file, base);
          if (slideKey === null) {
            throw new PortError(
              "bad_request",
              "This media isn't stored in FastGram's bucket.",
              {
                source: "worker/slideshow-reel",
              },
            );
          }
          const path = join(
            dir,
            `slide-${String(i).padStart(2, "0")}${extensionOf(slideKey)}`,
          );
          await writeFile(path, await readAll(await deps.storage.get(slideKey)));
          inputs.push(path);
        }
        const output = join(dir, "reel.mp4");
        try {
          await run(binary, slideshowReelArgs(inputs, output));
        } catch (error) {
          const missing =
            typeof error === "object" &&
            error !== null &&
            (error as { code?: unknown }).code === "ENOENT";
          // Nunca el stderr de FFmpeg hacia afuera: un código y un mensaje nuestro.
          throw missing
            ? new SlideshowReelError(
                "slideshow_reel_unavailable",
                "Publishing a slideshow as a Reel needs FFmpeg on this machine. Choose Carousel, or install FFmpeg.",
              )
            : new SlideshowReelError(
                "slideshow_reel_failed",
                "We couldn't turn this slideshow into a Reel. Try Carousel instead.",
              );
        }
        await deps.storage.put({
          key,
          body: await readFile(output),
          contentType: "video/mp4",
        });
        return canonicalObjectUrl(deps.storage, key);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
