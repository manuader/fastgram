/**
 * El tope mensual de gasto en generación — `PU-MODEL-005`,
 * `docs/PLAN-USO-PERSONAL.md` §4 y D-14 (presupuesto de US$20–50 por mes).
 *
 * Lógica pura sobre el libro de gasto que vive en `~/.fastgram/spend.json`
 * (lo lee y escribe `JsonFileDocument`, bajo lock entre la API y el worker).
 *
 * ## Cómo se cuenta
 *
 * Cada generación **reserva** su costo estimado antes de encolarse. Al
 * terminar:
 *
 * - `ready` → la reserva pasa a **cobrada** (`charged`). El monto es el
 *   estimado: ni Higgsfield ni fal devuelven el costo real en el estado del
 *   pedido, así que no hay un número mejor.
 * - `failed`, `nsfw`, `canceled` → la reserva **se libera**: los dos
 *   proveedores documentan que eso no se cobra.
 * - Un envío con resultado ambiguo (timeout después de mandar el `POST`) se
 *   **deja cobrado**: pudo haberse aceptado, y para un tope es mejor contar de
 *   más que de menos.
 *
 * Una generación entra si `cobrado + reservado + estimado ≤ tope`. En el
 * borde exacto entra; un centavo de centavo más, no.
 *
 * ## El mes
 *
 * `YYYY-MM` en **UTC**, del momento de la reserva. Un mes nuevo arranca en
 * cero; lo de meses anteriores queda en el archivo como historial.
 *
 * ## El tope
 *
 * El de Settings → Models si el usuario lo guardó; si no,
 * `FASTGRAM_MONTHLY_BUDGET_USD`; si no, {@link DEFAULT_MONTHLY_BUDGET_USD}. El
 * default es una elección nuestra dentro del rango que dio el dueño (20–50).
 */
import type { GenMediaKind } from "@fastgram/ports";

export const DEFAULT_MONTHLY_BUDGET_USD = 30;
export const BUDGET_ENV_VAR = "FASTGRAM_MONTHLY_BUDGET_USD";
/** Tope de sanidad del input: nadie quiere un tope de un millón por mes. */
export const MAX_MONTHLY_BUDGET_USD = 100_000;

export interface SpendEntry {
  readonly usd: number;
  readonly state: "reserved" | "charged";
  readonly provider: string;
  readonly model: string;
  readonly kind: GenMediaKind;
  readonly companyId: string;
  readonly at: string;
}

export interface SpendLedger {
  readonly version: 1;
  /** El de Settings. `null` = no se guardó (entorno o default). */
  readonly budgetUsd: number | null;
  /** Mes → id de generación → entrada. */
  readonly months: Readonly<Record<string, Readonly<Record<string, SpendEntry>>>>;
}

export const EMPTY_SPEND_LEDGER: SpendLedger = {
  version: 1,
  budgetUsd: null,
  months: {},
};

/** Diezmilésimos de dólar: las cuentas se hacen en enteros. */
const UNITS = 10_000;
const toUnits = (usd: number): number => Math.round(usd * UNITS);
const fromUnits = (units: number): number => units / UNITS;

export function monthKey(at: Date): string {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth() + 1;
  return `${String(y)}-${m < 10 ? "0" : ""}${String(m)}`;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseEntry(v: unknown): SpendEntry | null {
  if (!isObj(v)) return null;
  const { usd, state, provider, model, kind, companyId, at } = v;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return null;
  if (state !== "reserved" && state !== "charged") return null;
  if (kind !== "image" && kind !== "video") return null;
  if (
    typeof provider !== "string" ||
    typeof model !== "string" ||
    typeof companyId !== "string" ||
    typeof at !== "string"
  ) {
    return null;
  }
  return { usd, state, provider, model, kind, companyId, at };
}

/**
 * Lo que hay en disco → el libro. `null` (no existe) = vacío. Algo con otra
 * forma → `null`: quien llama no lo pisa (podría tener gasto que no se quiere
 * perder) y responde un error.
 */
export function parseSpendLedger(value: unknown): SpendLedger | null {
  if (value === null) return EMPTY_SPEND_LEDGER;
  if (!isObj(value) || value["version"] !== 1 || !isObj(value["months"])) return null;
  const budget = value["budgetUsd"];
  if (
    budget !== null &&
    (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0)
  ) {
    return null;
  }
  const months: Record<string, Record<string, SpendEntry>> = {};
  for (const [month, entries] of Object.entries(value["months"])) {
    if (!MONTH.test(month) || !isObj(entries)) return null;
    const parsed: Record<string, SpendEntry> = {};
    for (const [id, raw] of Object.entries(entries)) {
      const entry = parseEntry(raw);
      if (entry === null) return null;
      parsed[id] = entry;
    }
    months[month] = parsed;
  }
  return { version: 1, budgetUsd: budget, months };
}

export interface ResolvedBudget {
  readonly usd: number;
  readonly source: "settings" | "env" | "default";
}

/** Un monto de presupuesto válido de una variable de entorno, o `null`. */
export function budgetFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): number | null {
  const raw = env[BUDGET_ENV_VAR]?.trim() ?? "";
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= MAX_MONTHLY_BUDGET_USD ? n : null;
}

export function resolveBudget(
  ledger: SpendLedger,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedBudget {
  if (ledger.budgetUsd !== null) return { usd: ledger.budgetUsd, source: "settings" };
  const fromEnv = budgetFromEnv(env);
  if (fromEnv !== null) return { usd: fromEnv, source: "env" };
  return { usd: DEFAULT_MONTHLY_BUDGET_USD, source: "default" };
}

export interface MonthSpend {
  readonly month: string;
  readonly chargedUsd: number;
  readonly reservedUsd: number;
  readonly generations: number;
}

export function monthSpend(ledger: SpendLedger, month: string): MonthSpend {
  let charged = 0;
  let reserved = 0;
  let generations = 0;
  for (const entry of Object.values(ledger.months[month] ?? {})) {
    generations += 1;
    if (entry.state === "charged") charged += toUnits(entry.usd);
    else reserved += toUnits(entry.usd);
  }
  return {
    month,
    chargedUsd: fromUnits(charged),
    reservedUsd: fromUnits(reserved),
    generations,
  };
}

export interface BudgetSummary extends MonthSpend {
  readonly budgetUsd: number;
  readonly budgetSource: ResolvedBudget["source"];
  /** Lo que queda sin contar lo reservado en vuelo. Nunca negativo. */
  readonly remainingUsd: number;
}

export function budgetSummary(
  ledger: SpendLedger,
  month: string,
  env: Readonly<Record<string, string | undefined>>,
): BudgetSummary {
  const spend = monthSpend(ledger, month);
  const budget = resolveBudget(ledger, env);
  const remaining =
    toUnits(budget.usd) - toUnits(spend.chargedUsd) - toUnits(spend.reservedUsd);
  return {
    ...spend,
    budgetUsd: budget.usd,
    budgetSource: budget.source,
    remainingUsd: fromUnits(Math.max(0, remaining)),
  };
}

/** ¿Entra `estimateUsd` en lo que queda? En el borde exacto, sí. */
export function fitsBudget(summary: BudgetSummary, estimateUsd: number): boolean {
  return (
    toUnits(summary.chargedUsd) + toUnits(summary.reservedUsd) + toUnits(estimateUsd) <=
    toUnits(summary.budgetUsd)
  );
}

export interface ReserveInput {
  readonly month: string;
  readonly generationId: string;
  readonly usd: number;
  readonly provider: string;
  readonly model: string;
  readonly kind: GenMediaKind;
  readonly companyId: string;
  readonly at: string;
}

export type ReserveResult =
  | { readonly ok: true; readonly next: SpendLedger; readonly summary: BudgetSummary }
  | {
      readonly ok: false;
      readonly reason: "budget_exceeded";
      readonly summary: BudgetSummary;
    };

/**
 * Reserva el estimado si entra. Idempotente por `generationId`: reservar dos
 * veces la misma generación no cuenta doble.
 */
export function reserveSpend(
  ledger: SpendLedger,
  input: ReserveInput,
  env: Readonly<Record<string, string | undefined>>,
): ReserveResult {
  const existing = ledger.months[input.month]?.[input.generationId];
  const summary = budgetSummary(ledger, input.month, env);
  if (existing !== undefined) return { ok: true, next: ledger, summary };
  if (!fitsBudget(summary, input.usd))
    return { ok: false, reason: "budget_exceeded", summary };
  const entry: SpendEntry = {
    usd: fromUnits(toUnits(input.usd)),
    state: "reserved",
    provider: input.provider,
    model: input.model,
    kind: input.kind,
    companyId: input.companyId,
    at: input.at,
  };
  const next: SpendLedger = {
    ...ledger,
    months: {
      ...ledger.months,
      [input.month]: {
        ...(ledger.months[input.month] ?? {}),
        [input.generationId]: entry,
      },
    },
  };
  return { ok: true, next, summary: budgetSummary(next, input.month, env) };
}

/** Reserva → cobrada. `null` si no hay reserva (nada que escribir). */
export function settleSpend(
  ledger: SpendLedger,
  month: string,
  generationId: string,
): SpendLedger | null {
  const entry = ledger.months[month]?.[generationId];
  if (entry === undefined || entry.state === "charged") return null;
  return {
    ...ledger,
    months: {
      ...ledger.months,
      [month]: {
        ...ledger.months[month],
        [generationId]: { ...entry, state: "charged" },
      },
    },
  };
}

/**
 * Libera una reserva (no se cobra). `null` si no había o ya estaba cobrada:
 * lo cobrado no se devuelve desde acá.
 */
export function releaseSpend(
  ledger: SpendLedger,
  month: string,
  generationId: string,
): SpendLedger | null {
  const entries = ledger.months[month];
  const entry = entries?.[generationId];
  if (entries === undefined || entry === undefined || entry.state === "charged")
    return null;
  const rest: Record<string, SpendEntry> = { ...entries };
  delete rest[generationId];
  return { ...ledger, months: { ...ledger.months, [month]: rest } };
}

export type BudgetUpdate =
  | { readonly ok: true; readonly next: SpendLedger }
  | { readonly ok: false; readonly message: string };

/** El tope de Settings. `null` = volver al entorno o al default. */
export function setBudget(ledger: SpendLedger, usd: number | null): BudgetUpdate {
  if (usd !== null) {
    if (!Number.isFinite(usd) || usd < 0 || usd > MAX_MONTHLY_BUDGET_USD) {
      return { ok: false, message: "Monthly budget must be between $0 and $100,000." };
    }
    if (toUnits(usd) % 100 !== 0) {
      return { ok: false, message: "Use whole cents for the monthly budget." };
    }
  }
  return { ok: true, next: { ...ledger, budgetUsd: usd } };
}
