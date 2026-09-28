/**
 * A/B de creatividades — sprint 9 (R), `PU-S9-012`.
 *
 * ## La regla del ganador (fijada en `ads.test.ts`)
 *
 * Nadie gana por mirar dos CTR distintos con 200 impresiones. Hay ganador
 * sólo si se cumplen las tres:
 *
 * 1. **Muestra mínima por variante**: {@link AB_MIN_IMPRESSIONS} impresiones y
 *    {@link AB_MIN_EVENTS} eventos (clics para CTR, resultados para CVR).
 *    Debajo de eso es `insufficient_data`.
 * 2. **Significancia**: la variante líder le gana a **cada** otra con un test
 *    z de dos proporciones (varianza agrupada) con z ≥ {@link AB_Z_CRITICAL}
 *    (95 % a dos colas). Si no, `no_winner_yet`.
 * 3. La métrica es la tasa que se eligió al crear el experimento: `ctr`
 *    (clics / impresiones) o `cvr` (resultados / impresiones). Con gasto
 *    parejo entre variantes —el A/B reparte el diario en partes iguales—, la
 *    mejor tasa por impresión es también el menor CPA, sin tener que testear
 *    un cociente de dos variables aleatorias.
 *
 * Los umbrales son una elección nuestra (convención estadística estándar), no
 * un dato de Meta. Meta tiene su propio `confidence_level` en `ad_studies`,
 * pero sus resultados no llegan por los insights que leemos: la regla de acá
 * es la que decide lo que se muestra.
 */

export const AB_MIN_IMPRESSIONS = 1000;
export const AB_MIN_EVENTS = 20;
/** Dos colas, 95 %. */
export const AB_Z_CRITICAL = 1.96;

export type AbMetric = "ctr" | "cvr";

export interface AbVariantStats {
  readonly variantId: string;
  readonly impressions: number;
  readonly clicks: number;
  readonly results: number;
  readonly spendMinor: number;
}

export interface AbVariantOutcome {
  readonly variantId: string;
  /** Tasa de la métrica elegida, `null` sin impresiones. */
  readonly rate: number | null;
  readonly events: number;
  readonly impressions: number;
  readonly enoughData: boolean;
}

export type AbStatus = "insufficient_data" | "no_winner_yet" | "winner";

export interface AbOutcome {
  readonly status: AbStatus;
  readonly metric: AbMetric;
  /** Sólo con `winner`. */
  readonly winnerVariantId: string | null;
  /** La de mejor tasa, gane o no. */
  readonly leaderVariantId: string | null;
  /** El menor z del líder contra las demás (el que decide). */
  readonly minZ: number | null;
  readonly variants: readonly AbVariantOutcome[];
}

const eventsOf = (v: AbVariantStats, metric: AbMetric): number =>
  metric === "ctr" ? v.clicks : v.results;

/** z de dos proporciones con varianza agrupada; `null` si no se puede. */
export function twoProportionZ(
  x1: number,
  n1: number,
  x2: number,
  n2: number,
): number | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  return (x1 / n1 - x2 / n2) / se;
}

export function evaluateAbTest(
  variants: readonly AbVariantStats[],
  metric: AbMetric,
): AbOutcome {
  const outcomes: AbVariantOutcome[] = variants.map((v) => {
    const events = eventsOf(v, metric);
    return {
      variantId: v.variantId,
      rate: v.impressions > 0 ? events / v.impressions : null,
      events,
      impressions: v.impressions,
      enoughData: v.impressions >= AB_MIN_IMPRESSIONS && events >= AB_MIN_EVENTS,
    };
  });
  const ranked = [...outcomes].sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  const leader = ranked[0];
  const base = {
    metric,
    variants: outcomes,
    leaderVariantId:
      leader?.rate === null || leader === undefined ? null : leader.variantId,
  };

  if (variants.length < 2 || outcomes.some((o) => !o.enoughData)) {
    return { ...base, status: "insufficient_data", winnerVariantId: null, minZ: null };
  }
  const lead = ranked[0] as AbVariantOutcome;
  let minZ = Number.POSITIVE_INFINITY;
  for (const other of ranked.slice(1)) {
    const z = twoProportionZ(
      lead.events,
      lead.impressions,
      other.events,
      other.impressions,
    );
    if (z === null) {
      minZ = Number.NEGATIVE_INFINITY;
      break;
    }
    minZ = Math.min(minZ, z);
  }
  const z = Number.isFinite(minZ) ? minZ : null;
  if (z !== null && z >= AB_Z_CRITICAL) {
    return { ...base, status: "winner", winnerVariantId: lead.variantId, minZ: z };
  }
  return { ...base, status: "no_winner_yet", winnerVariantId: null, minZ: z };
}
