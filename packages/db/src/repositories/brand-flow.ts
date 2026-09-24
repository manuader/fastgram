/**
 * La oferta post-análisis de `/brand` — `P1-ONB-007`, `D-04`, `FR-011.5.1`
 * (migración `0031`).
 *
 * `FR-011.5.1` dice *dónde* se ofrece: **después** de que el análisis haya
 * terminado y el perfil exista, nunca antes. «Terminó» es una fuente que
 * alguna vez llegó a `ready`/`partial`: `lastAnalysedAt` no nulo con esos
 * estados (o `stale`, que sólo se alcanza desde `ready`). Un `failed` también
 * mueve `lastAnalysedAt`, por eso el estado entra en el filtro.
 *
 * El descarte es por marca (`company_profiles`), no por navegador.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import type { Executor } from "../client.js";
import { brandSources, companyProfiles } from "../schema/index.js";
import type { TenantScope } from "./base.js";

type SourceType = (typeof brandSources.$inferSelect)["sourceType"];

export interface PostAnalysisOfferState {
  /** `null` = no descartada (o la marca todavía no tiene perfil). */
  readonly dismissedAt: Date | null;
  /** La fuente analizada que da nombre a la oferta; `null` = nada terminó todavía. */
  readonly analysedSource: {
    readonly sourceType: SourceType;
    readonly handle: string | null;
  } | null;
}

async function readPostAnalysisOffer(
  exec: Executor,
  scope: TenantScope,
): Promise<PostAnalysisOfferState> {
  const profile = await exec
    .select({ dismissedAt: companyProfiles.postAnalysisOfferDismissedAt })
    .from(companyProfiles)
    .where(eq(companyProfiles.companyId, scope.companyId))
    .limit(1);
  const source = await exec
    .select({ sourceType: brandSources.sourceType, handle: brandSources.handle })
    .from(brandSources)
    .where(
      and(
        eq(brandSources.companyId, scope.companyId),
        inArray(brandSources.status, ["ready", "partial", "stale"]),
        isNotNull(brandSources.lastAnalysedAt),
      ),
    )
    // La primaria primero: es la que el usuario reconoce como «su» marca.
    .orderBy(desc(brandSources.isPrimary), asc(brandSources.createdAt))
    .limit(1);
  const found = source[0];
  return {
    dismissedAt: profile[0]?.dismissedAt ?? null,
    analysedSource:
      found === undefined ? null : { sourceType: found.sourceType, handle: found.handle },
  };
}

/**
 * Marca la oferta como descartada. Idempotente: la segunda vez no mueve la
 * fecha. `false` si la marca no tiene perfil (no hay qué descartar).
 */
async function dismissPostAnalysisOffer(
  exec: Executor,
  scope: TenantScope,
  now: Date,
): Promise<boolean> {
  const updated = await exec
    .update(companyProfiles)
    .set({ postAnalysisOfferDismissedAt: now })
    .where(
      and(
        eq(companyProfiles.companyId, scope.companyId),
        isNull(companyProfiles.postAnalysisOfferDismissedAt),
      ),
    )
    .returning({ id: companyProfiles.id });
  if (updated.length > 0) return true;
  const exists = await exec
    .select({ id: companyProfiles.id })
    .from(companyProfiles)
    .where(eq(companyProfiles.companyId, scope.companyId))
    .limit(1);
  return exists.length > 0;
}

export const brandFlowStore = {
  readPostAnalysisOffer,
  dismissPostAnalysisOffer,
};
