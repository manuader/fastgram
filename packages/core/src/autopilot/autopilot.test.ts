import { describe, expect, it } from "vitest";

import type { NetworkPlan } from "../scheduling/auto-slot.js";
import {
  AUTOPILOT_QUEUE_TARGET_MAX,
  AUTOPILOT_QUEUE_TARGET_MIN,
  autopilotAcceptCapacity,
  autopilotBrandJobKey,
  autopilotQueueTarget,
  localDateOf,
  localDayRange,
  parseAutopilotJob,
  parseLocalDate,
} from "./policy.js";
import {
  AUTOPILOT_PRECHECK_QUESTIONS,
  PRECHECK_THRESHOLDS,
  buildPrecheckState,
  decideAutopilot,
  evaluatePrecheck,
  parseStoredPrecheckAnswers,
  type PrecheckAnswers,
} from "../judgment/preflight.js";

const net = (
  network: NetworkPlan["network"],
  perDay: number,
  enabled = true,
  dailyCap = 3,
): NetworkPlan => ({ network, enabled, perDay, dailyCap });

describe("objetivo de la cola (PU-AUTO-001)", () => {
  it("piezas/día × redes activas × horizonte", () => {
    // 2 redes × 3 por día × 2 días.
    expect(autopilotQueueTarget([net("instagram", 3), net("tiktok", 3)])).toBe(12);
    // Una red apagada no cuenta; el tope anti-bot recorta perDay.
    expect(
      autopilotQueueTarget([
        net("instagram", 3),
        net("x", 3, false),
        net("tiktok", 3, true, 2),
      ]),
    ).toBe(10);
  });

  it("nunca por debajo de 5 (Blitz sigue necesitando tarjetas) ni por encima de 30", () => {
    expect(autopilotQueueTarget([])).toBe(AUTOPILOT_QUEUE_TARGET_MIN);
    expect(autopilotQueueTarget([net("instagram", 1)])).toBe(5);
    const all = (["instagram", "tiktok", "x", "threads", "facebook"] as const).map((n) =>
      net(n, 3),
    );
    expect(autopilotQueueTarget(all)).toBe(AUTOPILOT_QUEUE_TARGET_MAX);
  });

  it("el horizonte es parámetro", () => {
    expect(autopilotQueueTarget([net("instagram", 3), net("tiktok", 3)], 3)).toBe(18);
  });
});

describe("cupo de aprobación del piloto", () => {
  const now = Date.UTC(2026, 8, 24, 12);
  const H = 3_600_000;

  it("cupo diario × horizonte − lo ya programado, por red; gana la red con más lugar", () => {
    const networks = [net("instagram", 2), net("tiktok", 1)];
    expect(autopilotAcceptCapacity({ networks, nowMs: now, scheduled: [] })).toBe(4);
    const scheduled = [
      { network: "instagram", atMs: now + 1 * H },
      { network: "instagram", atMs: now + 20 * H },
      { network: "instagram", atMs: now + 30 * H },
      { network: "tiktok", atMs: now + 2 * H },
    ];
    // instagram 4 − 3 = 1; tiktok 2 − 1 = 1.
    expect(autopilotAcceptCapacity({ networks, nowMs: now, scheduled })).toBe(1);
  });

  it("lo que está fuera del horizonte, en el pasado o en otra red no ocupa", () => {
    const networks = [net("instagram", 1)];
    const scheduled = [
      { network: "instagram", atMs: now - H },
      { network: "instagram", atMs: now + 49 * H },
      { network: "x", atMs: now + H },
    ];
    expect(autopilotAcceptCapacity({ networks, nowMs: now, scheduled })).toBe(2);
  });

  it("lleno = 0, nunca negativo; sin redes activas = 0", () => {
    const scheduled = Array.from({ length: 9 }, (_u, i) => ({
      network: "instagram",
      atMs: now + (i + 1) * H,
    }));
    expect(
      autopilotAcceptCapacity({ networks: [net("instagram", 1)], nowMs: now, scheduled }),
    ).toBe(0);
    expect(
      autopilotAcceptCapacity({
        networks: [net("instagram", 1, false)],
        nowMs: now,
        scheduled: [],
      }),
    ).toBe(0);
  });
});

describe("el job", () => {
  it("{} es el barrido; {companyId} una marca; basura es null", () => {
    expect(parseAutopilotJob({})).toEqual({ kind: "sweep" });
    expect(parseAutopilotJob(null)).toEqual({ kind: "sweep" });
    const id = "0b9c2f3e-8a1d-4c55-9e1a-2f3b4c5d6e7f";
    expect(parseAutopilotJob({ companyId: id })).toEqual({
      kind: "brand",
      companyId: id,
    });
    expect(parseAutopilotJob({ companyId: "no-uuid" })).toBeNull();
    expect(parseAutopilotJob([1])).toBeNull();
  });

  it("la clave rota cada 15 min (trampas 39 y 45) y es estable dentro de la ventana", () => {
    const t = Date.UTC(2026, 8, 24, 12, 0, 0);
    const a = autopilotBrandJobKey("automation-generation", "c", t);
    expect(autopilotBrandJobKey("automation-generation", "c", t + 14 * 60_000)).toBe(a);
    expect(autopilotBrandJobKey("automation-generation", "c", t + 15 * 60_000)).not.toBe(
      a,
    );
    expect(autopilotBrandJobKey("automation-generation", "d", t)).not.toBe(a);
  });
});

describe("días locales", () => {
  it("parsea fechas reales y rechaza las imposibles", () => {
    expect(parseLocalDate("2026-09-24")).toEqual({ year: 2026, month: 9, day: 24 });
    expect(parseLocalDate("2026-02-30")).toBeNull();
    expect(parseLocalDate("24/09/2026")).toBeNull();
  });

  it("el rango del día respeta la zona", () => {
    const d = { year: 2026, month: 9, day: 24 };
    const ba = localDayRange(d, "America/Argentina/Buenos_Aires");
    expect(new Date(ba.fromMs).toISOString()).toBe("2026-09-24T03:00:00.000Z");
    expect(ba.toMs - ba.fromMs).toBe(86_400_000);
    expect(localDateOf(Date.UTC(2026, 8, 25, 2), "America/Argentina/Buenos_Aires")).toBe(
      "2026-09-24",
    );
  });
});

/* ------------------------------------------------------------------------ *
 * Pre-chequeo
 * ------------------------------------------------------------------------ */

const good: PrecheckAnswers = {
  onBrand: { kind: "noul", probability: 0.9 },
  riskyClaims: {
    kind: "choice",
    value: "none",
    probabilities: {
      none: 0.95,
      health_claim: 0.02,
      financial_claim: 0.02,
      legal_claim: 0.01,
    },
    confidence: 0.9,
  },
  thirdPartyBrands: { kind: "noul", probability: 0.1 },
  coherent: { kind: "noul", probability: 0.9 },
  inLanguage: { kind: "noul", probability: 0.95 },
};

describe("pre-chequeo JV-3 del piloto (PU-AUTO-002)", () => {
  it("las preguntas son las del pedido, cerradas, con ids únicos", () => {
    const ids = AUTOPILOT_PRECHECK_QUESTIONS.map((q) => q.id);
    expect(ids).toEqual([
      "onBrand",
      "riskyClaims",
      "thirdPartyBrands",
      "coherent",
      "inLanguage",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ningún umbral viaja en el prompt (§9.15.3 regla 2)", () => {
    const text = JSON.stringify(AUTOPILOT_PRECHECK_QUESTIONS);
    for (const value of Object.values(PRECHECK_THRESHOLDS)) {
      expect(text).not.toContain(String(value));
    }
  });

  it("una pieza sana pasa", () => {
    expect(evaluatePrecheck(good)).toEqual({ pass: true, reasons: [] });
    expect(decideAutopilot({ kind: "answered", answers: good })).toEqual({
      kind: "approve",
    });
  });

  it("cada pregunta puede rechazar sola, con su motivo", () => {
    const cases: [Partial<PrecheckAnswers>, string][] = [
      [{ onBrand: { kind: "noul", probability: 0.59 } }, "off_brand"],
      [{ thirdPartyBrands: { kind: "noul", probability: 0.5 } }, "third_party_brand"],
      [{ coherent: { kind: "noul", probability: 0.2 } }, "incoherent"],
      [{ inLanguage: { kind: "noul", probability: 0.1 } }, "wrong_language"],
    ];
    for (const [patch, reason] of cases) {
      expect(evaluatePrecheck({ ...good, ...patch }).reasons).toEqual([reason]);
    }
  });

  it("riesgo por masa, no por el argmax: none=0,65 igual rechaza, con la opción más probable", () => {
    const risky: PrecheckAnswers = {
      ...good,
      riskyClaims: {
        kind: "choice",
        value: "none",
        probabilities: {
          none: 0.65,
          health_claim: 0.05,
          financial_claim: 0.25,
          legal_claim: 0.05,
        },
        confidence: 0.5,
      },
    };
    expect(evaluatePrecheck(risky).reasons).toEqual(["financial_claim"]);
    // Recalcular con otro umbral no reinfiere: la misma respuesta ahora pasa.
    expect(
      evaluatePrecheck(risky, { ...PRECHECK_THRESHOLDS, riskyClaimMaxMass: 0.4 }).pass,
    ).toBe(true);
  });

  it("timeout o juicio caído → queda en la cola (hold), NUNCA aprueba", () => {
    expect(decideAutopilot({ kind: "timeout" })).toEqual({
      kind: "hold",
      reason: "judgment_timeout",
    });
    expect(
      decideAutopilot({ kind: "unavailable", code: "provider_unavailable" }),
    ).toEqual({
      kind: "hold",
      reason: "judgment_unavailable",
    });
  });

  it("lo guardado se relee y se recalcula igual; lo roto es null", () => {
    const stored: unknown = JSON.parse(JSON.stringify(good));
    const parsed = parseStoredPrecheckAnswers(stored);
    expect(parsed).not.toBeNull();
    expect(evaluatePrecheck(parsed as PrecheckAnswers)).toEqual(evaluatePrecheck(good));
    expect(parseStoredPrecheckAnswers({ ...good, onBrand: { kind: "noul" } })).toBeNull();
    expect(parseStoredPrecheckAnswers("x")).toBeNull();
  });

  it("el estado va filtrado y limpio (reglas 4 y 5)", () => {
    const state = buildPrecheckState({
      caption: "Hola‮mundo" + "x".repeat(5000),
      contentType: "wall-of-text",
      language: "es",
      brandName: "Acme",
      profile: { coreIdentity: "café", productOffering: null },
    });
    const caption = state["caption"] as string;
    expect(caption.startsWith("Holamundo")).toBe(true);
    expect(caption.length).toBe(2000);
    expect(Object.keys(state).sort()).toEqual([
      "brand",
      "caption",
      "contentType",
      "expectedLanguage",
    ]);
  });
});
