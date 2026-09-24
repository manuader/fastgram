/**
 * La Configuration del influencer (`FR-083`, `P4-INFL-003`) consumida por el
 * refill de Blitz — sprint 7, segunda tanda.
 *
 * `GET/PUT /influencers/:id/config` (`apps/api/src/routes/v1/influencers.ts`)
 * guarda en `influencer_configs` los ángulos, las cuentas de publicación y los
 * sets del personaje. Hasta acá nadie los leía: el refill elegía el ángulo sin
 * mirar al personaje. Esto cierra la mitad de los ángulos.
 *
 * ## La regla
 *
 * Cuando la sugerencia **usa** un influencer y su Configuration tiene ángulos
 * asociados que siguen activos, el ángulo tiene que ser uno de ésos. Si la
 * tirada de `AI-002` ya cayó en uno, no se toca nada (ni el `Rng`). Si no, se
 * re-sortea **entre los asociados** con los mismos pesos de `angleWeights`
 * (uniforme si todos pesan 0: el dueño los asoció a mano, eso ya es una
 * elección), y la media se vuelve a elegir con el tema nuevo.
 *
 * Sin ángulos asociados, o con asociados que ya no están activos, **no hay
 * restricción**: la Configuration vacía significa "cualquiera", no "ninguno".
 *
 * ## Por qué acá y no en `planBlitzSuggestion`
 *
 * El orden de `core` sortea el ángulo **antes** que el influencer (`AI-002`), y
 * `JV-6` puede re-elegir el personaje después. La restricción depende del
 * personaje final, así que va después de los dos. Moverla a `core` sería lo
 * prolijo; queda anotado en el reporte (el paquete no es de este agente).
 */
import {
  explainSuggestion,
  selectMedia,
  type BlitzPlanningContext,
  type BlitzPreferences,
  type PlannedBlitzSuggestion,
} from "@fastgram/core";
import { influencerConfigRepository, type Transaction } from "@fastgram/db";
import type { Rng } from "@fastgram/ports";

/** Por influencer, los ángulos asociados en su Configuration (sólo los no vacíos). */
export type InfluencerAngles = ReadonlyMap<string, readonly string[]>;

/**
 * Lee la Configuration de cada influencer activo. Son a lo sumo 50
 * (`HARD_CAPS.activeInfluencers`) y la PK es `influencerId`: una lectura por
 * personaje, sin paginar.
 */
export async function readInfluencerAngles(
  tx: Transaction,
  companyId: string,
  influencerIds: readonly string[],
): Promise<InfluencerAngles> {
  const out = new Map<string, readonly string[]>();
  for (const id of influencerIds) {
    const row = await influencerConfigRepository.findById(tx, { companyId }, id);
    if (row !== null && row.angleIds.length > 0) out.set(id, row.angleIds);
  }
  return out;
}

/**
 * La sugerencia con el ángulo restringido a los del influencer. Ver la
 * cabecera. Devuelve la misma referencia cuando no hay nada que cambiar.
 */
export function restrictToInfluencerAngles(
  rng: Rng,
  preferences: BlitzPreferences,
  context: BlitzPlanningContext,
  influencerAngles: InfluencerAngles | undefined,
  planned: PlannedBlitzSuggestion,
): PlannedBlitzSuggestion {
  if (planned.influencerId === null || influencerAngles === undefined) return planned;
  const configured = influencerAngles.get(planned.influencerId);
  if (configured === undefined) return planned;

  const active = new Set(context.activeAngleIds);
  const allowed = [...new Set(configured)].filter((id) => active.has(id));
  if (allowed.length === 0) return planned;
  if (planned.plan.angleId !== null && allowed.includes(planned.plan.angleId)) {
    return planned;
  }

  const weighted = allowed.map((value) => ({
    value,
    weight: Math.max(0, preferences.angleWeights[value] ?? 0),
  }));
  const angleId = weighted.some((w) => w.weight > 0)
    ? rng.weightedPick(weighted)
    : (allowed[rng.nextInt(0, allowed.length)] as string);

  const plan = { ...planned.plan, angleId };
  const angleTitle = context.angleTitles.get(angleId);
  const topic = angleTitle ?? null;
  // El tema elige la media (`JV-6`); con el tema nuevo, se vuelve a elegir de
  // los sets del mismo personaje. Si por algún motivo no hay (no debería: el
  // formato y el personaje no cambiaron), queda la que estaba.
  const media =
    selectMedia(rng, context.bank, plan.contentType, planned.influencerId, topic) ??
    planned.media;
  const narrative = {
    ...planned.narrative,
    angleTitle,
    // Las líneas de media por tema son sólo de green-screen, que no lleva
    // influencer (`INFLUENCER_CAPABLE_TYPES`): no hay nada que conservar.
    mediaLines: [],
  };
  return {
    ...planned,
    plan,
    topic,
    media,
    narrative,
    derivedExplanation: explainSuggestion(plan, narrative),
  };
}
