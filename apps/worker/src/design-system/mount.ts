/**
 * Cómo se monta la cola `design-system` — sprint 9 (M).
 *
 * Siempre se monta: el import funciona sin nada más que la base y el
 * storage. Lo opcional degrada con aviso, nunca en silencio:
 *
 *  - sin `services/render` (`RENDER_SERVICE_URL`): los SVG se saltean y no
 *    hay generación local;
 *  - sin modelo `text`: el resumen de estilo es el heurístico;
 *  - sin modelo `image` (`resolveGenAiConfig`): la generación con modelo se
 *    saltea.
 *
 * ## La imagen con modelo respeta el tope mensual
 *
 * Mismo circuito que AI Studio (`genai/handler.ts`), en chico: estimar →
 * **reservar** en el libro de gasto (`reserveSpend`, falla si no entra en el
 * tope) → enviar → sondear hasta terminar → bajar (`httpDownloader`, https y
 * con tope) → **cobrar** o **liberar** la reserva. Un `nsfw` o `failed` no se
 * cobra (Higgsfield no cobra esos).
 */
import { createGenClient, isGenProvider, type GenClient } from "@fastgram/adapters";
import {
  JOB_QUEUES,
  monthKey,
  parseSpendLedger,
  releaseSpend,
  reserveSpend,
  resolveGenAiConfig,
  settleSpend,
  EMPTY_SPEND_LEDGER,
  type SecretEnv,
} from "@fastgram/core";
import type { Database } from "@fastgram/db";
import {
  PortError,
  TERMINAL_GEN_STATUSES,
  type BrandBackgroundGenerator,
  type JobHandler,
  type Llm,
  type ModelRegistry,
  type Storage,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { httpDownloader, type SpendLedgerStore } from "../genai/handler.js";
import { createDesignSystemHandler, type DesignSystemImageModel } from "./handler.js";
import { createRenderRasterizer } from "./render-client.js";

export const DESIGN_SYSTEM_QUEUE = JOB_QUEUES.designSystem;

const PROVIDER_TIMEOUT_MS = 30_000;
const POLL_BUDGET_MS = 180_000;
const POLL_EVERY_MS = 3_000;
const DOWNLOAD_MAX_BYTES = 30 * 1024 * 1024;

export interface DesignSystemMountDeps {
  readonly db: Database;
  readonly storage: Storage;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly textLlm: () => Promise<Llm | null>;
  /** `RENDER_SERVICE_URL`, o `null`. */
  readonly renderBaseUrl: string | null;
  readonly generator: BrandBackgroundGenerator | null;
  readonly registry: ModelRegistry;
  readonly ledger: SpendLedgerStore;
  readonly env: SecretEnv;
  /** Inyectables para test. */
  readonly clientFor?: (config: Parameters<typeof createGenClient>[0]) => GenClient;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly download?: (url: string) => Promise<{ body: Uint8Array; contentType: string }>;
}

export function createImageModelSource(
  deps: Pick<
    DesignSystemMountDeps,
    "registry" | "ledger" | "env" | "clientFor" | "sleep" | "download" | "logger"
  >,
): () => Promise<DesignSystemImageModel | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const download =
    deps.download ?? httpDownloader({ timeoutMs: 120_000, maxBytes: DOWNLOAD_MAX_BYTES });
  return async () => {
    let config;
    try {
      config = resolveGenAiConfig("image", await deps.registry.read(), deps.env);
    } catch (error: unknown) {
      deps.logger.warn({ error }, "no se pudo leer el registro de modelos para image");
      return null;
    }
    if (config === null || !isGenProvider(config.provider)) return null;
    const resolved = config;
    const provider = resolved.provider as Parameters<
      typeof createGenClient
    >[0]["provider"];
    const client = (deps.clientFor ?? createGenClient)({
      provider,
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      timeoutMs: PROVIDER_TIMEOUT_MS,
      task: "image",
      model: resolved.model,
      ...(resolved.comfyWorkflow === undefined
        ? {}
        : { comfyWorkflow: resolved.comfyWorkflow }),
    });
    return {
      async generate({ prompt, aspectRatio, generationId, companyId }) {
        const request = { prompt, aspectRatio, model: resolved.model, n: 1 };
        const estimate = await client.estimateImage(request);
        const month = monthKey(new Date());
        const reserved = await deps.ledger.update((raw) => {
          const ledger = parseSpendLedger(raw) ?? EMPTY_SPEND_LEDGER;
          const r = reserveSpend(
            ledger,
            {
              month,
              generationId,
              usd: estimate.usd,
              provider: resolved.provider,
              model: resolved.model,
              kind: "image",
              companyId,
              at: new Date().toISOString(),
            },
            deps.env,
          );
          return r.ok ? { next: r.next, result: true } : { result: false };
        });
        if (!reserved) {
          throw new PortError(
            "quota_exceeded",
            "the monthly generation budget is spent",
            {
              source: "worker/design-system",
            },
          );
        }
        const settle = async (charge: boolean): Promise<void> => {
          await deps.ledger.update((raw) => {
            const ledger = parseSpendLedger(raw) ?? EMPTY_SPEND_LEDGER;
            const next = charge
              ? settleSpend(ledger, month, generationId)
              : releaseSpend(ledger, month, generationId);
            return next === null ? { result: undefined } : { next, result: undefined };
          });
        };
        try {
          const submission = await client.generateImage(request);
          if (submission.kind === "rejected") {
            await settle(false);
            throw new PortError("bad_request", "the image model rejected the prompt", {
              source: "worker/design-system",
            });
          }
          const deadline = Date.now() + POLL_BUDGET_MS;
          let state = await client.poll(submission.handle);
          while (!TERMINAL_GEN_STATUSES.includes(state.status)) {
            if (Date.now() > deadline) {
              // Queda reservado: el proveedor puede terminar y cobrar igual.
              throw new PortError("timeout", "the image model did not finish in time", {
                source: "worker/design-system",
              });
            }
            await sleep(POLL_EVERY_MS);
            state = await client.poll(submission.handle);
          }
          const output = state.outputs[0];
          if (state.status !== "completed" || output === undefined) {
            await settle(false);
            throw new PortError(
              "provider_unavailable",
              `image generation ${state.status}`,
              {
                source: "worker/design-system",
              },
            );
          }
          await settle(true);
          const file = await download(output.url);
          return { bytes: file.body, contentType: file.contentType };
        } catch (error: unknown) {
          if (!(error instanceof PortError)) await settle(false);
          throw error;
        }
      },
    };
  };
}

export function createDesignSystemMount(
  deps: DesignSystemMountDeps,
): JobHandler<unknown> {
  return createDesignSystemHandler({
    db: deps.db,
    storage: deps.storage,
    appRole: deps.appRole,
    logger: deps.logger,
    textLlm: deps.textLlm,
    rasterizer:
      deps.renderBaseUrl === null
        ? null
        : createRenderRasterizer({ baseUrl: deps.renderBaseUrl }),
    generator: deps.generator,
    imageModel: createImageModelSource(deps),
  });
}
