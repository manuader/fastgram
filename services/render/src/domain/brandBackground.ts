/**
 * `PU-MEDIA-002` — fondos de marca generados acá, sin proveedor externo.
 *
 * Una marca recién creada no tiene media, y sin media Blitz no planifica nada
 * (`plan-suggestion.ts`: «No content type in the mix has media available»). El
 * plan de uso personal pide que Blitz funcione desde cero, sin keys: este
 * módulo decide **qué** se dibuja —degradé, manchas suaves, grano— a partir de
 * una paleta y una semilla. Cómo se dibuja (sharp para la imagen, FFmpeg para
 * el loop) está en `render/brandBackground.ts`.
 *
 * ## Determinismo: la semilla es la única fuente de azar
 *
 * `Math.random` no aparece. Todo sale de {@link seededRandom}, un PRNG
 * sembrado con el sha256 de la semilla, así que el mismo `(paleta, semilla)`
 * da el mismo {@link BackgroundSpec} en cualquier máquina. Los **bytes** de
 * salida dependen además de libvips/FFmpeg (ver el golden de frames), pero el
 * plan no: eso es lo que el test de plan compara entre máquinas.
 *
 * ## Coordenadas relativas
 *
 * El spec guarda posiciones y tamaños como fracción del canvas. Así el mismo
 * spec se dibuja a 1080×1350 y a 1080×1920 sin que la composición se deforme
 * más de lo que cambia el aspecto, y el loop de video usa exactamente las
 * mismas manchas que la imagen fija.
 *
 * ## El loop cierra por construcción
 *
 * Cada mancha orbita con `sin(2π·h·t/D + φ)`, con `h` entero. En `t = D` todas
 * vuelven a su posición de `t = 0`: el último cuadro empalma con el primero sin
 * fundido. {@link blobOffsetAt} es la misma fórmula que el filtergraph evalúa,
 * y el test la comprueba en `t = 0` y `t = D`.
 */
import { createHash } from "node:crypto";

/** `#RRGGBB`. Sin alfa: la transparencia la decide el generador. */
export const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export const MIN_PALETTE = 2;
export const MAX_PALETTE = 5;

/**
 * Versión del generador. **Subirla con cualquier cambio que altere los bytes
 * de salida**: entra en la clave de cache, y sin subirla un deploy nuevo
 * seguiría sirviendo los fondos del algoritmo anterior.
 */
export const BRAND_BACKGROUND_GENERATOR_VERSION = "1";

export type BackgroundStyle = "linear" | "radial" | "mesh";

export interface GradientStop {
  readonly color: string;
  /** 0–1. */
  readonly offset: number;
}

export interface BlobSpec {
  readonly color: string;
  /** Centro, fracción del ancho / alto. Puede caer apenas fuera del canvas. */
  readonly cx: number;
  readonly cy: number;
  /** Radio, fracción del **ancho** (el lado común a los dos formatos). */
  readonly rx: number;
  readonly ry: number;
  /** 0.35–0.85. */
  readonly opacity: number;
  /** Órbita del loop, fracción del ancho / alto. */
  readonly orbitX: number;
  readonly orbitY: number;
  /** Vueltas por loop, enteras: es lo que hace que el loop cierre. */
  readonly harmonicX: number;
  readonly harmonicY: number;
  /** Radianes. */
  readonly phaseX: number;
  readonly phaseY: number;
}

export interface BackgroundSpec {
  readonly style: BackgroundStyle;
  /** Grados, 0 = de izquierda a derecha. Sólo `linear` y `mesh`. */
  readonly angleDeg: number;
  /** Centro del degradé radial, fracción del canvas. */
  readonly focusX: number;
  readonly focusY: number;
  readonly stops: readonly GradientStop[];
  readonly blobs: readonly BlobSpec[];
  /** Desenfoque de las manchas, fracción del ancho. */
  readonly blur: number;
  /** Oscurecimiento de bordes, 0–0.35. Ayuda a que el texto de arriba se lea. */
  readonly vignette: number;
  /** Amplitud del grano en niveles de 0–255, 0 = sin grano. */
  readonly grain: number;
}

/**
 * PRNG sembrado. sfc32 sobre los primeros 16 bytes del sha256 de la semilla:
 * rápido, con período largo y, sobre todo, **sin estado global**. Dos llamadas
 * con la misma semilla dan la misma secuencia; no hay otra forma de azar en el
 * generador.
 */
export function seededRandom(seed: string): () => number {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  let a = digest.readUInt32LE(0);
  let b = digest.readUInt32LE(4);
  let c = digest.readUInt32LE(8);
  let d = digest.readUInt32LE(12);
  const next = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  // Se descartan las primeras salidas: con semillas parecidas, sfc32 tarda
  // unas vueltas en decorrelacionarse.
  for (let i = 0; i < 12; i += 1) next();
  return next;
}

/** Normaliza la paleta: mayúsculas y sin duplicados, en el orden recibido. */
export function normalizePalette(palette: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const color of palette) {
    const upper = color.toUpperCase();
    if (!out.includes(upper)) out.push(upper);
  }
  return out;
}

/** Luminancia relativa aproximada (sRGB sin linealizar): alcanza para ordenar. */
export function luma(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const between = (rand: () => number, min: number, max: number): number =>
  min + (max - min) * rand();

const intBetween = (rand: () => number, min: number, maxInclusive: number): number =>
  min + Math.floor(rand() * (maxInclusive - min + 1));

function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error("pick sobre una lista vacía");
  return item;
}

/** Redondeo a 4 decimales: el spec viaja al golden y a un filtergraph. */
const r4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * El spec de un fondo. Puro y determinista: `(paleta, semilla)` → spec.
 *
 * La paleta tiene que venir ya validada (2–5 colores `#RRGGBB`); con menos de
 * dos colores distintos, lanza.
 */
export function planBackground(palette: readonly string[], seed: string): BackgroundSpec {
  const colors = normalizePalette(palette);
  if (colors.length < MIN_PALETTE) {
    throw new Error("la paleta necesita al menos dos colores distintos");
  }
  const rand = seededRandom(`${BRAND_BACKGROUND_GENERATOR_VERSION}|${seed}`);

  const style = pick<BackgroundStyle>(rand, ["linear", "radial", "mesh"]);

  // El degradé de base va de oscuro a claro entre dos o tres colores de la
  // paleta: ordenarlos por luminancia evita el degradé «sucio» que sale de
  // mezclar un claro con un oscuro en el medio.
  const byLuma = [...colors].sort((x, y) => luma(x) - luma(y));
  const stopCount = Math.min(byLuma.length, intBetween(rand, 2, 3));
  const start = intBetween(rand, 0, byLuma.length - stopCount);
  const chosen = byLuma.slice(start, start + stopCount);
  if (rand() < 0.5) chosen.reverse();
  const stops = chosen.map((color, i) => ({
    color,
    offset: r4(chosen.length === 1 ? 0 : i / (chosen.length - 1)),
  }));

  // Manchas: más y más chicas en `mesh`, pocas y grandes en los otros dos.
  const blobCount = style === "mesh" ? intBetween(rand, 4, 6) : intBetween(rand, 2, 4);
  const blobs: BlobSpec[] = [];
  for (let i = 0; i < blobCount; i += 1) {
    const size = style === "mesh" ? between(rand, 0.28, 0.5) : between(rand, 0.35, 0.65);
    blobs.push({
      color: pick(rand, colors),
      cx: r4(between(rand, -0.05, 1.05)),
      cy: r4(between(rand, -0.05, 1.05)),
      rx: r4(size),
      ry: r4(size * between(rand, 0.7, 1.3)),
      opacity: r4(between(rand, 0.35, 0.85)),
      orbitX: r4(between(rand, 0.04, 0.12)),
      orbitY: r4(between(rand, 0.03, 0.09)),
      harmonicX: intBetween(rand, 1, 2),
      harmonicY: intBetween(rand, 1, 2),
      phaseX: r4(between(rand, 0, Math.PI * 2)),
      phaseY: r4(between(rand, 0, Math.PI * 2)),
    });
  }

  return {
    style,
    angleDeg: r4(between(rand, 0, 360)),
    focusX: r4(between(rand, 0.2, 0.8)),
    focusY: r4(between(rand, 0.15, 0.6)),
    stops,
    blobs,
    blur: r4(between(rand, 0.06, 0.11)),
    vignette: r4(between(rand, 0.12, 0.32)),
    grain: r4(between(rand, 4, 9)),
  };
}

/**
 * Desplazamiento de una mancha en el instante `t` de un loop de `period`
 * segundos, en fracción del canvas. Es la misma expresión que evalúa el
 * `overlay` de FFmpeg (ver `render/brandBackground.ts`): periódica en
 * `period` porque los armónicos son enteros.
 */
export function blobOffsetAt(
  blob: BlobSpec,
  t: number,
  period: number,
): { readonly dx: number; readonly dy: number } {
  const w = (2 * Math.PI * t) / period;
  return {
    dx: blob.orbitX * Math.sin(blob.harmonicX * w + blob.phaseX),
    dy: blob.orbitY * Math.cos(blob.harmonicY * w + blob.phaseY),
  };
}
