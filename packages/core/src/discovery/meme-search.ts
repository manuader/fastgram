/**
 * Buscar un meme de pantalla verde cuando el Media Bank no tiene uno que sirva
 * — sprint 7 (memes desde un prompt), `PLAN-USO-PERSONAL` §6 y D-12 (el dueño
 * asume los derechos de lo que publica).
 *
 * ## Qué es puro y qué no
 *
 * Acá: armar la búsqueda, leer lo que devuelve `yt-dlp --flat-playlist
 * --dump-single-json "ytsearchN:…"` y elegir el resultado. El proceso lo lanza
 * el worker (`apps/worker/src/discovery/meme-finder.ts`), y la bajada, la
 * medición del verde y la fila del Media Bank son el import de siempre
 * (`PU-MEME-001/002`): no hay un segundo camino al Media Bank.
 *
 * ## Los topes, y de dónde salen
 *
 * - **Una búsqueda por pedido, dos como mucho** ({@link MEME_SEARCH_LIMITS}):
 *   lo pidió el dueño. Cada búsqueda son segundos de `yt-dlp` y, si el clip no
 *   es verde, un import que no sirve.
 * - **≤ 15 s preferido, ≤ 30 s aceptado**: un meme de reacción dura segundos
 *   (lo pidió el dueño). Por encima de 30 s el resultado casi nunca es «el
 *   meme» sino una compilación. **No se recorta**: el downloader no sabe
 *   bajar un tramo (`--download-sections` no está en el puerto) — ver el
 *   reporte del sprint 7.
 * - Nada en vivo ni sin duración: un directo no termina y sin duración no hay
 *   cómo respetar el tope antes de bajar.
 *
 * ## El título es dato
 *
 * Lo escribió un tercero. Se usa para puntuar (palabras en común con el tema,
 * «green screen» en el título) y nada más; no llega a ningún prompt salvo como
 * descripción en el `state` de `JV-6`.
 */
import { rankByRelevance } from "./relevance.js";

export const MEME_SEARCH_LIMITS = {
  /** Resultados que se piden a YouTube por búsqueda. */
  resultsPerSearch: 8,
  /** Búsquedas por pedido de prompt (entre reintentos incluidos). */
  searchesPerRequest: 2,
  /** Duración preferida: un meme de reacción. */
  preferredMaxSeconds: 15,
  /** Duración aceptada. Más largo casi siempre es una compilación. */
  maxSeconds: 30,
  /** Tope del tema dentro de la búsqueda. */
  topicChars: 80,
} as const;

/** Lo que se agrega al tema para que YouTube devuelva clips de pantalla verde. */
export const MEME_SEARCH_SUFFIX = "green screen meme";

/**
 * La consulta de `yt-dlp` (`ytsearchN:<tema> green screen meme`). Sin saltos,
 * sin comillas y acotada: el tema lo escribió el usuario, y aunque viaja como
 * argumento (sin shell), un tema de 500 caracteres no es una búsqueda.
 */
export function memeSearchQuery(
  topic: string,
  results: number = MEME_SEARCH_LIMITS.resultsPerSearch,
): string {
  const clean = topic
    // eslint-disable-next-line no-control-regex -- sacar controles es el punto
    .replace(/[\u0000-\u001F\u007F"'`]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MEME_SEARCH_LIMITS.topicChars)
    .trim();
  return `ytsearch${String(results)}:${clean} ${MEME_SEARCH_SUFFIX}`;
}

/** Un resultado de la búsqueda, ya validado. */
export interface MemeSearchResult {
  readonly id: string;
  /** La URL canónica del video: es la que pasa por `checkImportUrl` y el import. */
  readonly url: string;
  readonly title: string;
  readonly durationSeconds: number;
}

const YT_ID = /^[A-Za-z0-9_-]{6,20}$/u;

/**
 * Lee la salida de `--flat-playlist --dump-single-json`. Tolerante: lo que no
 * tiene id de YouTube válido, título o duración, o es un directo, se ignora.
 * La URL se **reconstruye** desde el id: no se confía en la que trae el JSON.
 */
export function parseMemeSearchResults(raw: unknown): readonly MemeSearchResult[] {
  if (typeof raw !== "object" || raw === null) return [];
  const entries = (raw as Record<string, unknown>)["entries"];
  if (!Array.isArray(entries)) return [];
  const out: MemeSearchResult[] = [];
  for (const e of entries) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    const id = r["id"];
    const title = r["title"];
    const duration = r["duration"];
    const live = r["live_status"];
    if (typeof id !== "string" || !YT_ID.test(id)) continue;
    if (typeof title !== "string" || title.trim() === "") continue;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0)
      continue;
    if (live === "is_live" || live === "is_upcoming" || r["is_live"] === true) continue;
    if (out.some((x) => x.id === id)) continue;
    out.push({
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: title.replace(/\s+/gu, " ").trim().slice(0, 200),
      durationSeconds: duration,
    });
  }
  return out;
}

const GREEN_HINT = /green\s*-?\s*screen|chroma|pantalla\s+verde|fondo\s+verde/iu;

/**
 * Los resultados en el orden en que conviene intentarlos, ya filtrados por
 * duración. El orden, de más a menos importante:
 *
 *  1. El título dice que es de pantalla verde (si no lo es, el import no puede
 *     recortarlo gratis y el clip no sirve).
 *  2. Dura ≤ 15 s.
 *  3. Más palabras en común con el tema.
 *  4. El orden de YouTube (su relevancia), que es el desempate.
 */
export function rankMemeResults(
  topic: string,
  results: readonly MemeSearchResult[],
): readonly MemeSearchResult[] {
  const fitting = results.filter(
    (r) => r.durationSeconds <= MEME_SEARCH_LIMITS.maxSeconds,
  );
  const ranked = rankByRelevance(topic, fitting, (r) => ({ title: r.title }));
  const scoreOf = new Map(ranked.map((r) => [r.item.id, r.score]));
  const position = new Map(fitting.map((r, i) => [r.id, i]));
  return [...fitting].sort((a, b) => {
    const green = Number(GREEN_HINT.test(b.title)) - Number(GREEN_HINT.test(a.title));
    if (green !== 0) return green;
    const short =
      Number(b.durationSeconds <= MEME_SEARCH_LIMITS.preferredMaxSeconds) -
      Number(a.durationSeconds <= MEME_SEARCH_LIMITS.preferredMaxSeconds);
    if (short !== 0) return short;
    const rel = (scoreOf.get(b.id) ?? 0) - (scoreOf.get(a.id) ?? 0);
    if (rel !== 0) return rel;
    return (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0);
  });
}

/* ------------------------------------------------------------------------ *
 * La marca en la sugerencia
 * ------------------------------------------------------------------------ */

/** El meme que encontró la búsqueda, tal como queda anotado en la sugerencia. */
export interface AutoFoundMeme {
  readonly mediaId: string;
  /** La URL de YouTube de la que salió: el dueño la ve y decide (D-12). */
  readonly sourceUrl: string;
}

/**
 * La clave con la que el worker anota el meme encontrado en `build_plan`. Es
 * una clave **extra**: `parseSuggestionBuildPlan` arma el plan campo por campo
 * y la ignora, así que aceptar y construir no cambian. La lee sólo la vista de
 * la cola (`GET /blitz/queue`) para dibujar el chip «Auto-found meme».
 */
export const AUTO_FOUND_MEME_KEY = "autoFoundMeme";

/** La anotación, si el `build_plan` crudo (jsonb) la trae bien formada. */
export function autoFoundMemeOf(rawBuildPlan: unknown): AutoFoundMeme | null {
  if (typeof rawBuildPlan !== "object" || rawBuildPlan === null) return null;
  const v = (rawBuildPlan as Record<string, unknown>)[AUTO_FOUND_MEME_KEY];
  if (typeof v !== "object" || v === null) return null;
  const { mediaId, sourceUrl } = v as Record<string, unknown>;
  if (typeof mediaId !== "string" || mediaId === "") return null;
  if (typeof sourceUrl !== "string" || !sourceUrl.startsWith("https://")) return null;
  return { mediaId, sourceUrl };
}

/**
 * El plan con la anotación. Sólo si el meme del plan **es** ése: si `JV-6` o
 * el editor lo cambiaron, la marca mentiría.
 */
export function withAutoFoundMeme<T extends object>(
  buildPlan: T,
  meme: AutoFoundMeme,
  memeMediaId: string | null,
): T {
  if (memeMediaId !== meme.mediaId) return buildPlan;
  return { ...buildPlan, [AUTO_FOUND_MEME_KEY]: meme };
}
