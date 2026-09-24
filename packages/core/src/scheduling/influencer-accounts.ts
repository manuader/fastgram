/**
 * Las cuentas de la Configuration del influencer en el auto-slot — `FR-083`,
 * `P4-INFL-003` (sprint 7, segunda tanda).
 *
 * `influencer_configs.publishing_accounts` guarda `[{platform, connectionId,
 * enabled}]`: en qué cuentas publica el personaje. Una pieza hecha con ese
 * personaje (`contents.influencer_id`, migración `0032`) las **prefiere**:
 *
 *  - **Redes**: si el personaje tiene cuentas marcadas y activas, el auto-slot
 *    planifica sólo esas redes — siempre que alguna esté en la estrategia con
 *    cupo. Si ninguna lo está, no hay preferencia (todas las de la estrategia):
 *    "preferir" no es "no publicar".
 *  - **Cuenta**: en una red con cuentas marcadas, las candidatas son sólo ésas.
 *    Con una sola, el slot se convierte en post con esa cuenta aunque la marca
 *    tenga otras conexiones en la misma red (sin esto, dos conexiones = slot
 *    ambiguo que espera). En una red sin marcadas, todas las activas, como
 *    siempre.
 *
 * Una cuenta marcada que ya no está activa (desconectada, o de otra red) no
 * cuenta: la preferencia nunca inventa una conexión.
 *
 * `accounts` llega como `unknown` porque es `jsonb`: se valida acá, campo por
 * campo, y lo que no calza se ignora.
 */
import {
  effectiveDailyQuota,
  type ConnectionCandidate,
  type SlotStrategy,
  type StrategyNetwork,
} from "./auto-slot.js";

export interface InfluencerAccountPreference {
  /** Las conexiones candidatas para `planSlotConversion`. */
  readonly connections: readonly ConnectionCandidate[];
  /** Las redes a planificar, o `undefined` = sin preferencia. */
  readonly networks: readonly StrategyNetwork[] | undefined;
  /**
   * Red → la **única** cuenta marcada y activa en esa red. Para quien crea un
   * slot planificado sin convertirlo (el piloto): lo guarda como su
   * `connectionId` y el barrido lo convierte con esa cuenta (`FR-150`).
   * Redes con cero o varias marcadas no están.
   */
  readonly pinned: ReadonlyMap<string, string>;
}

interface MarkedAccount {
  readonly platform: string;
  readonly connectionId: string;
}

function markedAccounts(accounts: unknown): MarkedAccount[] {
  if (!Array.isArray(accounts)) return [];
  const out: MarkedAccount[] = [];
  for (const raw of accounts as readonly unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const a = raw as Record<string, unknown>;
    if (a["enabled"] !== true) continue;
    if (typeof a["platform"] !== "string" || typeof a["connectionId"] !== "string")
      continue;
    out.push({ platform: a["platform"], connectionId: a["connectionId"] });
  }
  return out;
}

export function preferInfluencerAccounts(
  strategy: SlotStrategy,
  active: readonly ConnectionCandidate[],
  accounts: unknown,
): InfluencerAccountPreference {
  const marked = markedAccounts(accounts).filter((m) =>
    active.some((c) => c.id === m.connectionId && c.platform === m.platform),
  );
  if (marked.length === 0) {
    return { connections: active, networks: undefined, pinned: new Map() };
  }

  const markedPlatforms = new Set(marked.map((m) => m.platform));
  const markedIds = new Set(marked.map((m) => m.connectionId));
  const connections = active.filter(
    (c) => !markedPlatforms.has(c.platform) || markedIds.has(c.id),
  );

  const networks = strategy.networks
    .filter((plan) => effectiveDailyQuota(plan) > 0 && markedPlatforms.has(plan.network))
    .map((plan) => plan.network);
  const pinned = new Map<string, string>();
  for (const platform of markedPlatforms) {
    const onPlatform = marked.filter((m) => m.platform === platform);
    if (onPlatform.length === 1)
      pinned.set(platform, (onPlatform[0] as MarkedAccount).connectionId);
  }
  return {
    connections,
    networks: networks.length === 0 ? undefined : networks,
    pinned,
  };
}
