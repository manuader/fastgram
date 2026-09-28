/**
 * Rasgos de una pieza para aprender preferencias — sprint 9 (agente Q),
 * `PU-S9-011`, `D-22`.
 *
 * ## Vocabulario cerrado y versionado
 *
 * Un rasgo es una clave `familia=valor` (`format=green-screen`,
 * `bg.tone=dark`). Las familias son fijas ({@link PREFERENCE_FEATURE_FAMILIES}) y cada
 * una acepta **sólo** valores de una lista cerrada o un id (uuid) de una
 * entidad nuestra. Nada de texto libre: las etiquetas de un clip vienen de un
 * modelo con visión y pueden decir cualquier cosa, así que pasan por una tabla
 * de palabras ({@link PREF_MEME_KIND_KEYWORDS}) que las lleva a {@link PREF_MEME_KINDS} o
 * las descarta. Una etiqueta que no está en la tabla no es un rasgo.
 *
 * Por qué importa: los pesos se materializan por rasgo y viven meses. Si un
 * rasgo pudiera ser texto libre, cada etiqueta nueva sería una fila nueva sin
 * evidencia, y la pantalla «What Blitz learned» mostraría lo que escribió un
 * modelo, no lo que decidió el dueño.
 *
 * Cambiar una lista de valores **sube {@link PREFERENCE_VOCABULARY_VERSION}**:
 * las señales guardan la versión con la que se extrajeron, y un rasgo que ya no
 * existe se ignora al puntuar (no rompe nada, deja de sumar).
 *
 * ## Por qué la entrada es estructural y no una fila
 *
 * Se extrae de tres lugares que no comparten forma: una sugerencia con su
 * `buildPlan` (aceptar/descartar), una pieza con sus ediciones (editar) y un
 * candidato del refill antes de existir (segunda tanda: `scoreCandidate`).
 * Cada llamador arma un {@link PreferenceSubject} con lo que sabe; lo que no
 * sabe lo omite y ese rasgo no aparece. Omitir nunca inventa un valor.
 */

/** Sube cuando cambia una lista cerrada o la forma de una clave. */
export const PREFERENCE_VOCABULARY_VERSION = 1;

/**
 * Qué puede cambiar el dueño en el editor. Una edición es una señal sobre
 * **un** aspecto: cambiar el fondo dice algo del fondo, no del formato.
 */
export const PREFERENCE_ASPECTS = [
  "text",
  "background",
  "clip",
  "music",
  "style",
] as const;
export type PreferenceAspect = (typeof PREFERENCE_ASPECTS)[number];

export const PREFERENCE_FORMATS = [
  "slideshow",
  "wall-of-text",
  "green-screen",
  "video-hook",
  "custom",
] as const;

/** De dónde salió la sugerencia: el refill, «crear desde prompt» o un remix. */
export const PREF_SUGGESTION_ORIGINS = ["refill", "prompt", "remix"] as const;
export type PrefSuggestionOrigin = (typeof PREF_SUGGESTION_ORIGINS)[number];

/**
 * De dónde es la media. `library` = la biblioteca global o un asset interno;
 * `brand` = el brand kit generado para la marca.
 */
export const PREF_MEDIA_SOURCES = [
  "upload",
  "generated",
  "brand",
  "library",
  "imported",
] as const;
export type PrefMediaSource = (typeof PREF_MEDIA_SOURCES)[number];

export const PREF_MUSIC_SOURCES = ["upload", "import", "extracted", "library"] as const;
export type PrefMusicSource = (typeof PREF_MUSIC_SOURCES)[number];

export const PREF_TONES = ["light", "dark"] as const;
export type PrefTone = (typeof PREF_TONES)[number];

export const PREF_BUCKETS = ["short", "medium", "long"] as const;
export type PrefBucket = (typeof PREF_BUCKETS)[number];

export const PREF_TEXT_SIZES = ["small", "medium", "large"] as const;

/** Las animaciones de texto que puede tener un reel. `none` es un valor. */
export const PREF_TEXT_ANIMATIONS = [
  "none",
  "pop",
  "typewriter",
  "karaoke",
  "fade",
  "slide",
  "bounce",
] as const;

/** Los siete presets de caption de `FR-055` (`TEXT_STYLE_PRESETS`). */
export const PREF_TEXT_PRESETS = [
  "tiktok-classic",
  "bold-impact",
  "snapchat",
  "white-box",
  "yellow-pop",
  "clean-karaoke",
  "script-playful",
] as const;

/** Qué tipo de meme es un clip. Cerrado: ver {@link PREF_MEME_KIND_KEYWORDS}. */
export const PREF_MEME_KINDS = [
  "reaction",
  "laugh",
  "shock",
  "facepalm",
  "cringe",
  "celebrate",
  "sad",
  "angry",
  "confused",
  "smug",
  "dance",
  "animal",
  "sports",
  "movie",
  "cartoon",
] as const;
export type PrefMemeKind = (typeof PREF_MEME_KINDS)[number];

/**
 * Palabra de etiqueta → tipo de meme. Elección nuestra leída de lo que devuelve
 * el etiquetador de clips (`CLIP_TAGGING_SYSTEM_PROMPT`: emoción en 1–3
 * palabras y 3–8 tags en minúsculas), no un dato. Se compara por palabra
 * entera, así `"shocked face"` cuenta y `"shockwave"` no.
 */
export const PREF_MEME_KIND_KEYWORDS: Readonly<Record<PrefMemeKind, readonly string[]>> =
  {
    reaction: ["reaction", "react", "reacting", "meme"],
    laugh: ["laugh", "laughing", "lol", "funny", "hilarious", "giggle"],
    shock: ["shock", "shocked", "surprised", "surprise", "omg", "wow", "gasp", "stunned"],
    facepalm: ["facepalm", "disappointed", "disappointment", "ugh"],
    cringe: ["cringe", "awkward", "embarrassed", "yikes"],
    celebrate: [
      "celebrate",
      "celebration",
      "party",
      "win",
      "winning",
      "excited",
      "cheer",
    ],
    sad: ["sad", "crying", "cry", "tears", "upset"],
    angry: ["angry", "mad", "rage", "furious", "annoyed"],
    confused: ["confused", "confusion", "thinking", "hmm", "puzzled"],
    smug: ["smug", "proud", "confident", "smirk"],
    dance: ["dance", "dancing", "dancer"],
    animal: ["cat", "dog", "animal", "pet", "puppy", "kitten"],
    sports: ["sports", "sport", "football", "soccer", "basketball", "baseball"],
    movie: ["movie", "film", "scene", "cinema"],
    cartoon: ["cartoon", "anime", "animated", "animation"],
  };

/** Tope de tipos por clip: un clip con diez etiquetas no vota diez veces. */
export const PREF_MEME_KINDS_PER_CLIP = 3;

/** Palabras de etiqueta que dicen si un fondo es claro u oscuro. */
const PREF_TONE_KEYWORDS: Readonly<Record<PrefTone, readonly string[]>> = {
  dark: ["dark", "night", "black", "noir", "moody", "shadow"],
  light: ["light", "bright", "white", "day", "daylight", "sunny", "pastel"],
};

/**
 * Cortes de los buckets. Elecciones nuestras, sin número en el PRD:
 *  - texto: 60 caracteres ≈ un hook de una línea; 160 ≈ un párrafo corto.
 *  - duración: un meme de reacción dura 2–8 s (trampa 67), un reel 8–20 s.
 *  - tamaño: 18 es el default del editor (`BLITZ_CAPTION_FONT_SIZE`).
 */
export const PREF_TEXT_LENGTH_CUTS = { short: 60, medium: 160 } as const;
export const PREF_DURATION_CUTS_SEC = { short: 8, medium: 20 } as const;
export const PREF_FONT_SIZE_CUTS = { small: 16, medium: 28 } as const;

type ValueRule =
  | { readonly kind: "closed"; readonly values: readonly string[] }
  | {
      readonly kind: "id";
      /** Además de uuids, valores cerrados permitidos (p. ej. `none`). */
      readonly also?: readonly string[];
    }
  | { readonly kind: "slug" };

interface FamilyDef {
  /** El aspecto que una edición cambia, o `null` si no se edita. */
  readonly aspect: PreferenceAspect | null;
  readonly rule: ValueRule;
  /**
   * Si pasa al nivel del dueño. Un id de ángulo, de influencer o de pista es
   * de **una** marca: sumado entre marcas no significa nada.
   */
  readonly ownerLevel: boolean;
}

const closed = (values: readonly string[]): ValueRule => ({ kind: "closed", values });

export const PREFERENCE_FEATURE_FAMILIES = {
  format: { aspect: null, rule: closed(PREFERENCE_FORMATS), ownerLevel: true },
  angle: { aspect: null, rule: { kind: "id" }, ownerLevel: false },
  influencer: { aspect: null, rule: { kind: "id", also: ["none"] }, ownerLevel: false },
  /** El modelo de la biblioteca del dueño (sprint 8): sí cruza marcas. */
  model: { aspect: null, rule: { kind: "id" }, ownerLevel: true },
  origin: { aspect: null, rule: closed(PREF_SUGGESTION_ORIGINS), ownerLevel: true },
  "bg.type": { aspect: "background", rule: closed(["image", "video"]), ownerLevel: true },
  "bg.source": {
    aspect: "background",
    rule: closed(PREF_MEDIA_SOURCES),
    ownerLevel: true,
  },
  "bg.tone": { aspect: "background", rule: closed(PREF_TONES), ownerLevel: true },
  "clip.type": { aspect: "clip", rule: closed(["image", "video"]), ownerLevel: true },
  "clip.kind": { aspect: "clip", rule: closed(PREF_MEME_KINDS), ownerLevel: true },
  "clip.source": { aspect: "clip", rule: closed(PREF_MEDIA_SOURCES), ownerLevel: true },
  music: { aspect: "music", rule: closed(["none", "track"]), ownerLevel: true },
  "music.track": { aspect: "music", rule: { kind: "id" }, ownerLevel: false },
  "music.source": { aspect: "music", rule: closed(PREF_MUSIC_SOURCES), ownerLevel: true },
  "text.preset": { aspect: "style", rule: closed(PREF_TEXT_PRESETS), ownerLevel: true },
  /** La familia tipográfica: el contrato ya la acota (`fontFamilySchema`). */
  "text.font": { aspect: "style", rule: { kind: "slug" }, ownerLevel: true },
  "text.size": { aspect: "style", rule: closed(PREF_TEXT_SIZES), ownerLevel: true },
  "text.box": { aspect: "style", rule: closed(["yes", "no"]), ownerLevel: true },
  "text.anim": { aspect: "style", rule: closed(PREF_TEXT_ANIMATIONS), ownerLevel: true },
  "text.len": { aspect: "text", rule: closed(PREF_BUCKETS), ownerLevel: true },
  duration: { aspect: null, rule: closed(PREF_BUCKETS), ownerLevel: true },
} as const satisfies Record<string, FamilyDef>;

export type PreferenceFeatureFamily = keyof typeof PREFERENCE_FEATURE_FAMILIES;
export const PREFERENCE_FEATURE_FAMILY_NAMES = Object.keys(
  PREFERENCE_FEATURE_FAMILIES,
) as PreferenceFeatureFamily[];

/** `familia=valor`. Se construye sólo con {@link preferenceFeatureKey}. */
export type PreferenceFeatureKey = string;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function isFamily(v: string): v is PreferenceFeatureFamily {
  return Object.prototype.hasOwnProperty.call(PREFERENCE_FEATURE_FAMILIES, v);
}

function valueAllowed(rule: ValueRule, value: string): boolean {
  switch (rule.kind) {
    case "closed":
      return rule.values.includes(value);
    case "id":
      return UUID_RE.test(value) || (rule.also ?? []).includes(value);
    case "slug":
      return SLUG_RE.test(value);
  }
}

/** La clave de un rasgo, o `null` si el valor no está en el vocabulario. */
export function preferenceFeatureKey(
  family: PreferenceFeatureFamily,
  value: string,
): PreferenceFeatureKey | null {
  const v = value.trim().toLowerCase();
  const def: FamilyDef = PREFERENCE_FEATURE_FAMILIES[family];
  return valueAllowed(def.rule, v) ? `${family}=${v}` : null;
}

export interface ParsedPreferenceFeature {
  readonly family: PreferenceFeatureFamily;
  readonly value: string;
  readonly aspect: PreferenceAspect | null;
  readonly ownerLevel: boolean;
}

/**
 * Parte una clave. `null` = no pertenece al vocabulario actual (una versión
 * vieja o algo que no salió de {@link preferenceFeatureKey}): quien puntúa la ignora.
 */
export function parsePreferenceFeature(key: string): ParsedPreferenceFeature | null {
  const i = key.indexOf("=");
  if (i <= 0) return null;
  const family = key.slice(0, i);
  const value = key.slice(i + 1);
  if (!isFamily(family)) return null;
  const def: FamilyDef = PREFERENCE_FEATURE_FAMILIES[family];
  if (!valueAllowed(def.rule, value)) return null;
  return { family, value, aspect: def.aspect, ownerLevel: def.ownerLevel };
}

// ───────────────────────────────────────────────────────────────────────────
// La entrada
// ───────────────────────────────────────────────────────────────────────────

export interface PreferenceMediaInput {
  readonly mediaType: "image" | "video";
  readonly source?: PrefMediaSource | null | undefined;
  /** Las etiquetas del asset (`media.tags`, del usuario o del etiquetador). */
  readonly tags?: readonly string[] | undefined;
  /** Si los metadatos la traen. Si no, se intenta leer de las etiquetas. */
  readonly tone?: PrefTone | null | undefined;
}

export interface PreferenceTextStyleInput {
  readonly presetId?: string | null | undefined;
  readonly fontFamily?: string | null | undefined;
  /** En unidades del editor (`FR-051`, 8–72). */
  readonly fontSize?: number | null | undefined;
  /** Caja de fondo detrás del texto (`backgroundColor` / `background`). */
  readonly boxed?: boolean | null | undefined;
  /** Sólo reels. */
  readonly animation?: string | null | undefined;
}

/**
 * Lo que se sabe de una pieza. Todo es opcional salvo el formato: lo que falta
 * no genera rasgo. `music: null` sí es un dato («sin música»); `undefined` es
 * «no se sabe».
 */
export interface PreferenceSubject {
  readonly format: string;
  readonly angleId?: string | null | undefined;
  readonly influencerId?: string | null | undefined;
  readonly modelId?: string | null | undefined;
  readonly origin?: PrefSuggestionOrigin | null | undefined;
  readonly background?: PreferenceMediaInput | null | undefined;
  readonly clip?: PreferenceMediaInput | null | undefined;
  readonly music?:
    | {
        readonly trackId?: string | null | undefined;
        readonly source?: PrefMusicSource | null | undefined;
      }
    | null
    | undefined;
  readonly texts?: readonly string[] | undefined;
  readonly textStyle?: PreferenceTextStyleInput | null | undefined;
  readonly durationSec?: number | null | undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Extracción
// ───────────────────────────────────────────────────────────────────────────

function words(tags: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const tag of tags) {
    for (const w of tag.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w !== "") out.add(w);
    }
  }
  return out;
}

/** Los tipos de meme de un clip, en el orden de {@link PREF_MEME_KINDS}, hasta 3. */
export function prefMemeKindsOf(tags: readonly string[]): PrefMemeKind[] {
  const w = words(tags);
  const out: PrefMemeKind[] = [];
  for (const kind of PREF_MEME_KINDS) {
    if (PREF_MEME_KIND_KEYWORDS[kind].some((k) => w.has(k))) out.push(kind);
    if (out.length >= PREF_MEME_KINDS_PER_CLIP) break;
  }
  return out;
}

/** Claro u oscuro según las etiquetas; `null` si no lo dicen o se contradicen. */
export function prefToneOfTags(tags: readonly string[]): PrefTone | null {
  const w = words(tags);
  const dark = PREF_TONE_KEYWORDS.dark.some((k) => w.has(k));
  const light = PREF_TONE_KEYWORDS.light.some((k) => w.has(k));
  if (dark === light) return null;
  return dark ? "dark" : "light";
}

export function prefBucketOf(
  value: number,
  cuts: { short: number; medium: number },
): PrefBucket {
  if (value <= cuts.short) return "short";
  if (value <= cuts.medium) return "medium";
  return "long";
}

function sizeOf(fontSize: number): (typeof PREF_TEXT_SIZES)[number] {
  if (fontSize < PREF_FONT_SIZE_CUTS.small) return "small";
  if (fontSize <= PREF_FONT_SIZE_CUTS.medium) return "medium";
  return "large";
}

function push(
  out: Set<string>,
  family: PreferenceFeatureFamily,
  value: string | null | undefined,
): void {
  if (value === null || value === undefined || value === "") return;
  const key = preferenceFeatureKey(family, value);
  if (key !== null) out.add(key);
}

function mediaFeatures(
  out: Set<string>,
  prefix: "bg" | "clip",
  m: PreferenceMediaInput | null | undefined,
): void {
  if (m === null || m === undefined) return;
  push(out, `${prefix}.type`, m.mediaType);
  push(out, `${prefix}.source`, m.source);
  const tags = m.tags ?? [];
  if (prefix === "bg") {
    push(out, "bg.tone", m.tone ?? prefToneOfTags(tags));
  } else {
    for (const kind of prefMemeKindsOf(tags)) push(out, "clip.kind", kind);
  }
}

/**
 * Los rasgos de una pieza, ordenados y sin repetir. Pura y determinista: la
 * misma entrada da siempre la misma lista (las señales se comparan así).
 */
export function extractPreferenceFeatures(
  subject: PreferenceSubject,
): PreferenceFeatureKey[] {
  const out = new Set<string>();
  push(out, "format", subject.format);
  push(out, "angle", subject.angleId);
  if (subject.influencerId !== undefined) {
    push(out, "influencer", subject.influencerId ?? "none");
  }
  push(out, "model", subject.modelId);
  push(out, "origin", subject.origin);

  mediaFeatures(out, "bg", subject.background);
  mediaFeatures(out, "clip", subject.clip);

  if (subject.music === null) {
    push(out, "music", "none");
  } else if (subject.music !== undefined) {
    push(out, "music", "track");
    push(out, "music.track", subject.music.trackId);
    push(out, "music.source", subject.music.source);
  }

  const style = subject.textStyle;
  if (style !== null && style !== undefined) {
    push(out, "text.preset", style.presetId);
    push(out, "text.font", style.fontFamily);
    if (typeof style.fontSize === "number" && Number.isFinite(style.fontSize)) {
      push(out, "text.size", sizeOf(style.fontSize));
    }
    if (typeof style.boxed === "boolean")
      push(out, "text.box", style.boxed ? "yes" : "no");
    push(out, "text.anim", style.animation);
  }

  if (subject.texts !== undefined && subject.texts.length > 0) {
    const chars = subject.texts.reduce((n, t) => n + t.trim().length, 0);
    push(out, "text.len", prefBucketOf(chars, PREF_TEXT_LENGTH_CUTS));
  }

  if (typeof subject.durationSec === "number" && Number.isFinite(subject.durationSec)) {
    push(out, "duration", prefBucketOf(subject.durationSec, PREF_DURATION_CUTS_SEC));
  }

  return [...out].sort();
}

/** El aspecto de un rasgo (`null` si no se edita o no es del vocabulario). */
export function preferenceAspectOf(key: PreferenceFeatureKey): PreferenceAspect | null {
  return parsePreferenceFeature(key)?.aspect ?? null;
}

export interface PreferenceAspectChange {
  readonly aspect: PreferenceAspect;
  /** Lo que tenía la pieza y el dueño sacó. */
  readonly removed: readonly PreferenceFeatureKey[];
  /** Lo que el dueño puso. */
  readonly added: readonly PreferenceFeatureKey[];
}

/**
 * Qué cambió entre dos versiones de una pieza, **por aspecto**. Un aspecto
 * cuyos rasgos quedaron iguales no aparece aunque el valor exacto cambió
 * (cambiar un fondo oscuro por otro oscuro no dice nada del tono): eso es a
 * propósito, la preferencia se aprende sobre rasgos, no sobre archivos.
 *
 * `forced` marca aspectos que cambiaron aunque los rasgos no lo muestren
 * todavía (regenerar la copy: el texto nuevo lo escribe el worker después).
 */
export function diffPreferenceFeatures(
  before: readonly PreferenceFeatureKey[],
  after: readonly PreferenceFeatureKey[],
  forced: readonly PreferenceAspect[] = [],
): PreferenceAspectChange[] {
  const b = new Set(before);
  const a = new Set(after);
  const out: PreferenceAspectChange[] = [];
  for (const aspect of PREFERENCE_ASPECTS) {
    const removed = [...b]
      .filter((k) => !a.has(k) && preferenceAspectOf(k) === aspect)
      .sort();
    const added = [...a]
      .filter((k) => !b.has(k) && preferenceAspectOf(k) === aspect)
      .sort();
    if (removed.length > 0 || added.length > 0) {
      out.push({ aspect, removed, added });
    } else if (forced.includes(aspect)) {
      out.push({
        aspect,
        removed: [...b].filter((k) => preferenceAspectOf(k) === aspect).sort(),
        added: [],
      });
    }
  }
  return out;
}
