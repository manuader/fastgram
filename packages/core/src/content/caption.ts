/**
 * La caption de un post, derivada de la copy de la pieza — sprint 7
 * (publish-flow), `FR-060`, `AI-006`.
 *
 * ## Por qué existe
 *
 * Hasta acá, todo post que no salía de Automations se publicaba **con caption
 * vacía**: el auto-slot creaba los posts sin copy (`bareTarget` de
 * `routes/v1/calendar.ts`), el barrido del worker sólo llenaba la caption de
 * los slots de campaña y el publicador mandaba `post.caption ?? ""`. Esto es
 * la regla que llena ese hueco, **pura** (sin I/O ni modelo): la usan la API al
 * crear un post, el barrido al convertir un slot y el publicador como última
 * red, así que las tres dicen lo mismo.
 *
 * ## `null` y `""` no son lo mismo
 *
 * Un post con `caption: null` es uno al que **nadie le escribió** caption: se
 * deriva. Uno con `""` es uno que el usuario dejó vacío **a propósito**: se
 * respeta. Quien llama es el que distingue; esta función sólo deriva.
 *
 * ## Qué hace, por red
 *
 * - La copy es `generatedText` (los textos en pantalla, unidos por línea en
 *   blanco). Una **tira final de hashtags** de la copy se separa y se vuelve a
 *   poner al final, junto con los que la pieza traiga aparte.
 * - Topes por code point, los de {@link PLATFORM_FIELD_LIMITS} (los mismos con
 *   los que `FR-060` programa y los publicadores validan). Si no entra, se
 *   recorta el cuerpo con `…`; los hashtags se conservan sólo si caben sin
 *   comerse más de un tercio del tope.
 * - Donde la red tiene título + cuerpo (TikTok, YouTube), el título es la
 *   primera frase y el cuerpo la copy entera — el mismo criterio que
 *   `defaultCaptions` de Automations.
 * - **X sin links** salvo que la instalación los permita
 *   (`PUBLISH_X_ALLOW_LINKS`): un post con URL cuesta ~13 veces más. Mismo
 *   patrón que `stripLinks` del publicador de X.
 * - Reddit no tiene tope verificado (`null`): título = primera frase, sin
 *   recortar.
 */
import { PLATFORM_FIELD_LIMITS, type Platform } from "../scheduling/schedule-post.js";

export interface CaptionSource {
  /** `generatedText` de la pieza (`DATA-008`). */
  readonly generatedText: string | null | undefined;
  /** Hashtags que la pieza trae aparte, con o sin `#`. */
  readonly hashtags?: readonly string[] | undefined;
}

export interface CaptionOptions {
  /** `PUBLISH_X_ALLOW_LINKS`. Default `false`: las URLs se sacan en X. */
  readonly allowXLinks?: boolean | undefined;
}

export interface DerivedCaption {
  /** Instagram/X/Threads/Facebook/LinkedIn: el texto · TikTok/YouTube: el título. */
  readonly caption: string;
  /** Sólo TikTok y YouTube. */
  readonly description: string | null;
}

/** Un hashtag: `#` pegado a una letra o `_`. `#1` no lo es. */
const HASHTAG_TOKEN = /#[\p{L}_][\p{L}\p{N}_]*/gu;
/** Una tira de hashtags al final: `… mañana #cafe #lunes`. */
const TRAILING_HASHTAGS = /(?:\s*#[\p{L}_][\p{L}\p{N}_]*)+\s*$/u;
/** Las mismas URLs que saca el publicador de X (`stripLinks`). */
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/giu;

/** Techo del espacio que los hashtags pueden ocupar en un texto recortado. */
const HASHTAG_SHARE_MAX = 1 / 3;

export function codePointLength(text: string): number {
  return [...text].length;
}

/** Recorta a `max` code points, con `…` si cortó. */
export function clipCaption(text: string, max: number): string {
  const points = [...text];
  if (points.length <= max) return text;
  if (max <= 1) return points.slice(0, Math.max(0, max)).join("");
  return `${points
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

/** Saca las URLs (`http(s)://…`, `www.…`) y colapsa los espacios que quedan. */
export function stripCaptionLinks(text: string): string {
  return text
    .replace(URL_PATTERN, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** La primera frase o línea: el título de TikTok / YouTube. */
export function captionHeadline(text: string): string {
  const first = text.split(/\n+/u).find((line) => line.trim() !== "") ?? "";
  const sentence = /^(.+?[.!?])(\s|$)/u.exec(first.trim());
  return (sentence?.[1] ?? first).trim();
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeTag(tag: string): string | null {
  const clean = tag.trim().replace(/^#+/, "");
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(clean) ? clean : null;
}

/** Cuerpo sin la tira final de hashtags, y los hashtags (sin `#`, sin repetir). */
export function splitHashtags(
  text: string,
  extra: readonly string[] = [],
): { readonly body: string; readonly hashtags: readonly string[] } {
  const normalized = normalizeText(text);
  const trailing = TRAILING_HASHTAGS.exec(normalized);
  const body =
    trailing === null ? normalized : normalized.slice(0, trailing.index).trim();
  const fromText = trailing === null ? [] : (trailing[0].match(HASHTAG_TOKEN) ?? []);
  const seen = new Set<string>();
  const hashtags: string[] = [];
  for (const raw of [...fromText, ...extra]) {
    const tag = normalizeTag(raw);
    if (tag === null) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hashtags.push(tag);
  }
  return { body, hashtags };
}

/** Cuerpo + hashtags dentro de `max` (o sin tope si es `null`). */
function compose(body: string, hashtags: readonly string[], max: number | null): string {
  const tags = hashtags.map((h) => `#${h}`).join(" ");
  const join = (b: string) => (b === "" ? tags : tags === "" ? b : `${b}\n\n${tags}`);
  if (max === null) return join(body);
  const full = join(body);
  if (codePointLength(full) <= max) return full;
  const tagsCost = tags === "" ? 0 : codePointLength(tags) + (body === "" ? 0 : 2);
  if (tags !== "" && tagsCost <= Math.floor(max * HASHTAG_SHARE_MAX)) {
    const budget = max - tagsCost;
    return join(body === "" ? "" : clipCaption(body, budget));
  }
  return clipCaption(body === "" ? tags : body, max);
}

/**
 * La caption por defecto de `platform` a partir de la copy de la pieza.
 * `null` si la pieza no trae nada que usar (sin texto ni hashtags): ahí no hay
 * de dónde derivar y quien llama decide (la API muestra el campo vacío).
 */
export function deriveCaption(
  platform: Platform,
  source: CaptionSource,
  options: CaptionOptions = {},
): DerivedCaption | null {
  const { body: rawBody, hashtags } = splitHashtags(
    source.generatedText ?? "",
    source.hashtags ?? [],
  );
  const body =
    platform === "x" && options.allowXLinks !== true
      ? stripCaptionLinks(rawBody)
      : rawBody;
  if (body === "" && hashtags.length === 0) return null;

  const limits = PLATFORM_FIELD_LIMITS[platform];
  if (limits.description !== null) {
    // Título + cuerpo (TikTok, YouTube): el título sin hashtags.
    const headline = captionHeadline(body);
    const title =
      headline === ""
        ? compose("", hashtags, limits.caption)
        : limits.caption === null
          ? headline
          : clipCaption(headline, limits.caption);
    return { caption: title, description: compose(body, hashtags, limits.description) };
  }
  if (platform === "reddit") {
    // Sin tope verificado: el título es la primera frase, sin recortar.
    return {
      caption: captionHeadline(body) || compose("", hashtags, null),
      description: null,
    };
  }
  const caption = compose(body, hashtags, limits.caption);
  return caption === "" ? null : { caption, description: null };
}

/** `deriveCaption` para todas las redes a la vez (la pantalla de Schedule). */
export function deriveCaptionsForAll(
  platforms: readonly Platform[],
  source: CaptionSource,
  options: CaptionOptions = {},
): Partial<Record<Platform, DerivedCaption>> {
  const out: Partial<Record<Platform, DerivedCaption>> = {};
  for (const platform of platforms) {
    const derived = deriveCaption(platform, source, options);
    if (derived !== null) out[platform] = derived;
  }
  return out;
}

/**
 * Qué caption lleva un post al crearse: la explícita si vino (aunque sea `""`,
 * que es «vacía a propósito»), si no la derivada. Mismo trato para `description`
 * en las redes que la tienen.
 */
export function captionFieldsFor(
  platform: Platform,
  explicit: { readonly caption: string | null; readonly description: string | null },
  source: CaptionSource,
  options: CaptionOptions = {},
): { readonly caption: string | null; readonly description: string | null } {
  if (explicit.caption !== null && explicit.description !== null) return explicit;
  const derived = deriveCaption(platform, source, options);
  return {
    caption: explicit.caption ?? derived?.caption ?? null,
    description:
      explicit.description ??
      (PLATFORM_FIELD_LIMITS[platform].description === null
        ? null
        : (derived?.description ?? null)),
  };
}
