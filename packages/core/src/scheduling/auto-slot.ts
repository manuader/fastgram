/**
 * Auto-slot — `PU-CAL-001` · `docs/PLAN-USO-PERSONAL.md` §2 (paso 5) y §5.
 *
 * *"Lo aprobado cae solo en el próximo horario libre de su estrategia."* Este
 * archivo decide **cuál** es ese horario. Es puro: no lee la base ni el reloj.
 * Quien llama le pasa la estrategia de la marca, "ahora" y lo que ya está
 * ocupado en **todas** las marcas del mismo dueño.
 *
 * ## Las guardas anti-bot (§5), y de dónde sale cada número
 *
 * Ninguna plataforma publica una "cadencia segura", así que los tres números
 * son **defaults nuestros, configurables** por marca, no datos:
 *
 * 1. **Tope por red y por día** (default 3): el día que ya tiene esa cantidad
 *    de piezas de la marca en la red no recibe otra, aunque le queden ventanas.
 * 2. **Jitter** (default ±7 min): la hora final no es la de la ventana sino
 *    una corrida por un valor **determinista por contenido** —mismo contenido,
 *    misma red, misma ventana → mismo corrimiento—. Determinista para que
 *    reintentar el auto-slot no mueva la pieza, y para que el test pueda fijar
 *    el resultado sin mockear un RNG.
 * 3. **Separación entre marcas** (default 10 min): dos marcas del mismo dueño
 *    no publican casi a la vez. Si la hora cae cerca de un post de *otra*
 *    marca, se corre hacia adelante hasta cumplir la separación; si eso la
 *    aleja demasiado de su ventana, la ventana se da por ocupada.
 *
 * ## Qué cuenta como "ocupado"
 *
 * Todo lo que llega en `occupied`: posts no terminales y slots planificados.
 * Quien arma la lista decide qué estados entran (hoy, `apps/api`). Acá sólo
 * importan la marca, la red y el instante.
 */
import {
  addCivilDays,
  civilDateOf,
  civilKey,
  parseTimeOfDay,
  weekdayOf,
  zonedWallTimeToUtc,
  type CivilDate,
} from "./zoned-time.js";

const MINUTE_MS = 60_000;

/** Las redes de la estrategia (`D-09`). YouTube y LinkedIn existen, "después". */
export const STRATEGY_NETWORKS = [
  "instagram",
  "tiktok",
  "x",
  "threads",
  "facebook",
  "youtube",
  "linkedin",
] as const;
export type StrategyNetwork = (typeof STRATEGY_NETWORKS)[number];

/** `D-09`: van al final del orden. Se pueden guardar; la UI las marca "later". */
export const LATER_NETWORKS: readonly StrategyNetwork[] = ["youtube", "linkedin"];

/** §5.2 — "Topes propios por red por debajo de los oficiales (default: 3 por día y por red)". */
export const ANTI_BOT_DAILY_CAP_DEFAULT = 3;
/** §5.3 — "Jitter aleatorio en la hora (± 7 min)". */
export const JITTER_MINUTES_DEFAULT = 7;
/** §5.3 — "separación mínima entre cuentas". El número es nuestro. */
export const BRAND_GAP_MINUTES_DEFAULT = 10;

/** Cuántos días hacia adelante se busca antes de rendirse. */
export const AUTO_SLOT_HORIZON_DAYS = 30;
/**
 * Margen mínimo desde "ahora". Una ventana que empieza en 30 s no sirve: el
 * publicador tiene que tomar el job y el render puede no haber terminado.
 */
export const AUTO_SLOT_MIN_LEAD_MS = 5 * MINUTE_MS;
/**
 * Cuánto se puede alejar la hora final de su ventana empujada por la
 * separación entre marcas, **además** del jitter. Más allá, la ventana deja de
 * ser "las 9" y pasa a ser otra hora que nadie eligió.
 */
export const AUTO_SLOT_MAX_SLIDE_MS = 30 * MINUTE_MS;

/** 0 = domingo … 6 = sábado, como `Date#getUTCDay`. */
export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export interface NetworkPlan {
  readonly network: StrategyNetwork;
  readonly enabled: boolean;
  /** Piezas por día que la estrategia quiere en esta red. */
  readonly perDay: number;
  /** Tope anti-bot. El cupo efectivo es `min(perDay, dailyCap)`. */
  readonly dailyCap: number;
}

export interface SlotStrategy {
  readonly networks: readonly NetworkPlan[];
  /** Horas locales `HH:MM` por día de la semana. */
  readonly windows: Readonly<Record<WeekdayKey, readonly string[]>>;
  readonly timezone: string;
  readonly jitterMinutes: number;
  readonly brandGapMinutes: number;
}

export interface OccupiedSlot {
  readonly brandId: string;
  readonly network: string;
  readonly atMs: number;
}

export interface FoundSlot {
  readonly network: StrategyNetwork;
  /** La hora final, con jitter y separación aplicados. */
  readonly atMs: number;
  /** La hora de la ventana, sin corrimientos. */
  readonly windowMs: number;
  /** El día local de la marca, `YYYY-MM-DD`. */
  readonly localDay: string;
}

/** Cupo efectivo por día. `0` = la red no recibe nada. */
export function effectiveDailyQuota(plan: NetworkPlan): number {
  if (!plan.enabled) return 0;
  return Math.max(0, Math.min(plan.perDay, plan.dailyCap));
}

/**
 * FNV-1a de 32 bits con el `fmix32` de MurmurHash3 al final. No es
 * criptográfico ni tiene por qué: sólo hace falta que reparta parejo y que sea
 * el mismo en Node y en el navegador.
 *
 * El `fmix32` no es decorativo: FNV-1a solo mezcla mal los bits altos cuando
 * las semillas difieren en el último carácter (`c-1`, `c-2`…), y el corrimiento
 * se saca justamente de los bits altos. Medido: 88 valores distintos en 200
 * semillas sobre 841 posibles, contra ~178 esperables.
 */
function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * El corrimiento determinista, en ms, dentro de `[-jitter, +jitter]` minutos,
 * con resolución de un segundo.
 */
export function jitterOffsetMs(seed: string, jitterMinutes: number): number {
  const spanSeconds = Math.max(0, Math.floor(jitterMinutes * 60));
  if (spanSeconds === 0) return 0;
  const buckets = 2 * spanSeconds + 1;
  const pick = Math.floor((hash32(seed) / 0x1_0000_0000) * buckets);
  return (pick - spanSeconds) * 1000;
}

/** Las ventanas de un día, parseadas, sin repetidas y en orden. */
function windowsFor(strategy: SlotStrategy, date: CivilDate): number[] {
  const key = WEEKDAY_KEYS[weekdayOf(date)] ?? "sun";
  const minutes = new Set<number>();
  for (const raw of strategy.windows[key]) {
    const parsed = parseTimeOfDay(raw);
    if (parsed !== null) minutes.add(parsed);
  }
  return [...minutes].sort((a, b) => a - b);
}

export interface FindSlotParams {
  readonly strategy: SlotStrategy;
  readonly brandId: string;
  readonly network: StrategyNetwork;
  readonly contentId: string;
  readonly nowMs: number;
  readonly occupied: readonly OccupiedSlot[];
  readonly horizonDays?: number;
}

/**
 * El próximo horario libre de **una** red. `null` si no hay en el horizonte
 * (red apagada, sin ventanas, o todo lleno).
 */
export function findNextSlot(params: FindSlotParams): FoundSlot | null {
  const { strategy, brandId, network, contentId, nowMs, occupied } = params;
  const plan = strategy.networks.find((candidate) => candidate.network === network);
  if (plan === undefined) return null;
  const quota = effectiveDailyQuota(plan);
  if (quota === 0) return null;

  const tz = strategy.timezone;
  const jitterMs = Math.max(0, strategy.jitterMinutes) * MINUTE_MS;
  const gapMs = Math.max(0, strategy.brandGapMinutes) * MINUTE_MS;
  const earliest = nowMs + AUTO_SLOT_MIN_LEAD_MS;

  const own = occupied.filter((o) => o.brandId === brandId && o.network === network);
  const others = occupied.filter((o) => o.brandId !== brandId);
  const today = civilDateOf(nowMs, tz);
  const horizon = params.horizonDays ?? AUTO_SLOT_HORIZON_DAYS;

  for (let offset = 0; offset < horizon; offset += 1) {
    const date = addCivilDays(today, offset);
    const dayKey = civilKey(date);
    const usedToday = own.filter((o) => civilKey(civilDateOf(o.atMs, tz)) === dayKey);
    if (usedToday.length >= quota) continue;

    for (const minutes of windowsFor(strategy, date)) {
      const windowMs = zonedWallTimeToUtc(date, minutes, tz);
      // Una pieza de la marca en esta red ya está en esta ventana (con su
      // jitter, o movida a mano cerca): la ventana está tomada.
      if (own.some((o) => Math.abs(o.atMs - windowMs) <= jitterMs)) continue;

      let atMs =
        windowMs +
        jitterOffsetMs(
          `${contentId}:${network}:${dayKey}:${String(minutes)}`,
          jitterMinutes(strategy),
        );
      if (atMs < earliest) continue;

      atMs = pushPastOtherBrands(atMs, others, gapMs);
      if (atMs - windowMs > jitterMs + AUTO_SLOT_MAX_SLIDE_MS) continue;
      // El empujón no puede sacarla del día: el cupo se contó para éste.
      if (civilKey(civilDateOf(atMs, tz)) !== dayKey) continue;

      return { network, atMs, windowMs, localDay: dayKey };
    }
  }
  return null;
}

function jitterMinutes(strategy: SlotStrategy): number {
  return Math.max(0, strategy.jitterMinutes);
}

/**
 * Corre la hora hacia adelante hasta que ningún post de otra marca quede a
 * menos de `gapMs`. Termina: cada vuelta avanza a un instante estrictamente
 * mayor, y la lista es finita.
 */
function pushPastOtherBrands(
  startMs: number,
  others: readonly OccupiedSlot[],
  gapMs: number,
): number {
  if (gapMs === 0) return startMs;
  let atMs = startMs;
  for (let guard = 0; guard <= others.length; guard += 1) {
    const clash = others
      .filter((o) => Math.abs(o.atMs - atMs) < gapMs)
      .reduce<number | null>(
        (max, o) => (max === null || o.atMs > max ? o.atMs : max),
        null,
      );
    if (clash === null) return atMs;
    atMs = clash + gapMs;
  }
  return atMs;
}

export interface PlanAutoSlotsParams {
  readonly strategy: SlotStrategy;
  readonly brandId: string;
  readonly contentId: string;
  readonly nowMs: number;
  readonly occupied: readonly OccupiedSlot[];
  /** Limitar a estas redes. Sin esto, todas las activas con cupo. */
  readonly networks?: readonly StrategyNetwork[];
  /** Redes que ya tienen esta pieza programada: no se vuelven a programar. */
  readonly alreadyScheduled?: readonly string[];
  readonly horizonDays?: number;
}

export type AutoSlotOutcome =
  | { readonly kind: "slot"; readonly slot: FoundSlot }
  | {
      readonly kind: "skipped";
      readonly network: StrategyNetwork;
      readonly reason: "already_scheduled" | "no_free_slot";
    };

/**
 * Un horario por red activa. Lo que se elige para una red entra en "ocupado"
 * antes de pasar a la siguiente, para que el resultado no dependa de que quien
 * llama lo haga.
 */
export function planAutoSlots(params: PlanAutoSlotsParams): readonly AutoSlotOutcome[] {
  const wanted = params.strategy.networks.filter(
    (plan) =>
      effectiveDailyQuota(plan) > 0 &&
      (params.networks === undefined || params.networks.includes(plan.network)),
  );
  const occupied: OccupiedSlot[] = [...params.occupied];
  const outcomes: AutoSlotOutcome[] = [];

  for (const plan of wanted) {
    if (params.alreadyScheduled?.includes(plan.network) === true) {
      outcomes.push({
        kind: "skipped",
        network: plan.network,
        reason: "already_scheduled",
      });
      continue;
    }
    const slot = findNextSlot({
      strategy: params.strategy,
      brandId: params.brandId,
      network: plan.network,
      contentId: params.contentId,
      nowMs: params.nowMs,
      occupied,
      ...(params.horizonDays === undefined ? {} : { horizonDays: params.horizonDays }),
    });
    if (slot === null) {
      outcomes.push({ kind: "skipped", network: plan.network, reason: "no_free_slot" });
      continue;
    }
    occupied.push({ brandId: params.brandId, network: plan.network, atMs: slot.atMs });
    outcomes.push({ kind: "slot", slot });
  }
  return outcomes;
}

// ───────────────────────────────────────────────────────────────────────────
// Slot planificado → post
// ───────────────────────────────────────────────────────────────────────────

/**
 * Las redes de la estrategia que hoy pueden ser un `Post` por el flujo de
 * `FR-060` (`POST /content/:id/schedule`). X, Threads y Facebook entraron con
 * sus adaptadores (`D-09`, migración `0015`). LinkedIn está en el enum
 * `post_platform` pero el contrato de programación no lo acepta (entra por
 * automations): sigue siendo sólo slot planificado. Reddit se puede programar
 * pero no es una red de la estrategia.
 */
export const POSTABLE_NETWORKS: readonly StrategyNetwork[] = [
  "instagram",
  "tiktok",
  "x",
  "threads",
  "facebook",
  "youtube",
];

export interface ConnectionCandidate {
  readonly id: string;
  readonly platform: string;
}

export type SlotConversionPlan =
  | {
      readonly kind: "convert";
      readonly platform: StrategyNetwork;
      readonly connectionId: string;
    }
  | {
      readonly kind: "wait";
      readonly reason: "network_not_postable" | "no_connection" | "connection_ambiguous";
    };

/**
 * ¿Este slot puede ser un post ya? Mismo criterio que `resolveConnection`
 * (`FR-060`): con **exactamente una** conexión activa en la red se usa ésa;
 * con varias, elegir por el usuario publicaría desde la cuenta equivocada, así
 * que el slot espera.
 *
 * `activeConnections` tiene que venir ya filtrada por activas y por la marca.
 */
export function planSlotConversion(
  network: StrategyNetwork,
  activeConnections: readonly ConnectionCandidate[],
  postable: readonly StrategyNetwork[] = POSTABLE_NETWORKS,
): SlotConversionPlan {
  if (!postable.includes(network))
    return { kind: "wait", reason: "network_not_postable" };
  const matching = activeConnections.filter((c) => c.platform === network);
  const only = matching[0];
  if (only === undefined) return { kind: "wait", reason: "no_connection" };
  if (matching.length > 1) return { kind: "wait", reason: "connection_ambiguous" };
  return { kind: "convert", platform: network, connectionId: only.id };
}
