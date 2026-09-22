/**
 * `P2-RENDER-016` — La versión del motor, apta para ser **clave de cache**.
 *
 * ── Lo que había ─────────────────────────────────────────────────────────────
 * `GET /capabilities` publicaba `ffmpeg.version`, y el adaptador la usaba como
 * etiqueta de motor para su `fingerprint`. Dos problemas medidos:
 *
 *  1. Era la línea entera del banner:
 *
 *       "ffmpeg version 9.0.1 Copyright (c) 2000-2026 the FFmpeg developers"
 *
 *     con espacios y un aviso de copyright metidos adentro de una clave de
 *     cache.
 *
 *  2. No cubría lo que de verdad decide el frame. Un cambio en cómo este
 *     servicio arma el filtergraph o compone el overlay no movía esa etiqueta,
 *     así que el adaptador seguía sirviendo frames viejos con tipografía o
 *     layout nuevos.
 *
 * ── Qué entra, y por qué cada cosa ───────────────────────────────────────────
 *
 *  · `code` — hash del árbol de código de este servicio (`domain/codeVersion`).
 *    Es la parte que no se puede olvidar de actualizar: el filtergraph, el
 *    layout del overlay y la geometría viven ahí.
 *  · `ffmpeg` — el token de versión, no el banner. Decide los bytes del video:
 *    un upgrade de libx264 cambia el encode aunque el argv sea idéntico.
 *  · `sharp` / `vips` / `pango` / `freetype` — deciden los píxeles del texto.
 *    No es una sospecha: el golden de frame de `P2-RENDER-011` lleva
 *    exactamente estas cuatro versiones en el **nombre del archivo**, porque un
 *    cambio en cualquiera de ellas invalida el golden. Si invalidan el golden,
 *    invalidan la cache.
 *  · `fonts` — `FONT_REGISTRY_VERSION`: cambiar una familia cambia el overlay
 *    sin tocar una línea de código de composición.
 *  · `textStrategy` — hoy siempre `sharp-overlay`. Entra porque el día que haya
 *    una segunda estrategia, las dos producen frames distintos para el mismo
 *    payload.
 *
 * ── Lo que NO entra ──────────────────────────────────────────────────────────
 * El **contenido de los archivos de fuente en disco** (`RENDER_FONT_DIR`). Si
 * alguien reemplaza `Inter-Bold.ttf` por otra versión del mismo archivo, el
 * frame cambia y esta etiqueta no se entera. No entra porque el directorio de
 * fuentes puede tener decenas de MB y hashearlo al arrancar pagaría un costo
 * fijo por un caso que se resuelve subiendo `FONT_REGISTRY_VERSION` cuando se
 * tocan las fuentes. Queda dicho: es el hueco conocido de esta etiqueta.
 *
 * ── La forma ─────────────────────────────────────────────────────────────────
 * `version` es un sha256 hex de los componentes: sin espacios, sin copyright,
 * de largo fijo, y se puede concatenar a cualquier clave. `components` viaja al
 * lado para que un operador pueda contestar «¿por qué cambió?» sin tener que
 * adivinar — que es lo único que se pierde al hashear.
 */
import sharp from "sharp";
import { createHash } from "node:crypto";
import { codeVersion } from "../domain/codeVersion.js";
import { FONT_REGISTRY_VERSION } from "../domain/fonts.js";
import {
  probeCapabilities,
  TEXT_STRATEGY,
  type FfmpegCapabilities,
} from "../ffmpeg/capabilities.js";

export interface EngineVersionComponents {
  /** sha256 del árbol de código de este servicio. */
  readonly code: string;
  /** Token de versión de ffmpeg (`9.0.1`), no la línea del banner. */
  readonly ffmpeg: string;
  readonly sharp: string;
  readonly vips: string;
  readonly pango: string;
  readonly freetype: string;
  readonly fonts: string;
  readonly textStrategy: string;
}

export interface EngineVersion {
  /** sha256 hex. **Esto** es lo que se usa como clave de cache. */
  readonly version: string;
  readonly components: EngineVersionComponents;
}

/** Cuando ffmpeg no está, para que la etiqueta no quede vacía y mienta. */
export const FFMPEG_UNAVAILABLE = "unavailable";

/**
 * `"ffmpeg version 9.0.1 Copyright (c) …"` → `"9.0.1"`.
 *
 * Si el banner no tiene la forma esperada —builds de git dicen
 * `N-119584-g1a2b3c`, y un fork puede decir cualquier cosa— se devuelve un
 * sha256 corto de la línea entera. Nunca se devuelve la línea cruda: el punto
 * de todo esto es que en la clave no haya espacios ni texto libre. Y se prefiere
 * un hash antes que un `"desconocido"`, porque `"desconocido"` haría que dos
 * builds distintos compartan etiqueta, que es el bug original.
 */
export function parseFfmpegVersion(banner: string): string {
  const trimmed = banner.trim();
  if (trimmed.length === 0) return FFMPEG_UNAVAILABLE;
  const match = /^ffmpeg version (\S+)/i.exec(trimmed);
  const token = match?.[1];
  if (token !== undefined && /^[A-Za-z0-9._+~-]+$/.test(token)) return token;
  return `sha-${createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * Las versiones del stack de texto. `sharp.versions` trae `pango` y `freetype`
 * sólo cuando libvips se compiló con ellas; `na` es un valor real —"esta
 * máquina no las reporta"— y distinto de cualquier número, así que sigue
 * separando entornos en vez de fundirlos.
 */
function textStackVersions(): Pick<
  EngineVersionComponents,
  "sharp" | "vips" | "pango" | "freetype"
> {
  const versions = sharp.versions;
  return {
    sharp: versions.sharp ?? "na",
    vips: versions.vips ?? "na",
    pango: versions.pango ?? "na",
    freetype: versions.freetype ?? "na",
  };
}

/**
 * El hash de los componentes, separado de dónde salen los componentes.
 *
 * Está partido así para poder **medir que cada componente mueve el hash**: con
 * todo junto, `code` y las versiones del stack son constantes del proceso y no
 * hay forma de escribir un test que se ponga rojo si alguien saca uno del
 * material. Ver `engineVersion.test.ts`.
 */
export function hashEngineComponents(components: EngineVersionComponents): string {
  // Orden fijo y explícito: si esto fuera `Object.entries`, agregar un
  // componente en otra posición cambiaría el hash sin cambiar nada real.
  const material = [
    `code=${components.code}`,
    `ffmpeg=${components.ffmpeg}`,
    `sharp=${components.sharp}`,
    `vips=${components.vips}`,
    `pango=${components.pango}`,
    `freetype=${components.freetype}`,
    `fonts=${components.fonts}`,
    `text=${components.textStrategy}`,
  ].join("|");
  return createHash("sha256").update(material, "utf8").digest("hex");
}

export function engineVersionFrom(caps: FfmpegCapabilities): EngineVersion {
  const components: EngineVersionComponents = {
    code: codeVersion(),
    ffmpeg: caps.available ? parseFfmpegVersion(caps.version) : FFMPEG_UNAVAILABLE,
    ...textStackVersions(),
    fonts: FONT_REGISTRY_VERSION,
    textStrategy: TEXT_STRATEGY,
  };
  return { version: hashEngineComponents(components), components };
}

/**
 * La versión del motor de este proceso. `probeCapabilities` está memoizada, así
 * que después de la primera llamada esto no gasta un proceso hijo.
 */
export async function engineVersion(caps?: FfmpegCapabilities): Promise<EngineVersion> {
  return engineVersionFrom(caps ?? (await probeCapabilities()));
}
