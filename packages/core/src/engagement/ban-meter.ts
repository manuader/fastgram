/**
 * Ban meter — `JV-5` / `DP-003` (PRD §25.3), `F-197`, `F-200`,
 * `P4-ENGAGE-009` y `P4-ENGAGE-010`.
 *
 * ## La frontera (⚠️ `P4-ENGAGE-010`)
 *
 * El modelo **sólo** etiqueta el tono de **una** respuesta enviada
 * ({@link REPLY_TONE_QUESTION}: `value_add` / `subtle_mention` /
 * `direct_promo`). Contar, el ratio, la ventana y el nivel (`safe` /
 * `caution` / `warning` / `danger`) son aritmética y viven acá
 * ({@link computeBanMeter}). §25.2: *"contar no es juzgar"*. Nada de este
 * archivo le pide un número a un modelo, y ninguna función acepta un nivel o
 * un ratio que venga de afuera.
 *
 * ## De dónde salen los umbrales
 *
 * El PRD (F-200, FR-140) da la guía literal de la UI de Fastlane: *"Aim for
 * 60-70% value, 20-30% subtle, 10-20% direct"* y *"at least 3-4 value-add
 * replies for every promotional one"*. No da los cortes entre niveles: los de
 * {@link BAN_METER_THRESHOLDS} son **decisión nuestra**, derivados de esa guía
 * y del lado conservador:
 *
 * - `safe`: promoción ≤ 40 % (valor ≥ 60 %) **y** directa ≤ 20 %.
 * - `caution`: promoción ≤ 50 % y directa ≤ 30 %.
 * - `warning`: promoción ≤ 65 % y directa ≤ 45 %.
 * - `danger`: el resto. **Bloquea "Send"** ({@link sendBlockedBy}).
 *
 * Con muestra chica (menos de {@link BAN_METER_THRESHOLDS.minSample}
 * respuestas etiquetadas) un solo mensaje movería el ratio de 0 a 100 %; ahí
 * rige la regla de conteo del PRD: `safe` si hay al menos 3 de valor por cada
 * promocional, si no `caution`. Nunca `danger` con dos mensajes.
 *
 * `promoRatio` (`DATA-025`) = (sutiles + directas) / etiquetadas en la
 * ventana. Las respuestas **sin etiqueta todavía** (el juicio no corrió o
 * falló) no entran en el ratio y se informan aparte (`unlabeled`): la UI dice
 * que el medidor está incompleto en vez de inventarles un tono.
 */
import type { ChoiceAnswer, ChoiceQuestion, JudgmentState } from "@fastgram/ports";

import { cleanStateText } from "../judgment/preflight.js";

export const REPLY_TONES = ["value_add", "subtle_mention", "direct_promo"] as const;
export type ReplyTone = (typeof REPLY_TONES)[number];

export function isReplyTone(value: unknown): value is ReplyTone {
  return typeof value === "string" && (REPLY_TONES as readonly string[]).includes(value);
}

/** `JV-5`: una pregunta, tres valores. */
export const REPLY_TONE_QUESTION: ChoiceQuestion<"promoLevel", ReplyTone> = {
  id: "promoLevel",
  kind: "choice",
  instructions:
    "How promotional is this Reddit reply about brandName, given the thread it answers?",
  criteria: {
    value_add:
      "Pure help: answers the question or adds useful information, and does not mention brandName or its product.",
    subtle_mention:
      "Mainly helpful, and mentions brandName or its product once, in passing, as one option among others or with disclosure.",
    direct_promo:
      "The reply exists to push brandName or its product: the recommendation is the main point, it repeats the pitch, or it asks people to sign up, buy or click.",
  },
};

export const REPLY_TONE_VERSION = "2026-09-24.1";

export interface ReplyToneSubject {
  readonly replyText: string;
  /** Título y cuerpo del post al que responde. */
  readonly threadContext: string;
  readonly brandName: string;
}

export const REPLY_TONE_STATE_LIMITS = {
  reply: 4_000,
  thread: 1_500,
  brand: 120,
} as const;

/** `JV-5` estado: `{replyText, threadContext, brandName}` (PRD), limpio y truncado. */
export function buildReplyToneState(subject: ReplyToneSubject): JudgmentState {
  const L = REPLY_TONE_STATE_LIMITS;
  return {
    replyText: cleanStateText(subject.replyText, L.reply),
    threadContext: cleanStateText(subject.threadContext, L.thread),
    brandName: cleanStateText(subject.brandName, L.brand),
  };
}

/** La etiqueta de una respuesta: el `value` del `choice`. Nada más sale del modelo. */
export function toneFromAnswer(answer: ChoiceAnswer<ReplyTone>): ReplyTone {
  return answer.value;
}

/* ------------------------------------------------------------------------ *
 * El medidor (código)
 * ------------------------------------------------------------------------ */

export const BAN_RISK_LEVELS = ["safe", "caution", "warning", "danger"] as const;
export type BanRiskLevel = (typeof BAN_RISK_LEVELS)[number];

export interface BanMeterThresholds {
  /** Ventana móvil hacia atrás desde `now`. */
  readonly windowDays: number;
  /** Menos etiquetadas que esto → regla de conteo del PRD. */
  readonly minSample: number;
  /** Respuestas de valor exigidas por cada promocional con muestra chica. */
  readonly valuePerPromo: number;
  /** Máximos de (promo, directa) por nivel, en [0, 1]. */
  readonly safe: { readonly promo: number; readonly direct: number };
  readonly caution: { readonly promo: number; readonly direct: number };
  readonly warning: { readonly promo: number; readonly direct: number };
}

/** Ver la cabecera: **decisión nuestra**, derivada de la guía de F-200. */
export const BAN_METER_THRESHOLDS: BanMeterThresholds = {
  windowDays: 30,
  minSample: 5,
  valuePerPromo: 3,
  safe: { promo: 0.4, direct: 0.2 },
  caution: { promo: 0.5, direct: 0.3 },
  warning: { promo: 0.65, direct: 0.45 },
};

export interface SentReplyForMeter {
  readonly sentAt: Date;
  /** `null` = todavía sin etiquetar. */
  readonly tone: ReplyTone | null;
}

export interface BanMeterReading {
  readonly level: BanRiskLevel;
  /** (sutiles + directas) / etiquetadas. `null` sin etiquetadas. */
  readonly promoRatio: number | null;
  readonly counts: {
    readonly valueAdd: number;
    readonly subtle: number;
    readonly direct: number;
    readonly unlabeled: number;
  };
  /** Etiquetadas en la ventana. */
  readonly sampleSize: number;
  /** `true` si se usó la regla de conteo (muestra chica). */
  readonly smallSample: boolean;
  readonly windowDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;

/**
 * El nivel del medidor. **Pura**: la misma lista y el mismo `now` dan siempre
 * lo mismo. Es la única función que conoce los umbrales.
 */
export function computeBanMeter(
  replies: readonly SentReplyForMeter[],
  now: Date,
  thresholds: BanMeterThresholds = BAN_METER_THRESHOLDS,
): BanMeterReading {
  const since = now.getTime() - thresholds.windowDays * DAY_MS;
  let valueAdd = 0;
  let subtle = 0;
  let direct = 0;
  let unlabeled = 0;
  for (const r of replies) {
    const t = r.sentAt.getTime();
    if (t < since || t > now.getTime()) continue;
    switch (r.tone) {
      case "value_add":
        valueAdd++;
        break;
      case "subtle_mention":
        subtle++;
        break;
      case "direct_promo":
        direct++;
        break;
      case null:
        unlabeled++;
        break;
    }
  }
  const sample = valueAdd + subtle + direct;
  const promo = subtle + direct;
  const counts = { valueAdd, subtle, direct, unlabeled };
  const base = { counts, sampleSize: sample, windowDays: thresholds.windowDays };

  if (sample === 0) {
    return { ...base, level: "safe", promoRatio: null, smallSample: true };
  }
  const promoRatio = round4(promo / sample);
  if (sample < thresholds.minSample) {
    const ok = promo === 0 || valueAdd >= thresholds.valuePerPromo * promo;
    return { ...base, level: ok ? "safe" : "caution", promoRatio, smallSample: true };
  }
  const directRatio = direct / sample;
  const within = (lim: { promo: number; direct: number }): boolean =>
    promoRatio <= lim.promo && directRatio <= lim.direct;
  const level: BanRiskLevel = within(thresholds.safe)
    ? "safe"
    : within(thresholds.caution)
      ? "caution"
      : within(thresholds.warning)
        ? "warning"
        : "danger";
  return { ...base, level, promoRatio, smallSample: false };
}

/**
 * `Send` se bloquea en `danger`: la recomendación literal del PRD para ese
 * nivel es *"Stop replying through Fastlane"*. `warning` avisa y deja enviar
 * (el usuario confirma igual cada envío).
 */
export function sendBlockedBy(level: BanRiskLevel): boolean {
  return level === "danger";
}

/**
 * Código estable de la recomendación por nivel (`DATA-025.recommendation`).
 * La web lo traduce al texto literal del PRD; la base guarda el código, no la
 * prosa, para que cambiar el copy no deje filas con textos viejos.
 */
export function banMeterRecommendation(level: BanRiskLevel): string {
  return `engagement.banMeter.recommendation.${level}`;
}
