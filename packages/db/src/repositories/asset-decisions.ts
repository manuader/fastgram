/**
 * `asset_decisions` (migración `0037`, sprint 9, agente O): escribir una
 * decisión del decisor de assets y leer las últimas de una marca.
 *
 * Escribir es **observabilidad + insumo de preferencias**: quien llama (el
 * worker) no deja que un fallo acá tire la pieza — lo loguea y sigue, igual
 * que `RecordingJudgment` con `judgment_records`.
 *
 * La lista de campos se escribe a mano (no `...input`) por la misma razón que
 * en `judgment-sink.ts`: es la línea de retención. Un campo nuevo en la
 * entrada no llega a la base hasta que alguien lo agregue acá.
 */
import { and, desc, eq } from "drizzle-orm";

import type { Database, Executor } from "../client.js";
import { assetDecisions, type AssetDecisionMode } from "../schema/asset-decisions.js";
import { withCompany, type WithCompanyOptions } from "../tenancy.js";
import type { TenantScope } from "./base.js";

export type AssetDecisionRow = typeof assetDecisions.$inferSelect;

export interface NewAssetDecision {
  readonly subjectType: string;
  readonly subjectId?: string | null;
  readonly role: string;
  readonly format: string;
  readonly idea?: string | null;
  readonly candidates: unknown;
  readonly excluded: unknown;
  readonly answers: unknown;
  readonly scored: unknown;
  readonly weights: unknown;
  readonly weightsVersion: string;
  readonly questionsVersion: string;
  readonly chosenId: string | null;
  readonly mode: AssetDecisionMode;
  readonly reason: string;
  readonly adapter: string | null;
  readonly model: string | null;
  readonly latencyMs: number;
}

/** Tope de `idea` en la base. El estado del juicio ya la recorta a 500. */
const IDEA_MAX = 500;

export async function insertAssetDecision(
  exec: Executor,
  scope: TenantScope,
  input: NewAssetDecision,
): Promise<AssetDecisionRow> {
  const rows = await exec
    .insert(assetDecisions)
    .values({
      companyId: scope.companyId,
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      role: input.role,
      format: input.format,
      idea:
        input.idea === undefined || input.idea === null
          ? null
          : input.idea.slice(0, IDEA_MAX),
      candidates: input.candidates,
      excluded: input.excluded,
      answers: input.answers,
      scored: input.scored,
      weights: input.weights,
      weightsVersion: input.weightsVersion,
      questionsVersion: input.questionsVersion,
      chosenId: input.chosenId,
      mode: input.mode,
      reason: input.reason,
      adapter: input.adapter,
      model: input.model,
      // `integer` con CHECK >= 0: un `performance.now()` fraccional no puede
      // tirar el INSERT (misma trampa que `judgment_records`).
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("El INSERT de asset_decisions no devolvió la fila creada.");
  }
  return row;
}

/** Las últimas decisiones de una marca, las más nuevas primero. */
export async function listRecentAssetDecisions(
  exec: Executor,
  scope: TenantScope,
  options: { readonly role?: string; readonly limit?: number } = {},
): Promise<AssetDecisionRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const where =
    options.role === undefined
      ? eq(assetDecisions.companyId, scope.companyId)
      : and(
          eq(assetDecisions.companyId, scope.companyId),
          eq(assetDecisions.role, options.role),
        );
  return exec
    .select()
    .from(assetDecisions)
    .where(where)
    .orderBy(desc(assetDecisions.createdAt))
    .limit(limit);
}

/** Una decisión en su propia transacción con el scope de la marca (RLS). */
export async function recordAssetDecision(
  db: Database,
  companyId: string,
  input: NewAssetDecision,
  options: WithCompanyOptions = {},
): Promise<AssetDecisionRow> {
  return withCompany(
    db,
    companyId,
    (tx) => insertAssetDecision(tx, { companyId }, input),
    options,
  );
}

export const assetDecisionStore = {
  table: assetDecisions,
  insertAssetDecision,
  listRecentAssetDecisions,
  recordAssetDecision,
};
