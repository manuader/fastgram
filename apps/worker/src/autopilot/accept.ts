/**
 * Aceptar una sugerencia desde el worker — `PU-AUTO-002`.
 *
 * Es `POST /blitz` con `suggestionId` (`apps/api/src/routes/v1/blitz.ts`) sin
 * la capa HTTP, y **reusa las mismas piezas**: `lockSuggestionById`,
 * `parseSuggestionBuildPlan` → `lockLiveMedia` → `composeBlitzBuildPayload` →
 * `contentBuildPayloadSchema`, y el caso de uso `acceptBlitzSuggestionUseCase`
 * de `core` con su gate de cuota (saves y swipes), la pieza en `BUILDING`, el
 * `popped` y el `content-build` encolado **en la misma transacción**
 * (ADR-005).
 *
 * ## Por qué no es un caso de uso compartido con la ruta
 *
 * Lo que la ruta tiene y `core` no —el repositorio del caso de uso sobre una
 * transacción de Drizzle, el lock del ledger y la validación con el schema del
 * contrato— necesita `core` + `db` + `contracts` a la vez, y ningún paquete ve
 * los tres: sólo las apps. Un paquete nuevo es un `package.json` nuevo. Así
 * que la ruta queda intacta y esto repite ~80 líneas de pegamento; la regla de
 * negocio (el gate, el orden, el encolado) sigue siendo una sola, la de
 * `core`. Está en el reporte como deuda.
 *
 * ## Qué cambia respecto de la ruta
 *
 * - **Sin `aspectRatio`**: el slideshow sale con el default de
 *   `composeBlitzBuildPayload`, igual que un `POST /blitz` sin el campo.
 * - **El perfil lo mira quien llama**, una vez por corrida y no por pieza.
 * - **Cuota**: `unlimited` en el modo personal (`D-06`), `enforced` si no —la
 *   misma `QuotaPolicy` que la API resuelve con `quotaPolicyFor`.
 */
import { randomUUID } from "node:crypto";

import { contentBuildPayloadSchema } from "@fastgram/contracts";
import {
  BLITZ_DAILY_SWIPE_LIMIT,
  acceptBlitzSuggestionUseCase,
  acceptReelSuggestionUseCase,
  billingPeriodKey,
  composeBlitzBuildPayload,
  currentSwipesLedger,
  isBlitzContentType,
  nextBillingResetUtc,
  parsePlanId,
  parseSuggestionBuildPlan,
  rebindMediaUrls,
  selectionMediaIds,
  PLANS,
  type BlitzAcceptanceRepository,
  type BlitzQuotaSnapshot,
  type PlanId,
  type Suggestion,
} from "@fastgram/core";
import {
  companyRepository,
  contentRepository,
  lockLiveMedia,
  lockSuggestionById,
  markSuggestionPopped,
  quotaLedgerStore,
  type SuggestionRow,
  type Transaction,
} from "@fastgram/db";
import type { Clock, Queue } from "@fastgram/ports";

import { markReelPlanItemAccepted, prepareReelBuildPayload } from "../reels/accept.js";

/** `enforced` = lo del PRD; `unlimited` = modo personal. Igual que en la API. */
export type AutopilotQuotaPolicy = "enforced" | "unlimited";

export type AcceptOutcome =
  | { readonly kind: "accepted"; readonly contentId: string }
  /** Ya no está `queued` (el humano la aceptó o descartó mientras tanto). */
  | { readonly kind: "gone" }
  /** No se puede construir: el llamador la descarta en otra transacción. */
  | { readonly kind: "unbuildable"; readonly detail: string };

class Unbuildable extends Error {
  override readonly name = "Unbuildable";
}

/** Corre dentro de `tx`, con el scope de la marca. Lanza lo que lance `core` (cuota). */
export async function acceptForAutopilot(
  tx: Transaction,
  args: {
    readonly companyId: string;
    readonly suggestionId: string;
    readonly queue: Queue;
    readonly clock: Clock;
    readonly policy: AutopilotQuotaPolicy;
  },
): Promise<AcceptOutcome> {
  const { companyId } = args;
  const claimed = await lockSuggestionById(tx, { companyId }, args.suggestionId);
  if (claimed === null || claimed.status !== "queued") return { kind: "gone" };

  let buildPayload: unknown;
  // Sprint 9 (U): un reel del planificador trae su spec entero en el plan.
  let reelItemId: string | null = null;
  if (claimed.contentType === "reel") {
    const prepared = await prepareReelBuildPayload(tx, companyId, claimed);
    if (!prepared.ok) return { kind: "unbuildable", detail: prepared.detail };
    buildPayload = prepared.payload;
    reelItemId = prepared.planItemId;
  } else {
    try {
      buildPayload = await prepareBuildPayload(tx, companyId, claimed);
    } catch (error: unknown) {
      if (error instanceof Unbuildable)
        return { kind: "unbuildable", detail: error.message };
      throw error;
    }
  }

  let createdId: string | undefined;
  let period: string | undefined;

  const repository: BlitzAcceptanceRepository = {
    async findSuggestion(cid, sid, transaction) {
      sameTx(transaction, tx);
      if (cid !== companyId || sid !== claimed.id) return null;
      return toDomainSuggestion(claimed);
    },
    async loadQuota(cid, transaction): Promise<BlitzQuotaSnapshot> {
      sameTx(transaction, tx);
      const locked = await lockLedger(tx, cid, args.clock, args.policy);
      period = locked.period;
      return {
        saves: {
          plan: locked.plan,
          includedUsed: locked.row.contentSavesUsed,
          purchasedRemaining: locked.row.contentSavesPurchased,
          overageUsed: locked.row.overageUnits,
          overageEnabled: locked.apiOverageEnabled,
          resetAt: nextBillingResetUtc(locked.now, locked.billingAnchorDay),
        },
        swipes: currentSwipesLedger({
          storedUsed: locked.row.dailySwipesUsed,
          storedResetAt: locked.row.dailySwipeResetAt,
          now: locked.now,
          dailyLimit: BLITZ_DAILY_SWIPE_LIMIT,
        }),
      };
    },
    async saveQuota(cid, quota, transaction) {
      sameTx(transaction, tx);
      if (period === undefined) throw new Error("saveQuota antes de loadQuota.");
      await quotaLedgerStore.writeCounters(tx, { companyId: cid }, period, {
        contentSavesUsed: quota.saves.includedUsed,
        contentSavesPurchased: quota.saves.purchasedRemaining,
        overageUnits: quota.saves.overageUsed,
      });
      await quotaLedgerStore.writeDailySwipes(
        tx,
        { companyId: cid },
        period,
        quota.swipes.used,
        quota.swipes.resetAt,
      );
    },
    async insertContent(content, transaction) {
      sameTx(transaction, tx);
      if (period === undefined) throw new Error("insertContent antes de loadQuota.");
      const row = await contentRepository.create(
        tx,
        { companyId },
        {
          id: content.id,
          type: content.type,
          status: content.status,
          generatedText:
            content.generatedText === undefined || content.generatedText === ""
              ? null
              : content.generatedText,
          remixSourceUrl: content.remixSourceUrl ?? null,
          // Migración `0032`: el personaje de la sugerencia, para el auto-slot.
          influencerId: content.influencerId ?? null,
          revision: content.revision,
          buildPayload,
          saveBucket: content.saveBucket,
          savePeriod: period,
        },
      );
      createdId = row.id;
    },
    async markSuggestionPopped(cid, sid, transaction) {
      sameTx(transaction, tx);
      const popped = await markSuggestionPopped(tx, { companyId: cid }, sid);
      if (!popped)
        throw new Error(`La sugerencia ${sid} dejó de estar queued con el lock tomado.`);
    },
    // Sin idempotency key: la guarda del piloto es el `UNIQUE (suggestion_id)`
    // de `autopilot_decisions`, escrito en esta misma transacción.
    async findIdempotencyRecord() {
      throw new Error("El piloto acepta sin idempotency key.");
    },
    async putIdempotencyRecord() {
      throw new Error("El piloto acepta sin idempotency key.");
    },
  };

  if (reelItemId !== null) {
    // Mismo cobro, misma pieza en BUILDING y mismo build encolado en la
    // transacción, con el caso de uso de reels (`core/reels/accept.ts`).
    await acceptReelSuggestionUseCase(
      { clock: args.clock, queue: args.queue, ids: { newId: () => randomUUID() }, repository },
      {
        companyId,
        suggestion: {
          id: claimed.id,
          companyId: claimed.companyId,
          status: claimed.status,
          generatedText: claimed.generatedText,
          angleId: claimed.angleId,
        },
        transaction: tx,
      },
    );
    if (createdId === undefined) throw new Error("El caso de uso no insertó la pieza.");
    await markReelPlanItemAccepted(tx, companyId, reelItemId, createdId);
    return { kind: "accepted", contentId: createdId };
  }

  await acceptBlitzSuggestionUseCase(
    {
      clock: args.clock,
      queue: args.queue,
      // `contents.id` es `uuid`: mismo criterio que la ruta.
      ids: { newId: () => randomUUID() },
      repository,
    },
    {
      companyId,
      // No hay usuario: el actor es el piloto. Sólo viaja a los errores de scope.
      actorId: "autopilot",
      suggestionId: claimed.id,
      transaction: tx,
    },
  );
  if (createdId === undefined) throw new Error("El caso de uso no insertó la pieza.");
  return { kind: "accepted", contentId: createdId };
}

function sameTx(transaction: unknown, tx: Transaction): void {
  if (transaction !== tx) {
    throw new Error(
      "acceptBlitzSuggestionUseCase pasó otra transacción: todo va en una.",
    );
  }
}

/** Igual que `toDomainSuggestion` de la ruta (ver su comentario). */
function toDomainSuggestion(row: SuggestionRow): Suggestion {
  if (!isBlitzContentType(row.contentType)) {
    throw new Error(`La sugerencia ${row.id} tiene un contentType desconocido.`);
  }
  return {
    id: row.id,
    companyId: row.companyId,
    contentType: row.contentType,
    generatedText: row.generatedText ?? "",
    aiExplanation: row.aiExplanation ?? "",
    remixSourceUrl: row.remixSourceUrl ?? undefined,
    sourceTrendingItemId: row.sourceTrendingItemId ?? undefined,
    influencerId: row.influencerId ?? undefined,
    angleId: row.angleId ?? undefined,
    textStylePresetId: row.textStylePresetId ?? undefined,
    status: row.status,
    textBoxes: [],
    slideCount: 1,
  };
}

/** Igual que `prepareBuildPayload` de la ruta, sin `aspectRatio`. */
async function prepareBuildPayload(
  tx: Transaction,
  companyId: string,
  claimed: SuggestionRow,
): Promise<unknown> {
  const parsed = parseSuggestionBuildPlan(claimed.buildPlan, claimed.contentType);
  if (!parsed.ok) throw new Unbuildable(parsed.reason);
  const plan = parsed.plan;

  const ids = [...new Set(selectionMediaIds(plan.media))];
  const live = new Map(
    (await lockLiveMedia(tx, { companyId }, ids)).map((m) => [m.mediaId, m.url]),
  );
  const lost = ids.filter((id) => !live.has(id));
  if (lost.length > 0)
    throw new Unbuildable(`media ${lost.join(", ")} deleted or not ready`);

  let payload: unknown;
  try {
    payload = composeBlitzBuildPayload(rebindMediaUrls(plan, live), {
      textStylePresetId: claimed.textStylePresetId,
    });
  } catch (error: unknown) {
    throw new Unbuildable(error instanceof Error ? error.message : String(error));
  }
  const checked = contentBuildPayloadSchema.safeParse(payload);
  if (!checked.success) {
    throw new Unbuildable(
      checked.error.issues.map((i) => `${i.path.join(".")}: ${i.code}`).join("; "),
    );
  }
  return checked.data;
}

/**
 * El ledger del período, bloqueado. Mismo cálculo que `lockLedger` de
 * `apps/api/src/support/quota.ts` (plan, período por día ancla, `lockPeriod`
 * con el cupo incluido del plan); en `unlimited` se evalúa como `pro`.
 */
async function lockLedger(
  tx: Transaction,
  companyId: string,
  clock: Clock,
  policy: AutopilotQuotaPolicy,
) {
  const scope = { companyId };
  const company = await companyRepository.billing(tx, scope);
  if (company === null) {
    throw new Error(
      "No se pudo leer el workspace para cobrar: scope y GUC no coinciden.",
    );
  }
  const plan: PlanId = policy === "unlimited" ? "pro" : parsePlanId(company.planId);
  const now = new Date(clock.nowMs());
  const period = billingPeriodKey(now, company.billingAnchorDay);
  const row = await quotaLedgerStore.lockPeriod(tx, scope, period, {
    contentSavesIncluded: PLANS[plan].contentSaves ?? 0,
  });
  return {
    plan,
    now,
    period,
    row,
    apiOverageEnabled: company.apiOverageEnabled,
    billingAnchorDay: company.billingAnchorDay,
  };
}
