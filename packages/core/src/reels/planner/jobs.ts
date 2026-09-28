/**
 * La cola `reel-planner` — sprint 9 (U), `PU-S9-014`. Dos formas de job, como
 * el piloto:
 *
 * ```
 *   cron cada hora   →  {}                   barrido: una corrida por marca
 *   {companyId, mode}                        corrida de una marca:
 *      mode "tick"    → plan de la semana si falta + los reels de hoy a la cola
 *      mode "replan"  → rehace lo `planned` de la semana (botón «Plan now»)
 * ```
 *
 * La clave de cada corrida **rota** (trampas 39 y 45): con una fija por marca
 * el adaptador de pg-boss la correría una sola vez en la vida.
 */
export const REEL_PLANNER_CRON = "7 * * * *";

/** Ventana de la clave de una corrida `tick`: dos barridos en la misma hora son una. */
export const REEL_PLANNER_TICK_BUCKET_MS = 10 * 60_000;

export const REEL_PLANNER_MODES = ["tick", "replan"] as const;
export type ReelPlannerMode = (typeof REEL_PLANNER_MODES)[number];

export type ReelPlannerJob =
  | { readonly kind: "sweep" }
  | { readonly kind: "brand"; readonly companyId: string; readonly mode: ReelPlannerMode };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseReelPlannerJob(raw: unknown): ReelPlannerJob | null {
  if (raw === null || raw === undefined) return { kind: "sweep" };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o["companyId"] === undefined) return { kind: "sweep" };
  const companyId = o["companyId"];
  const mode = o["mode"] ?? "tick";
  if (typeof companyId !== "string" || !UUID_RE.test(companyId)) return null;
  if (mode !== "tick" && mode !== "replan") return null;
  return { kind: "brand", companyId, mode };
}

/**
 * La clave de una corrida. `tick` rota cada 10 min; `replan` va con el
 * instante (cada clic es un pedido: dos clics seguidos son dos, y el segundo
 * encuentra el plan ya rehecho).
 */
export function reelPlannerJobKey(
  queue: string,
  companyId: string,
  mode: ReelPlannerMode,
  nowMs: number,
): string {
  const bucket =
    mode === "tick" ? Math.floor(nowMs / REEL_PLANNER_TICK_BUCKET_MS) : Math.floor(nowMs);
  return `${queue}:${companyId}:${mode}:${String(bucket)}`;
}
