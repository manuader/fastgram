/**
 * Payloads de las tres colas de Engagement (`JOB_QUEUES.redditLeadDiscovery`,
 * `redditThreadMonitoring`, `banRiskComputation`, PRD §9.5.13–15).
 *
 * ## Por qué `reddit-lead-discovery` también genera respuestas
 *
 * Generar una respuesta (`F-195`) y el `Why this lead?` necesitan el LLM, y
 * el LLM vive en el worker (la API no tiene uno). No hay cola propia para eso
 * en `JOB_QUEUES` y agregar una es tocar el contrato compartido de colas; se
 * reusa la de descubrimiento con un `kind` explícito, como el piloto reusa
 * `automation-generation`. Su política (5 intentos, backoff exponencial) le
 * sirve: generar un borrador es idempotente (pisa el borrador anterior).
 *
 * **Nada que publique va por una cola**: "Send" es síncrono en la API, con
 * confirmación explícita, y sin reintentos (un reintento podría comentar dos
 * veces).
 */

export const ENGAGEMENT_JOB_KINDS = ["sweep", "discover", "score", "reply"] as const;

export type LeadDiscoveryJob =
  /** Cron: encola `discover` para cada marca con Reddit conectado y subreddits. */
  | { readonly kind: "sweep" }
  /** Una corrida de descubrimiento para una marca. */
  | { readonly kind: "discover"; readonly companyId: string }
  /** Juzgar un lead (el agregado a mano, o un re-juicio). */
  | { readonly kind: "score"; readonly companyId: string; readonly leadId: string }
  /** Generar (o regenerar) el borrador de respuesta de un lead. */
  | {
      readonly kind: "reply";
      readonly companyId: string;
      readonly leadId: string;
      readonly regenerate: boolean;
    };

export type ThreadMonitoringJob =
  | { readonly kind: "sweep" }
  | { readonly kind: "sync"; readonly companyId: string; readonly leadId?: string };

export type BanRiskJob =
  { readonly kind: "sweep" } | { readonly kind: "compute"; readonly companyId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

function obj(payload: unknown): Record<string, unknown> | null {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

/** `{}` (lo que manda el cron) es `sweep`. Un payload que no se entiende es `null`. */
export function parseLeadDiscoveryJob(payload: unknown): LeadDiscoveryJob | null {
  const o = obj(payload);
  if (o === null) return null;
  const kind = o["kind"] ?? (Object.keys(o).length === 0 ? "sweep" : undefined);
  if (kind === "sweep") return { kind: "sweep" };
  if (!isUuid(o["companyId"])) return null;
  const companyId = o["companyId"];
  if (kind === "discover") return { kind, companyId };
  if (!isUuid(o["leadId"])) return null;
  if (kind === "score") return { kind, companyId, leadId: o["leadId"] };
  if (kind === "reply") {
    return { kind, companyId, leadId: o["leadId"], regenerate: o["regenerate"] === true };
  }
  return null;
}

export function parseThreadMonitoringJob(payload: unknown): ThreadMonitoringJob | null {
  const o = obj(payload);
  if (o === null) return null;
  const kind = o["kind"] ?? (Object.keys(o).length === 0 ? "sweep" : undefined);
  if (kind === "sweep") return { kind: "sweep" };
  if (kind !== "sync" || !isUuid(o["companyId"])) return null;
  if (o["leadId"] === undefined) return { kind, companyId: o["companyId"] };
  return isUuid(o["leadId"])
    ? { kind, companyId: o["companyId"], leadId: o["leadId"] }
    : null;
}

export function parseBanRiskJob(payload: unknown): BanRiskJob | null {
  const o = obj(payload);
  if (o === null) return null;
  const kind = o["kind"] ?? (Object.keys(o).length === 0 ? "sweep" : undefined);
  if (kind === "sweep") return { kind: "sweep" };
  return kind === "compute" && isUuid(o["companyId"])
    ? { kind, companyId: o["companyId"] }
    : null;
}

/**
 * Crons. Decisión nuestra; a minutos que no chocan con los otros barridos
 * (`:07` métricas, cada 15 el piloto).
 * - Descubrimiento cada hora: con ≤10 subreddits son ≤25 llamadas por marca,
 *   lejos de las 60/min.
 * - Seguimiento de hilos cada 2 h: sólo hilos respondidos en los últimos 7 días.
 * - Ban meter una vez por día: la ventana se mueve aunque nadie envíe nada.
 */
export const ENGAGEMENT_CRONS = {
  discovery: "23 * * * *",
  threadMonitoring: "41 */2 * * *",
  banRisk: "53 4 * * *",
} as const;

/** Claves de singleton con componente que no se repite (trampas 39 y 45). */
export function engagementSingletonKey(parts: readonly string[], now: Date): string {
  return [...parts, String(now.getTime())].join(":");
}
