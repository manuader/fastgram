/**
 * Puerto Rng — IMPL §2.2.
 *
 * El PRD decide cosas por muestreo ponderado: `angleWeights` reparte qué
 * ángulo toca en la próxima sugerencia, `influencerChance` decide si una pieza
 * lleva influencer. Con `Math.random()` esas reglas no se pueden verificar:
 * el test que comprueba "con weight 0 nunca sale" sería flaky por definición.
 */
export interface Rng {
  /** Flotante en [0, 1). */
  next(): number;
  /** Entero en [minInclusive, maxExclusive). */
  nextInt(minInclusive: number, maxExclusive: number): number;
  /**
   * Elige un elemento según pesos relativos. Un peso de 0 nunca sale.
   * Lanza si `items` está vacío o si la suma de pesos no es positiva.
   */
  weightedPick<T>(items: readonly { value: T; weight: number }[]): T;
}
