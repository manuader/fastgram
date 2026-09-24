/**
 * Guardas anti-bot al momento de publicar — `PU-PUB-007`, `D-11`,
 * `docs/PLAN-USO-PERSONAL.md` §5.
 *
 * El auto-slot (`scheduling/auto-slot.ts`) ya reparte las piezas respetando el
 * tope por red y día, el jitter y la separación entre marcas **al programar**.
 * Esto es la segunda línea, **al publicar**, y existe porque entre una cosa y
 * la otra pasan cosas que el auto-slot no ve: un post movido a mano en el
 * calendario, un `Schedule Post` con hora elegida por el usuario, un reintento
 * que salió más tarde, una reconexión que reanuda cinco posts juntos. Es el
 * worker el que está por hablar con la plataforma, así que es el último que
 * puede decir «ahora no».
 *
 * Puro: no lee la base ni el reloj. El worker le pasa el post, «ahora», la
 * política de la marca y lo que hay alrededor en **todas** las marcas del
 * mismo dueño.
 *
 * ## Las tres reglas, y qué hace cada una cuando no se cumple
 *
 * 1. **Nunca la misma pieza en dos marcas** (§5.4). Si el contenido
 *    renderizado (su huella, un hash de los bytes) ya salió en **otra** marca,
 *    se **rechaza**: no hay hora a la que eso esté bien.
 * 2. **Tope por red y por día de la marca** (§5.2, default 3). Si el día local
 *    de la marca ya tiene ese tope en la red, se **reprograma** al día
 *    siguiente a la misma hora local (no se falla: la pieza está bien, sólo
 *    llegó tarde a un día lleno).
 * 3. **Separación mínima entre marcas del mismo dueño** (§5.3, default 10 min).
 *    Si otra marca publicó hace menos que eso, se **reprograma** a la hora de
 *    esa publicación más la separación.
 *
 * El jitter (§5.3) no está acá: ya se aplicó al programar, y aplicarlo otra vez
 * al publicar sólo movería la hora que el usuario ve en el calendario.
 *
 * ## Quién cede cuando dos llegan juntos
 *
 * Los jobs de dos marcas programados al mismo minuto corren a la vez en el
 * worker. Si cada uno mirara sólo lo que «ya salió», los dos verían la cancha
 * libre y publicarían juntos. Por eso un post **pendiente** de otra marca con
 * hora anterior (o igual y con id menor) también cuenta: la decisión es
 * simétrica y determinista, así que de dos que se miran, exactamente uno cede.
 */
import {
  ANTI_BOT_DAILY_CAP_DEFAULT,
  BRAND_GAP_MINUTES_DEFAULT,
} from "../scheduling/auto-slot.js";
import {
  addCivilDays,
  civilDateOf,
  civilKey,
  timeZoneOffsetMs,
  zonedWallTimeToUtc,
} from "../scheduling/zoned-time.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Cuántos días hacia adelante se busca un hueco antes de rendirse. */
export const PUBLISH_GUARD_HORIZON_DAYS = 30;

export interface PublishGuardPolicy {
  /** Tope de la marca en esta red por día local. `0` = la red no recibe nada. */
  readonly dailyCap: number;
  /** Separación mínima con otras marcas del mismo dueño, en minutos. */
  readonly brandGapMinutes: number;
  /** Zona de la marca: el «día» del tope es el suyo, no el UTC. */
  readonly timezone: string;
  readonly horizonDays?: number;
}

/** El post que está por salir. */
export interface GuardSubject {
  readonly id: string;
  readonly brandId: string;
  readonly network: string;
  readonly scheduledAtMs: number;
  /** Huella del contenido renderizado. `null` = no se pudo calcular. */
  readonly fingerprint: string | null;
}

/**
 * Un post alrededor, de esta u otra marca del mismo dueño.
 *
 * - `out`: ya llegó a la plataforma (`POSTED`, `IN_USER_INBOX`,
 *   `UPLOADING_TO_TIKTOK`). `atMs` es la hora en que salió.
 * - `pending`: todavía no salió pero ocupa su hora (`SCHEDULED`,
 *   `AWAITING_RECONNECT`, `BUILDING`).
 */
export interface GuardNeighbor {
  readonly id: string;
  readonly brandId: string;
  readonly network: string;
  readonly atMs: number;
  readonly state: "out" | "pending";
  readonly fingerprint?: string | null;
}

export type GuardDecision =
  | { readonly kind: "publish" }
  | {
      readonly kind: "reschedule";
      readonly atMs: number;
      /** La primera regla que obligó a mover. */
      readonly reason: "daily_cap" | "brand_gap";
    }
  | {
      readonly kind: "reject";
      readonly code: PublishGuardRejectCode;
      /** Seguro de mostrar (`FR-060`). */
      readonly message: string;
    };

/**
 * Códigos estables de rechazo. **No están en el PRD**: salen del plan de uso
 * personal (§5), que no enumera códigos. Son neutrales respecto al proveedor
 * porque las guardas son nuestras, no de la plataforma.
 */
export const PUBLISH_GUARD_REJECT_CODES = [
  "duplicate_across_brands",
  "anti_bot_no_slot",
] as const;
export type PublishGuardRejectCode = (typeof PUBLISH_GUARD_REJECT_CODES)[number];

export interface EvaluateGuardsParams {
  readonly subject: GuardSubject;
  readonly nowMs: number;
  readonly policy: PublishGuardPolicy;
  readonly neighbors: readonly GuardNeighbor[];
}

/** Evalúa las tres reglas. Ver la cabecera. */
export function evaluatePublishGuards(params: EvaluateGuardsParams): GuardDecision {
  const { subject, nowMs, policy } = params;
  const neighbors = params.neighbors.filter((n) => n.id !== subject.id);

  // 1 · la misma pieza en otra marca.
  if (subject.fingerprint !== null) {
    const clash = neighbors.some(
      (n) =>
        n.brandId !== subject.brandId &&
        n.state === "out" &&
        n.fingerprint !== undefined &&
        n.fingerprint !== null &&
        n.fingerprint === subject.fingerprint,
    );
    if (clash) {
      return {
        kind: "reject",
        code: "duplicate_across_brands",
        message:
          "This exact piece was already published by another brand. Each brand has to publish its own content.",
      };
    }
  }

  const cap = Math.max(0, Math.floor(policy.dailyCap));
  if (cap === 0) {
    return {
      kind: "reject",
      code: "anti_bot_no_slot",
      message: "This brand's strategy doesn't allow any posts on this network.",
    };
  }
  const gapMs = Math.max(0, policy.brandGapMinutes) * MINUTE_MS;
  const tz = policy.timezone;
  const horizonMs = (policy.horizonDays ?? PUBLISH_GUARD_HORIZON_DAYS) * DAY_MS;

  const own = neighbors.filter(
    (n) => n.brandId === subject.brandId && n.network === subject.network,
  );
  const others = neighbors.filter((n) => n.brandId !== subject.brandId);

  const start = Math.max(nowMs, subject.scheduledAtMs);
  let at = start;
  let reason: "daily_cap" | "brand_gap" | null = null;

  // Cada vuelta avanza `at` estrictamente, y el horizonte la corta.
  for (let guard = 0; guard < 10_000; guard += 1) {
    if (at - start > horizonMs) {
      return {
        kind: "reject",
        code: "anti_bot_no_slot",
        message:
          "There's no free slot for this post in the next days without breaking the brand's posting limits.",
      };
    }

    if (usedOnDay(own, at, tz) >= cap) {
      at = sameWallTimeNextDay(at, tz);
      reason ??= "daily_cap";
      continue;
    }

    const pushed = pushPastOtherBrands(at, others, gapMs, subject.id);
    if (pushed !== at) {
      at = pushed;
      reason ??= "brand_gap";
      continue;
    }
    break;
  }

  if (at === start && reason === null) return { kind: "publish" };
  return { kind: "reschedule", atMs: at, reason: reason ?? "brand_gap" };
}

/**
 * Cuántas de la marca en esta red cuentan para el día local de `at`: las que
 * ya salieron ese día, y las pendientes de ese día con hora hasta `at` (salen
 * antes, así que ocupan cupo primero).
 */
function usedOnDay(own: readonly GuardNeighbor[], at: number, tz: string): number {
  const day = civilKey(civilDateOf(at, tz));
  return own.filter(
    (n) =>
      civilKey(civilDateOf(n.atMs, tz)) === day && (n.state === "out" || n.atMs <= at),
  ).length;
}

/**
 * La misma hora de pared, al día siguiente, en la zona de la marca. Conserva
 * segundos (y con ellos el jitter que se aplicó al programar).
 */
function sameWallTimeNextDay(at: number, tz: string): number {
  const msOfDay = (((at + timeZoneOffsetMs(at, tz)) % DAY_MS) + DAY_MS) % DAY_MS;
  const next = addCivilDays(civilDateOf(at, tz), 1);
  const minutes = Math.floor(msOfDay / MINUTE_MS);
  return zonedWallTimeToUtc(next, minutes, tz) + (msOfDay % MINUTE_MS);
}

/**
 * Corre `at` hasta que ninguna publicación de otra marca que **le gane** quede
 * a menos de `gapMs`. Le gana: la que ya salió, y la pendiente con hora
 * anterior (o igual y con id menor). Las pendientes posteriores ceden ellas
 * cuando les toque.
 */
function pushPastOtherBrands(
  at: number,
  others: readonly GuardNeighbor[],
  gapMs: number,
  subjectId: string,
): number {
  if (gapMs === 0) return at;
  const winners = others.filter(
    (o) =>
      Math.abs(o.atMs - at) < gapMs &&
      (o.state === "out" || o.atMs < at || (o.atMs === at && o.id < subjectId)),
  );
  if (winners.length === 0) return at;
  const latest = Math.max(...winners.map((o) => o.atMs));
  return Math.max(at + 1, latest + gapMs);
}

/* ------------------------------------------------------------------------ *
 * Política desde la estrategia guardada
 * ------------------------------------------------------------------------ */

export interface StoredStrategyForGuards {
  /** `brand_strategies.networks` tal cual (jsonb): `[{network, dailyCap, …}]`. */
  readonly networks: unknown;
  readonly brandGapMinutes: number;
}

/**
 * La política de una red a partir de la fila de estrategia de la marca, o de
 * los defaults de §5 si la marca nunca guardó una (`null`), si la red no está
 * en la lista, o si el `dailyCap` guardado no es un entero no negativo.
 *
 * Una red **apagada** en la estrategia no pone el tope en 0: el post ya existe
 * porque alguien lo programó a mano, y la estrategia gobierna el auto-slot, no
 * la publicación manual. Sólo el `dailyCap` explícito cuenta.
 */
export function publishGuardPolicyFor(
  stored: StoredStrategyForGuards | null,
  network: string,
  timezone: string,
): PublishGuardPolicy {
  if (stored === null) {
    return {
      dailyCap: ANTI_BOT_DAILY_CAP_DEFAULT,
      brandGapMinutes: BRAND_GAP_MINUTES_DEFAULT,
      timezone,
    };
  }
  let dailyCap = ANTI_BOT_DAILY_CAP_DEFAULT;
  if (Array.isArray(stored.networks)) {
    for (const entry of stored.networks as readonly unknown[]) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (record["network"] !== network) continue;
      const cap = record["dailyCap"];
      if (typeof cap === "number" && Number.isInteger(cap) && cap >= 0) dailyCap = cap;
    }
  }
  const gap =
    Number.isFinite(stored.brandGapMinutes) && stored.brandGapMinutes >= 0
      ? stored.brandGapMinutes
      : BRAND_GAP_MINUTES_DEFAULT;
  return { dailyCap, brandGapMinutes: gap, timezone };
}

export * from "./retry.js";
