/**
 * Aceptar un reel de la cola desde el worker (piloto automático) — sprint 9
 * (U), `PU-S9-014`. La API tiene la misma pieza para `POST /blitz`
 * (`apps/api/src/routes/v1/reels.ts`): ~30 líneas repetidas por la misma razón
 * que `autopilot/accept.ts` repite la ruta (ningún paquete ve `core`, `db` y
 * `contracts` a la vez salvo las apps).
 */
import { reelBuildPayloadSchema, reelSpecSchema, type ReelBuildPayload } from "@fastgram/contracts";
import { reelSuggestionPlanOf } from "@fastgram/core";
import {
  lockLiveMedia,
  reelPlanStore,
  type SuggestionRow,
  type Transaction,
} from "@fastgram/db";

export type PreparedReel =
  | { readonly ok: true; readonly payload: ReelBuildPayload; readonly planItemId: string }
  | { readonly ok: false; readonly reason: "invalid_build_plan" | "media_unavailable"; readonly detail: string };

/**
 * El payload de build de una sugerencia `reel`: su spec validado contra el
 * contrato y la media del Media Bank que usa, **viva y retenida** hasta el
 * commit (`lockLiveMedia`, igual que los formatos base). Corre antes de cobrar.
 */
export async function prepareReelBuildPayload(
  tx: Transaction,
  companyId: string,
  claimed: Pick<SuggestionRow, "buildPlan">,
): Promise<PreparedReel> {
  const plan = reelSuggestionPlanOf(claimed.buildPlan);
  if (plan === null) {
    return { ok: false, reason: "invalid_build_plan", detail: "not a reel build_plan" };
  }
  const spec = reelSpecSchema.safeParse(plan.spec);
  if (!spec.success) {
    return {
      ok: false,
      reason: "invalid_build_plan",
      detail: spec.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  const ids = [...new Set(plan.mediaIds)];
  const live = new Set((await lockLiveMedia(tx, { companyId }, ids)).map((m) => m.mediaId));
  const lost = ids.filter((id) => !live.has(id));
  if (lost.length > 0) {
    return { ok: false, reason: "media_unavailable", detail: `media ${lost.join(", ")} deleted or not ready` };
  }
  const payload = reelBuildPayloadSchema.safeParse({ reel: spec.data });
  if (!payload.success) {
    return { ok: false, reason: "invalid_build_plan", detail: "reel payload rejected by the contract" };
  }
  return { ok: true, payload: payload.data, planItemId: plan.planItemId };
}

/** El ítem del plan pasa a `accepted` con su pieza, en la misma transacción del cobro. */
export async function markReelPlanItemAccepted(
  tx: Transaction,
  companyId: string,
  planItemId: string,
  contentId: string,
): Promise<void> {
  await reelPlanStore.updateReelPlanItem(tx, { companyId }, planItemId, {
    status: "accepted",
    contentId,
  });
}
