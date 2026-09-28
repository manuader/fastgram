/**
 * Subtítulos: de palabras con tiempo a renglones cortos que se muestran de a
 * uno. Es lo que hacen los reels que se leen sin sonido: 1–4 palabras por
 * pantalla, cambiando al ritmo del habla, con la palabra dicha resaltada.
 */
import type { ReelCaptionWord } from "../spec.js";

export interface CaptionChunk {
  readonly words: readonly ReelCaptionWord[];
  /** Cuándo aparece y cuándo se va (hora del reel). */
  readonly start: number;
  readonly end: number;
}

/** Un silencio más largo que esto corta el renglón aunque tenga lugar. */
export const CAPTION_PAUSE_BREAK_SEC = 0.6;
/** Tope de letras por renglón: más de esto no se lee en un vistazo. */
export const CAPTION_MAX_CHARS = 22;
/** Cuánto queda un renglón en pantalla después de su última palabra. */
export const CAPTION_LINGER_SEC = 0.3;
/** Si el siguiente arranca antes de esto, el renglón se queda hasta que arranque. */
const CAPTION_BRIDGE_SEC = 0.8;
const MIN_CHUNK_SEC = 0.2;

const SENTENCE_END = /[.!?…]$/;

/**
 * Agrupa. Corta por: tope de palabras, pausa larga, fin de oración, o tope de
 * letras. Las palabras fuera de `[windowStart, windowEnd)` se descartan (el
 * clip se recortó o empieza más tarde).
 */
export function chunkCaptions(
  words: readonly ReelCaptionWord[],
  wordsPerChunk: number,
  windowStart: number,
  windowEnd: number,
): CaptionChunk[] {
  const inside = words.filter(
    (w) => w.start >= windowStart - 1e-6 && w.start < windowEnd,
  );
  const groups: ReelCaptionWord[][] = [];
  let current: ReelCaptionWord[] = [];
  const chars = (ws: readonly ReelCaptionWord[]): number =>
    ws.reduce((n, w) => n + w.text.length + 1, 0);
  for (const word of inside) {
    const last = current[current.length - 1];
    if (last !== undefined) {
      const full = current.length >= wordsPerChunk;
      const pause = word.start - last.end > CAPTION_PAUSE_BREAK_SEC;
      const sentence = SENTENCE_END.test(last.text);
      const long = chars(current) + word.text.length > CAPTION_MAX_CHARS;
      if (full || pause || sentence || long) {
        groups.push(current);
        current = [];
      }
    }
    current.push(word);
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, i) => {
    const first = group[0] as ReelCaptionWord;
    const last = group[group.length - 1] as ReelCaptionWord;
    const next = groups[i + 1]?.[0];
    let end =
      next !== undefined && next.start - last.end < CAPTION_BRIDGE_SEC
        ? next.start
        : last.end + CAPTION_LINGER_SEC;
    if (next !== undefined) end = Math.min(end, next.start);
    end = Math.min(end, windowEnd);
    const start = Math.max(first.start, windowStart);
    return {
      words: group,
      start,
      end: Math.max(end, Math.min(start + MIN_CHUNK_SEC, windowEnd)),
    };
  });
}
