/**
 * Carga y verificación de fuentes para el overlay de texto.
 *
 * ── Por qué esto existe ──────────────────────────────────────────────────────
 * `sharp` 0.33 trae su propio libvips con fontconfig SIN configuración por
 * defecto (imprime `Fontconfig error: Cannot load default config file`). En esa
 * situación toda familia pedida por nombre cae en el MISMO tipo de reserva, y
 * lo hace en silencio. Medido en esta máquina con la cadena sonda
 * "MWiljq1080 Hamburgefonstiv" a 40px:
 *
 *     __NoSuchFamily__ → 517x39
 *     Helvetica        → 517x39
 *     Courier          → 517x39
 *     Montserrat       → 517x39
 *
 * Idénticas. Es decir: pedir "Montserrat" y que ande no significa nada.
 *
 * Verificado de nuevo, por separado, el 2026-09-21, con un matiz que lo
 * empeora: `Comic Sans MS` SÍ resuelve distinto (555x44). O sea que la
 * resolución por nombre no está rota del todo, está rota **a medias**. Eso es
 * peor que si fallara siempre: alguien que spot-chequea con la fuente
 * equivocada ve que "anda" y cierra la investigación. `Helvetica`, que existe
 * en cualquier Mac, cae en el fallback igual que una familia inventada.
 *
 * ── CORRECCIÓN del 2026-09-22: `fontfile` NO es lo que funciona ──────────────
 *
 * Este comentario decía que «lo que SÍ funciona es pasar el archivo con
 * `fontfile` (verificado con Georgia.ttf: 545x40 contra 517x39 del fallback)».
 * **Ese experimento estaba confundido**, y la conclusión era falsa.
 *
 * Georgia es una fuente del sistema en macOS, así que resuelve **por nombre**.
 * Lo que aquella medición comparó fue «una familia que existe» contra «una que
 * no», no «con archivo» contra «sin archivo». Medido de nuevo, aislando:
 *
 *     centinela __NoSuchFamily__            517x39
 *     Georgia SIN fontfile                  545x40   ← resuelve sola
 *     Georgia CON fontfile                  545x40   ← igual
 *     Anton CON su propio fontfile          517x39   ← NO carga
 *     Anton CON el fontfile de Georgia      517x39   ← el archivo se ignora
 *
 * La última línea es la que cierra el caso: pedir "Anton" pasándole el archivo
 * de Georgia da exactamente el centinela. **`fontfile` no se usa.** Lo único
 * que decide es si el nombre de familia resuelve en el sistema.
 *
 * Consecuencia práctica, y es la que importa: **bajar los 42 archivos a un
 * directorio no alcanza**. En esta máquina, con las 32 fuentes OFL presentes y
 * válidas —nombres internos correctos, verificados leyendo la tabla `name`—,
 * las 10 familias siguen sin cargar. `FONTCONFIG_FILE` apuntando al directorio
 * tampoco cambia nada. Lo que hace falta es que las fuentes estén donde el
 * sistema las encuentre por nombre, y eso es trabajo del despliegue —del
 * Dockerfile que `P0-REPO-004` bloquea—, no de este archivo.
 *
 * `services/render/scripts/fetch-fonts.mts` consigue los archivos; instalarlos
 * es otra cosa y todavía no está resuelta.
 *
 * ── Lo que sí sigue en pie ───────────────────────────────────────────────────
 *
 * La verificación contra la sonda centinela. Es lo que convierte «no cargó» en
 * un `font_unavailable` ruidoso en vez de una pieza renderizada con la
 * tipografía equivocada — y es lo que delató que los archivos bajados no
 * cargaban, cuando la conclusión fácil habría sido «ya están, listo».
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { RenderError } from "../errors.js";
import {
  fontFileName,
  resolvePangoFamily,
  type FontFamily,
  type FontManifest,
} from "../domain/fonts.js";

/** Cadena con ascendentes, descendentes, dígitos y pares con kerning. */
export const FONT_PROBE_STRING = "MWiljq1080 Hamburgefonstiv";
const SENTINEL_FAMILY = "__fastgram_no_such_family__";
const PROBE_SIZE_PX = 40;

export interface ResolvedFont {
  readonly family: FontFamily;
  readonly weight: number;
  /** Descripción Pango, p. ej. `"Montserrat 600 42px"`. */
  readonly pangoDescription: string;
  /** Ruta absoluta al archivo, o `null` si se resolvió por nombre. */
  readonly fontFile: string | null;
  /** `false` = la fuente pedida NO cargó y se está usando la de reserva. */
  readonly verified: boolean;
}

export interface FontLoaderOptions {
  /** Directorio con los `.ttf`. Sin esto no hay ninguna de las 12 familias. */
  readonly fontDir: string | null;
  /**
   * `true` (default): una familia que no carga es `font_unavailable`.
   * `false`: se degrada a la fuente de reserva y se marca `verified: false`.
   * Nunca se degrada en silencio.
   */
  readonly strict: boolean;
}

export function fontLoaderOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): FontLoaderOptions {
  const dir = env["RENDER_FONT_DIR"];
  return {
    fontDir: dir === undefined || dir === "" ? null : path.resolve(dir),
    strict: env["RENDER_FONT_STRICT"] !== "false",
  };
}

/** Ancho×alto de la sonda con una descripción Pango dada. */
async function probeMetrics(
  description: string,
  fontFile: string | null,
): Promise<string> {
  const text: {
    text: string;
    font: string;
    rgba: boolean;
    dpi: number;
    fontfile?: string;
  } = { text: FONT_PROBE_STRING, font: description, rgba: true, dpi: 72 };
  if (fontFile !== null) text.fontfile = fontFile;
  const metadata = await sharp({ text }).metadata();
  return `${metadata.width ?? 0}x${metadata.height ?? 0}`;
}

let sentinelMetrics: string | null = null;

async function getSentinelMetrics(): Promise<string> {
  sentinelMetrics ??= await probeMetrics(`${SENTINEL_FAMILY} ${PROBE_SIZE_PX}px`, null);
  return sentinelMetrics;
}

export function resetFontProbeCache(): void {
  sentinelMetrics = null;
  manifestCache.clear();
  verificationCache.clear();
}

const manifestCache = new Map<string, FontManifest | null>();

async function loadManifest(fontDir: string | null): Promise<FontManifest | null> {
  if (fontDir === null) return null;
  const cached = manifestCache.get(fontDir);
  if (cached !== undefined) return cached;
  const manifestPath = path.join(fontDir, "fonts.json");
  let manifest: FontManifest | null = null;
  if (existsSync(manifestPath)) {
    try {
      // Archivo de configuración del operador: se parsea, no se ejecuta.
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FontManifest;
    } catch (cause) {
      throw new RenderError(
        "font_unavailable",
        "fonts.json del directorio de fuentes es inválido",
        {
          details: { manifestPath },
          cause,
        },
      );
    }
  }
  manifestCache.set(fontDir, manifest);
  return manifest;
}

const verificationCache = new Map<string, boolean>();

/**
 * Resuelve una familia+peso a algo que sharp pueda usar, y verifica que la
 * fuente realmente haya cargado.
 */
export async function resolveFont(
  family: FontFamily,
  weight: number,
  sizePx: number,
  options: FontLoaderOptions,
): Promise<ResolvedFont> {
  const manifest = await loadManifest(options.fontDir);
  const pangoFamily = resolvePangoFamily(family, manifest);

  if (pangoFamily === null) {
    // Familia de marca sin archivo conocido (`tiktok`, `snapchat`).
    if (options.strict) {
      throw new RenderError(
        "font_unavailable",
        "la familia tipográfica no tiene un nombre de fuente resuelto",
        { details: { family, hint: "definila en fonts.json del RENDER_FONT_DIR" } },
      );
    }
    return {
      family,
      weight,
      pangoDescription: `${family} ${weight} ${sizePx}px`,
      fontFile: null,
      verified: false,
    };
  }

  const fontFile =
    options.fontDir === null
      ? null
      : path.join(options.fontDir, fontFileName(family, weight));
  const available = fontFile !== null && existsSync(fontFile);
  const description = `${pangoFamily} ${weight} ${sizePx}px`;

  if (!available) {
    if (options.strict) {
      throw new RenderError("font_unavailable", "falta el archivo de la fuente pedida", {
        details: {
          family,
          weight,
          expectedFile: fontFile ?? fontFileName(family, weight),
          hint: "configurá RENDER_FONT_DIR con los .ttf de FR-051",
        },
      });
    }
    return {
      family,
      weight,
      pangoDescription: description,
      fontFile: null,
      verified: false,
    };
  }

  const verified = await verifyFontLoads(pangoFamily, fontFile);
  if (!verified && options.strict) {
    throw new RenderError(
      "font_unavailable",
      "el archivo de la fuente existe pero no lo tomó el motor de texto",
      { details: { family, weight, fontFile } },
    );
  }

  return { family, weight, pangoDescription: description, fontFile, verified };
}

/**
 * La verificación que evita el fallback silencioso: si las métricas de la sonda
 * con esta fuente son idénticas a las del centinela inexistente, la fuente no
 * cargó.
 */
export async function verifyFontLoads(
  pangoFamily: string,
  fontFile: string,
): Promise<boolean> {
  const cacheKey = `${pangoFamily}|${fontFile}`;
  const cached = verificationCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const sentinel = await getSentinelMetrics();
  let metrics: string;
  try {
    metrics = await probeMetrics(`${pangoFamily} ${PROBE_SIZE_PX}px`, fontFile);
  } catch {
    verificationCache.set(cacheKey, false);
    return false;
  }
  const ok = metrics !== sentinel;
  verificationCache.set(cacheKey, ok);
  return ok;
}
