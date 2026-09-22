/**
 * Pesos que tienen que sumar 100 · FR-055 (PRD:1269, PRD:1276, PRD:1277).
 *
 * Tres mapas del producto comparten la misma regla: el content mix (los cuatro
 * formatos), `angleWeights` y `textStyleWeights`. El servidor los valida **como
 * unidad** y rechaza con `400` cualquier conjunto que no sume exactamente 100
 * (`packages/core/src/discovery/blitz-preferences.ts`).
 *
 * ## Por qué esto existe, y por qué es la pieza central de la pantalla
 *
 * Con auto-guardado, cada movimiento de un slider dispara un PATCH. Si la UI
 * mandara el peso que se movió y nada más, **todo estado intermedio sería
 * inválido**: subir `slideshow` de 25 a 40 deja el conjunto en 115 y el
 * servidor responde `400` hasta que el usuario acierte los otros tres a mano.
 * Vería un error por cada arrastre y no habría forma de salir salvo por
 * casualidad.
 *
 * La salida **no** es que reparta el servidor: el dominio ya decidió que esa
 * decisión no es suya — *"el servidor tendría que decidir a quién le quita los
 * 15 puntos … el usuario acabaría con un mix que no eligió"*. La salida es que
 * **reparta el cliente y lo enseñe**: mover un slider recalcula los otros en
 * pantalla, el usuario ve el resultado y puede corregirlo. El estado local
 * nunca sale de la regla, así que el PATCH que se manda siempre es válido.
 *
 * ## Enteros, y por qué no es un detalle
 *
 * Las columnas de `blitz_preferences` son `integer()` — los once porcentajes,
 * no sólo `influencerChance` (que es el único que la ruta comprueba, con un
 * `400` explícito). Repartir en enteros que sumen exacto obliga a elegir un
 * método: `100 / 3` no son tres treses y pico, son `34/33/33`. Se usa el del
 * **resto mayor** (Hare), el único reparto que cumple las dos cosas a la vez
 * —suma exacta y proporción respetada— sin favorecer siempre al primero.
 */

/** FR-055 (PRD:1269) — la suma exacta que exigen los tres mapas. */
export const WEIGHT_SUM = 100;

/** Un mapa de pesos tal y como viaja por el contrato. */
export type WeightMap = Readonly<Record<string, number>>;

/** Un porcentaje válido para el contrato y para la columna: entero, 0–100. */
export function clampWeight(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(WEIGHT_SUM, Math.max(0, Math.round(value)));
}

export function sumWeights(weights: WeightMap): number {
  return Object.values(weights).reduce((acc, value) => acc + value, 0);
}

/**
 * ¿Este mapa se puede mandar tal cual?
 *
 * El mapa vacío **sí**: para `textStyleWeights` significa "mix desactivado" y
 * para `angleWeights` "cero ángulos activos". Tratarlo como inválido dejaría al
 * usuario sin forma de volver al comportamiento por defecto.
 */
export function isSendableWeights(weights: WeightMap): boolean {
  const entries = Object.entries(weights);
  if (entries.length === 0) return true;
  if (!entries.every(([, value]) => Number.isInteger(value) && value >= 0)) return false;
  return sumWeights(weights) === WEIGHT_SUM;
}

interface Slot {
  readonly key: string;
  readonly index: number;
  readonly exact: number;
  readonly floor: number;
  weight: number;
}

/**
 * Reparte `total` entre las claves de `shares` **proporcionalmente a su valor
 * actual**, en enteros que suman exactamente `total`.
 *
 * Si todas valen 0 no hay proporción que respetar y el reparto es par: es el
 * caso de "el usuario puso un formato al 100 % y ahora lo baja", donde los
 * otros tres están en 0 y un reparto proporcional daría 0/0/0 — o sea una suma
 * de 40 y un `400` en el siguiente guardado.
 */
export function redistribute(shares: WeightMap, total: number): Record<string, number> {
  const entries = Object.entries(shares);
  const out: Record<string, number> = {};
  if (entries.length === 0) return out;

  const target = Math.max(0, Math.round(total));
  const current = entries.reduce((acc, [, value]) => acc + Math.max(0, value), 0);

  const slots: Slot[] = entries.map(([key, value], index) => {
    const exact =
      current === 0 ? target / entries.length : (Math.max(0, value) * target) / current;
    const floor = Math.floor(exact);
    return { key, index, exact, floor, weight: floor };
  });

  // Los puntos que sobran al truncar van a quien más parte fraccionaria perdió.
  // El desempate es por posición, para que el reparto sea determinista: sin él,
  // dos renders del mismo estado podrían repartir distinto.
  let left = target - slots.reduce((acc, slot) => acc + slot.floor, 0);
  const byRemainder = [...slots].sort((a, b) => {
    const fractionA = a.exact - a.floor;
    const fractionB = b.exact - b.floor;
    if (fractionA !== fractionB) return fractionB - fractionA;
    return a.index - b.index;
  });
  for (const slot of byRemainder) {
    if (left <= 0) break;
    slot.weight += 1;
    left -= 1;
  }

  for (const slot of slots) out[slot.key] = slot.weight;
  return out;
}

/**
 * Mueve un peso y reequilibra los demás para que el conjunto siga sumando 100.
 *
 * Es la operación que hace que **cada** estado de la pantalla sea guardable.
 */
export function setWeight(
  weights: WeightMap,
  key: string,
  value: number,
): Record<string, number> {
  const next = clampWeight(value);
  const others: Record<string, number> = {};
  for (const [candidate, weight] of Object.entries(weights)) {
    if (candidate !== key) others[candidate] = weight;
  }
  // Un único peso no se puede "repartir": es el conjunto entero, así que vale
  // 100 pase lo que pase. Sin esta rama, un mapa de un solo ángulo activo se
  // guardaría con el valor del slider y el servidor lo rechazaría.
  if (Object.keys(others).length === 0) return { [key]: WEIGHT_SUM };
  return { ...redistribute(others, WEIGHT_SUM - next), [key]: next };
}

/** El reparto par sobre un conjunto de claves: tres claves → 34/33/33. */
export function evenWeights(keys: readonly string[]): Record<string, number> {
  const ones: Record<string, number> = {};
  for (const key of keys) ones[key] = 1;
  return redistribute(ones, WEIGHT_SUM);
}
