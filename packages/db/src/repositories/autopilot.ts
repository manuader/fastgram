/**
 * Piloto automático — `PU-AUTO-001…003`. Tablas y función de
 * `0017_autopilot.sql`.
 *
 * Todo con `TenantScope` salvo {@link listAutopilotBrands}, que es la pregunta
 * de arriba del tenant ("¿qué marcas hay?") y pasa por la función `SECURITY
 * DEFINER` de la migración — nunca por una consulta directa a `companies` sin
 * scope. Devuelve sólo ids y la autonomía: los datos de cada marca se leen
 * después con su scope.
 */
import { and, asc, eq, gte, isNull, lt, notExists, sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import {
  autopilotDecisions,
  autopilotRuns,
  suggestions,
  type AutopilotDecisionKind,
} from "../schema/index.js";
import type { TenantScope } from "./base.js";

export type AutopilotDecisionRow = typeof autopilotDecisions.$inferSelect;
export type AutopilotRunRow = typeof autopilotRuns.$inferSelect;
export type SuggestionCandidateRow = typeof suggestions.$inferSelect;

/**
 * Qué pasó en la última corrida de una marca.
 *
 * - `ran` — corrió (con o sin decisiones).
 * - `manual` — la marca está en manual: sólo se mantuvo la cola.
 * - `no_llm` — no hay modelo para `text`: no se generó ni se juzgó nada.
 * - `no_judgment` — hay modelo para `text` pero no para `judgment`.
 * - `invalid_strategy` — la fila de estrategia no se pudo leer.
 * - `profile_not_ready` — el perfil de la marca no está listo: no se aprueba
 *   nada (mismo criterio que `POST /blitz`).
 * - `error` — la corrida falló a mitad de camino (el log dice por qué).
 */
export const AUTOPILOT_RUN_OUTCOMES = [
  "ran",
  "manual",
  "no_llm",
  "no_judgment",
  "invalid_strategy",
  "profile_not_ready",
  "error",
] as const;
export type AutopilotRunOutcome = (typeof AUTOPILOT_RUN_OUTCOMES)[number];

export interface AutopilotBrandRow {
  readonly companyId: string;
  readonly ownerUserId: string;
  /** `null` = la marca nunca guardó una estrategia. */
  readonly autonomy: "manual" | "autopilot" | null;
}

interface RawBrandRow {
  company_id: string;
  owner_user_id: string;
  autonomy: string | null;
}

/** Las marcas vivas, de todos los dueños. Ver la cabecera y la migración. */
export async function listAutopilotBrands(exec: Executor): Promise<AutopilotBrandRow[]> {
  const rows = (await exec.execute(
    sql`select company_id, owner_user_id, autonomy from app.autopilot_brands()`,
  )) as unknown as RawBrandRow[];
  return rows.map((r) => ({
    companyId: r.company_id,
    ownerUserId: r.owner_user_id,
    autonomy:
      r.autonomy === "autopilot"
        ? "autopilot"
        : r.autonomy === "manual"
          ? "manual"
          : null,
  }));
}

/**
 * Las sugerencias que el piloto puede juzgar: `queued`, **las más viejas
 * primero**, sin decisión previa y **sin** pedido de «crear desde prompt»
 * (ésas las pidió el humano desde Blitz y las está esperando en el deck: que
 * el piloto se las lleve sería sorprenderlo).
 */
export async function listPilotCandidates(
  exec: Executor,
  scope: TenantScope,
  opts: { readonly limit: number },
): Promise<SuggestionCandidateRow[]> {
  return exec
    .select()
    .from(suggestions)
    .where(
      and(
        eq(suggestions.companyId, scope.companyId),
        eq(suggestions.status, "queued"),
        isNull(suggestions.promptRequestId),
        notExists(
          exec
            .select({ one: sql`1` })
            .from(autopilotDecisions)
            .where(eq(autopilotDecisions.suggestionId, suggestions.id)),
        ),
      ),
    )
    .orderBy(asc(suggestions.createdAt), asc(suggestions.id))
    .limit(opts.limit);
}

export interface NewAutopilotDecision {
  readonly suggestionId: string;
  readonly decision: AutopilotDecisionKind;
  readonly reason: string | null;
  readonly contentId: string | null;
  readonly details: Record<string, unknown>;
}

/**
 * Registra la decisión. `false` si la sugerencia ya tenía una (otra corrida
 * la juzgó primero): el `UNIQUE (suggestion_id)` es la guarda, no una lectura.
 */
export async function recordAutopilotDecision(
  exec: Executor,
  scope: TenantScope,
  input: NewAutopilotDecision,
): Promise<boolean> {
  const rows = await exec
    .insert(autopilotDecisions)
    .values({ ...input, companyId: scope.companyId })
    .onConflictDoNothing({ target: autopilotDecisions.suggestionId })
    .returning({ id: autopilotDecisions.id });
  return rows.length > 0;
}

export interface DecisionWithSuggestion {
  readonly decision: AutopilotDecisionRow;
  readonly contentType: string | null;
  readonly generatedText: string | null;
}

/** Las decisiones con `created_at` en `[from, to)`, de la más vieja a la más nueva. */
export async function listAutopilotDecisionsInRange(
  exec: Executor,
  scope: TenantScope,
  range: { readonly fromMs: number; readonly toMs: number; readonly limit: number },
): Promise<DecisionWithSuggestion[]> {
  const rows = await exec
    .select({
      decision: autopilotDecisions,
      contentType: suggestions.contentType,
      generatedText: suggestions.generatedText,
    })
    .from(autopilotDecisions)
    .leftJoin(
      suggestions,
      and(
        eq(suggestions.id, autopilotDecisions.suggestionId),
        eq(suggestions.companyId, autopilotDecisions.companyId),
      ),
    )
    .where(
      and(
        eq(autopilotDecisions.companyId, scope.companyId),
        gte(autopilotDecisions.createdAt, new Date(range.fromMs)),
        lt(autopilotDecisions.createdAt, new Date(range.toMs)),
      ),
    )
    .orderBy(asc(autopilotDecisions.createdAt), asc(autopilotDecisions.id))
    .limit(range.limit);
  return rows;
}

export type AutopilotRunValues = Omit<
  typeof autopilotRuns.$inferInsert,
  "companyId" | "createdAt" | "updatedAt"
> & { readonly outcome: AutopilotRunOutcome };

export async function saveAutopilotRun(
  exec: Executor,
  scope: TenantScope,
  values: AutopilotRunValues,
): Promise<void> {
  await exec
    .insert(autopilotRuns)
    .values({ ...values, companyId: scope.companyId })
    .onConflictDoUpdate({
      target: autopilotRuns.companyId,
      set: { ...values, updatedAt: new Date() },
    });
}

export async function findAutopilotRun(
  exec: Executor,
  scope: TenantScope,
): Promise<AutopilotRunRow | null> {
  const rows = await exec
    .select()
    .from(autopilotRuns)
    .where(eq(autopilotRuns.companyId, scope.companyId))
    .limit(1);
  return rows[0] ?? null;
}

/** Cuántas sugerencias nuevas se generaron en `[from, to)` ("qué se generó"). */
export async function countSuggestionsCreatedInRange(
  exec: Executor,
  scope: TenantScope,
  range: { readonly fromMs: number; readonly toMs: number },
): Promise<number> {
  const rows = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.companyId, scope.companyId),
        gte(suggestions.createdAt, new Date(range.fromMs)),
        lt(suggestions.createdAt, new Date(range.toMs)),
      ),
    );
  return rows[0]?.n ?? 0;
}

export const autopilotStore = {
  listBrands: listAutopilotBrands,
  listCandidates: listPilotCandidates,
  recordDecision: recordAutopilotDecision,
  listDecisionsInRange: listAutopilotDecisionsInRange,
  saveRun: saveAutopilotRun,
  findRun: findAutopilotRun,
  countSuggestionsCreatedInRange,
};
