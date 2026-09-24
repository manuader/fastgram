import { describe, expect, it } from "vitest";

import {
  BAN_METER_THRESHOLDS,
  REPLY_TONE_QUESTION,
  buildReplyToneState,
  computeBanMeter,
  sendBlockedBy,
  toneFromAnswer,
  type ReplyTone,
  type SentReplyForMeter,
} from "./ban-meter.js";

const now = new Date("2026-09-24T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 3600 * 1000);

function replies(
  spec: Partial<Record<ReplyTone | "null", number>>,
  age = 1,
): SentReplyForMeter[] {
  const out: SentReplyForMeter[] = [];
  for (const [tone, n] of Object.entries(spec)) {
    for (let i = 0; i < (n ?? 0); i++) {
      out.push({
        sentAt: daysAgo(age),
        tone: tone === "null" ? null : (tone as ReplyTone),
      });
    }
  }
  return out;
}

describe("DP-003: el modelo sólo etiqueta; el nivel es código", () => {
  it("la pregunta es una sola, de tres valores, y no lleva umbrales", () => {
    expect(Object.keys(REPLY_TONE_QUESTION.criteria)).toEqual([
      "value_add",
      "subtle_mention",
      "direct_promo",
    ]);
    const text = JSON.stringify(REPLY_TONE_QUESTION);
    expect(text).not.toMatch(/\d+\s*%|0\.\d/);
    expect(text).not.toMatch(/safe|caution|warning|danger/i);
  });

  it("del juicio sale sólo la etiqueta (el `value`)", () => {
    expect(
      toneFromAnswer({
        kind: "choice",
        value: "subtle_mention",
        probabilities: { value_add: 0.2, subtle_mention: 0.7, direct_promo: 0.1 },
        confidence: 0.7,
      }),
    ).toBe("subtle_mention");
  });

  it("es determinista: misma entrada, misma lectura", () => {
    const r = replies({ value_add: 6, subtle_mention: 2, direct_promo: 2 });
    expect(computeBanMeter(r, now)).toEqual(computeBanMeter(r, now));
  });

  it("estado del juicio: {replyText, threadContext, brandName}, limpio", () => {
    const s = buildReplyToneState({
      replyText: "hi‮",
      threadContext: "t".repeat(5_000),
      brandName: "Acme",
    });
    expect(Object.keys(s).sort()).toEqual(["brandName", "replyText", "threadContext"]);
    expect(s["replyText"]).toBe("hi");
    expect((s["threadContext"] as string).length).toBe(1_500);
  });
});

describe("DP-003: niveles con umbrales explícitos", () => {
  it("sin respuestas: safe, ratio null", () => {
    const r = computeBanMeter([], now);
    expect(r.level).toBe("safe");
    expect(r.promoRatio).toBeNull();
  });

  it("guía del PRD (60-70 % valor, ≤ 20 % directa) → safe", () => {
    const r = computeBanMeter(
      replies({ value_add: 7, subtle_mention: 2, direct_promo: 1 }),
      now,
    );
    expect(r.promoRatio).toBe(0.3);
    expect(r.level).toBe("safe");
  });

  it("50 % promo con 30 % directa → caution", () => {
    const r = computeBanMeter(
      replies({ value_add: 5, subtle_mention: 2, direct_promo: 3 }),
      now,
    );
    expect(r.level).toBe("caution");
  });

  it("60 % promo → warning", () => {
    const r = computeBanMeter(
      replies({ value_add: 4, subtle_mention: 2, direct_promo: 4 }),
      now,
    );
    expect(r.promoRatio).toBe(0.6);
    expect(r.level).toBe("warning");
  });

  it("mayoría directa → danger, y danger bloquea Send", () => {
    const r = computeBanMeter(replies({ value_add: 2, direct_promo: 8 }), now);
    expect(r.level).toBe("danger");
    expect(sendBlockedBy(r.level)).toBe(true);
    expect(sendBlockedBy("warning")).toBe(false);
  });

  it("muestra chica: regla de conteo 3:1, nunca danger con pocas respuestas", () => {
    expect(computeBanMeter(replies({ direct_promo: 2 }), now).level).toBe("caution");
    expect(computeBanMeter(replies({ value_add: 3, subtle_mention: 1 }), now).level).toBe(
      "safe",
    );
    expect(computeBanMeter(replies({ value_add: 2, subtle_mention: 1 }), now).level).toBe(
      "caution",
    );
  });

  it("fuera de la ventana no cuenta; sin etiqueta no entra al ratio", () => {
    const old = replies({ direct_promo: 10 }, BAN_METER_THRESHOLDS.windowDays + 1);
    const r = computeBanMeter([...old, ...replies({ value_add: 5, null: 4 })], now);
    expect(r.level).toBe("safe");
    expect(r.counts).toEqual({ valueAdd: 5, subtle: 0, direct: 0, unlabeled: 4 });
    expect(r.sampleSize).toBe(5);
  });

  it("umbrales inyectables: cambiar un corte no reinfiere nada", () => {
    const r = replies({ value_add: 7, subtle_mention: 2, direct_promo: 1 });
    const strict = {
      ...BAN_METER_THRESHOLDS,
      safe: { promo: 0.2, direct: 0.05 },
      caution: { promo: 0.25, direct: 0.05 },
      warning: { promo: 0.28, direct: 0.05 },
    };
    expect(computeBanMeter(r, now).level).toBe("safe");
    expect(computeBanMeter(r, now, strict).level).toBe("danger");
  });
});
