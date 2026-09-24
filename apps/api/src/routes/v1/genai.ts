/**
 * Dependencias compartidas de generación (AI Studio y el tope mensual) y las
 * rutas del presupuesto: `GET /models/budget`, `PUT /models/budget` —
 * `PU-MODEL-005`, `docs/PLAN-USO-PERSONAL.md` §4 y D-14.
 *
 * Como `models.ts`, esto lee el entorno por su cuenta (`FASTGRAM_HOME`,
 * `FASTGRAM_MONTHLY_BUDGET_USD`) y no pasa por `ApiDeps`: `server/types.ts` y
 * `main.ts` no son de esta tarea. Moverlo es mecánico.
 *
 * ## Decisiones que el PRD no cubre
 *
 * - **El presupuesto es de la instalación**, no de una marca: el dueño paga
 *   una sola cuenta de Higgsfield/fal para todas (D-06, D-14). El gasto guarda
 *   de qué marca vino cada generación, por si mañana se quiere desglosar.
 * - **El mes es UTC**, igual que el resto de los cortes diarios del producto.
 */
import {
  budgetSummary,
  monthKey,
  parseSpendLedger,
  resolveGenAiConfig,
  setBudget,
  type BudgetSummary as CoreBudgetSummary,
  type ResolvedGenAiConfig,
  type SecretEnv,
  type SpendLedger,
} from "@fastgram/core";
import {
  FileModelRegistry,
  JsonFileCollection,
  JsonFileDocument,
  aiStudioDir,
  createGenClient,
  isGenProvider,
  modelRegistryPath,
  spendLedgerPath,
  type DocumentUpdate,
  type GenClient,
} from "@fastgram/adapters";
import { updateBudgetRequestSchema, type BudgetSummary } from "@fastgram/contracts";
import { PortError, type ModelRegistry } from "@fastgram/ports";

import { ApiRejection } from "../../http/errors.js";
import { data } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

/** El libro de gasto: un documento JSON bajo lock (`JsonFileDocument`). */
export interface SpendLedgerFile {
  read(): Promise<unknown>;
  update<T>(fn: (current: unknown) => DocumentUpdate<T>): Promise<T>;
}

/** Las generaciones, por marca (`JsonFileCollection`). */
export interface GenerationFiles {
  get(scope: string, id: string): Promise<unknown>;
  list(scope: string): Promise<unknown[]>;
  create(scope: string, id: string, value: unknown): Promise<void>;
  update<T>(
    scope: string,
    id: string,
    fn: (current: unknown) => DocumentUpdate<T>,
  ): Promise<T>;
}

export interface GenAiRouteDeps {
  readonly registry: ModelRegistry;
  readonly ledger: SpendLedgerFile;
  readonly generations: GenerationFiles;
  /** Las variables que nombre un `apiKeyEnv` y el tope del entorno. */
  readonly env: SecretEnv;
  /** Un cliente de Higgsfield o fal. Inyectable para los tests. */
  readonly clientFor: (config: ResolvedGenAiConfig) => GenClient;
}

/**
 * Presupuesto por llamada al proveedor desde la API: por debajo de los 10 s
 * del proxy de `apps/web` (ver `MODEL_PROBE_TIMEOUT_MS` en `models.ts`).
 */
export const GENAI_API_TIMEOUT_MS = 9_000;

export function defaultGenAiRouteDeps(env: SecretEnv = process.env): GenAiRouteDeps {
  return {
    registry: new FileModelRegistry({ path: modelRegistryPath(env) }),
    ledger: new JsonFileDocument(spendLedgerPath(env)),
    generations: new JsonFileCollection(aiStudioDir(env)),
    env,
    clientFor: (config) => {
      if (!isGenProvider(config.provider)) {
        throw new PortError("bad_request", "That provider has no generation adapter", {
          source: "api/genai",
        });
      }
      return createGenClient({
        provider: config.provider,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: GENAI_API_TIMEOUT_MS,
      });
    },
  };
}

/** El libro, o un 503 si el archivo existe y no se entiende (no se pisa). */
export function ledgerOrFail(raw: unknown): SpendLedger {
  const ledger = parseSpendLedger(raw);
  if (ledger === null) {
    throw new ApiRejection(
      503,
      "service_unavailable",
      "The local spend file (~/.fastgram/spend.json) cannot be read.",
    );
  }
  return ledger;
}

export function toBudgetView(summary: CoreBudgetSummary): BudgetSummary {
  return {
    month: summary.month,
    budgetUsd: summary.budgetUsd,
    budgetSource: summary.budgetSource,
    chargedUsd: summary.chargedUsd,
    reservedUsd: summary.reservedUsd,
    remainingUsd: summary.remainingUsd,
    generations: summary.generations,
  };
}

/** La configuración de imagen o video, si está completa. */
export async function genAiConfigFor(
  deps: GenAiRouteDeps,
  kind: "image" | "video",
): Promise<ResolvedGenAiConfig | null> {
  const snapshot = await deps.registry.read();
  return resolveGenAiConfig(kind, snapshot, deps.env);
}

export function registerGenAiRoutes(
  app: ZodApp,
  deps: GenAiRouteDeps = defaultGenAiRouteDeps(),
): void {
  const now = (): Date => app.deps.clock.now();

  // ── GET /models/budget ──
  app.get("/models/budget", async () => {
    const ledger = ledgerOrFail(await deps.ledger.read());
    return data(toBudgetView(budgetSummary(ledger, monthKey(now()), deps.env)));
  });

  // ── PUT /models/budget ──
  app.put(
    "/models/budget",
    { schema: { body: updateBudgetRequestSchema } },
    async (request) => {
      const { budgetUsd } = request.body;
      const month = monthKey(now());
      const summary = await deps.ledger.update((raw) => {
        const updated = setBudget(ledgerOrFail(raw), budgetUsd);
        if (!updated.ok) {
          throw new ApiRejection(400, "bad_request", updated.message, {
            field: "budgetUsd",
          });
        }
        return {
          next: updated.next,
          result: budgetSummary(updated.next, month, deps.env),
        };
      });
      request.log.info(
        { budgetUsd, source: summary.budgetSource },
        "monthly budget updated",
      );
      return data(toBudgetView(summary));
    },
  );
}
