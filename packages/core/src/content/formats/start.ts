/**
 * Estimar y arrancar una corrida de formato generativo — `P4-FORMAT-001`.
 *
 * Es el caso de uso que llaman **dos** bordes:
 *
 * - la API (`POST /ai-studio/formats/:format/runs`, pantalla del formato), y
 * - «Create from prompt» de Blitz (agente C, en el worker), cuando el tema
 *   pide un formato generativo (`matchGenerativeFormat`).
 *
 * Por eso recibe todo lo de afuera como dependencias estructurales (el
 * registro de modelos ya resuelto, el estimador del proveedor, el libro de
 * gasto, las dos colecciones de archivos y el encolado): `core` no importa
 * adaptadores.
 *
 * ## El orden, que es el de `POST /ai-studio/generations`
 *
 * 1. Plan del formato (escena + texto) → `invalid` con el campo.
 * 2. Modelo de video configurado, **texto a video** (un image-to-video pide
 *    una imagen que un formato no tiene) → `not_configured`.
 * 3. Validar contra la ficha (`checkGenerationInput`) y **estimar**.
 * 4. Reservar el estimado bajo el lock del libro → `budget_exceeded`.
 * 5. Escribir la generación (`queued`) y la corrida con **el mismo id**, y
 *    encolar `ai-studio-generation`. Si algo de esto falla, se libera la
 *    reserva y se relanza.
 *
 * El worker de AI Studio hace el resto; al quedar `ready`, arma la pieza
 * (`apps/worker/src/formats/`).
 */
import type { GenCostEstimate, GenModelSpec, VideoGenRequest } from "@fastgram/ports";

import { checkGenerationInput, type AiStudioGenerationJob } from "../../genai/request.js";
import {
  budgetSummary,
  monthKey,
  parseSpendLedger,
  releaseSpend,
  reserveSpend,
  type BudgetSummary,
  type ReserveResult,
} from "../../genai/budget.js";
import { newGenerationRecord, type GenerationRecord } from "../../genai/record.js";
import type { SecretEnv } from "../../models/config.js";
import {
  planGenerativeFormat,
  pickDuration,
  type GenerativeBrandBrief,
  type GenerativeFormatPlan,
} from "./plan.js";
import { newFormatRunRecord, type FormatRunRecord, type FormatRunSource } from "./run.js";

/** La tarea `video` del registro, ya resuelta por quien llama. */
export interface FormatVideoTask {
  readonly provider: string;
  readonly defaultModel: string;
  /** El catálogo del adaptador (sólo los de video importan). */
  readonly models: readonly GenModelSpec[];
  /** ComfyUI: la imagen la baja el adaptador. Acá no hay imagen: no importa. */
}

interface UpdatableDoc {
  update<T>(fn: (current: unknown) => { next?: unknown; result: T }): Promise<T>;
}
interface Collection {
  create(scope: string, id: string, value: unknown): Promise<void>;
  update<T>(
    scope: string,
    id: string,
    fn: (current: unknown) => { next?: unknown; result: T },
  ): Promise<T>;
}

export interface FormatRunDeps {
  readonly now: () => Date;
  readonly newId: () => string;
  /** Para el tope del mes (`FASTGRAM_MONTHLY_BUDGET_USD`). */
  readonly env: SecretEnv;
  /** `null` = no hay modelo de video en Settings → Models. */
  readonly videoTask: () => Promise<FormatVideoTask | null>;
  /** El estimador del proveedor. Lanza `PortError` (quien llama traduce). */
  readonly estimate: (request: VideoGenRequest) => Promise<GenCostEstimate>;
  /** `~/.fastgram/spend.json`. */
  readonly ledger: UpdatableDoc;
  /** `~/.fastgram/ai-studio/`. */
  readonly generations: Collection;
  /** `~/.fastgram/format-runs/`. */
  readonly runs: Collection;
  /** `ai-studio-generation`, con la política de la cola. */
  readonly enqueue: (job: AiStudioGenerationJob) => Promise<void>;
}

export interface FormatRunInput {
  readonly companyId: string;
  readonly formatId: string;
  readonly topic?: string | undefined;
  readonly overlayText: string;
  readonly brand?: GenerativeBrandBrief | null | undefined;
  readonly includeBrand?: boolean | undefined;
  /** Default: el de Settings → Models, si es texto a video. */
  readonly model?: string | undefined;
  readonly durationSeconds?: number | undefined;
  readonly source: FormatRunSource;
}

export type FormatRunRejection =
  | {
      readonly ok: false;
      readonly reason: "invalid";
      readonly field: string;
      readonly message: string;
    }
  | { readonly ok: false; readonly reason: "not_configured"; readonly message: string }
  | { readonly ok: false; readonly reason: "ledger_unreadable"; readonly message: string }
  | {
      readonly ok: false;
      readonly reason: "budget_exceeded";
      readonly estimateUsd: number;
      readonly summary: BudgetSummary;
    };

export interface PreparedFormatRun {
  readonly plan: GenerativeFormatPlan;
  readonly provider: string;
  readonly spec: GenModelSpec;
  readonly durationSeconds: number;
  readonly request: VideoGenRequest;
}

/** Los modelos que sirven para un formato: video y sin imagen obligatoria. */
export function formatVideoModels(models: readonly GenModelSpec[]): GenModelSpec[] {
  return models.filter(
    (m) => m.kind === "video" && m.imageInput !== "required" && m.promptRequired,
  );
}

async function prepare(
  deps: FormatRunDeps,
  input: FormatRunInput,
): Promise<PreparedFormatRun | FormatRunRejection> {
  const planned = planGenerativeFormat(input);
  if (!planned.ok) {
    return {
      ok: false,
      reason: "invalid",
      field: planned.field,
      message: planned.message,
    };
  }
  const task = await deps.videoTask();
  if (task === null) {
    return {
      ok: false,
      reason: "not_configured",
      message: "Set up a video model in Settings → Models first.",
    };
  }
  const usable = formatVideoModels(task.models);
  const modelId =
    input.model ??
    (usable.some((m) => m.id === task.defaultModel) ? task.defaultModel : usable[0]?.id);
  const spec = usable.find((m) => m.id === modelId);
  if (spec === undefined) {
    return input.model === undefined
      ? {
          ok: false,
          reason: "not_configured",
          message: "Formats need a text-to-video model. Pick one in Settings → Models.",
        }
      : {
          ok: false,
          reason: "invalid",
          field: "model",
          message: "That model can't make a video from text.",
        };
  }
  const plan = planned.plan;
  const durationSeconds = pickDuration(
    plan.format,
    spec.durationsSeconds,
    input.durationSeconds,
  );
  if (
    durationSeconds === null ||
    (input.durationSeconds !== undefined && durationSeconds !== input.durationSeconds)
  ) {
    return {
      ok: false,
      reason: "invalid",
      field: "durationSeconds",
      message: `Pick a duration: ${spec.durationsSeconds.join(", ")} seconds.`,
    };
  }
  const aspectRatio = plan.format.aspectRatio;
  const check = checkGenerationInput(spec, {
    kind: "video",
    model: spec.id,
    prompt: plan.videoPrompt,
    aspectRatio,
    count: spec.counts[0] ?? 1,
    durationSeconds,
  });
  if (!check.ok) {
    return { ok: false, reason: "invalid", field: check.field, message: check.message };
  }
  return {
    plan,
    provider: task.provider,
    spec,
    durationSeconds,
    request: {
      model: spec.id,
      prompt: plan.videoPrompt,
      aspectRatio,
      durationSeconds,
    },
  };
}

export interface FormatRunEstimate {
  readonly ok: true;
  readonly provider: string;
  readonly model: string;
  readonly durationSeconds: number;
  readonly videoPrompt: string;
  readonly estimate: GenCostEstimate;
}

/** El costo antes de generar. Lanza lo que lance el estimador. */
export async function estimateGenerativeFormatRun(
  deps: FormatRunDeps,
  input: FormatRunInput,
): Promise<FormatRunEstimate | FormatRunRejection> {
  const prepared = await prepare(deps, input);
  if (!("plan" in prepared)) return prepared;
  const estimate = await deps.estimate(prepared.request);
  return {
    ok: true,
    provider: prepared.provider,
    model: prepared.spec.id,
    durationSeconds: prepared.durationSeconds,
    videoPrompt: prepared.plan.videoPrompt,
    estimate,
  };
}

export interface StartedFormatRun {
  readonly ok: true;
  readonly run: FormatRunRecord;
  readonly generation: GenerationRecord;
  readonly estimate: GenCostEstimate;
}

/** Estimar → reservar → escribir → encolar. Ver la cabecera. */
export async function startGenerativeFormatRun(
  deps: FormatRunDeps,
  input: FormatRunInput,
): Promise<StartedFormatRun | FormatRunRejection> {
  const prepared = await prepare(deps, input);
  if (!("plan" in prepared)) return prepared;
  const cost = await deps.estimate(prepared.request);

  const at = deps.now();
  const month = monthKey(at);
  const id = deps.newId();
  const reserved = await deps.ledger.update<ReserveResult | null>((raw) => {
    const ledger = parseSpendLedger(raw);
    if (ledger === null) return { result: null };
    const r = reserveSpend(
      ledger,
      {
        month,
        generationId: id,
        usd: cost.usd,
        provider: prepared.provider,
        model: prepared.spec.id,
        kind: "video",
        companyId: input.companyId,
        at: at.toISOString(),
      },
      deps.env,
    );
    return r.ok ? { next: r.next, result: r } : { result: r };
  });
  if (reserved === null) {
    return {
      ok: false,
      reason: "ledger_unreadable",
      message: "The local spend file (~/.fastgram/spend.json) cannot be read.",
    };
  }
  if (!reserved.ok) {
    return {
      ok: false,
      reason: "budget_exceeded",
      estimateUsd: cost.usd,
      summary: reserved.summary,
    };
  }

  const now = at.toISOString();
  const generation = newGenerationRecord({
    id,
    companyId: input.companyId,
    kind: "video",
    provider: prepared.provider,
    model: prepared.spec.id,
    prompt: prepared.plan.videoPrompt,
    aspectRatio: prepared.request.aspectRatio,
    count: prepared.spec.counts[0] ?? 1,
    durationSeconds: prepared.durationSeconds,
    imageUrl: null,
    estimate: {
      usd: cost.usd,
      source: cost.source,
      basis: cost.basis,
      sourceUrl: cost.sourceUrl ?? null,
    },
    spendMonth: month,
    now,
  });
  const run = newFormatRunRecord({
    id,
    companyId: input.companyId,
    formatId: prepared.plan.format.id,
    topic: prepared.plan.topic,
    overlayText: prepared.plan.overlayText,
    videoPrompt: prepared.plan.videoPrompt,
    source: input.source,
    now,
  });

  try {
    // La corrida primero: si el worker toma la generación antes de que exista
    // la corrida, al terminar no sabría que tiene que armar una pieza.
    await deps.runs.create(input.companyId, id, run);
    await deps.generations.create(input.companyId, id, generation);
    await deps.enqueue({ companyId: input.companyId, generationId: id });
  } catch (error) {
    await deps.ledger
      .update((raw) => {
        const ledger = parseSpendLedger(raw);
        const next = ledger === null ? null : releaseSpend(ledger, month, id);
        return next === null ? { result: null } : { next, result: null };
      })
      .catch(() => undefined);
    // Una generación escrita y sin job no la procesa nadie: se cierra.
    await deps.generations
      .update(input.companyId, id, (raw) =>
        raw === null
          ? { result: null }
          : {
              next: {
                ...(raw as GenerationRecord),
                status: "failed",
                error: {
                  code: "provider_unavailable",
                  message: "The job could not be queued.",
                },
                updatedAt: deps.now().toISOString(),
              },
              result: null,
            },
      )
      .catch(() => undefined);
    throw error;
  }
  return { ok: true, run, generation, estimate: cost };
}

/** El resumen del mes para mostrar junto al estimado. */
export function formatBudgetSummary(
  raw: unknown,
  at: Date,
  env: SecretEnv,
): BudgetSummary | null {
  const ledger = parseSpendLedger(raw);
  return ledger === null ? null : budgetSummary(ledger, monthKey(at), env);
}
