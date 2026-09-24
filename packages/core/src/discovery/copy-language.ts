/**
 * El idioma de la copy — sprint 7 (memes desde un prompt), `PU-BRAND-002`.
 *
 * La estrategia de cada marca tiene `language` (BCP 47, `brand_strategies`),
 * y hasta acá sólo lo usaba el pre-chequeo del piloto (`JV-3`): la copy de
 * Blitz, la de «crear desde prompt» y la de `Regenerate Text` salían «en el
 * idioma del perfil», así que una marca con perfil en castellano y estrategia
 * en inglés recibía piezas que el propio pre-chequeo después rechazaba por
 * `wrong_language`.
 *
 * ## Qué manda
 *
 * 1. El `language` de la estrategia **guardada**.
 * 2. Sin estrategia guardada: el idioma del perfil de marca, que es lo que el
 *    prompt ya pedía («Write in the language … of the brand profile»). El
 *    perfil no tiene una columna de idioma, así que ese fallback lo aplica el
 *    modelo leyendo el perfil — no se inventa un detector.
 *
 * El default de la API (`en`, `defaultStrategy`) **no** cuenta como elección
 * del dueño: una marca que nunca guardó estrategia no dijo «inglés».
 *
 * ## Qué entra al prompt
 *
 * Sólo un tag que pasa el mismo patrón que el contrato
 * (`^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$`): el valor viaja en el mensaje de
 * **sistema** y no puede ser texto libre. Uno que no pasa es como no tener.
 */

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u;

/** Nombres de los idiomas más probables. El resto se nombra por su tag. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  es: "Spanish",
  pt: "Portuguese",
  fr: "French",
  it: "Italian",
  de: "German",
  nl: "Dutch",
  ca: "Catalan",
};

/** El tag normalizado, o `null` si no es un tag BCP 47 plausible. */
export function normalizeLanguageTag(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const tag = value.trim();
  if (tag === "" || tag.length > 35 || !LANGUAGE_TAG.test(tag)) return null;
  const [primary, ...rest] = tag.split("-");
  return [primary?.toLowerCase() ?? "", ...rest].join("-");
}

/** «Spanish (es-AR)», «English (en)», o el tag si no lo conocemos. */
export function languageLabel(tag: string): string {
  const primary = tag.split("-")[0] ?? tag;
  const name = LANGUAGE_NAMES[primary];
  return name === undefined ? `the language with tag ${tag}` : `${name} (${tag})`;
}

/**
 * La regla 1 de los prompts de copy. Con idioma: ése, siempre. Sin idioma:
 * `fallback` (el texto de siempre de cada prompt).
 */
export function copyLanguageRule(
  language: string | null | undefined,
  fallback: string,
): string {
  const tag = normalizeLanguageTag(language);
  if (tag === null) return fallback;
  return (
    `1. Write every text in ${languageLabel(tag)}, even if the brand profile, the topic ` +
    "or the current texts are in another language. Keep the tone of voice of the brand profile."
  );
}
