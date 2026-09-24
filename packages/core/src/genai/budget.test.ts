import { describe, expect, it } from "vitest";

import {
  DEFAULT_MONTHLY_BUDGET_USD,
  EMPTY_SPEND_LEDGER,
  budgetSummary,
  monthKey,
  parseSpendLedger,
  releaseSpend,
  reserveSpend,
  resolveBudget,
  setBudget,
  settleSpend,
  type ReserveInput,
  type SpendLedger,
} from "./budget.js";

const NO_ENV = {};
const SEPT = "2026-09";

function input(id: string, usd: number, month = SEPT): ReserveInput {
  return {
    month,
    generationId: id,
    usd,
    provider: "fal",
    model: "fal-ai/flux/schnell",
    kind: "image",
    companyId: "c1",
    at: "2026-09-24T12:00:00.000Z",
  };
}

function reserveOk(ledger: SpendLedger, i: ReserveInput, env = NO_ENV): SpendLedger {
  const r = reserveSpend(ledger, i, env);
  if (!r.ok) throw new Error("expected reserve to fit");
  return r.next;
}

describe("monthKey", () => {
  it("es UTC: las 23:30 del 30/9 en Buenos Aires ya es octubre", () => {
    expect(monthKey(new Date("2026-09-30T23:59:59.999Z"))).toBe("2026-09");
    expect(monthKey(new Date("2026-10-01T02:30:00.000-03:00"))).toBe("2026-10");
    expect(monthKey(new Date("2027-01-01T00:00:00.000Z"))).toBe("2027-01");
  });
});

describe("resolveBudget", () => {
  it("Settings > FASTGRAM_MONTHLY_BUDGET_USD > default 30", () => {
    expect(resolveBudget(EMPTY_SPEND_LEDGER, NO_ENV)).toEqual({
      usd: DEFAULT_MONTHLY_BUDGET_USD,
      source: "default",
    });
    expect(
      resolveBudget(EMPTY_SPEND_LEDGER, { FASTGRAM_MONTHLY_BUDGET_USD: "45.5" }),
    ).toEqual({
      usd: 45.5,
      source: "env",
    });
    expect(
      resolveBudget(
        { ...EMPTY_SPEND_LEDGER, budgetUsd: 20 },
        { FASTGRAM_MONTHLY_BUDGET_USD: "45" },
      ),
    ).toEqual({ usd: 20, source: "settings" });
  });

  it("un valor raro en el entorno cae al default", () => {
    for (const bad of ["", "abc", "-5", "1e9", "10.123"]) {
      expect(
        resolveBudget(EMPTY_SPEND_LEDGER, { FASTGRAM_MONTHLY_BUDGET_USD: bad }).source,
      ).toBe("default");
    }
  });
});

describe("reserveSpend — el tope corta en el borde", () => {
  it("llegar exacto al tope entra; un diezmilésimo más, no", () => {
    let ledger: SpendLedger = { ...EMPTY_SPEND_LEDGER, budgetUsd: 1 };
    ledger = reserveOk(ledger, input("a", 0.6));
    ledger = reserveOk(ledger, input("b", 0.4));
    expect(budgetSummary(ledger, SEPT, NO_ENV).remainingUsd).toBe(0);
    const over = reserveSpend(ledger, input("c", 0.0001), NO_ENV);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("budget_exceeded");
  });

  it("sin errores de coma flotante: 10 × 0.1 = 1 exacto", () => {
    let ledger: SpendLedger = { ...EMPTY_SPEND_LEDGER, budgetUsd: 1 };
    for (let i = 0; i < 10; i++) ledger = reserveOk(ledger, input(`g${String(i)}`, 0.1));
    expect(budgetSummary(ledger, SEPT, NO_ENV).reservedUsd).toBe(1);
  });

  it("lo reservado en vuelo cuenta igual que lo cobrado", () => {
    let ledger: SpendLedger = { ...EMPTY_SPEND_LEDGER, budgetUsd: 1 };
    ledger = reserveOk(ledger, input("a", 0.7));
    ledger = settleSpend(ledger, SEPT, "a") ?? ledger;
    ledger = reserveOk(ledger, input("b", 0.3));
    expect(reserveSpend(ledger, input("c", 0.01), NO_ENV).ok).toBe(false);
    const s = budgetSummary(ledger, SEPT, NO_ENV);
    expect(s).toMatchObject({ chargedUsd: 0.7, reservedUsd: 0.3, generations: 2 });
  });

  it("reservar dos veces la misma generación no cuenta doble", () => {
    let ledger: SpendLedger = { ...EMPTY_SPEND_LEDGER, budgetUsd: 1 };
    ledger = reserveOk(ledger, input("a", 0.8));
    const again = reserveSpend(ledger, input("a", 0.8), NO_ENV);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.next).toBe(ledger);
  });

  it("un mes nuevo arranca en cero", () => {
    let ledger: SpendLedger = { ...EMPTY_SPEND_LEDGER, budgetUsd: 1 };
    ledger = reserveOk(ledger, input("a", 1));
    expect(reserveSpend(ledger, input("b", 0.5), NO_ENV).ok).toBe(false);
    const october = reserveSpend(ledger, input("b", 0.5, "2026-10"), NO_ENV);
    expect(october.ok).toBe(true);
    // Septiembre sigue en el archivo como historial.
    if (october.ok) expect(budgetSummary(october.next, SEPT, NO_ENV).reservedUsd).toBe(1);
  });

  it("el default de 30 aplica sin configuración", () => {
    expect(reserveSpend(EMPTY_SPEND_LEDGER, input("a", 30), NO_ENV).ok).toBe(true);
    expect(reserveSpend(EMPTY_SPEND_LEDGER, input("a", 30.01), NO_ENV).ok).toBe(false);
  });
});

describe("settle / release", () => {
  it("fallido o nsfw libera la reserva; listo la cobra; lo cobrado no se libera", () => {
    let ledger = reserveOk(EMPTY_SPEND_LEDGER, input("a", 0.5));
    ledger = reserveOk(ledger, input("b", 0.25));
    const released = releaseSpend(ledger, SEPT, "b");
    expect(released).not.toBeNull();
    ledger = released ?? ledger;
    ledger = settleSpend(ledger, SEPT, "a") ?? ledger;
    expect(budgetSummary(ledger, SEPT, NO_ENV)).toMatchObject({
      chargedUsd: 0.5,
      reservedUsd: 0,
    });
    expect(releaseSpend(ledger, SEPT, "a")).toBeNull();
    expect(settleSpend(ledger, SEPT, "a")).toBeNull();
    expect(settleSpend(ledger, SEPT, "missing")).toBeNull();
  });
});

describe("parseSpendLedger", () => {
  it("null = vacío; ida y vuelta por JSON; forma rara = null", () => {
    expect(parseSpendLedger(null)).toEqual(EMPTY_SPEND_LEDGER);
    const ledger = reserveOk({ ...EMPTY_SPEND_LEDGER, budgetUsd: 25 }, input("a", 0.25));
    expect(parseSpendLedger(JSON.parse(JSON.stringify(ledger)))).toEqual(ledger);
    expect(parseSpendLedger({ version: 2, months: {} })).toBeNull();
    expect(
      parseSpendLedger({ version: 1, budgetUsd: null, months: { "2026-13": {} } }),
    ).toBeNull();
    expect(
      parseSpendLedger({
        version: 1,
        budgetUsd: null,
        months: { [SEPT]: { a: { usd: -1 } } },
      }),
    ).toBeNull();
  });
});

describe("setBudget", () => {
  it("acepta centavos, rechaza negativos, fracciones de centavo y absurdos; null borra", () => {
    expect(setBudget(EMPTY_SPEND_LEDGER, 42.5).ok).toBe(true);
    expect(setBudget(EMPTY_SPEND_LEDGER, -1).ok).toBe(false);
    expect(setBudget(EMPTY_SPEND_LEDGER, 10.001).ok).toBe(false);
    expect(setBudget(EMPTY_SPEND_LEDGER, 1_000_000).ok).toBe(false);
    const cleared = setBudget({ ...EMPTY_SPEND_LEDGER, budgetUsd: 5 }, null);
    expect(cleared.ok && cleared.next.budgetUsd).toBeNull();
  });
});
