/**
 * Métricas derivadas de anuncios — sprint 9 (R).
 *
 * Se calculan de los totales (gasto, impresiones, clics, resultados), nunca se
 * promedian promedios. Un denominador en 0 da `null`: "sin dato" no es 0.
 *
 * ## Qué es un "resultado"
 *
 * Meta devuelve `actions[]` con muchos `action_type`, y cuál cuenta como
 * resultado depende del objetivo. El mapeo por defecto de
 * {@link DEFAULT_RESULT_ACTION_TYPE} es **nuestro** y no está verificado contra
 * la doc (la página de insights no lista los `action_type` por objetivo en las
 * lecturas del 2026-09-28): cada campaña guarda el suyo y se puede cambiar.
 */
import type { AdObjective } from "@fastgram/ports";

export const DEFAULT_RESULT_ACTION_TYPE: Readonly<Record<AdObjective, string | null>> = {
  OUTCOME_AWARENESS: null,
  OUTCOME_TRAFFIC: "link_click",
  OUTCOME_ENGAGEMENT: "post_engagement",
  OUTCOME_LEADS: "lead",
  OUTCOME_SALES: "purchase",
  OUTCOME_APP_PROMOTION: "mobile_app_install",
};

export interface AdTotals {
  readonly spendMinor: number;
  readonly impressions: number;
  readonly clicks: number;
  /** `null` si la campaña no tiene tipo de resultado. */
  readonly results: number | null;
  /** Valor de conversión (`action_values`), unidades mínimas. */
  readonly resultValueMinor: number | null;
}

export interface DerivedAdMetrics {
  /** Costo por mil impresiones, unidades mínimas. */
  readonly cpmMinor: number | null;
  /** 0–1. */
  readonly ctr: number | null;
  readonly cpcMinor: number | null;
  readonly cpaMinor: number | null;
  /** Valor / gasto. */
  readonly roas: number | null;
}

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

export function derivedAdMetrics(t: AdTotals): DerivedAdMetrics {
  const cpm = ratio(t.spendMinor * 1000, t.impressions);
  const cpc = ratio(t.spendMinor, t.clicks);
  const cpa = t.results === null ? null : ratio(t.spendMinor, t.results);
  return {
    cpmMinor: cpm === null ? null : Math.round(cpm),
    ctr: ratio(t.clicks, t.impressions),
    cpcMinor: cpc === null ? null : Math.round(cpc),
    cpaMinor: cpa === null ? null : Math.round(cpa),
    roas:
      t.resultValueMinor === null || t.resultValueMinor === 0
        ? null
        : ratio(t.resultValueMinor, t.spendMinor),
  };
}

export interface DailyInsight {
  readonly spendMinor: number;
  readonly impressions: number;
  readonly clicks: number;
  readonly actions: Readonly<Record<string, number>>;
  readonly actionValuesMinor: Readonly<Record<string, number>>;
}

/** Suma filas diarias a totales, contando como resultado `resultActionType`. */
export function sumAdInsights(
  rows: readonly DailyInsight[],
  resultActionType: string | null,
): AdTotals {
  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  let results = 0;
  let value = 0;
  for (const r of rows) {
    spend += r.spendMinor;
    impressions += r.impressions;
    clicks += r.clicks;
    if (resultActionType !== null) {
      results += r.actions[resultActionType] ?? 0;
      value += r.actionValuesMinor[resultActionType] ?? 0;
    }
  }
  return {
    spendMinor: spend,
    impressions,
    clicks,
    results: resultActionType === null ? null : results,
    resultValueMinor: resultActionType === null ? null : value,
  };
}
