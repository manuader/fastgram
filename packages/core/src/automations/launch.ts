/**
 * `launchValidation` — `F-216`, `FR-150`, `P3-AUTO-009`.
 *
 * *"`launchValidation` enumera **todos** los gates incumplidos antes de
 * permitir lanzar"* (criterio de aceptación 2): no corta en el primero. Es
 * aritmética de estado y cuotas (PRD §24: *"Estado y cuotas. Código."*), así
 * que es puro.
 *
 * | Gate                       | Copy del PRD                                   |
 * |----------------------------|------------------------------------------------|
 * | `not_in_review`            | (la campaña no está en revisión)               |
 * | `content_generating`       | `Content is still generating`                  |
 * | `no_ready_slots`           | (nada que lanzar)                              |
 * | `no_destinations`          | (sin cuentas)                                  |
 * | `destination_unavailable`  | (conexión borrada, de otra red o desconectada) |
 * | `schedule_in_past`         | `Adjust schedule`                              |
 * | `posting_limit_conflicts`  | `Posting limit conflicts`                      |
 * | `youtube_slideshow`        | (defensa: la generación ya lo impide)          |
 * | `content_budget`           | `More content saves needed`                    |
 * | `ai_label_unsupported`     | `No current campaign destination supports this label.` |
 *
 * Los gates de cuentas warmed (`More warmed-account post slots needed`,
 * `Warmed accounts not available on trial`) **no aplican**: en uso personal no
 * hay cuentas warmed ni trial (`D-06`).
 *
 * `content_budget` sólo existe con la política `enforced`. En modo personal
 * el launch **registra** los saves en el ledger igual (se ven en el uso) pero
 * no los corta.
 */
import { civilDateOf, civilKey } from "../scheduling/zoned-time.js";
import { ANTI_BOT_DAILY_CAP_DEFAULT } from "../scheduling/auto-slot.js";
import type { BlitzContentType } from "../content/content.js";
import {
  GENERATING_SLOT_STATUSES,
  accountProblems,
  type AccountProblem,
  type AutomationAccount,
  type AutomationPlatform,
  type AutomationSlotStatus,
  type AutomationStatus,
  type ConnectionFact,
} from "./model.js";

/** Margen mínimo entre "ahora" y el primer slot que se lanza. */
export const LAUNCH_MIN_LEAD_MS = 10 * 60_000;

/** Redes con etiqueta de contenido IA (`FR-150`, disclaimers del wizard). */
export const AI_LABEL_PLATFORMS: readonly AutomationPlatform[] = ["instagram", "tiktok"];

export const LAUNCH_GATE_CODES = [
  "not_in_review",
  "content_generating",
  "no_ready_slots",
  "no_destinations",
  "destination_unavailable",
  "schedule_in_past",
  "posting_limit_conflicts",
  "youtube_slideshow",
  "content_budget",
  "ai_label_unsupported",
] as const;
export type LaunchGateCode = (typeof LAUNCH_GATE_CODES)[number];

export interface LaunchGate {
  readonly code: LaunchGateCode;
  /** Datos para que la UI arme el mensaje (conteos, días, redes). */
  readonly details: Readonly<Record<string, unknown>>;
}

export interface LaunchValidation {
  readonly ok: boolean;
  readonly checkedAt: number;
  readonly gates: readonly LaunchGate[];
  readonly summary: {
    readonly readySlots: number;
    readonly destinations: number;
    /** Posts que se van a reservar: slots listos × destinos. */
    readonly posts: number;
    /** Saves que el launch registra (uno por pieza). */
    readonly contentSaves: number;
  };
}

export interface LaunchSlotFact {
  readonly id: string;
  readonly status: AutomationSlotStatus;
  readonly contentType: BlitzContentType;
  readonly scheduledAtMs: number | null;
}

export interface OccupiedFact {
  readonly network: string;
  readonly atMs: number;
}

export interface LaunchGateInput {
  readonly status: AutomationStatus;
  readonly slots: readonly LaunchSlotFact[];
  readonly accounts: readonly AutomationAccount[];
  readonly connections: readonly ConnectionFact[];
  readonly aiContentDisclaimer: boolean;
  readonly nowMs: number;
  /** Zona de la marca: el "día" del tope anti-bot es el suyo. */
  readonly brandTimezone: string;
  /** Tope por red y día de la estrategia. Ausente = {@link ANTI_BOT_DAILY_CAP_DEFAULT}. */
  readonly dailyCaps: Readonly<Partial<Record<string, number>>>;
  /** Lo que la marca ya tiene en el calendario (sin esta campaña). */
  readonly occupied: readonly OccupiedFact[];
  readonly saves:
    | { readonly policy: "unlimited" }
    | { readonly policy: "enforced"; readonly remaining: number | null };
}

export function evaluateLaunchGates(input: LaunchGateInput): LaunchValidation {
  const gates: LaunchGate[] = [];
  const ready = input.slots.filter((s) => s.status === "READY");
  const platforms = [...new Set(input.accounts.map((a) => a.platform))];

  if (input.status !== "REVIEW")
    gates.push({ code: "not_in_review", details: { status: input.status } });

  const generating = input.slots.filter((s) =>
    GENERATING_SLOT_STATUSES.includes(s.status),
  );
  if (generating.length > 0)
    gates.push({ code: "content_generating", details: { slots: generating.length } });

  if (ready.length === 0) gates.push({ code: "no_ready_slots", details: {} });

  if (input.accounts.length === 0) gates.push({ code: "no_destinations", details: {} });

  const problems: AccountProblem[] = accountProblems(input.accounts, input.connections);
  if (problems.length > 0)
    gates.push({
      code: "destination_unavailable",
      details: {
        problems: problems.map((p) => ({ platform: p.platform, reason: p.kind })),
      },
    });

  const past = ready.filter(
    (s) => s.scheduledAtMs === null || s.scheduledAtMs < input.nowMs + LAUNCH_MIN_LEAD_MS,
  );
  if (past.length > 0)
    gates.push({ code: "schedule_in_past", details: { slotIds: past.map((s) => s.id) } });

  // Tope por red y día local de la marca: lo de la campaña + lo que ya hay.
  const conflicts: { platform: string; day: string; count: number; cap: number }[] = [];
  for (const platform of platforms) {
    const cap = input.dailyCaps[platform] ?? ANTI_BOT_DAILY_CAP_DEFAULT;
    const perDay = new Map<string, number>();
    const add = (atMs: number): void => {
      const day = civilKey(civilDateOf(atMs, input.brandTimezone));
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    };
    for (const s of ready) if (s.scheduledAtMs !== null) add(s.scheduledAtMs);
    for (const o of input.occupied) if (o.network === platform) add(o.atMs);
    for (const [day, count] of [...perDay.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (count > cap) conflicts.push({ platform, day, count, cap });
    }
  }
  if (conflicts.length > 0)
    gates.push({ code: "posting_limit_conflicts", details: { conflicts } });

  if (platforms.includes("youtube")) {
    const slideshows = ready.filter((s) => s.contentType === "slideshow");
    if (slideshows.length > 0)
      gates.push({
        code: "youtube_slideshow",
        details: { slotIds: slideshows.map((s) => s.id) },
      });
  }

  if (
    input.saves.policy === "enforced" &&
    input.saves.remaining !== null &&
    input.saves.remaining < ready.length
  ) {
    gates.push({
      code: "content_budget",
      details: { needed: ready.length, remaining: input.saves.remaining },
    });
  }

  if (
    input.aiContentDisclaimer &&
    !platforms.some((p) => AI_LABEL_PLATFORMS.includes(p))
  ) {
    gates.push({ code: "ai_label_unsupported", details: {} });
  }

  return {
    ok: gates.length === 0,
    checkedAt: input.nowMs,
    gates,
    summary: {
      readySlots: ready.length,
      destinations: input.accounts.length,
      posts: ready.length * input.accounts.length,
      contentSaves: ready.length,
    },
  };
}

/**
 * Lee un `launchValidation` guardado (`jsonb`). `null` si no tiene la forma:
 * la próxima consulta lo recalcula.
 */
export function parseLaunchValidation(raw: unknown): LaunchValidation | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["ok"] !== "boolean" || typeof r["checkedAt"] !== "number") return null;
  if (!Array.isArray(r["gates"])) return null;
  const gates: LaunchGate[] = [];
  for (const g of r["gates"] as unknown[]) {
    if (g === null || typeof g !== "object") return null;
    const code = (g as Record<string, unknown>)["code"];
    if (
      typeof code !== "string" ||
      !(LAUNCH_GATE_CODES as readonly string[]).includes(code)
    )
      return null;
    const details = (g as Record<string, unknown>)["details"];
    gates.push({
      code: code as LaunchGateCode,
      details:
        details !== null && typeof details === "object"
          ? (details as Record<string, unknown>)
          : {},
    });
  }
  const s = r["summary"];
  if (s === null || typeof s !== "object") return null;
  const sum = s as Record<string, unknown>;
  const n = (k: string): number => (typeof sum[k] === "number" ? (sum[k] as number) : 0);
  return {
    ok: r["ok"],
    checkedAt: r["checkedAt"],
    gates,
    summary: {
      readySlots: n("readySlots"),
      destinations: n("destinations"),
      posts: n("posts"),
      contentSaves: n("contentSaves"),
    },
  };
}
