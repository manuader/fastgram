/**
 * Después del launch — `F-217`, `F-218`, `F-219`, `P3-AUTO-010`, `P3-AUTO-012`.
 *
 * El launch crea una pieza por slot `READY` (`BUILDING`, con su
 * `content-build`) y reserva un slot planificado por destino. De ahí en más:
 *
 * ```
 *   slot  QUEUED_BUILD ─(pieza BUILDING)→ BUILDING ─(CREATED)→ SCHEDULED
 *                                                  └(FAILED)→ FAILED
 *   campaña BUILDING ─(ningún slot construyendo, alguno SCHEDULED)→ ACTIVE
 *                    └(ninguno SCHEDULED)→ FAILED
 *           ACTIVE ─(pasó el último slot + gracia, sin posts pendientes)→ COMPLETED
 * ```
 *
 * Lo mira `automation-build-schedule` (cron + re-armado por campaña). La
 * publicación sigue el camino normal: el barrido de publicación convierte los
 * slots planificados en posts cuando la pieza está `CREATED`, y las guardas
 * anti-bot deciden al publicar.
 */
import type { AutomationSlotStatus, AutomationStatus } from "./model.js";

const HOUR_MS = 3_600_000;

/**
 * Cuánto después del último slot se da la campaña por terminada si no queda
 * nada pendiente. Un día: un post puede reprogramarse por la guarda de tope
 * diario al día siguiente (`guards.ts`, regla 2).
 */
export const AUTOMATION_COMPLETION_GRACE_MS = 24 * HOUR_MS;

/** Estados de post que todavía pueden salir: un cancel los revoca. */
export const AUTOMATION_REVOCABLE_POST_STATUSES = [
  "SCHEDULED",
  "BUILDING",
  "AWAITING_RECONNECT",
] as const;

/** Estados de post que todavía no terminaron (para `COMPLETED`). */
export const AUTOMATION_PENDING_POST_STATUSES = [
  "SCHEDULED",
  "BUILDING",
  "AWAITING_RECONNECT",
  "UPLOADING_TO_TIKTOK",
] as const;

export type BuildContentStatus = "BUILDING" | "CREATED" | "FAILED" | null;

/**
 * El estado de un slot lanzado según su pieza. `null` = la pieza ya no está
 * (borrada desde la Library): el slot no va a publicar nada → `FAILED`.
 */
export function slotStatusForContent(
  current: AutomationSlotStatus,
  content: BuildContentStatus,
): AutomationSlotStatus {
  if (current !== "QUEUED_BUILD" && current !== "BUILDING") return current;
  if (content === null || content === "FAILED") return "FAILED";
  if (content === "CREATED") return "SCHEDULED";
  return "BUILDING";
}

/** `BUILDING` → `ACTIVE` / `FAILED`, o se queda. */
export function automationStatusAfterBuilds(
  current: AutomationStatus,
  slots: readonly AutomationSlotStatus[],
): AutomationStatus {
  if (current !== "BUILDING") return current;
  if (slots.some((s) => s === "QUEUED_BUILD" || s === "BUILDING")) return "BUILDING";
  return slots.some((s) => s === "SCHEDULED") ? "ACTIVE" : "FAILED";
}

export interface CompletionFacts {
  readonly status: AutomationStatus;
  readonly lastSlotAtMs: number | null;
  readonly pendingPosts: number;
  readonly nowMs: number;
}

export function isAutomationComplete(facts: CompletionFacts): boolean {
  if (facts.status !== "ACTIVE") return false;
  if (facts.pendingPosts > 0) return false;
  if (facts.lastSlotAtMs === null) return true;
  return facts.nowMs >= facts.lastSlotAtMs + AUTOMATION_COMPLETION_GRACE_MS;
}

/**
 * Qué pasa con cada slot al cancelar (`cancel_automation`): todo lo que no
 * terminó queda `CANCELLED`. Un `SCHEDULED` cuyo post ya salió **se queda**
 * `SCHEDULED` (lo publicado sigue vivo); quien llama lo sabe mirando los posts.
 */
export function slotStatusOnCancel(
  current: AutomationSlotStatus,
  alreadyPublished: boolean,
): AutomationSlotStatus {
  if (current === "FAILED" || current === "CANCELLED") return current;
  if (current === "SCHEDULED" && alreadyPublished) return current;
  return "CANCELLED";
}
