/**
 * Filtro en código y shortlist textual — la mitad barata del decisor.
 *
 * Lo que se puede decidir con certeza no pasa por el juicio (§25.2): la clase
 * de asset, la duración, el aspecto, la licencia y «ya lo usaste recién» son
 * código. Lo que queda se ordena por la relevancia textual de siempre
 * (`discovery/relevance.ts`) y los mejores N van a juicio.
 *
 * ## Por qué la shortlist incluye candidatos con relevancia 0
 *
 * El ranking textual no entiende sinónimos ni idiomas cruzados («lunes» no
 * matchea «monday»): es justo lo que el juicio sí ve. Si sólo pasaran los que
 * comparten una palabra con la idea, el juicio no podría rescatar el clip
 * perfecto que está etiquetado en otro idioma. Con cero en todos, el orden es
 * el de entrada (el ranking es estable).
 */
import { rankByRelevance, type RelevanceText } from "../../discovery/relevance.js";
import type { RoleNeeds } from "./formats.js";
import {
  isVerifiableLicense,
  type AssetCandidate,
  type ExclusionReason,
} from "./types.js";

/**
 * Cuántos candidatos llegan al juicio por defecto. Medido contra Laya en la
 * Mac (sprint 9): ~0,05–0,15 s por candidato con el checkpoint caliente, así
 * que 20 entran holgados en el plazo de 10 s del worker. Por encima, el
 * ranking textual ya no separa mucho y cada candidato es una llamada más.
 */
export const DEFAULT_SHORTLIST_SIZE = 20;

export interface Exclusion {
  readonly id: string;
  readonly reason: ExclusionReason;
}

export interface ShortlistEntry {
  readonly candidate: AssetCandidate;
  /** 0 = el mejor del ranking textual. Desempata y es el fallback. */
  readonly textRank: number;
  readonly textScore: number;
}

export interface FilterResult {
  readonly shortlist: readonly ShortlistEntry[];
  readonly excluded: readonly Exclusion[];
}

/** Por qué un candidato no sirve para el rol, o `null` si sirve. */
export function exclusionFor(
  candidate: AssetCandidate,
  needs: RoleNeeds,
): Exclude<ExclusionReason, "recent" | "shortlist"> | null {
  if (!needs.kinds.includes(candidate.kind)) return "kind";
  const d = candidate.durationSec;
  if (typeof d === "number" && Number.isFinite(d)) {
    if (needs.minDurationSec !== undefined && d < needs.minDurationSec) return "duration";
    if (needs.maxDurationSec !== undefined && d > needs.maxDurationSec) return "duration";
  }
  const a = candidate.aspect;
  if (
    a !== null &&
    a !== undefined &&
    needs.aspects !== undefined &&
    needs.aspects.length > 0 &&
    !needs.aspects.includes(a)
  ) {
    return "aspect";
  }
  // D-19: de la biblioteca global sólo entra lo que tiene licencia verificable.
  // Lo de la marca es responsabilidad del dueño (D-12) y no se filtra acá.
  if (candidate.source === "library" && !isVerifiableLicense(candidate.license)) {
    return "license";
  }
  return null;
}

function relevanceOf(c: AssetCandidate): RelevanceText {
  return c.relevance ?? { title: c.description, tags: c.tags ?? [] };
}

/**
 * Filtra por formato/duración/aspecto/licencia, saca los recientes y arma la
 * shortlist. **Los recientes se sacan sólo si queda alguien**: no repetir es
 * una preferencia, quedarse sin pieza no.
 */
export function shortlistCandidates(input: {
  readonly idea: string | null | undefined;
  readonly needs: RoleNeeds;
  readonly candidates: readonly AssetCandidate[];
  readonly recentIds?: ReadonlySet<string> | undefined;
  readonly size?: number | undefined;
}): FilterResult {
  const excluded: Exclusion[] = [];
  const eligible: AssetCandidate[] = [];
  const seen = new Set<string>();
  for (const c of input.candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const reason = exclusionFor(c, input.needs);
    if (reason === null) eligible.push(c);
    else excluded.push({ id: c.id, reason });
  }

  let pool = eligible;
  const recent = input.recentIds;
  if (recent !== undefined && recent.size > 0) {
    const fresh = eligible.filter((c) => !recent.has(c.id));
    if (fresh.length > 0) {
      for (const c of eligible) {
        if (recent.has(c.id)) excluded.push({ id: c.id, reason: "recent" });
      }
      pool = fresh;
    }
  }

  const size = Math.max(1, input.size ?? DEFAULT_SHORTLIST_SIZE);
  const ranked = rankByRelevance(input.idea, pool, relevanceOf);
  const shortlist = ranked.slice(0, size).map((r, i) => ({
    candidate: r.item,
    textRank: i,
    textScore: r.score,
  }));
  for (const r of ranked.slice(size)) {
    excluded.push({ id: r.item.id, reason: "shortlist" });
  }
  return { shortlist, excluded };
}
