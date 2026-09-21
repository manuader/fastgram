import type { Rng } from "@fastgram/ports";

function pick<T>(r: number, items: readonly { value: T; weight: number }[]): T {
  if (items.length === 0) throw new Error("weightedPick: lista vacía");
  let total = 0;
  for (const it of items) {
    if (it.weight < 0) throw new Error("weightedPick: peso negativo");
    total += it.weight;
  }
  if (total <= 0) throw new Error("weightedPick: la suma de pesos no es positiva");

  let acc = 0;
  const target = r * total;
  let last = items[0];
  for (const it of items) {
    acc += it.weight;
    // `<` estricto: con weight 0 el acumulado no avanza y el ítem nunca gana.
    // Es la propiedad que el PRD necesita para `angleWeights` en 0.
    if (target < acc) return it.value;
    last = it;
  }
  // Sólo alcanzable por error de redondeo en coma flotante: la suma de los
  // pesos dio algo microscópicamente menor que `total`. Cae en el último.
  if (last === undefined) throw new Error("weightedPick: lista vacía");
  return last.value;
}

export const systemRng: Rng = {
  next: () => Math.random(),
  nextInt: (min, max) => min + Math.floor(Math.random() * (max - min)),
  weightedPick: (items) => pick(Math.random(), items),
};

/**
 * Rng determinista para tests. mulberry32: 32 bits de estado, misma secuencia
 * para la misma semilla. No es criptográfico y no pretende serlo.
 */
export class SeededRng implements Rng {
  #state: number;
  constructor(seed = 1) {
    this.#state = seed >>> 0;
  }
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  nextInt(minInclusive: number, maxExclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive));
  }
  weightedPick<T>(items: readonly { value: T; weight: number }[]): T {
    return pick(this.next(), items);
  }
}
