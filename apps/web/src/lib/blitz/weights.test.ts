/**
 * El reparto de pesos · FR-055 (PRD:1269).
 *
 * Lo que se prueba acá es **la propiedad que hace guardable a la pantalla**: el
 * conjunto suma exactamente 100 después de cualquier movimiento. No es una
 * comprobación de redondeo: es la diferencia entre auto-guardar y que cada
 * arrastre devuelva un `400`.
 */
import { describe, expect, it } from "vitest";
import {
  clampWeight,
  evenWeights,
  isSendableWeights,
  redistribute,
  setWeight,
  sumWeights,
  WEIGHT_SUM,
} from "./weights";

const MIX = {
  slideshowWeight: 25,
  wallOfTextWeight: 25,
  greenScreenWeight: 25,
  videoHookWeight: 25,
};

describe("redistribute", () => {
  it("respeta la proporción de lo que había", () => {
    // 60 entre tres partes iguales: 20 cada una.
    expect(redistribute({ a: 25, b: 25, c: 25 }, 60)).toEqual({ a: 20, b: 20, c: 20 });
    // Y cuando no son iguales, el reparto las conserva: 50/25/25 de 80.
    expect(redistribute({ a: 50, b: 25, c: 25 }, 80)).toEqual({ a: 40, b: 20, c: 20 });
  });

  it("reparte par cuando todo lo que queda vale 0", () => {
    // Es el caso real: el usuario puso un formato al 100 % y ahora lo baja. Un
    // reparto proporcional daría 0/0/0 y el conjunto sumaría 40 — o sea un
    // `400` en el siguiente guardado, sin que el usuario hiciera nada raro.
    expect(redistribute({ a: 0, b: 0, c: 0 }, 60)).toEqual({ a: 20, b: 20, c: 20 });
  });

  it("los puntos que sobran van a quien más perdió al truncar", () => {
    // 100/3 = 33,33: dos suben a 34 no habría manera, el sobrante es 1.
    expect(redistribute({ a: 1, b: 1, c: 1 }, 100)).toEqual({ a: 34, b: 33, c: 33 });
    // 100/7 = 14,28: el sobrante son 2 y van a las dos primeras por desempate.
    const seven = redistribute({ a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 }, 100);
    expect(sumWeights(seven)).toBe(100);
    expect(Object.values(seven).filter((v) => v === 15)).toHaveLength(2);
  });

  it("el desempate es por posición, así que el reparto es determinista", () => {
    const first = redistribute({ a: 1, b: 1, c: 1 }, 100);
    const second = redistribute({ a: 1, b: 1, c: 1 }, 100);
    expect(first).toEqual(second);
    // Si el desempate fuera por orden de recorrido de un `Set` o por `sort`
    // inestable, dos renders del mismo estado podrían repartir distinto y el
    // borrador se ensuciaría solo.
    expect(first).toEqual({ a: 34, b: 33, c: 33 });
  });

  it("un conjunto vacío no se reparte", () => {
    expect(redistribute({}, 100)).toEqual({});
  });
});

describe("setWeight — la propiedad que sostiene el auto-guardado", () => {
  it("mover un peso reequilibra los otros tres", () => {
    expect(setWeight(MIX, "slideshowWeight", 40)).toEqual({
      slideshowWeight: 40,
      wallOfTextWeight: 20,
      greenScreenWeight: 20,
      videoHookWeight: 20,
    });
  });

  it("llevar uno a 100 deja a los demás en 0, y volver a bajarlo los recupera", () => {
    const all = setWeight(MIX, "slideshowWeight", 100);
    expect(all).toEqual({
      slideshowWeight: 100,
      wallOfTextWeight: 0,
      greenScreenWeight: 0,
      videoHookWeight: 0,
    });
    // Sin la rama de "todo a 0 reparte par", esto devolvería 40/0/0/0.
    expect(setWeight(all, "slideshowWeight", 40)).toEqual({
      slideshowWeight: 40,
      wallOfTextWeight: 20,
      greenScreenWeight: 20,
      videoHookWeight: 20,
    });
  });

  it("suma exactamente 100 para CUALQUIER valor de CUALQUIER peso", () => {
    // El barrido completo, no tres casos elegidos: 4 pesos × 202 pasos, y cada
    // paso es un PATCH que el servidor aceptaría o rechazaría. Una sola suma
    // distinta de 100 es un `400` que el usuario ve.
    //
    // **Lo que este barrido NO cubre, medido y no supuesto.** Se quitó a mano
    // la rama de "todo a 0 reparte par" de `redistribute` y este caso siguió
    // **verde**: al bajar desde 100 el primer paso pide repartir 1 punto entre
    // tres, y con el bug el reparto de restos lo acierta igual; del paso
    // siguiente en adelante ya hay un peso distinto de 0 y la rama rota no
    // se vuelve a tocar. Quien pone en rojo ese bug es el caso de arriba,
    // `llevar uno a 100 … y volver a bajarlo`, que salta directo a 40. O sea
    // que un barrido grande no sustituye al caso elegido a mano.
    const keys = Object.keys(MIX);
    for (const key of keys) {
      let current: Record<string, number> = { ...MIX };
      const path = [
        ...Array.from({ length: 101 }, (_unused, value) => value),
        ...Array.from({ length: 101 }, (_unused, value) => 100 - value),
      ];
      for (const value of path) {
        current = setWeight(current, key, value);
        expect(sumWeights(current)).toBe(WEIGHT_SUM);
        expect(current[key]).toBe(value);
        expect(Object.values(current).every((v) => Number.isInteger(v))).toBe(true);
      }
    }
  });

  it("un conjunto de un solo peso vale 100 pase lo que pase", () => {
    // Es el caso del workspace con un único ángulo activo: no hay entre quién
    // repartir, así que el slider no puede fijar otra cosa que 100.
    expect(setWeight({ only: 100 }, "only", 30)).toEqual({ only: 100 });
  });

  it("un valor fuera de rango se recorta en vez de viajar al servidor", () => {
    expect(setWeight(MIX, "slideshowWeight", 130).slideshowWeight).toBe(100);
    expect(setWeight(MIX, "slideshowWeight", -5).slideshowWeight).toBe(0);
  });
});

describe("evenWeights", () => {
  it("los siete presets de caption suman 100", () => {
    const weights = evenWeights(["a", "b", "c", "d", "e", "f", "g"]);
    expect(sumWeights(weights)).toBe(100);
    expect(Object.keys(weights)).toHaveLength(7);
  });
});

describe("clampWeight", () => {
  it("redondea a entero, porque la columna lo es", () => {
    expect(clampWeight(33.4)).toBe(33);
    expect(clampWeight(33.6)).toBe(34);
  });

  it("un no-número es 0 y no un `NaN` que rompa la suma", () => {
    expect(clampWeight(Number.NaN)).toBe(0);
  });
});

describe("isSendableWeights", () => {
  it("el mapa vacío SÍ se puede mandar: es 'mix desactivado', no 'inválido'", () => {
    // FR-055 (PRD:1277). Tratarlo como error dejaría al usuario sin forma de
    // volver al comportamiento por defecto.
    expect(isSendableWeights({})).toBe(true);
  });

  it("rechaza lo que el servidor rechazaría", () => {
    expect(isSendableWeights({ a: 50, b: 49 })).toBe(false);
    expect(isSendableWeights({ a: 50.5, b: 49.5 })).toBe(false);
    expect(isSendableWeights({ a: 110, b: -10 })).toBe(false);
  });

  it("acepta un conjunto que suma 100 en enteros", () => {
    expect(isSendableWeights(MIX)).toBe(true);
  });
});
