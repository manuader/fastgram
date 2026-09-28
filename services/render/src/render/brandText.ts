/**
 * Fuentes de marca en el render — sprint 9 (M), `PU-S9-001/003`.
 *
 * Dos partes:
 *
 *  1. {@link prepareBrandFonts}: de las URLs del request (`brandFonts`, ya
 *     autorizadas por la política de media) a archivos locales validados
 *     (firma sfnt `OTTO`/`\0\1\0\0`/`true`, tope de tamaño) con la familia que
 *     **declara el archivo** (`fontNames.ts`): Rotis se llama «Rotis SemiSans
 *     Std» adentro aunque el CSS diga «Rotis Semi Sans».
 *  2. {@link renderBrandGlyphs}: dibuja los glifos en un **proceso hijo**
 *     (`brandTextChild.ts`) que registra esas fuentes antes de su primer
 *     texto. En el proceso principal no se puede: ver `domain/fonts.ts`.
 *
 * El hijo cuesta un arranque de Node + sharp por caja (~0,3–0,5 s medidos en
 * esta Mac): sólo lo pagan las cajas con familia de marca.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RenderError } from "../errors.js";
import { BRAND_FONT_MAX_BYTES, type BrandFontRef } from "../domain/fonts.js";
import { renderFontsConf } from "./fontActivation.js";
import { readFontNames } from "./fontNames.js";

/** Una cara de marca lista para usar. */
export interface LocalBrandFont {
  readonly id: string;
  readonly weight: number;
  readonly style: "normal" | "italic";
  /** Archivo local (bajado por el resolver de media). */
  readonly file: string;
  /** La familia que declara el archivo: la que se le pide a Pango. */
  readonly pangoFamily: string;
}

/** `true` si los primeros bytes son de una fuente sfnt (TrueType u OpenType/CFF). */
export function isSfnt(head: Uint8Array): boolean {
  if (head.length < 4) return false;
  const tag = String.fromCharCode(head[0] ?? 0, head[1] ?? 0, head[2] ?? 0, head[3] ?? 0);
  return (
    tag === "OTTO" ||
    tag === "true" ||
    (head[0] === 0 && head[1] === 1 && head[2] === 0 && head[3] === 0)
  );
}

/**
 * Baja (con `resolveLocal`) y valida las caras de marca del request. Una cara
 * que no es sfnt, pesa de más o no trae nombre de familia es `bad_request`:
 * el request pidió algo que no se puede dibujar, y reintentar no lo arregla.
 */
export async function prepareBrandFonts(
  refs: readonly BrandFontRef[],
  resolveLocal: (url: string) => Promise<string>,
): Promise<readonly LocalBrandFont[]> {
  const out: LocalBrandFont[] = [];
  for (const ref of refs) {
    const file = await resolveLocal(ref.url);
    const bytes = await readFile(file);
    if (bytes.byteLength > BRAND_FONT_MAX_BYTES) {
      throw new RenderError(
        "bad_request",
        "una fuente de marca pesa más de lo permitido",
        {
          details: { id: ref.id, bytes: bytes.byteLength, max: BRAND_FONT_MAX_BYTES },
        },
      );
    }
    if (!isSfnt(bytes)) {
      throw new RenderError("bad_request", "una fuente de marca no es OTF ni TTF", {
        details: { id: ref.id, weight: ref.weight },
      });
    }
    const names = readFontNames(bytes);
    if (names === null) {
      throw new RenderError("bad_request", "una fuente de marca no declara su familia", {
        details: { id: ref.id, weight: ref.weight },
      });
    }
    // CoreText registra por extensión conocida: el archivo del resolver puede
    // no tenerla. Se copia al lado con la que corresponde.
    const ext = bytes[0] === 0x4f ? ".otf" : ".ttf";
    const named = file.endsWith(ext) ? file : `${file}${ext}`;
    if (named !== file && !existsSync(named)) await writeFile(named, bytes);
    out.push({
      id: ref.id,
      weight: ref.weight,
      style: ref.style,
      file: named,
      pangoFamily: names.family,
    });
  }
  return out;
}

export interface GlyphJob {
  readonly text: string;
  readonly font: string;
  readonly width: number;
  readonly align: "left" | "centre" | "right";
}

export interface BrandGlyphs {
  readonly verified: boolean;
  readonly registered: number;
  readonly results: readonly { buffer: Buffer; width: number; height: number }[];
}

/** El hijo, al lado de este módulo: `.ts` en desarrollo y tests, `.js` en `dist/`. */
export function brandTextChildPath(): string {
  const self = fileURLToPath(import.meta.url);
  const ext = path.extname(self);
  return path.join(path.dirname(self), `brandTextChild${ext}`);
}

/** Tope del hijo. Un texto de 5 000 caracteres con contorno tarda < 2 s. */
export const BRAND_CHILD_TIMEOUT_MS = 20_000;
const MAX_CHILD_OUTPUT = 64 * 1024 * 1024;

/**
 * Dibuja `jobs` con las fuentes `fonts` registradas en un proceso nuevo.
 * `probe` es la descripción (familia + palabras de peso y estilo) que se
 * compara contra el centinela: `verified: false` = la fuente no cargó.
 */
export async function renderBrandGlyphs(input: {
  readonly fonts: readonly string[];
  readonly jobs: readonly GlyphJob[];
  readonly probe: { family: string; weightWord: string; styleWord: string } | null;
}): Promise<BrandGlyphs> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  let confDir: string | null = null;
  if (process.platform !== "darwin") {
    // Linux: un `fonts.conf` con la carpeta de cada fuente. Mismo generador
    // que la activación de `RENDER_FONT_DIR`.
    confDir = await mkdtemp(path.join(tmpdir(), "fastgram-brand-fonts-"));
    const dirs = [...new Set(input.fonts.map((f) => path.dirname(f)))];
    const conf = renderFontsConf({
      fontDir: dirs[0] ?? confDir,
      cacheDir: path.join(confDir, "cache"),
      includes: [
        ...(process.env["FONTCONFIG_FILE"] === undefined
          ? []
          : [process.env["FONTCONFIG_FILE"]]),
        "/etc/fonts/fonts.conf",
      ],
    }).replace(
      "</fontconfig>",
      `${dirs
        .slice(1)
        .map((d) => `  <dir>${d}</dir>\n`)
        .join("")}</fontconfig>`,
    );
    const confFile = path.join(confDir, "fonts.conf");
    await writeFile(confFile, conf);
    env["FONTCONFIG_FILE"] = confFile;
  }
  // `NODE_OPTIONS` del padre puede traer `--import tsx` u otras cosas: el hijo
  // arranca limpio y con lo único que necesita.
  delete env["NODE_OPTIONS"];
  const args = [
    ...(process.platform === "darwin" ? ["--experimental-ffi"] : []),
    "--no-warnings",
    brandTextChildPath(),
  ];
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new RenderError(
            "render_timeout",
            "el texto con fuente de marca tardó demasiado",
          ),
        );
      }, BRAND_CHILD_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_CHILD_OUTPUT) child.kill("SIGKILL");
        else out.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (cause) => {
        clearTimeout(timer);
        reject(
          new RenderError("render_failed", "no arrancó el proceso de texto de marca", {
            cause,
          }),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
        else
          reject(
            new RenderError("render_failed", "falló el proceso de texto de marca", {
              // stderr puede traer rutas locales: va a `cause` (log), nunca al cuerpo.
              cause: Buffer.concat(err).toString("utf8").slice(0, 2_000),
              details: { exitCode: code },
            }),
          );
      });
      child.stdin.end(JSON.stringify(input));
    });
    const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {
      registered?: number;
      verified?: boolean;
      results?: { png: string; width: number; height: number }[];
    };
    return {
      verified: parsed.verified === true,
      registered: parsed.registered ?? 0,
      results: (parsed.results ?? []).map((r) => ({
        buffer: Buffer.from(r.png, "base64"),
        width: r.width,
        height: r.height,
      })),
    };
  } finally {
    if (confDir !== null) await rm(confDir, { recursive: true, force: true });
  }
}

/**
 * Huella de las caras de marca de un request, para la clave de cache: el
 * mismo payload con otras fuentes es otro artefacto. Ordenada: el orden en
 * que llegan no cambia el dibujo.
 */
export function brandFontsFingerprint(refs: readonly BrandFontRef[]): string {
  const canonical = [...refs]
    .map((r) => `${r.id}|${String(r.weight)}|${r.style}|${r.url}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
