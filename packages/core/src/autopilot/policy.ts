/**
 * Piloto automático — `PU-AUTO-001`, `PU-AUTO-002`, `PU-AUTO-003`
 * (`docs/PLAN-USO-PERSONAL.md` §2 pasos 3–5, PRD §2.7 `D-08`).
 *
 * Todo lo que el worker y la API necesitan decidir sin tocar la base: cuánto
 * tiene que tener la cola de una marca, cuántas piezas puede aprobar el piloto
 * en una corrida, cada cuánto corre y qué clave lleva cada job.
 *
 * ## Los números, y de dónde salen
 *
 * Ninguno es del PRD. Son **decisiones nuestras**, conservadoras:
 *
 * - **Horizonte de 2 días** ({@link AUTOPILOT_HORIZON_DAYS}): la cola cubre lo
 *   que la estrategia publica en dos días, y el piloto no aprueba más de lo
 *   que se puede agendar en ese plazo. Dos y no uno: si una corrida se pierde
 *   (worker caído, LLM caído) el día siguiente sigue cubierto. No más: cada
 *   sugerencia cuesta una llamada al LLM, y una cola larga envejece (el perfil
 *   o la estrategia cambian y lo encolado queda viejo).
 * - **Objetivo de la cola** ({@link autopilotQueueTarget}): `piezas/día × redes
 *   activas × horizonte`, con piso en {@link TARGET_QUEUED_ITEMS} (5, `AI-002`:
 *   una marca manual con una red y una pieza por día sigue viendo 5 tarjetas en
 *   Blitz) y techo en {@link AUTOPILOT_QUEUE_TARGET_MAX} (30). El techo es el
 *   costo: 30 copies en un relleno son ~30 llamadas al LLM, y con 7 redes × 3
 *   por día × 2 días la fórmula daría 42.
 *
 *   Ojo con lo que la fórmula **sobreestima**: el auto-slot pone cada pieza
 *   aprobada en **todas** las redes activas, así que para publicar `perDay`
 *   por red alcanzan `max(perDay)` piezas por día, no la suma. La fórmula es
 *   la del pedido y se deja así a propósito: la cola es también el deck de
 *   Blitz, y el piloto descarta las que no pasan el pre-chequeo.
 * - **Cupo por corrida** ({@link AUTOPILOT_MAX_DECISIONS_PER_RUN}): cada
 *   decisión es una llamada al juicio. Seis por corrida y por marca, cada 15
 *   minutos, son 24 por hora: sobra para cualquier estrategia dentro del tope
 *   anti-bot y acota lo que puede tardar un job.
 */
import { TARGET_QUEUED_ITEMS } from "../discovery/blitz-preferences.js";
import { effectiveDailyQuota, type NetworkPlan } from "../scheduling/auto-slot.js";
import {
  addCivilDays,
  civilDateOf,
  civilKey,
  zonedWallTimeToUtc,
  type CivilDate,
} from "../scheduling/zoned-time.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export const AUTOPILOT_HORIZON_DAYS = 2;
export const AUTOPILOT_QUEUE_TARGET_MIN = TARGET_QUEUED_ITEMS;
export const AUTOPILOT_QUEUE_TARGET_MAX = 30;
export const AUTOPILOT_MAX_DECISIONS_PER_RUN = 6;
/**
 * Timeout duro del pre-chequeo. No es el del `JV-3` síncrono del PRD (ahí hay
 * un usuario esperando): es un job de fondo y el modelo puede ser local. Medio
 * minuto alcanza para un 7B en una Mac; más, y una corrida con seis decisiones
 * se come el timeout del job.
 */
export const AUTOPILOT_PRECHECK_TIMEOUT_MS = 30_000;

/** Cada cuánto corre el barrido (cron del catálogo, en UTC). */
export const AUTOPILOT_RUN_EVERY_MINUTES = 15;
export const AUTOPILOT_SWEEP_CRON = `*/${String(AUTOPILOT_RUN_EVERY_MINUTES)} * * * *`;
const RUN_BUCKET_MS = AUTOPILOT_RUN_EVERY_MINUTES * MINUTE_MS;

/**
 * Cuántas sugerencias tiene que tener la cola de la marca. Ver la cabecera.
 * Sin redes activas, el piso: Blitz sigue necesitando tarjetas.
 */
export function autopilotQueueTarget(
  networks: readonly NetworkPlan[],
  horizonDays: number = AUTOPILOT_HORIZON_DAYS,
): number {
  const perDay = networks.reduce((sum, plan) => sum + effectiveDailyQuota(plan), 0);
  const raw = perDay * Math.max(1, Math.floor(horizonDays));
  return Math.min(AUTOPILOT_QUEUE_TARGET_MAX, Math.max(AUTOPILOT_QUEUE_TARGET_MIN, raw));
}

export interface OwnScheduledItem {
  readonly network: string;
  readonly atMs: number;
}

/**
 * Cuántas piezas más puede aprobar el piloto sin pasarse de lo que la
 * estrategia publica en el horizonte.
 *
 * Por red: `cupo diario × horizonte − lo que la marca ya tiene programado ahí
 * en [ahora, ahora + horizonte)`. El resultado es el **máximo** entre redes,
 * no la suma: una pieza aprobada va a todas las redes activas (auto-slot), así
 * que alcanza con que una tenga lugar. Acotado por
 * {@link AUTOPILOT_MAX_DECISIONS_PER_RUN} lo decide quien llama.
 */
export function autopilotAcceptCapacity(params: {
  readonly networks: readonly NetworkPlan[];
  readonly nowMs: number;
  readonly scheduled: readonly OwnScheduledItem[];
  readonly horizonDays?: number;
}): number {
  const horizon = Math.max(1, Math.floor(params.horizonDays ?? AUTOPILOT_HORIZON_DAYS));
  const until = params.nowMs + horizon * DAY_MS;
  let best = 0;
  for (const plan of params.networks) {
    const quota = effectiveDailyQuota(plan);
    if (quota === 0) continue;
    const taken = params.scheduled.filter(
      (s) => s.network === plan.network && s.atMs >= params.nowMs && s.atMs < until,
    ).length;
    best = Math.max(best, quota * horizon - taken);
  }
  return Math.max(0, best);
}

/* ------------------------------------------------------------------------ *
 * El job
 * ------------------------------------------------------------------------ */

/**
 * Lo que viaja en `automation-generation`:
 *  - `{}` — el barrido del cron: lista las marcas y encola una por marca.
 *  - `{ companyId }` — la corrida de una marca.
 */
export type AutopilotJob =
  { readonly kind: "sweep" } | { readonly kind: "brand"; readonly companyId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseAutopilotJob(raw: unknown): AutopilotJob | null {
  if (raw === null || raw === undefined) return { kind: "sweep" };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const companyId = (raw as Record<string, unknown>)["companyId"];
  if (companyId === undefined) return { kind: "sweep" };
  return typeof companyId === "string" && UUID_RE.test(companyId)
    ? { kind: "brand", companyId }
    : null;
}

/**
 * La clave de la corrida de una marca. **Rota por ventana de 15 min**
 * (trampas 39 y 45 del HANDOFF): el adaptador deriva de la clave un id
 * permanente, así que una clave fija por marca haría que la marca corriera una
 * sola vez en la vida. Con el cubo, dos barridos en la misma ventana son una
 * sola corrida, y la ventana siguiente es otra clave que nunca existió.
 */
export function autopilotBrandJobKey(
  queue: string,
  companyId: string,
  nowMs: number,
): string {
  return `${queue}:${companyId}:${String(Math.floor(nowMs / RUN_BUCKET_MS))}`;
}

/* ------------------------------------------------------------------------ *
 * Días locales (resumen diario)
 * ------------------------------------------------------------------------ */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** `YYYY-MM-DD` → fecha civil, o `null` si no es una fecha real. */
export function parseLocalDate(value: string): CivilDate | null {
  const m = DATE_RE.exec(value);
  if (m === null) return null;
  const date = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const probe = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (
    probe.getUTCFullYear() !== date.year ||
    probe.getUTCMonth() !== date.month - 1 ||
    probe.getUTCDate() !== date.day
  ) {
    return null;
  }
  return date;
}

/** El día local de `nowMs` en la zona, `YYYY-MM-DD`. */
export function localDateOf(nowMs: number, timeZone: string): string {
  return civilKey(civilDateOf(nowMs, timeZone));
}

/** `[inicio, fin)` del día civil en la zona, en ms UTC. Respeta los cambios de horario. */
export function localDayRange(
  date: CivilDate,
  timeZone: string,
): { readonly fromMs: number; readonly toMs: number } {
  return {
    fromMs: zonedWallTimeToUtc(date, 0, timeZone),
    toMs: zonedWallTimeToUtc(addCivilDays(date, 1), 0, timeZone),
  };
}
