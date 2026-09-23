/**
 * Carga y verificación de fuentes para el overlay de texto.
 *
 * ── Lo que decide si una familia carga (medido el 2026-09-23) ────────────────
 * El texto lo dibuja Pango dentro de sharp, y una familia resuelve **por
 * nombre** o no resuelve. `fontfile` no participa: este archivo ya no lo pasa.
 * Hacer que el nombre resuelva desde `RENDER_FONT_DIR`, sin instalar nada, es
 * trabajo de `fontActivation.ts` (CoreText por proceso en macOS, `fonts.conf`
 * propio en Linux), que corre al arrancar.
 *
 * Historia, porque costó dos conclusiones falsas:
 *  1. «`fontfile` es lo que funciona, verificado con Georgia» — Georgia es del
 *     sistema: resolvía por nombre (trampa 40 del HANDOFF).
 *  2. «`FONTCONFIG_FILE` no cambia nada» — cierto en macOS, pero no porque el
 *     mecanismo esté mal: el Pango de `@img/sharp-libvips-darwin-*` sólo trae
 *     el backend CoreText (`PANGOCAIRO_BACKEND=fc` → `Available backends are:
 *     coretext`). Fontconfig lee el directorio y nadie le pregunta.
 *
 * ── Y un bug que ninguna de las dos veía: el peso numérico ──────────────────
 * La descripción era `"Montserrat 700 42px"`. **Pango no entiende pesos
 * numéricos en la descripción**: toma `"Montserrat 700"` como el nombre de la
 * familia, no la encuentra y cae a la de reserva. Medido con Georgia (del
 * sistema, así que el nombre resuelve):
 *
 *     "Georgia"        545x40
 *     "Georgia 700"    517x39   ← el centinela
 *     "Georgia Bold"   633x40
 *
 * La sonda de verificación pedía `"<familia> 40px"`, **sin** peso, así que
 * habría dado «verificada» y el render —que sí llevaba el peso— habría salido
 * con la reserva. Ahora la descripción usa la palabra de peso de Pango y una
 * coma que cierra la lista de familias (`"Montserrat, Semi-Bold 42px"`): sin la
 * coma, `"Poppins Light"` se parte en familia `Poppins` + peso `Light`. Y la
 * sonda verifica **exactamente** la descripción que se va a dibujar.
 *
 * ── La verificación ──────────────────────────────────────────────────────────
 * Firma = sha256 de los píxeles de la sonda. Una familia está verificada si su
 * firma difiere de la de un centinela inexistente **con la misma palabra de
 * peso** (el centinela en Bold es otra imagen: 551x39 contra 517x39), y, para
 * pesos distintos de 400, si además difiere de la firma del 400 de la misma
 * familia: eso atrapa a un peso que no cargó y cayó al regular de la familia.
 * No atrapa que caiga a *otro* peso no regular; para eso está `fontNames.ts`,
 * que pide la familia que el archivo declara.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { RenderError } from "../errors.js";
import {
  FONT_FAMILIES,
  FONT_REGISTRY,
  fontFileName,
  resolvePangoFamily,
  type FontFamily,
  type FontManifest,
} from "../domain/fonts.js";
import { noteTextEngineUse } from "./fontActivation.js";
import { readFontNames } from "./fontNames.js";

/** Cadena con ascendentes, descendentes, dígitos y pares con kerning. */
export const FONT_PROBE_STRING = "MWiljq1080 Hamburgefonstiv";
const SENTINEL_FAMILY = "__fastgram_no_such_family__";
const PROBE_SIZE_PX = 40;
const REGULAR_WEIGHT = 400;

/**
 * Palabras de peso que entiende la descripción de Pango. Un número no sirve:
 * ver la cabecera. 400 no lleva palabra (es el default de la descripción).
 */
export const PANGO_WEIGHT_WORDS: Readonly<Record<number, string>> = {
  100: "Thin",
  200: "Ultra-Light",
  300: "Light",
  400: "",
  500: "Medium",
  600: "Semi-Bold",
  700: "Bold",
  800: "Ultra-Bold",
  900: "Heavy",
};

/**
 * Descripción Pango: `"<familia>, [<peso>] <px>px"`. La coma cierra la lista
 * de familias: sin ella, una familia cuyo nombre termina en una palabra de
 * estilo (`"Poppins Light"`) se parte en familia + peso.
 */
export function pangoDescription(family: string, weight: number, sizePx: number): string {
  const word = PANGO_WEIGHT_WORDS[weight] ?? "";
  return word === "" ? `${family}, ${sizePx}px` : `${family}, ${word} ${sizePx}px`;
}

export interface ResolvedFont {
  readonly family: FontFamily;
  readonly weight: number;
  /** Descripción Pango, p. ej. `"Montserrat, Semi-Bold 42px"`. */
  readonly pangoDescription: string;
  /**
   * El archivo que respalda este peso, o `null` si no está. Informativo: el
   * motor resuelve por nombre (ver `fontActivation.ts`), no por archivo.
   */
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

/** sha256 de los píxeles de la sonda con una descripción dada. */
async function probeSignature(description: string): Promise<string> {
  noteTextEngineUse();
  const { data, info } = await sharp({
    text: { text: FONT_PROBE_STRING, font: description, rgba: true, dpi: 72 },
  })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return createHash("sha256")
    .update(`${info.width}x${info.height}:`)
    .update(data)
    .digest("hex");
}

const signatureCache = new Map<string, Promise<string>>();

function cachedSignature(description: string): Promise<string> {
  let pending = signatureCache.get(description);
  if (pending === undefined) {
    pending = probeSignature(description);
    signatureCache.set(description, pending);
  }
  return pending;
}

export function resetFontProbeCache(): void {
  signatureCache.clear();
  manifestCache.clear();
  namesCache.clear();
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

const namesCache = new Map<string, string | null>();

/** La familia que el archivo declara (`fontNames.ts`), o `null` si no se lee. */
async function familyDeclaredBy(fontFile: string): Promise<string | null> {
  const cached = namesCache.get(fontFile);
  if (cached !== undefined) return cached;
  let family: string | null = null;
  try {
    family = readFontNames(await readFile(fontFile))?.family ?? null;
  } catch {
    family = null;
  }
  namesCache.set(fontFile, family);
  return family;
}

interface Located {
  /** Nombre que se le pide a Pango, o `null` si no hay ninguno conocible. */
  readonly pangoFamily: string | null;
  readonly fontFile: string | null;
}

/**
 * Qué nombre pedir y qué archivo lo respalda. Precedencia del nombre:
 * `fonts.json` (el operador lo dijo) → el que declara el archivo → el del
 * registro.
 */
async function locate(
  family: FontFamily,
  weight: number,
  options: FontLoaderOptions,
): Promise<Located> {
  const manifest = await loadManifest(options.fontDir);
  const override = manifest?.families?.[family]?.pangoFamily;
  const candidate =
    options.fontDir === null
      ? null
      : path.join(options.fontDir, fontFileName(family, weight));
  const fontFile = candidate !== null && existsSync(candidate) ? candidate : null;
  if (override !== undefined) return { pangoFamily: override, fontFile };
  const declared = fontFile === null ? null : await familyDeclaredBy(fontFile);
  return { pangoFamily: declared ?? resolvePangoFamily(family, manifest), fontFile };
}

/**
 * Resuelve una familia+peso a una descripción Pango, y verifica que la fuente
 * realmente haya cargado.
 */
export async function resolveFont(
  family: FontFamily,
  weight: number,
  sizePx: number,
  options: FontLoaderOptions,
): Promise<ResolvedFont> {
  const { pangoFamily, fontFile } = await locate(family, weight, options);

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
      pangoDescription: pangoDescription(family, weight, sizePx),
      fontFile: null,
      verified: false,
    };
  }

  const description = pangoDescription(pangoFamily, weight, sizePx);

  if (fontFile === null) {
    if (options.strict) {
      throw new RenderError("font_unavailable", "falta el archivo de la fuente pedida", {
        details: {
          family,
          weight,
          expectedFile:
            options.fontDir === null
              ? fontFileName(family, weight)
              : path.join(options.fontDir, fontFileName(family, weight)),
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

  const regular =
    weight === REGULAR_WEIGHT ? null : await locate(family, REGULAR_WEIGHT, options);
  const verified = await verifyFontLoads(
    pangoFamily,
    weight,
    regular === null || regular.fontFile === null ? null : regular.pangoFamily,
  );
  if (!verified && options.strict) {
    throw new RenderError(
      "font_unavailable",
      "el archivo de la fuente existe pero el motor de texto no la resuelve por nombre",
      {
        details: {
          family,
          weight,
          fontFile,
          pangoFamily,
          hint: "¿se activó RENDER_FONT_DIR al arrancar? ver GET /capabilities → fonts.activation",
        },
      },
    );
  }

  return { family, weight, pangoDescription: description, fontFile, verified };
}

/**
 * La verificación que evita el fallback silencioso. Ver la cabecera: la firma
 * tiene que diferir del centinela **con la misma palabra de peso** y, fuera
 * del 400, de la del regular de la familia (`regularFamily`, si se conoce).
 */
export async function verifyFontLoads(
  pangoFamily: string,
  weight: number,
  regularFamily: string | null = null,
): Promise<boolean> {
  try {
    const own = await cachedSignature(
      pangoDescription(pangoFamily, weight, PROBE_SIZE_PX),
    );
    const sentinel = await cachedSignature(
      pangoDescription(SENTINEL_FAMILY, weight, PROBE_SIZE_PX),
    );
    if (own === sentinel) return false;
    if (weight === REGULAR_WEIGHT || regularFamily === null) return true;
    const regular = await cachedSignature(
      pangoDescription(regularFamily, REGULAR_WEIGHT, PROBE_SIZE_PX),
    );
    return own !== regular;
  } catch {
    return false;
  }
}

export interface FontStatus {
  readonly family: FontFamily;
  readonly weight: number;
  readonly file: boolean;
  readonly verified: boolean;
  readonly pangoDescription: string;
}

/**
 * El estado real de las 12 familias × pesos: qué archivo está y qué resuelve.
 * Lo que `available` tiene que significar — no «el archivo existe».
 */
export async function fontAvailability(
  options: FontLoaderOptions,
): Promise<readonly FontStatus[]> {
  const lenient: FontLoaderOptions = { ...options, strict: false };
  const out: FontStatus[] = [];
  for (const family of FONT_FAMILIES) {
    for (const weight of FONT_REGISTRY[family].weights) {
      const font = await resolveFont(family, weight, PROBE_SIZE_PX, lenient);
      out.push({
        family,
        weight,
        file: font.fontFile !== null,
        verified: font.verified,
        pangoDescription: font.pangoDescription,
      });
    }
  }
  return out;
}
