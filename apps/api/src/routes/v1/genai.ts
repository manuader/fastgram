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
  FORMAT_RUNS_DIR_NAME,
  INFLUENCER_TEMPLATES_DIR_NAME,
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
import { join } from "node:path";

import {
  FileModelRegistry,
  HiggsfieldClient,
  JsonFileCollection,
  JsonFileDocument,
  aiStudioDir,
  resolveFastgramHome,
  createGenClient,
  isGenProvider,
  modelRegistryPath,
  spendLedgerPath,
  type DocumentUpdate,
  type GenClient,
} from "@fastgram/adapters";
import { updateBudgetRequestSchema, type BudgetSummary } from "@fastgram/contracts";
import {
  PortError,
  isPortError,
  type ModelRegistry,
  type Storage,
} from "@fastgram/ports";

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
  /**
   * Sprint 7 (agente G). Opcionales para que los montajes de test que ya
   * existían no cambien; `defaultGenAiRouteDeps` los pone siempre.
   *
   * - `formatRuns`: las corridas de formatos (`~/.fastgram/format-runs/`).
   * - `templates`: los templates de prompt de influencers por marca
   *   (`~/.fastgram/influencer-templates/`).
   * - `uploadImage`: sube una imagen de nuestro storage al proveedor y
   *   devuelve su URL pública (Higgsfield `files/generate-upload-url`).
   */
  readonly formatRuns?: GenerationFiles;
  readonly templates?: GenerationFiles;
  readonly uploadImage?: (
    config: ResolvedGenAiConfig,
    image: { readonly body: Uint8Array; readonly contentType: string },
  ) => Promise<string>;
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
    formatRuns: new JsonFileCollection(
      join(resolveFastgramHome(env), FORMAT_RUNS_DIR_NAME),
    ),
    templates: new JsonFileCollection(
      join(resolveFastgramHome(env), INFLUENCER_TEMPLATES_DIR_NAME),
    ),
    uploadImage: (config, image) => {
      if (config.provider !== "higgsfield") {
        return Promise.reject(
          new PortError("bad_request", "This provider can't take a Media Bank image", {
            source: "api/genai",
          }),
        );
      }
      return new HiggsfieldClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: GENAI_API_TIMEOUT_MS,
      }).uploadImage(image);
    },
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
        // ComfyUI (`PU-LATER-003`): el workflow es el modelo.
        task: config.task,
        model: config.model,
        ...(config.comfyWorkflow === undefined
          ? {}
          : { comfyWorkflow: config.comfyWorkflow }),
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

/* ------------------------------------------------------------------------ *
 * Una imagen del Media Bank como entrada del proveedor — sprint 7
 * ------------------------------------------------------------------------ */

/** Lo que hace falta de una fila de `media`. */
export interface MediaImageRef {
  readonly mediaId: string;
  readonly storageKey: string;
  readonly r2Url: string;
}

/** Una foto del Media Bank es ≤ 10 MB (FR-100); esto es para no llenar la memoria. */
const MEDIA_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
/**
 * Cuánto se reusa una subida a Higgsfield para la misma imagen (estimar y
 * después generar suben una sola vez). Su doc no dice cuánto viven las
 * subidas; media hora es la ventana de «estimar → generar» y nada más.
 */
const UPLOAD_CACHE_MS = 30 * 60_000;

async function readObject(
  storage: Storage,
  key: string,
): Promise<{ body: Uint8Array; contentType: string }> {
  const head = await storage.head(key);
  if (head === null) {
    throw new ApiRejection(400, "bad_request", "That image is missing from storage.", {
      field: "imageMediaId",
    });
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of await storage.get(key)) {
    size += chunk.byteLength;
    if (size > MEDIA_IMAGE_MAX_BYTES) {
      throw new ApiRejection(400, "bad_request", "That image is too large.", {
        field: "imageMediaId",
      });
    }
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.byteLength;
  }
  return { body, contentType: head.contentType };
}

/**
 * La URL que el proveedor configurado puede leer para una imagen **nuestra**.
 *
 * - `comfyui`: corre en esta máquina y baja `http://` del MinIO local.
 * - `higgsfield`: se sube a su storage (`files/generate-upload-url`) y se usa
 *   la `public_url` que devuelve — el mismo camino que las fotos del personaje.
 * - `fal` (o cualquier otro): sólo si la URL de nuestro storage ya es `https`
 *   pública. Si no, 400: fal no tiene subida en el adaptador verificado.
 */
export function createProviderImageResolver(
  deps: GenAiRouteDeps,
  now: () => number = Date.now,
): (
  config: ResolvedGenAiConfig,
  storage: Storage,
  scope: string,
  media: MediaImageRef,
) => Promise<string> {
  const cache = new Map<string, { at: number; url: string }>();
  return async (config, storage, scope, media) => {
    if (config.provider === "comfyui") return media.r2Url;
    if (config.provider !== "higgsfield") {
      if (media.r2Url.startsWith("https://")) return media.r2Url;
      throw new ApiRejection(
        400,
        "bad_request",
        "This provider downloads the image from the internet, and the Media Bank isn't public. Paste a public https:// URL instead.",
        { field: "imageMediaId" },
      );
    }
    const key = `${config.provider}:${scope}:${media.mediaId}`;
    const hit = cache.get(key);
    if (hit !== undefined && now() - hit.at < UPLOAD_CACHE_MS) return hit.url;
    if (deps.uploadImage === undefined) {
      throw new ApiRejection(
        503,
        "service_unavailable",
        "Image upload is not available.",
      );
    }
    const image = await readObject(storage, media.storageKey);
    let url: string;
    try {
      url = await deps.uploadImage(config, image);
    } catch (error) {
      if (error instanceof ApiRejection) throw error;
      throw new ApiRejection(
        503,
        "service_unavailable",
        isPortError(error)
          ? error.message
          : "The image could not be sent to the provider.",
        { reason: "provider_unavailable", field: "imageMediaId" },
      );
    }
    cache.set(key, { at: now(), url });
    return url;
  };
}
