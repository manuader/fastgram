/**
 * El decisor de assets en el worker — sprint 9 (O), `PU-S9-008`, D-18.
 *
 * Lo puro (filtro, shortlist, preguntas, ponderación, fallback) está en
 * `core/assets/decision`. Acá sólo lo que habla con el puerto:
 *
 * - **Dos pedidos por candidato**: el encaje (`ask` con idea/marca/remate
 *   sobre el estado completo) y la seguridad (dos `noul` sobre la sola
 *   descripción; ver `HARM_QUESTION` en `core`).
 * - **Paralelismo acotado** ({@link ASSET_DECISION_CONCURRENCY} en vuelo) y un
 *   **plazo total** ({@link ASSET_DECISION_DEADLINE_MS}). Lo que no llegó a
 *   tiempo no compite; si no llegó nada, manda el ranking textual. Nunca
 *   bloquea: ningún error sale de {@link runAssetDecision}.
 * - **Persistencia** en `asset_decisions`, en su propia transacción; un fallo
 *   ahí se loguea y la decisión sigue.
 */
import {
  clampPreferenceExploration,
  ASSET_DECISION_POINT,
  ASSET_QUESTIONS_VERSION,
  HARM_MAX,
  NSFW_MAX,
  SAFETY_QUESTIONS,
  decideAsset,
  planAssetDecision,
  rankByFit,
  topScored,
  type AssetDecision,
  type AssetDecisionInput,
  type AssetDimension,
  type CandidateAnswers,
  type LearnedPreferences,
  type SafetyDimension,
  type ShortlistEntry,
} from "@fastgram/core";
import { recordAssetDecision, type Database, type NewAssetDecision } from "@fastgram/db";
import {
  isPortError,
  type Judgment,
  type NoulAnswer,
  type Rng,
  type ScoreAnswer,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";

/**
 * Pedidos en vuelo. `laya-serve` infiere de a uno (un solo hilo de
 * inferencia): más en vuelo no acelera la inferencia, pero sí tapa la latencia
 * de red y de la transacción de `judgment_records` de cada llamada. Con 4 se
 * queda muy lejos del tope de admisión de Laya (`LAYA_MAX_CONCURRENT`, 16, 503
 * por encima).
 */
export const ASSET_DECISION_CONCURRENCY = 4;

/** Plazo total de una decisión (brief: «plazo total ~10 s»). */
export const ASSET_DECISION_DEADLINE_MS = 10_000;

/** Con menos que esto de plazo no se arranca otra llamada: vencería seguro. */
const MIN_CALL_BUDGET_MS = 150;

/**
 * Llamadas fallidas seguidas, sin ningún éxito, para dejar de intentar. Un
 * motor caído no puede costar 40 timeouts: a la tercera, manda el ranking.
 */
const GIVE_UP_AFTER_FAILURES = 3;

export interface AssetDecisionSubject {
  readonly companyId: string;
  readonly subjectType: string;
  readonly subjectId?: string;
}

export interface AssetDecisionRun {
  readonly decision: AssetDecision;
  /** Lo que se juzgó, en orden de ranking textual. */
  readonly shortlist: readonly ShortlistEntry[];
  /** Las respuestas crudas que usó la decisión (para `asset_decisions`). */
  readonly answers: ReadonlyMap<string, CandidateAnswers>;
  readonly latencyMs: number;
  /** Respuestas que entraron en la decisión / llamadas que se intentaron. */
  readonly answered: number;
  readonly attempted: number;
}

export interface AssetDecisionOptions {
  readonly concurrency?: number;
  readonly deadlineMs?: number;
  readonly nowMs?: () => number;
}

/**
 * Qué parte del plazo se guarda para la seguridad. La fase de encaje deja de
 * arrancar llamadas cuando queda menos que esto; con la Mac cargada una
 * llamada a Laya llegó a tardar 4 s (medido en el sprint 9), así que con menos
 * de un cuarto del plazo la seguridad no alcanzaría a nadie.
 */
const SAFETY_RESERVE_FRACTION = 0.25;

/** Corre `jobs` con `concurrency` en vuelo hasta que se acaben o venza `until`. */
async function runPool(
  jobs: readonly ((timeoutMs: number) => Promise<void>)[],
  opts: {
    readonly concurrency: number;
    /** No se arranca una llamada después de esto. */
    readonly startUntil: number;
    /** Plazo de cada llamada y de la espera. */
    readonly hardUntil: number;
    readonly now: () => number;
    readonly stats: PoolStats;
  },
): Promise<void> {
  let next = 0;
  let stop = false;
  // Cuánto tarda una llamada, visto desde acá (media de las que terminaron).
  // No se arranca una que no alcanzaría a terminar antes de `startUntil`:
  // Laya infiere de a una, así que una llamada abandonada igual ocupa su
  // hilo y demora a la fase siguiente (medido: la seguridad vencía detrás
  // de encajes abandonados).
  let doneCalls = 0;
  let doneMs = 0;
  async function lane(): Promise<void> {
    for (;;) {
      if (stop || opts.stats.gaveUp) return;
      const job = jobs[next];
      if (job === undefined) return;
      const t = opts.now();
      const expected = doneCalls === 0 ? 0 : doneMs / doneCalls;
      if (opts.startUntil - t < Math.max(MIN_CALL_BUDGET_MS, expected)) return;
      next += 1;
      opts.stats.attempted += 1;
      try {
        await job(Math.max(MIN_CALL_BUDGET_MS, Math.floor(opts.hardUntil - t)));
        doneCalls += 1;
        doneMs += opts.now() - t;
        opts.stats.answered += 1;
        opts.stats.failuresInARow = 0;
      } catch (error: unknown) {
        const code = isPortError(error) ? error.code : "unexpected";
        opts.stats.errors.set(code, (opts.stats.errors.get(code) ?? 0) + 1);
        opts.stats.failuresInARow += 1;
        if (
          opts.stats.answered === 0 &&
          opts.stats.failuresInARow >= GIVE_UP_AFTER_FAILURES
        ) {
          opts.stats.gaveUp = true;
        }
      }
    }
  }
  const lanes = Promise.all(
    Array.from({ length: Math.max(1, opts.concurrency) }, () => lane()),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeUp = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, opts.hardUntil - opts.now()));
  });
  try {
    await Promise.race([lanes, timeUp]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Lo que siga en vuelo termina solo; su resultado ya no cuenta.
    stop = true;
  }
}

interface PoolStats {
  attempted: number;
  answered: number;
  failuresInARow: number;
  gaveUp: boolean;
  readonly errors: Map<string, number>;
}

/**
 * Corre una decisión. `judgment: null` = sin motor: fallback directo, sin
 * llamar a nadie.
 *
 * ## Dos fases, para no pagar la seguridad de quien no puede ganar
 *
 * 1. **Encaje** de toda la shortlist (un `ask` por candidato), hasta que se
 *    acaben o quede sólo la reserva de seguridad del plazo.
 * 2. **Seguridad** en orden de encaje (`rankByFit`), de a `concurrency`,
 *    hasta encontrar uno seguro: todo lo que está debajo del mejor seguro no
 *    puede ganar, así que preguntarle sería gastar. El resultado es el mismo
 *    que preguntar todo, con N + ~1 llamadas en vez de 2N.
 */
export async function runAssetDecision(
  judgment: Judgment | null,
  input: AssetDecisionInput,
  logger: BuildLogger,
  options: AssetDecisionOptions = {},
): Promise<AssetDecisionRun> {
  const now = options.nowMs ?? Date.now;
  const started = now();
  const plan = planAssetDecision(input);
  if (plan === null) {
    return {
      decision: decideAsset({ role: input.role, shortlist: [], answers: null }),
      shortlist: [],
      answers: new Map(),
      latencyMs: 0,
      answered: 0,
      attempted: 0,
    };
  }
  if (judgment === null || plan.shortlist.length === 0) {
    return {
      decision: decideAsset({
        role: input.role,
        shortlist: plan.shortlist,
        excluded: plan.excluded,
        answers: null,
        preference: plan.preference,
      }),
      shortlist: plan.shortlist,
      answers: new Map(),
      latencyMs: now() - started,
      answered: 0,
      attempted: 0,
    };
  }

  const deadlineMs = options.deadlineMs ?? ASSET_DECISION_DEADLINE_MS;
  const deadline = started + deadlineMs;
  const concurrency = Math.max(1, options.concurrency ?? ASSET_DECISION_CONCURRENCY);
  const fits = new Map<string, Partial<Record<AssetDimension, ScoreAnswer>>>();
  const safety = new Map<string, Partial<Record<SafetyDimension, NoulAnswer>>>();
  const stats: PoolStats = {
    attempted: 0,
    answered: 0,
    failuresInARow: 0,
    gaveUp: false,
    errors: new Map(),
  };

  // Fase 1: encaje. Una respuesta que llega después del cierre no se anota.
  let fitOpen = true;
  await runPool(
    plan.requests.map((req) => async (timeoutMs: number) => {
      const { answers } = await judgment.ask({
        decisionPoint: ASSET_DECISION_POINT,
        state: req.fitState,
        questions: plan.questions,
        timeoutMs,
      });
      if (fitOpen)
        fits.set(req.id, answers as Partial<Record<AssetDimension, ScoreAnswer>>);
    }),
    {
      concurrency,
      startUntil: deadline - deadlineMs * SAFETY_RESERVE_FRACTION,
      hardUntil: deadline - deadlineMs * SAFETY_RESERVE_FRACTION,
      now,
      stats,
    },
  );
  fitOpen = false;

  // Fase 2: seguridad, del mejor encaje para abajo, hasta el primer seguro.
  // Con el gusto del dueño (T): el mismo orden que va a usar la decisión, así
  // el corte «hasta el primer seguro» sigue siendo exacto.
  const order = rankByFit({
    role: input.role,
    shortlist: plan.shortlist,
    fits,
    preference: plan.preference,
  });
  const byId = new Map(plan.requests.map((r) => [r.id, r]));
  let safetyOpen = true;
  for (let i = 0; i < order.length && !stats.gaveUp; i += concurrency) {
    if (deadline - now() < MIN_CALL_BUDGET_MS) break;
    const batch = order.slice(i, i + concurrency);
    await runPool(
      batch.map((id) => async (timeoutMs: number) => {
        const req = byId.get(id);
        if (req === undefined) return;
        const { answers } = await judgment.ask({
          decisionPoint: ASSET_DECISION_POINT,
          state: req.safetyState,
          questions: SAFETY_QUESTIONS,
          timeoutMs,
        });
        if (safetyOpen) safety.set(id, answers);
      }),
      { concurrency, startUntil: deadline, hardUntil: deadline, now, stats },
    );
    const safe = (id: string): boolean => {
      const a = safety.get(id);
      return (
        a !== undefined &&
        (a.harm?.probability ?? 1) < HARM_MAX &&
        (a.nsfw?.probability ?? 1) < NSFW_MAX
      );
    };
    if (batch.some(safe)) break;
  }
  safetyOpen = false;
  const { attempted, errors } = stats;
  // Las que **se usaron**: una que llegó después del cierre de su fase contó
  // como respondida para el corte por fallas, pero no entra en la decisión.
  const answered = fits.size + safety.size;

  // Foto de lo que llegó **hasta acá**: una respuesta tardía no puede cambiar
  // una decisión ya tomada.
  const answers = new Map<string, CandidateAnswers>();
  for (const req of plan.requests) {
    const fit = fits.get(req.id);
    const checks = safety.get(req.id);
    if (fit === undefined && checks === undefined) continue;
    answers.set(req.id, {
      ...(fit === undefined ? {} : { fit: { ...fit } }),
      ...(checks === undefined ? {} : { safety: { ...checks } }),
    });
  }

  const decision = decideAsset({
    role: input.role,
    shortlist: plan.shortlist,
    excluded: plan.excluded,
    answers,
    preference: plan.preference,
  });
  const latencyMs = now() - started;
  if (errors.size > 0 || decision.mode !== "judged") {
    logger.warn(
      {
        role: input.role,
        mode: decision.mode,
        attempted,
        answered,
        errors: Object.fromEntries(errors),
        latencyMs,
      },
      "decisor de assets: juicio incompleto (lo que falta lo decide el ranking)",
    );
  }
  return { decision, shortlist: plan.shortlist, answers, latencyMs, answered, attempted };
}

/** La fila de `asset_decisions` de una corrida. */
export function assetDecisionRow(
  subject: AssetDecisionSubject,
  input: AssetDecisionInput,
  run: AssetDecisionRun,
  provenance: { readonly adapter: string; readonly model: string } | null,
): NewAssetDecision {
  const d = run.decision;
  return {
    subjectType: subject.subjectType,
    subjectId: subject.subjectId ?? null,
    role: input.role,
    format: input.format,
    idea: input.idea ?? null,
    candidates: run.shortlist.map((e) => ({
      id: e.candidate.id,
      kind: e.candidate.kind,
      source: e.candidate.source,
      textRank: e.textRank,
      textScore: e.textScore,
    })),
    excluded: d.excluded,
    answers: Object.fromEntries(run.answers),
    scored: d.scored,
    weights: d.weights,
    weightsVersion: d.weightsVersion,
    questionsVersion: ASSET_QUESTIONS_VERSION,
    chosenId: d.chosenId,
    mode: d.mode,
    reason: d.reason,
    adapter: provenance?.adapter ?? null,
    model: provenance?.model ?? null,
    latencyMs: run.latencyMs,
  };
}

/**
 * El juez de assets de un job: corre la decisión y la persiste. Lo arma
 * `discovery/jv6.ts` cuando `judgment.assets` resuelve a un SystemOne.
 */
export interface AssetJudge {
  decide(input: AssetDecisionInput): Promise<AssetDecision>;
}

export function createAssetJudge(deps: {
  readonly judgment: Judgment;
  readonly subject: AssetDecisionSubject;
  readonly db: Database | null;
  readonly appRole: string | undefined;
  readonly logger: BuildLogger;
  readonly options?: AssetDecisionOptions;
}): AssetJudge {
  return {
    async decide(input) {
      const run = await runAssetDecision(deps.judgment, input, deps.logger, deps.options);
      const top = topScored(run.decision, 3).map((s) => ({
        id: s.id,
        total: s.total,
        fit: s.fit,
        preference: s.preference,
        textRank: s.textRank,
      }));
      deps.logger.info(
        {
          companyId: deps.subject.companyId,
          role: input.role,
          format: input.format,
          mode: run.decision.mode,
          chosenId: run.decision.chosenId,
          candidates: run.decision.scored.length,
          answered: run.answered,
          attempted: run.attempted,
          latencyMs: run.latencyMs,
          library: run.shortlist.filter((e) => e.candidate.source === "library").length,
          preferences:
            input.preferences === null || input.preferences === undefined
              ? "none"
              : input.preferences.explored
                ? "explored"
                : "applied",
          top,
        },
        "decisor de assets",
      );
      if (deps.db !== null) {
        try {
          await recordAssetDecision(
            deps.db,
            deps.subject.companyId,
            assetDecisionRow(deps.subject, input, run, deps.judgment.provenance),
            deps.appRole === undefined ? {} : { role: deps.appRole },
          );
        } catch (error: unknown) {
          deps.logger.warn(
            {
              companyId: deps.subject.companyId,
              reason: error instanceof Error ? error.message : String(error),
            },
            "no se pudo guardar la decisión en asset_decisions (la decisión sigue)",
          );
        }
      }
      return run.decision;
    },
  };
}

/**
 * Sprint 9 (T, `PU-S9-015`): el mismo juez, con el gusto aprendido del dueño.
 *
 * Cada decisión tira **una** vez la exploración (`settings.exploration`, la de
 * la marca o la del dueño) con el `Rng` del job: con probabilidad `p` decide
 * sin preferencias, igual que el refill con el mix. Sin nada aprendido (o
 * apagadas) devuelve el juez tal cual y no toca el `Rng`: la secuencia del
 * plan queda idéntica a la de antes.
 */
export function withLearnedPreferences(
  judge: AssetJudge,
  prefs: LearnedPreferences | null,
  rng: Rng,
): AssetJudge {
  if (prefs === null || !prefs.settings.enabled || prefs.features.size === 0)
    return judge;
  const exploration = clampPreferenceExploration(prefs.settings.exploration);
  return {
    decide(input) {
      if (input.preferences !== undefined && input.preferences !== null) {
        return judge.decide(input);
      }
      return judge.decide({
        ...input,
        preferences: { prefs, explored: rng.next() < exploration },
      });
    },
  };
}
