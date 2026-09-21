/**
 * Iniciales para el fallback del Avatar.
 *
 * Toma la primera letra de la primera y la última palabra. Usa `Intl.Segmenter`
 * cuando está disponible para no partir emojis ni grafemas compuestos por la
 * mitad: un nombre en devanagari o una bandera 🇦🇷 quedarían como basura con
 * `charAt(0)`.
 */
export function getInitials(name: string, max = 2): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";

  const picked = words.length === 1 ? words : [words[0], words[words.length - 1]];
  const letters: string[] = [];
  for (const word of picked) {
    if (word === undefined) continue;
    const grapheme = firstGrapheme(word);
    if (grapheme !== "") letters.push(grapheme.toLocaleUpperCase());
    if (letters.length >= max) break;
  }
  return letters.join("");
}

function firstGrapheme(word: string): string {
  const segmenter = getSegmenter();
  if (segmenter !== null) {
    for (const segment of segmenter.segment(word)) return segment.segment;
    return "";
  }
  // Fallback sin Intl.Segmenter: al menos respeta los pares suplentes.
  return Array.from(word)[0] ?? "";
}

let cachedSegmenter: Intl.Segmenter | null | undefined;

function getSegmenter(): Intl.Segmenter | null {
  if (cachedSegmenter === undefined) {
    cachedSegmenter =
      typeof Intl !== "undefined" && "Segmenter" in Intl
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
  }
  return cachedSegmenter;
}
