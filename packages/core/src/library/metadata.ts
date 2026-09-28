/**
 * La biblioteca global vista por el dominio — sprint 9 (agente N), D-19.
 *
 * El esquema zod vive en `@fastgram/contracts` (`resources/library.ts`);
 * `core` no depende de contracts, así que acá se repite **la forma** (no el
 * schema), como `quota/content-saves.ts`. Los tipos son estructurales y
 * `readonly`: un `LibraryAssetMetadata` de contracts se pasa tal cual.
 *
 * Lo que vive acá es lo que no depende de dónde corre:
 *
 * - {@link describeLibraryAsset}: la fila → un candidato textual corto y denso
 *   para un modelo de juicio (lo consume el decisor, `PU-S9-008`).
 * - {@link libraryKindsForFormat}: qué tipos sirven a cada formato de pieza.
 * - {@link measureChromaKey}: el `keyQuality` **medido** desde las muestras
 *   del borde (nunca lo propone un modelo).
 * - {@link buildLibrarySearchText}, {@link aspectRatioOf}.
 */
import type { RgbSample } from "@fastgram/ports";

import { isGreenSample } from "../media-import/green-screen.js";

export type LibraryKind =
  "green_screen_video" | "background_video" | "background_image" | "image" | "audio";

export interface LibraryLicenseLike {
  readonly type: string;
  readonly version?: string | undefined;
  readonly attribution?: string | undefined;
  readonly author?: string | undefined;
}

/** La forma de `LibraryAssetMetadata` (contracts) que el dominio lee. */
export interface LibraryMetadataLike {
  readonly schemaVersion: number;
  readonly kind: LibraryKind;
  readonly description: string;
  readonly memeType: string;
  readonly emotions: readonly string[];
  readonly useCases: readonly string[];
  readonly characters: readonly string[];
  readonly tags: readonly string[];
  readonly language: string | null;
  readonly hasSpeech: boolean;
  readonly durationSec: number | null;
  readonly aspect: {
    readonly ratio: string;
    readonly width: number | null;
    readonly height: number | null;
  };
  readonly framing: string;
  readonly chroma: {
    readonly type: string;
    readonly keyQuality: number | null;
    readonly keyColor: string | null;
  };
  readonly energy: string;
  readonly needsReview: boolean;
  readonly license: LibraryLicenseLike;
}

// --- Aspecto ---------------------------------------------------------------

/** Tolerancia al clasificar un aspecto: 1080×1920 y 1080×1918 son 9:16. */
const ASPECT_TOLERANCE = 0.03;
const NAMED_ASPECTS: readonly (readonly [string, number])[] = [
  ["9:16", 9 / 16],
  ["16:9", 16 / 9],
  ["1:1", 1],
  ["4:5", 4 / 5],
];

export function aspectRatioOf(width: number | null, height: number | null): string {
  if (width === null || height === null || width <= 0 || height <= 0) return "other";
  const r = width / height;
  for (const [name, value] of NAMED_ASPECTS) {
    if (Math.abs(r - value) / value <= ASPECT_TOLERANCE) return name;
  }
  return "other";
}

// --- Croma medido ----------------------------------------------------------

/** El azul croma: el mismo criterio que `isGreenSample`, con el azul dominante. */
const MIN_BLUE = 90;
const BLUE_DOMINANCE = 1.4;
export function isBlueSample(s: RgbSample): boolean {
  return s.b >= MIN_BLUE && s.b >= s.r * BLUE_DOMINANCE && s.b >= s.g * BLUE_DOMINANCE;
}

/**
 * Proporción mínima del borde que tiene que ser croma para llamar al clip
 * «de pantalla verde». Es la de `GREEN_SCREEN_MIN_SHARE` (0,6), calibrada en
 * `media-import/green-screen.ts`: la misma regla para el Media Bank y la
 * biblioteca.
 */
export const LIBRARY_KEY_MIN_SHARE = 0.6;

export interface ChromaMeasurement {
  readonly type: "green" | "blue" | "none";
  /**
   * La proporción de muestras del borde que son del color de croma, 0–1,
   * redondeada a centésimas. Es una medida de **cuánto** fondo limpio hay
   * alrededor: 1,00 es un fondo parejo en todo el marco; 0,6–0,8 suele ser
   * alguien que toca el borde o un fondo con sombras. `null` si no hubo
   * muestras.
   */
  readonly keyQuality: number | null;
  readonly keyColor: string | null;
}

const hex = (n: number): string =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();

function average(samples: readonly RgbSample[]): string {
  const n = samples.length;
  const sum = samples.reduce((a, s) => ({ r: a.r + s.r, g: a.g + s.g, b: a.b + s.b }), {
    r: 0,
    g: 0,
    b: 0,
  });
  return `#${hex(sum.r / n)}${hex(sum.g / n)}${hex(sum.b / n)}`;
}

export function measureChromaKey(samples: readonly RgbSample[]): ChromaMeasurement {
  if (samples.length === 0) return { type: "none", keyQuality: null, keyColor: null };
  const greens = samples.filter(isGreenSample);
  const blues = samples.filter(isBlueSample);
  const winner = greens.length >= blues.length ? greens : blues;
  const share = Math.round((winner.length / samples.length) * 100) / 100;
  const type = winner === greens ? "green" : "blue";
  if (winner.length === 0) return { type: "none", keyQuality: 0, keyColor: null };
  return {
    type: share >= LIBRARY_KEY_MIN_SHARE ? type : "none",
    keyQuality: share,
    keyColor: average(winner),
  };
}

// --- Formatos → tipos ------------------------------------------------------

export type LibraryPieceFormat = "video" | "carousel" | "static";

/**
 * Qué tipos de asset sirven a cada formato. Un video usa clips (verdes o de
 * fondo), fondos fijos y audio; un carrusel o una pieza fija, sólo imágenes.
 */
const KINDS_BY_FORMAT: Readonly<Record<LibraryPieceFormat, readonly LibraryKind[]>> = {
  video: ["green_screen_video", "background_video", "background_image", "audio"],
  carousel: ["background_image", "image"],
  static: ["background_image", "image"],
};

export function libraryKindsForFormat(
  format: LibraryPieceFormat,
): readonly LibraryKind[] {
  return KINDS_BY_FORMAT[format];
}

// --- Texto para buscar -----------------------------------------------------

export function buildLibrarySearchText(
  title: string,
  meta: LibraryMetadataLike | null,
): string {
  if (meta === null) return title;
  return [
    title,
    meta.description,
    meta.memeType.replace(/_/g, " "),
    ...meta.emotions,
    ...meta.useCases,
    ...meta.characters,
    ...meta.tags,
    meta.kind.replace(/_/g, " "),
  ]
    .filter((s) => s.trim().length > 0)
    .join(" \n")
    .slice(0, 4000);
}

// --- El candidato para un modelo de juicio ---------------------------------

/**
 * Tope de caracteres de {@link describeLibraryAsset}: ~300 tokens en inglés
 * (≈4 caracteres por token) con margen. Laya recorta descripciones cuando hay
 * más de ~20 opciones por `choice` (D-18): cuanto más corto, más candidatos
 * entran sin recorte.
 */
export const LIBRARY_DESCRIBE_MAX_CHARS = 1_000;

const clip = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;

const list = (xs: readonly string[], max: number): string =>
  xs
    .slice(0, max)
    .map((x) => x.replace(/_/g, " "))
    .join(", ");

/**
 * Una línea por atributo, en inglés (lo lee un modelo), sin nada que no
 * sirva para decidir: ni URLs, ni ids, ni la atribución (la licencia se
 * nombra por tipo). Lo que vino de terceros (`description`, `useCases`,
 * `tags`) se recorta; quien arma el prompt igual tiene que tratarlo como dato.
 */
export function describeLibraryAsset(meta: LibraryMetadataLike, title?: string): string {
  const lines: string[] = [];
  const kind = meta.kind.replace(/_/g, " ");
  lines.push(title === undefined ? kind : `${kind}: ${clip(title, 80)}`);
  if (meta.description.trim().length > 0) lines.push(clip(meta.description.trim(), 300));
  lines.push(
    `meme type: ${meta.memeType.replace(/_/g, " ")}; energy: ${meta.energy}` +
      (meta.emotions.length > 0 ? `; emotions: ${list(meta.emotions, 4)}` : ""),
  );
  if (meta.useCases.length > 0)
    lines.push(`use when: ${clip(list(meta.useCases, 4), 220)}`);
  if (meta.characters.length > 0)
    lines.push(`characters: ${clip(list(meta.characters, 3), 100)}`);
  const shape: string[] = [];
  if (meta.durationSec !== null) shape.push(`${meta.durationSec.toFixed(1)}s`);
  shape.push(meta.aspect.ratio === "other" ? "non-standard aspect" : meta.aspect.ratio);
  if (meta.framing !== "none") shape.push(meta.framing.replace(/_/g, " "));
  if (meta.chroma.type !== "none") {
    const q = meta.chroma.keyQuality;
    shape.push(
      `${meta.chroma.type} key${q === null ? "" : ` (clean border ${Math.round(q * 100)}%)`}`,
    );
  }
  shape.push(
    meta.hasSpeech
      ? `speech${meta.language === null ? "" : ` in ${meta.language}`}`
      : "no speech",
  );
  lines.push(shape.join(", "));
  if (meta.tags.length > 0) lines.push(`tags: ${clip(list(meta.tags, 10), 160)}`);
  const license =
    meta.license.type === "cc-by" ? "CC BY (credit shown)" : meta.license.type;
  lines.push(`license: ${license}${meta.needsReview ? "; metadata not reviewed" : ""}`);
  return clip(lines.join("\n"), LIBRARY_DESCRIBE_MAX_CHARS);
}
