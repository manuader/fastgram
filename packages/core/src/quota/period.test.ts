/**
 * La clave del período de facturación — `DATA-029`, PRD §16.2.
 *
 * Lo que este archivo persigue es una sola propiedad, y es la que hace que la
 * PK `(companyId, period)` signifique algo: **todo instante pertenece a
 * exactamente un período**. Si `currentBillingPeriodStartUtc` y
 * `nextBillingResetUtc` no fueran el mismo borde visto desde los dos lados,
 * habría instantes sin período —el save no se cobraría a nadie— o con dos —se
 * cobraría dos veces—, y el error aparecería en la factura de un cliente, no
 * en un test.
 */
import { describe, expect, it } from "vitest";

import {
  billingPeriodKey,
  currentBillingPeriodStartUtc,
  nextBillingResetUtc,
} from "./reset.js";

const at = (iso: string): Date => new Date(iso);

describe("currentBillingPeriodStartUtc", () => {
  it("el ancla del mes cuando ya pasó", () => {
    expect(currentBillingPeriodStartUtc(at("2026-09-20T10:00:00Z"), 15)).toEqual(
      at("2026-09-15T00:00:00Z"),
    );
  });

  it("el ancla del mes anterior cuando todavía no llegó", () => {
    expect(currentBillingPeriodStartUtc(at("2026-09-10T10:00:00Z"), 15)).toEqual(
      at("2026-08-15T00:00:00Z"),
    );
  });

  it("el instante exacto del ancla YA pertenece al período nuevo", () => {
    // El borde es `[inicio, siguiente)`. Si fuera `(inicio, siguiente]`, el save
    // hecho a las 00:00:00 exactas del día de reset se cobraría al período que
    // acaba de cerrar — al ciclo que el cliente ya pagó.
    expect(currentBillingPeriodStartUtc(at("2026-09-15T00:00:00Z"), 15)).toEqual(
      at("2026-09-15T00:00:00Z"),
    );
  });

  it("un milisegundo antes del ancla todavía es el período viejo", () => {
    expect(currentBillingPeriodStartUtc(at("2026-09-14T23:59:59.999Z"), 15)).toEqual(
      at("2026-08-15T00:00:00Z"),
    );
  });

  it("cruza el año hacia atrás", () => {
    expect(currentBillingPeriodStartUtc(at("2026-01-05T00:00:00Z"), 15)).toEqual(
      at("2025-12-15T00:00:00Z"),
    );
  });

  it("recorta el ancla 31 al último día de febrero, igual que el reset", () => {
    expect(currentBillingPeriodStartUtc(at("2026-02-28T12:00:00Z"), 31)).toEqual(
      at("2026-02-28T00:00:00Z"),
    );
  });

  it("y en bisiesto usa el 29", () => {
    expect(currentBillingPeriodStartUtc(at("2028-02-29T12:00:00Z"), 31)).toEqual(
      at("2028-02-29T00:00:00Z"),
    );
  });
});

describe("los dos bordes son el mismo borde", () => {
  // Es la propiedad que sostiene toda la facturación. Se prueba barriendo, no
  // con casos elegidos: los bordes que rompen son los que a uno no se le
  // ocurren.
  const anclas = [1, 15, 28, 29, 30, 31];

  it("el siguiente reset es siempre posterior al inicio del período", () => {
    for (const anchor of anclas) {
      for (let dia = 0; dia < 400; dia += 1) {
        const now = new Date(Date.UTC(2026, 0, 1) + dia * 86_400_000 + 3_600_000);
        const inicio = currentBillingPeriodStartUtc(now, anchor);
        const fin = nextBillingResetUtc(now, anchor);
        expect(fin.getTime()).toBeGreaterThan(inicio.getTime());
      }
    }
  });

  it("`now` siempre cae dentro de `[inicio, fin)`", () => {
    for (const anchor of anclas) {
      for (let dia = 0; dia < 400; dia += 1) {
        const now = new Date(Date.UTC(2026, 0, 1) + dia * 86_400_000 + 3_600_000);
        const inicio = currentBillingPeriodStartUtc(now, anchor);
        const fin = nextBillingResetUtc(now, anchor);
        expect(now.getTime()).toBeGreaterThanOrEqual(inicio.getTime());
        expect(now.getTime()).toBeLessThan(fin.getTime());
      }
    }
  });

  it("el fin de un período es el inicio del siguiente: no hay huecos", () => {
    // Si el fin de uno no fuera el inicio del otro, habría instantes que no
    // pertenecen a ningún período. Un save ahí no se cobraría a nadie.
    for (const anchor of anclas) {
      for (let dia = 0; dia < 400; dia += 1) {
        const now = new Date(Date.UTC(2026, 0, 1) + dia * 86_400_000 + 3_600_000);
        const fin = nextBillingResetUtc(now, anchor);
        expect(currentBillingPeriodStartUtc(fin, anchor)).toEqual(fin);
      }
    }
  });
});

describe("billingPeriodKey", () => {
  it("es la fecha UTC de inicio del período", () => {
    expect(billingPeriodKey(at("2026-09-20T10:00:00Z"), 15)).toBe("2026-09-15");
    expect(billingPeriodKey(at("2026-09-10T10:00:00Z"), 15)).toBe("2026-08-15");
  });

  it("NO es el mes calendario: con ancla 15 el período cruza dos meses", () => {
    // La razón por la que `YYYY-MM` no sirve. Estas dos fechas están en meses
    // distintos y en el **mismo** ciclo de facturación.
    expect(billingPeriodKey(at("2026-09-20T00:00:00Z"), 15)).toBe(
      billingPeriodKey(at("2026-10-10T00:00:00Z"), 15),
    );
  });

  it("ordena cronológicamente como texto", () => {
    // Es lo que permite usar el índice `(companyId, period)` para "el período
    // anterior" sin parsear la clave.
    const claves = [
      billingPeriodKey(at("2026-01-20T00:00:00Z"), 15),
      billingPeriodKey(at("2026-02-20T00:00:00Z"), 15),
      billingPeriodKey(at("2026-10-20T00:00:00Z"), 15),
    ];
    expect([...claves].sort()).toEqual(claves);
  });

  it("el recorte del ancla 31 no produce claves repetidas", () => {
    // Enero da 31, febrero 28, marzo 31. Días distintos, meses distintos: no
    // colisionan. Era el caso que había que comprobar antes de elegir el
    // formato, no después.
    const claves = new Set<string>();
    for (let mes = 0; mes < 24; mes += 1) {
      const now = new Date(Date.UTC(2026, mes, 1, 12));
      claves.add(billingPeriodKey(now, 31));
    }
    expect(claves.size).toBe(24);
  });
});
