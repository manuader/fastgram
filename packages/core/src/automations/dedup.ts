/**
 * Dedup de contenido de campañas — `AI-012` (*"evita repetir contenido ya
 * usado por el workspace"*), `P3-AUTO-006`, `P3-AUTO-007`.
 *
 * ## Por qué no es pgvector
 *
 * `P3-AUTO-007` pide *"pgvector + juicio sólo en borderline"*. La extensión
 * está habilitada (`0001_extensions.sql`), pero **no hay proveedor de
 * embeddings**: ni el puerto `Llm` ni el registro de modelos tienen una tarea
 * de embeddings, y el LLM local de la instalación (`qwen2.5:7b-instruct`) no
 * los da por la API compatible con OpenAI que usamos. Inventar uno sería un
 * endpoint que nadie configuró. Así que el dedup es **léxico y determinista**:
 *
 * 1. **Texto normalizado idéntico** (minúsculas, sin acentos, sin
 *    puntuación ni emojis, espacios colapsados) → duplicado.
 * 2. **Casi idéntico**: Jaccard de shingles de 2 palabras ≥
 *    {@link DEDUP_DUPLICATE_THRESHOLD} → duplicado.
 * 3. **Borderline** (≥ {@link DEDUP_BORDERLINE_THRESHOLD}): el "juicio" es la
 *    media. Si además usa **la misma media** que el texto parecido, es la misma
 *    pieza con otra coma → duplicado; con otra media, se deja pasar. No se
 *    llama a un LLM para esto: un 7B local decidiendo "¿es lo mismo?" es más
 *    caro y menos auditable que esta regla, y el costo de un falso positivo es
 *    un reintento de copy.
 *
 * Cuando exista un proveedor de embeddings, el paso 2 se reemplaza por
 * similitud de coseno sobre `vector` y el 3 por el juicio del PRD; la firma de
 * {@link judgeDuplicate} no cambia.
 */

/** Jaccard a partir del cual dos textos son el mismo. Número nuestro. */
export const DEDUP_DUPLICATE_THRESHOLD = 0.7;
/** Jaccard a partir del cual se mira la media. Número nuestro. */
export const DEDUP_BORDERLINE_THRESHOLD = 0.35;
const SHINGLE_WORDS = 2;

/** Minúsculas, sin acentos, sin puntuación/emojis, espacios colapsados. */
export function normalizeForDedup(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Huella del texto normalizado: cyrb53 (53 bits, JS puro). No es
 * criptográfica ni hace falta: indexa la comparación exacta.
 */
export function dedupFingerprint(text: string): string {
  const s = normalizeForDedup(text);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, "0");
}

/** Clave de la media de una pieza: ids ordenados. `null` = no se sabe. */
export function mediaKeyOf(
  mediaIds: readonly string[] | null | undefined,
): string | null {
  if (mediaIds === null || mediaIds === undefined || mediaIds.length === 0) return null;
  return [...new Set(mediaIds)].sort().join(",");
}

function shingles(normalized: string): Set<string> {
  const words = normalized === "" ? [] : normalized.split(" ");
  const out = new Set<string>();
  if (words.length < SHINGLE_WORDS) {
    if (words.length > 0) out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i += 1) {
    out.add(words.slice(i, i + SHINGLE_WORDS).join(" "));
  }
  return out;
}

export function jaccard(a: string, b: string): number {
  const sa = shingles(normalizeForDedup(a));
  const sb = shingles(normalizeForDedup(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Algo ya usado por la marca: una pieza, una sugerencia u otro slot. */
export interface UsedContent {
  readonly text: string;
  readonly mediaKey: string | null;
}

export interface DedupCandidate {
  readonly text: string;
  readonly mediaKey: string | null;
}

export type DedupVerdict =
  | { readonly verdict: "unique"; readonly score: number }
  | {
      readonly verdict: "duplicate";
      readonly score: number;
      readonly reason: "exact" | "near" | "borderline_same_media";
    };

/**
 * ¿La copy repite algo ya usado? Ver la cabecera para las tres reglas.
 * `score` es el máximo Jaccard encontrado (1 para una copia exacta).
 */
export function judgeDuplicate(
  candidate: DedupCandidate,
  corpus: readonly UsedContent[],
): DedupVerdict {
  const normalized = normalizeForDedup(candidate.text);
  if (normalized === "") return { verdict: "duplicate", score: 1, reason: "exact" };
  let best = 0;
  let borderlineSameMedia = false;
  for (const used of corpus) {
    const other = normalizeForDedup(used.text);
    if (other === "") continue;
    if (other === normalized) return { verdict: "duplicate", score: 1, reason: "exact" };
    const score = jaccard(normalized, other);
    if (score > best) best = score;
    if (score >= DEDUP_DUPLICATE_THRESHOLD)
      return { verdict: "duplicate", score, reason: "near" };
    if (
      score >= DEDUP_BORDERLINE_THRESHOLD &&
      candidate.mediaKey !== null &&
      candidate.mediaKey === used.mediaKey
    ) {
      borderlineSameMedia = true;
    }
  }
  if (borderlineSameMedia)
    return { verdict: "duplicate", score: best, reason: "borderline_same_media" };
  return { verdict: "unique", score: best };
}
