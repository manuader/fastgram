/**
 * Los jobs de las campañas — `F-213`, `F-215`, `F-217`, PRD §9.5.11 y §9.5.12.
 *
 * ## `automation-generation` la comparte con el piloto
 *
 * El piloto automático (`PU-AUTO-001/002`) ya consume `automation-generation`
 * con payload `{}` (barrido del cron) o `{companyId}` (una marca). Una cola
 * nueva tocaba cinco archivos compartidos para la misma política (3 intentos,
 * backoff, 900 s), así que las campañas viajan por la misma cola con un campo
 * que las distingue —`automationId`— y el worker despacha por él, igual que
 * `discovery-refill` con `promptRequestId` y `media-import` con
 * `inspirationItemId`. Un payload del piloto nunca lleva `automationId`.
 *
 * ## `automation-build-schedule`
 *
 * Existía en el catálogo sin handler. `{}` = barrido (cron) de las campañas
 * `BUILDING`/`ACTIVE` de todas las marcas; `{companyId, automationId}` = una.
 * El launch encola una por campaña y la corrida se re-arma sola mientras haya
 * builds en curso; el cron es la red por si una cadena se corta.
 *
 * ## Claves
 *
 * El adaptador de pg-boss deriva de la `singletonKey` un id **permanente**
 * (trampas 39 y 45): una clave fija por campaña haría que corriera una sola
 * vez en la vida. Las claves llevan un `nonce` que pone quien encola (un UUID
 * nuevo) o un cubo de tiempo.
 */
import type { BlitzContentType } from "../content/content.js";
import { isBlitzContentType } from "../content/content.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Slots por job de generación: acota lo que tarda un job con un LLM local. */
export const AUTOMATION_GENERATION_BATCH = 6;

/** Cada cuánto se vuelve a mirar una campaña con builds en curso. */
export const AUTOMATION_BUILD_RECHECK_MS = 60_000;
/** Red de seguridad: barrido de campañas vivas. */
export const AUTOMATION_BUILD_SWEEP_EVERY_MINUTES = 5;
export const AUTOMATION_BUILD_SWEEP_CRON = `*/${String(AUTOMATION_BUILD_SWEEP_EVERY_MINUTES)} * * * *`;

/**
 * Un slot `GENERATING` hace más de esto es de un worker que murió: vuelve a
 * `PENDING_GEN`. Holgado respecto del timeout del job (900 s).
 */
export const AUTOMATION_STALE_GENERATING_MS = 20 * 60_000;

export type AutomationCampaignJob =
  | {
      readonly kind: "generate";
      readonly companyId: string;
      readonly automationId: string;
    }
  | {
      readonly kind: "reroll";
      readonly companyId: string;
      readonly automationId: string;
      readonly slotId: string;
      /** `null` = el mix del snapshot decide. */
      readonly contentType: BlitzContentType | null;
    };

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

/** ¿Es un job de campaña (y no del piloto)? Mira sólo `automationId`. */
export function isAutomationCampaignPayload(raw: unknown): boolean {
  return isRecord(raw) && raw["automationId"] !== undefined;
}

export function parseAutomationCampaignJob(raw: unknown): AutomationCampaignJob | null {
  if (!isRecord(raw)) return null;
  const { companyId, automationId, slotId, contentType } = raw;
  if (typeof companyId !== "string" || !UUID_RE.test(companyId)) return null;
  if (typeof automationId !== "string" || !UUID_RE.test(automationId)) return null;
  if (slotId === undefined) return { kind: "generate", companyId, automationId };
  if (typeof slotId !== "string" || !UUID_RE.test(slotId)) return null;
  if (contentType !== undefined && contentType !== null) {
    if (typeof contentType !== "string" || !isBlitzContentType(contentType)) return null;
    return { kind: "reroll", companyId, automationId, slotId, contentType };
  }
  return { kind: "reroll", companyId, automationId, slotId, contentType: null };
}

export type AutomationBuildJob =
  | { readonly kind: "sweep" }
  | {
      readonly kind: "automation";
      readonly companyId: string;
      readonly automationId: string;
    };

export function parseAutomationBuildJob(raw: unknown): AutomationBuildJob | null {
  if (raw === null || raw === undefined) return { kind: "sweep" };
  if (!isRecord(raw)) return null;
  const { companyId, automationId } = raw;
  if (companyId === undefined && automationId === undefined) return { kind: "sweep" };
  if (typeof companyId !== "string" || !UUID_RE.test(companyId)) return null;
  if (typeof automationId !== "string" || !UUID_RE.test(automationId)) return null;
  return { kind: "automation", companyId, automationId };
}

/** Clave de un job de generación o re-roll. `nonce`: un UUID nuevo por encolado. */
export function automationCampaignJobKey(
  queue: string,
  automationId: string,
  nonce: string,
): string {
  return `${queue}:campaign:${automationId}:${nonce}`;
}

/** Clave de la corrida de build de una campaña: un cubo por minuto. */
export function automationBuildJobKey(
  queue: string,
  automationId: string,
  atMs: number,
): string {
  return `${queue}:${automationId}:${String(Math.floor(atMs / AUTOMATION_BUILD_RECHECK_MS))}`;
}
