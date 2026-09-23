import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import {
  AI_STUDIO_COST,
  HARD_CAPS,
  PLANS,
  UNKNOWN_LIMITS,
  hasUnlimitedSaves,
} from "./plans.js";
import {
  BLITZ_DAILY_SWIPE_LIMIT,
  TRIAL_CONTENT_ALLOWANCE,
  acceptBlitzSuggestion,
  consumeSave,
  currentSwipesLedger,
  trialAllowanceGoverns,
  consumeTrial,
  refundSave,
  releaseCredits,
  reserveCredits,
  savesRemaining,
  type SavesLedger,
  type SwipesLedger,
} from "./content-saves.js";
import { isExpired, nextBillingResetUtc, nextDailyResetUtc } from "./reset.js";

const RESET = new Date("2026-10-01T00:00:00.000Z");

const saves = (over: Partial<SavesLedger> = {}): SavesLedger => ({
  plan: "starter",
  includedUsed: 0,
  purchasedRemaining: 0,
  overageUsed: 0,
  overageEnabled: false,
  resetAt: RESET,
  ...over,
});

// ───────────────────────────────────────────────────────────────────────────

describe("planes del PRD §16.1 — los números son literales de la fuente oficial", () => {
  it("precios", () => {
    expect(PLANS.free.monthlyPriceCents).toBe(0);
    expect(PLANS.starter.monthlyPriceCents).toBe(2_900);
    expect(PLANS.growth.monthlyPriceCents).toBe(4_900);
    expect(PLANS.pro.monthlyPriceCents).toBe(14_900);
  });

  it("content saves: 20 Starter, 100 Growth, ilimitado Pro", () => {
    expect(PLANS.starter.contentSaves).toBe(20);
    expect(PLANS.growth.contentSaves).toBe(100);
    expect(PLANS.pro.contentSaves).toBeNull();
    expect(hasUnlimitedSaves("pro")).toBe(true);
    expect(hasUnlimitedSaves("growth")).toBe(false);
  });

  it("créditos de AI Studio: 10 / 250 / 500 / 2000", () => {
    expect(PLANS.free.aiStudioCredits).toBe(10);
    expect(PLANS.starter.aiStudioCredits).toBe(250);
    expect(PLANS.growth.aiStudioCredits).toBe(500);
    expect(PLANS.pro.aiStudioCredits).toBe(2_000);
  });

  it("workspaces: 1 / 1 / 3 / 10", () => {
    expect(PLANS.starter.workspaces).toBe(1);
    expect(PLANS.growth.workspaces).toBe(3);
    expect(PLANS.pro.workspaces).toBe(10);
  });

  it("coste en créditos por operación", () => {
    expect(AI_STUDIO_COST).toEqual({
      image: 4,
      video: 60,
      influencer: 250,
      baseImage: 4,
    });
  });

  it("caps técnicos del PRD §16.2 y §5", () => {
    expect(HARD_CAPS.contentAngles).toBe(100);
    expect(HARD_CAPS.anglesPerInfluencer).toBe(10);
    expect(HARD_CAPS.activeInfluencers).toBe(50);
    expect(HARD_CAPS.slidesPerSlideshow).toBe(20);
    expect(HARD_CAPS.inFlightGenerations).toBe(10);
    expect(HARD_CAPS.idsPerBatch).toBe(100);
    expect(HARD_CAPS.brandSources).toBe(5);
    expect(HARD_CAPS.itemsPerBrandAnalysis).toBe(24);
  });

  it("lo que el PRD marca UNKNOWN sigue siendo null, no un número a ojo", () => {
    // Si alguien pone un número acá sin verificarlo contra la fuente, este
    // test lo frena. Es la diferencia entre "no lo sabemos" y "lo inventamos".
    expect(UNKNOWN_LIMITS.apiKeysPerWorkspace).toBeNull();
    expect(UNKNOWN_LIMITS.connectionsPerWorkspace).toBeNull();
    expect(UNKNOWN_LIMITS.freeContentSaves).toBeNull();
    expect(UNKNOWN_LIMITS.storageBytesPerPlan).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe("orden de consumo: incluidos → comprados → overage (PRD §16.2)", () => {
  it("gasta primero los incluidos", () => {
    const r = consumeSave(saves({ purchasedRemaining: 5 }));
    expect(r.bucket).toBe("included");
    expect(r.ledger.includedUsed).toBe(1);
    expect(r.ledger.purchasedRemaining).toBe(5);
  });

  it("pasa a los comprados recién cuando se agotan los incluidos", () => {
    // El orden no es arbitrario: los incluidos caducan al cerrar el período y
    // los comprados no. Al revés, se le quema al cliente saldo permanente
    // mientras deja vencer saldo que ya pagó.
    const r = consumeSave(saves({ includedUsed: 20, purchasedRemaining: 5 }));
    expect(r.bucket).toBe("purchased");
    expect(r.ledger.purchasedRemaining).toBe(4);
  });

  it("con overage habilitado, sigue facturando por encima", () => {
    const r = consumeSave(saves({ includedUsed: 20, overageEnabled: true }));
    expect(r.bucket).toBe("overage");
    expect(r.ledger.overageUsed).toBe(1);
  });

  it("sin overage, agotada la cuota corta con content_quota_exceeded", () => {
    // PRD §16.6: con el toggle desactivado devuelven `content_quota_exceeded`.
    try {
      consumeSave(saves({ includedUsed: 20 }));
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      const d = e as DomainError;
      expect(d.code).toBe("content_quota_exceeded");
      // El PRD exige `resetAt` en el error de esta cuota.
      expect(d.details?.["resetAt"]).toBe(RESET.toISOString());
    }
  });

  it("Pro no lleva contador ni factura overage", () => {
    const l = saves({ plan: "pro", includedUsed: 0 });
    const r = consumeSave(l);
    expect(r.ledger).toEqual(l);
    expect(savesRemaining(l)).toBeNull();
  });

  it("savesRemaining suma incluidos restantes más comprados", () => {
    expect(savesRemaining(saves({ includedUsed: 15, purchasedRemaining: 3 }))).toBe(8);
    expect(savesRemaining(saves({ includedUsed: 20, purchasedRemaining: 3 }))).toBe(3);
  });
});

describe("reembolso por build fallido (PRD §16.2)", () => {
  it("devuelve al bucket del que salió, no siempre a incluidos", () => {
    // Reembolsar siempre a `included` le regalaría al cliente un save que
    // caduca mientras le come uno permanente.
    const antes = saves({ includedUsed: 20, purchasedRemaining: 4 });
    const { ledger, bucket } = consumeSave(antes);
    expect(bucket).toBe("purchased");

    expect(refundSave(ledger, bucket)).toEqual(antes);
  });

  it("consumir y reembolsar deja el ledger como estaba, en los tres buckets", () => {
    for (const antes of [
      saves(),
      saves({ includedUsed: 20, purchasedRemaining: 4 }),
      saves({ includedUsed: 20, overageEnabled: true }),
    ]) {
      const { ledger, bucket } = consumeSave(antes);
      expect(refundSave(ledger, bucket)).toEqual(antes);
    }
  });

  it("un reembolso no puede dejar el contador en negativo", () => {
    // Defensa contra un doble reembolso del mismo build.
    expect(refundSave(saves({ includedUsed: 0 }), "included").includedUsed).toBe(0);
    expect(refundSave(saves({ overageUsed: 0 }), "overage").overageUsed).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe("Blitz: el gate de saves se evalúa ANTES que el de swipes (PRD §16.2)", () => {
  const swipes = (over: Partial<SwipesLedger> = {}): SwipesLedger => ({
    dailyLimit: 30,
    used: 0,
    resetAt: RESET,
    ...over,
  });

  it("sin saves NO gasta el swipe", () => {
    // Si cobrara el swipe primero, el usuario perdería un swipe diario por una
    // operación que iba a fallar igual — y no lo recupera hasta mañana.
    const s = swipes();
    expect(() => acceptBlitzSuggestion(saves({ includedUsed: 20 }), s)).toThrow(
      DomainError,
    );
    expect(s.used).toBe(0);
  });

  it("sin saves devuelve blitz_quota_blocked, no content_quota_exceeded", () => {
    try {
      acceptBlitzSuggestion(saves({ includedUsed: 20 }), swipes());
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).code).toBe("blitz_quota_blocked");
    }
  });

  it("con saves pero sin swipes, corta por swipes", () => {
    try {
      acceptBlitzSuggestion(saves(), swipes({ used: 30 }));
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      const d = e as DomainError;
      expect(d.code).toBe("blitz_quota_blocked");
      expect(d.details?.["resetAt"]).toBe(RESET.toISOString());
    }
  });

  it("el corte por saves dice `quotaType: saves` y trae count/limit de ERR-R03", () => {
    // El borde traduce a `429 content_quota_exceeded` con `count`, `limit` y
    // `resetAt`. Sin `quotaType` no podría distinguirlo del corte por swipes:
    // los dos llevan `resetAt` y nada más en común.
    try {
      acceptBlitzSuggestion(saves({ includedUsed: 20 }), swipes());
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).details).toEqual({
        quotaType: "saves",
        resetAt: RESET.toISOString(),
        count: 20,
        limit: PLANS.starter.contentSaves,
      });
    }
  });

  it("el corte por swipes dice `quotaType: swipes`", () => {
    try {
      acceptBlitzSuggestion(saves(), swipes({ used: 30 }));
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).details?.["quotaType"]).toBe("swipes");
    }
  });

  it("`dailyLimit: null` no corta nunca, pero cuenta igual (PRD §2.4, 2026-09-23)", () => {
    // "El swipe se cuenta pero no se limita." Un contador enorme no corta, y
    // el swipe sube igual: el dato para calibrar el límite futuro tiene que
    // existir desde hoy.
    const r = acceptBlitzSuggestion(
      saves(),
      swipes({ dailyLimit: null, used: 1_000_000 }),
    );
    expect(r.swipes.used).toBe(1_000_001);
  });

  it("sin límite, igual se evalúan los saves primero", () => {
    expect(() =>
      acceptBlitzSuggestion(saves({ includedUsed: 20 }), swipes({ dailyLimit: null })),
    ).toThrow(DomainError);
  });

  it("con ambas cuotas, consume una de cada una", () => {
    const r = acceptBlitzSuggestion(saves(), swipes());
    expect(r.saves.includedUsed).toBe(1);
    expect(r.swipes.used).toBe(1);
    expect(r.bucket).toBe("included");
  });
});

describe("swipes: la configuración provisoria y el reset en lectura", () => {
  it("el límite configurado es `null`, que significa sin límite — no un número mágico", () => {
    // PRD §2.4 (2026-09-23). Si alguien pone un número acá, este test tiene que
    // caer junto con la actualización del PRD: son los dos pasos, no uno.
    expect(BLITZ_DAILY_SWIPE_LIMIT).toBeNull();
  });

  const NOW = new Date("2026-09-23T15:00:00.000Z");

  it("con el reset guardado en el futuro, el contador vigente es el guardado", () => {
    const l = currentSwipesLedger({
      storedUsed: 7,
      storedResetAt: new Date("2026-09-24T00:00:00.000Z"),
      now: NOW,
      dailyLimit: null,
    });
    expect(l.used).toBe(7);
    expect(l.resetAt).toEqual(nextDailyResetUtc(NOW));
  });

  it("con el reset vencido, vale 0 aunque el barrido no haya corrido", () => {
    const l = currentSwipesLedger({
      storedUsed: 7,
      storedResetAt: new Date("2026-09-23T00:00:00.000Z"),
      now: NOW,
      dailyLimit: 5,
    });
    expect(l.used).toBe(0);
    expect(l.dailyLimit).toBe(5);
  });

  it("justo en el instante del reset ya vale 0 (el borde es de mañana, no de hoy)", () => {
    const edge = new Date("2026-09-24T00:00:00.000Z");
    const l = currentSwipesLedger({
      storedUsed: 7,
      storedResetAt: edge,
      now: edge,
      dailyLimit: null,
    });
    expect(l.used).toBe(0);
    expect(l.resetAt).toEqual(new Date("2026-09-25T00:00:00.000Z"));
  });

  it("sin reset guardado (nunca swipeó), vale 0", () => {
    expect(
      currentSwipesLedger({
        storedUsed: 3,
        storedResetAt: null,
        now: NOW,
        dailyLimit: null,
      }).used,
    ).toBe(0);
  });
});

describe("trial allowance: quién lo tiene y si se sabe el número", () => {
  it("gobierna al plan Free, y a ningún plan pago", () => {
    expect(trialAllowanceGoverns("free")).toBe(true);
    expect(trialAllowanceGoverns("starter")).toBe(false);
    expect(trialAllowanceGoverns("growth")).toBe(false);
    expect(trialAllowanceGoverns("pro")).toBe(false);
  });

  it("el tope es desconocido (`null`), el mismo hueco que `freeContentSaves`", () => {
    // §16.1: "Limited content", sin número. Si aparece, se cambia en
    // `UNKNOWN_LIMITS` y en el PRD a la vez, y este test cae para avisar.
    expect(TRIAL_CONTENT_ALLOWANCE).toBeNull();
    expect(TRIAL_CONTENT_ALLOWANCE).toBe(UNKNOWN_LIMITS.freeContentSaves);
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe("créditos de AI Studio", () => {
  const credits = { remaining: 250, resetAt: RESET };

  it("cobra el coste exacto por operación", () => {
    expect(reserveCredits(credits, "image").remaining).toBe(246);
    expect(reserveCredits(credits, "video").remaining).toBe(190);
    expect(reserveCredits(credits, "influencer").remaining).toBe(0);
  });

  it("cobra por unidad en lote", () => {
    expect(reserveCredits(credits, "image", 10).remaining).toBe(210);
  });

  it("rechaza si no alcanza, e informa cuánto hacía falta", () => {
    try {
      reserveCredits({ remaining: 59, resetAt: RESET }, "video");
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      const d = e as DomainError;
      expect(d.code).toBe("content_quota_exceeded");
      expect(d.details?.["required"]).toBe(60);
    }
  });

  it("reservar y liberar deja el saldo igual", () => {
    const reservado = reserveCredits(credits, "influencer");
    expect(releaseCredits(reservado, "influencer")).toEqual(credits);
  });
});

describe("trial allowance — de por vida, sin reset (PRD §16.2, §16.7)", () => {
  it("consume hasta el límite", () => {
    expect(consumeTrial({ lifetimeLimit: 3, used: 0 }).used).toBe(1);
  });

  it("agotado, el error va SIN resetAt", () => {
    // No hay ninguno. Un `resetAt` inventado le diría al usuario que espere a
    // una fecha en la que no va a pasar nada.
    try {
      consumeTrial({ lifetimeLimit: 3, used: 3 });
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      const d = e as DomainError;
      expect(d.code).toBe("content_quota_exceeded");
      expect(d.details?.["resetAt"]).toBeUndefined();
      expect(d.details?.["trial"]).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe("resets (PRD §16.2)", () => {
  it("el diario cae en el siguiente 00:00 UTC", () => {
    expect(nextDailyResetUtc(new Date("2026-03-15T23:59:59.999Z")).toISOString()).toBe(
      "2026-03-16T00:00:00.000Z",
    );
    // Justo en medianoche, el siguiente es el de mañana: es "estrictamente
    // posterior", si no el contador se reiniciaría dos veces.
    expect(nextDailyResetUtc(new Date("2026-03-16T00:00:00.000Z")).toISOString()).toBe(
      "2026-03-17T00:00:00.000Z",
    );
  });

  it("el de facturación cae en el día ancla, 00:00 UTC", () => {
    expect(nextBillingResetUtc(new Date("2026-03-10T12:00:00Z"), 15).toISOString()).toBe(
      "2026-03-15T00:00:00.000Z",
    );
    expect(nextBillingResetUtc(new Date("2026-03-20T12:00:00Z"), 15).toISOString()).toBe(
      "2026-04-15T00:00:00.000Z",
    );
  });

  it("un ancla en 31 cae en el último día de febrero, no desborda a marzo", () => {
    // `new Date(año, 1, 31)` da el 3 de marzo. Ese desborde le da al cliente
    // un período más corto un mes y más largo al siguiente, y el error se
    // descubre en la factura.
    expect(nextBillingResetUtc(new Date("2026-02-01T00:00:00Z"), 31).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
    // 2028 es bisiesto.
    expect(nextBillingResetUtc(new Date("2028-02-01T00:00:00Z"), 31).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  it("un ancla en 31 en un mes de 30 cae en el 30", () => {
    expect(nextBillingResetUtc(new Date("2026-04-01T00:00:00Z"), 31).toISOString()).toBe(
      "2026-04-30T00:00:00.000Z",
    );
  });

  it("cruza el año", () => {
    expect(nextBillingResetUtc(new Date("2026-12-20T00:00:00Z"), 5).toISOString()).toBe(
      "2027-01-05T00:00:00.000Z",
    );
  });

  it("rechaza un ancla fuera de rango", () => {
    expect(() => nextBillingResetUtc(new Date(), 0)).toThrow(/anchorDay/);
    expect(() => nextBillingResetUtc(new Date(), 32)).toThrow(/anchorDay/);
  });

  it("isExpired compara contra el reloj, no contra un job", () => {
    const last = new Date("2026-03-01T00:00:00Z");
    const next = new Date("2026-04-01T00:00:00Z");
    expect(isExpired(last, next, new Date("2026-03-31T23:59:59Z"))).toBe(false);
    expect(isExpired(last, next, new Date("2026-04-01T00:00:00Z"))).toBe(true);
  });
});
