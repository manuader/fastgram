/**
 * Qué se lee de una referencia **sin login** — Inspiration de uso personal
 * (`FR-040` adaptado, `F-041`, `OQ-13`, `D-12`, `D-13`).
 *
 * El worker corre `yt-dlp --dump-single-json` sobre el link que pegó el dueño
 * y esto convierte ese JSON en los campos de `trending_items`. Es puro: no
 * hay red ni proceso acá, así que se prueba con la salida **real** de `yt-dlp`
 * guardada como fixture (`__fixtures__/`).
 *
 * ## Qué da `yt-dlp` y qué no (verificado el 2026-09-24, yt-dlp 2026.08.19)
 *
 * - YouTube (`Youtube`): `title`, `description`, `uploader`/`channel`,
 *   `uploader_id` (el @handle), `view_count`, `like_count`, `comment_count`,
 *   `duration`, `width`/`height`, `tags` y `thumbnail`. Sin login.
 * - Wikimedia Commons (`Wikimedia`): título, descripción, uploader, duración y
 *   licencia. **Ni métricas ni miniatura.**
 * - TikTok, Instagram y X: **no se verificó en esta tarea** (hacerlo pedía
 *   leer contenido de terceros). Por la documentación de los extractores,
 *   TikTok da `view_count`/`like_count`/`comment_count`/`repost_count`, X da
 *   `like_count`/`repost_count`, e Instagram anónimo está degradado (§6.1 del
 *   plan). Todo campo es opcional acá: lo que el sitio no dé queda `null`,
 *   nunca `0` (un "0 likes" inventado es un dato falso).
 *
 * ## Todo lo que viene de acá es texto de terceros
 *
 * Título, caption, autor y hashtags los escribió otra persona. Se guardan
 * recortados y sin controles, y cuando entran a un prompt (el remix) viajan en
 * el bloque `untrusted` (`discovery/suggestion-copy.ts`), nunca como
 * instrucción.
 */

/** Las plataformas de `social_platform` que Inspiration reconoce por el host. */
export type ReferencePlatform = "tiktok" | "instagram" | "youtube" | "x";

/** `trending_items.format` (`0022`). */
export type ReferenceFormat = "video" | "slideshow" | "image" | "text";

export const REFERENCE_FORMATS: readonly ReferenceFormat[] = [
  "video",
  "slideshow",
  "image",
  "text",
];

/** Topes de lo que se guarda. Sanidad, no producto: el PRD no los fija. */
export const REFERENCE_LIMITS = {
  title: 300,
  author: 120,
  caption: 2_200,
  hashtags: 30,
  hashtag: 60,
  /** `integer` de Postgres: una métrica mayor se guarda en el tope. */
  metricMax: 2_147_483_647,
  slides: 35,
} as const;

const HOSTS: ReadonlyArray<{
  readonly suffix: string;
  readonly platform: ReferencePlatform;
}> = [
  { suffix: "tiktok.com", platform: "tiktok" },
  { suffix: "instagram.com", platform: "instagram" },
  { suffix: "youtube.com", platform: "youtube" },
  { suffix: "youtu.be", platform: "youtube" },
  { suffix: "x.com", platform: "x" },
  { suffix: "twitter.com", platform: "x" },
];

/**
 * La plataforma por el host del link, o `null` si no es una de las cuatro.
 * Un link de otro sitio se acepta igual (lo que `yt-dlp` lea, se usa): sólo
 * queda sin plataforma.
 */
export function platformFromUrl(raw: string): ReferencePlatform | null {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  for (const { suffix, platform } of HOSTS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return platform;
  }
  return null;
}

/** Lo que se completa en `trending_items` después de leer la página. */
export interface ReferenceMetadata {
  readonly title: string | null;
  readonly author: string | null;
  readonly caption: string | null;
  readonly hashtags: readonly string[];
  readonly format: ReferenceFormat | null;
  readonly views: number | null;
  readonly likes: number | null;
  readonly comments: number | null;
  readonly durationSeconds: number | null;
  readonly isSlideshow: boolean;
  readonly slideCount: number;
  /** La URL que dio el sitio. El worker guarda **su copia**, no esta. */
  readonly thumbnailSourceUrl: string | null;
  /** El permalink canónico según el sitio (`webpage_url`), si es http(s). */
  readonly canonicalUrl: string | null;
}

// eslint-disable-next-line no-control-regex -- sacar controles es el punto
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g;
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** Texto de terceros → una cadena guardable, o `null`. Conserva los saltos de línea. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value
    .replace(/\r\n?/g, "\n")
    .replace(CONTROLS, " ")
    .replace(INVISIBLE, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (clean.length === 0) return null;
  return clean.length > max ? clean.slice(0, max).trimEnd() : clean;
}

/** Una línea (título, autor): sin saltos. */
function cleanLine(value: unknown, max: number): string | null {
  const c = cleanText(value, max);
  return c === null ? null : c.replace(/\s*\n\s*/g, " ");
}

/** Un contador de la página: entero no negativo, acotado al `integer` de Postgres. */
export function metric(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(REFERENCE_LIMITS.metricMax, Math.round(value));
}

const HASHTAG = /(?:^|[^\p{L}\p{N}_&#/=?])#([\p{L}\p{N}_]{1,60})/gu;

/** Los `#hashtags` de un texto, sin `#`, en minúscula y sin repetir. */
export function hashtagsIn(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  for (const m of text.matchAll(HASHTAG)) {
    const tag = m[1]?.toLowerCase();
    if (tag === undefined || /^\d+$/.test(tag)) continue;
    if (!out.includes(tag)) out.push(tag);
    if (out.length >= REFERENCE_LIMITS.hashtags) break;
  }
  return out;
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function formatOf(info: Record<string, unknown>): {
  format: ReferenceFormat | null;
  isSlideshow: boolean;
  slideCount: number;
} {
  const type = info["_type"];
  if (type === "playlist" || type === "multi_video") {
    // Un carrusel de Instagram o un post de fotos: varias entradas.
    const entries = Array.isArray(info["entries"]) ? info["entries"].length : 0;
    return {
      format: "slideshow",
      isSlideshow: true,
      slideCount: Math.min(REFERENCE_LIMITS.slides, entries),
    };
  }
  const vcodec = info["vcodec"];
  const ext = typeof info["ext"] === "string" ? info["ext"].toLowerCase() : "";
  if (["jpg", "jpeg", "png", "webp", "heic"].includes(ext) || vcodec === "none") {
    // `vcodec: none` con extensión de imagen es una foto; sin ella puede ser
    // un audio suelto, que no es un formato de referencia.
    if (ext !== "" && !["m4a", "mp3", "opus", "ogg", "wav"].includes(ext)) {
      return { format: "image", isSlideshow: false, slideCount: 0 };
    }
    return { format: null, isSlideshow: false, slideCount: 0 };
  }
  if (typeof info["duration"] === "number" || typeof info["width"] === "number") {
    return { format: "video", isSlideshow: false, slideCount: 0 };
  }
  return { format: null, isSlideshow: false, slideCount: 0 };
}

/**
 * La salida de `yt-dlp --dump-single-json` → los campos de la referencia.
 * `null` si no es un objeto (el worker lo trata como lectura fallida).
 */
export function parseReferenceInfo(raw: unknown): ReferenceMetadata | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const info = raw as Record<string, unknown>;
  const L = REFERENCE_LIMITS;

  // En TikTok, IG y X el `title` suele ser el caption truncado o "Video by
  // …": el caption es la `description`. En YouTube son dos cosas.
  const caption = cleanText(info["description"], L.caption);
  const title = cleanLine(info["title"] ?? info["fulltitle"], L.title);
  const author =
    cleanLine(info["uploader"], L.author) ??
    cleanLine(info["channel"], L.author) ??
    cleanLine(info["creator"], L.author) ??
    cleanLine(info["uploader_id"], L.author);

  const hashtags: string[] = [];
  const push = (tag: string) => {
    const t = tag.replace(/^#/, "").trim().toLowerCase().slice(0, L.hashtag);
    if (t !== "" && !hashtags.includes(t) && hashtags.length < L.hashtags) {
      hashtags.push(t);
    }
  };
  for (const tag of hashtagsIn(caption)) push(tag);
  for (const tag of hashtagsIn(title)) push(tag);
  // Los `tags` de YouTube son palabras clave del autor, no hashtags visibles:
  // se suman sólo si no hubo ninguno escrito.
  if (hashtags.length === 0 && Array.isArray(info["tags"])) {
    for (const t of info["tags"]) {
      if (typeof t === "string" && !/\s/.test(t.trim())) push(t);
    }
  }

  const duration = metric(info["duration"]);
  const shape = formatOf(info);
  return {
    title,
    author,
    caption,
    hashtags,
    format: shape.format,
    views: metric(info["view_count"]),
    likes: metric(info["like_count"]),
    comments: metric(info["comment_count"]),
    durationSeconds: duration,
    isSlideshow: shape.isSlideshow,
    slideCount: shape.slideCount,
    thumbnailSourceUrl: httpUrl(info["thumbnail"]),
    canonicalUrl: httpUrl(info["webpage_url"]),
  };
}
