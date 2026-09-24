/**
 * Registro de modelos — `GET /models`, `PUT /models/:task`, `DELETE /models/:task`
 * (sólo overrides de juicio, `P1-JUDGE-004`), `POST /models/test`,
 * `GET /models/providers/:provider/models`. `PU-MODEL-001`, `PU-MODEL-002`,
 * `docs/PLAN-USO-PERSONAL.md` §4, D-14, ADR-009.
 *
 * Toda la lógica está en `packages/core/src/models` (validar, fusionar,
 * enmascarar, resolver) y el I/O en `packages/adapters/src/model-registry`
 * (archivo y catálogo). Acá sólo se cablea.
 *
 * ## Lo que esta ruta no hace, a propósito
 *
 * - **No devuelve ninguna key.** Todo lo que sale pasa por `toPublicTaskConfig`.
 *   Ni siquiera la key que vino en el cuerpo de `POST /models/test` vuelve.
 * - **No presta una key guardada a otro host.** Probar o listar con la key
 *   guardada de una tarea sólo vale contra el mismo origen (`storedKeyFor`).
 *
 * ## Decisiones que el PRD no cubre
 *
 * - **El registro es de la instalación, no de un workspace.** No hay
 *   `companyId`: cualquier credencial válida lo lee y lo cambia. Es correcto
 *   para uso personal (D-06, un usuario) y **no lo es** si la app se abre a
 *   terceros: ahí esto pasa a ser de un rol de administrador. Sin datos de
 *   cliente adentro, no hay acceso cruzado que convertir en 404.
 * - **Probar y listar responden 200 con `ok: false`** cuando falla el
 *   proveedor (ver la cabecera del contrato). Un `401` del proveedor
 *   traducido a `401` le diría al cliente web que su sesión venció.
 * - **El destino de `POST /models/test` lo elige quien llama.** Es un fetch
 *   saliente hacia una URL arbitraria, con la credencial de la instalación
 *   detrás. Para uso personal es la función («probá mi Ollama»); abierta a
 *   terceros sería un SSRF y necesitaría la guarda de `website-ssrf.ts`, que
 *   acá no se aplica porque bloquearía justamente `localhost`.
 *
 * ## Las dependencias
 *
 * Entran por {@link registerModelRoutes} para los tests; sin ellas se arman de
 * `process.env` (`FASTGRAM_HOME`, las `LLM_*` y las variables que nombre un
 * `apiKeyEnv`). Es la única ruta que lee el entorno por su cuenta: el
 * registro no está en `ApiDeps` porque `server/types.ts` y `main.ts` no son de
 * esta tarea. Moverlo ahí es mecánico.
 */
import { z } from "zod";
import {
  providerModelsQuerySchema,
  testModelConnectionRequestSchema,
  updateModelTaskRequestSchema,
  type ModelConnectionTest,
  type ModelCompletionOutcome,
  type ModelKeySource,
  type ModelListOutcome,
  type ModelProbeError,
  type ModelProviderPreset,
  type ModelTaskConfig as ModelTaskConfigView,
  type ModelsOverview,
  type ProviderModels,
} from "@fastgram/contracts";
import {
  MODEL_PROVIDER_PRESETS,
  applyTaskUpdate,
  checkBaseUrl,
  isModelProvider,
  isModelTask,
  legacyLlmFromEnv,
  providerPreset,
  storedKeyFor,
  taskSpec,
  toPublicTaskConfig,
  type SecretEnv,
} from "@fastgram/core";
import {
  FileModelRegistry,
  OpenAiModelCatalog,
  createGenClient,
  genCatalog,
  isGenProvider,
  modelRegistryPath,
  type GenClient,
  type GenProviderId,
} from "@fastgram/adapters";
import {
  MODEL_TASKS,
  isJudgmentOverrideTask,
  isPortError,
  type ModelCatalog,
  type ModelProvider,
  type ModelRegistry,
  type ModelRegistrySnapshot,
  type ModelTask,
} from "@fastgram/ports";

import { ApiRejection } from "../../http/errors.js";
import { data } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

/**
 * Presupuesto de cada llamada al proveedor. **Por debajo** de los 10 s con los
 * que el proxy de `apps/web` corta (`UPSTREAM_TIMEOUT_MS`): si fuera mayor, un
 * modelo local que tarda en cargar llegaría a la pantalla como «la API no
 * respondió» en vez de como `timeout` del proveedor, que es la verdad.
 */
export const MODEL_PROBE_TIMEOUT_MS = 9_000;

export interface ModelRoutesDeps {
  readonly registry: ModelRegistry;
  readonly catalog: ModelCatalog;
  /**
   * El entorno del proceso: las `LLM_*` (para mostrar si el worker corre con
   * ellas) y las variables que nombre un `apiKeyEnv`. Se lee en cada pedido,
   * no se copia, así que es un objeto vivo como `process.env`.
   */
  readonly env: SecretEnv;
  /**
   * `PU-MODEL-003`/`004`: el cliente de Higgsfield o fal para «Test
   * connection». Opcional para no romper a quien arma estas deps a mano.
   */
  readonly genClientFor?: (config: {
    readonly provider: GenProviderId;
    readonly baseUrl: string;
    readonly apiKey: string;
  }) => GenClient;
}

export function defaultModelRoutesDeps(env: SecretEnv = process.env): ModelRoutesDeps {
  return {
    registry: new FileModelRegistry({ path: modelRegistryPath(env) }),
    catalog: new OpenAiModelCatalog({ timeoutMs: MODEL_PROBE_TIMEOUT_MS }),
    env,
    genClientFor: (config) =>
      createGenClient({ ...config, timeoutMs: MODEL_PROBE_TIMEOUT_MS }),
  };
}

/**
 * El catálogo verificado de un proveedor de imagen/video, de la clase de la
 * tarea (`image` → imágenes). Sin tarea, todos. No toca la red: Higgsfield no
 * tiene endpoint de listado y el de fal no dice qué campos acepta cada modelo.
 */
function genModelsFor(provider: GenProviderId, task: ModelTask | undefined) {
  return genCatalog(provider)
    .filter((m) => task === undefined || task === m.kind)
    .map((m) => ({ id: m.id, ownedBy: m.label }));
}

const taskParams = z.object({ task: z.string().min(1) });
const providerParams = z.object({ provider: z.string().min(1) });

function presetView(id: ModelProvider): ModelProviderPreset {
  const p = providerPreset(id);
  return {
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
    requiresKey: p.requiresKey,
    local: p.local,
    note: p.note ?? null,
  };
}

function taskView(
  task: ModelTask,
  snapshot: ModelRegistrySnapshot,
  env: SecretEnv,
): ModelTaskConfigView {
  const view = toPublicTaskConfig(task, snapshot, legacyLlmFromEnv(env), env);
  return {
    ...view,
    missing: [...view.missing],
    providers: [...taskSpec(task).providers],
  };
}

/** `PortError` → el error estable que viaja en `ok: false`. Nunca el `cause`. */
function probeError(error: unknown): ModelProbeError {
  if (isPortError(error)) return error.toPublic();
  return { code: "provider_unavailable", message: "The model provider check failed" };
}

function badBaseUrl(message: string): ApiRejection {
  return new ApiRejection(400, "bad_request", message, { field: "baseUrl" });
}

export function registerModelRoutes(
  app: ZodApp,
  deps: ModelRoutesDeps = defaultModelRoutesDeps(),
): void {
  const { registry, catalog, env } = deps;

  /** La key a usar: la que vino, o la guardada de `task` si el origen coincide. */
  async function keyFor(
    provided: string | undefined,
    task: ModelTask | undefined,
    baseUrl: string,
  ): Promise<{ key: string | undefined; source: ModelKeySource }> {
    const trimmed = provided?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      return { key: trimmed, source: "provided" };
    }
    if (task !== undefined) {
      const snapshot = await registry.read();
      const stored = storedKeyFor(snapshot.tasks[task], baseUrl, env);
      if (stored !== null) return { key: stored, source: "stored" };
    }
    return { key: undefined, source: "none" };
  }

  async function list(
    baseUrl: string,
    apiKey: string | undefined,
  ): Promise<ModelListOutcome> {
    try {
      const models = await catalog.listModels({
        baseUrl,
        ...(apiKey === undefined ? {} : { apiKey }),
      });
      return { ok: true, models: [...models] };
    } catch (error) {
      // Sólo el código: el `cause` trae el cuerpo del proveedor, y hay
      // proveedores que repiten ahí parte de la key.
      app.log.info(
        { probe: "list", code: probeError(error).code },
        "model provider list failed",
      );
      return { ok: false, error: probeError(error) };
    }
  }

  // ── GET /models ──
  app.get("/models", async () => {
    const snapshot = await registry.read();
    const overview: ModelsOverview = {
      tasks: MODEL_TASKS.map((task) => taskView(task, snapshot, env)),
      providers: MODEL_PROVIDER_PRESETS.map((p) => presetView(p.id)),
    };
    return data(overview);
  });

  // ── PUT /models/:task ──
  app.put(
    "/models/:task",
    { schema: { params: taskParams, body: updateModelTaskRequestSchema } },
    async (request) => {
      const { task } = request.params;
      if (!isModelTask(task)) {
        throw new ApiRejection(404, "not_found", "model task not found");
      }
      const body = request.body;
      // Imagen/video: el id tiene que estar en el catálogo verificado del
      // adaptador; si no, no hay cuerpo documentado que mandarle. ComfyUI no
      // tiene catálogo: el «modelo» es el nombre de su workflow (`PU-LATER-003`).
      if (
        isGenProvider(body.provider) &&
        body.provider !== "comfyui" &&
        taskSpec(task).kind === "genai" &&
        !genModelsFor(body.provider, task).some((m) => m.id === body.model.trim())
      ) {
        throw new ApiRejection(
          400,
          "bad_request",
          "Pick a model from the provider's list.",
          { field: "model" },
        );
      }
      const snapshot = await registry.read();
      const result = applyTaskUpdate(
        task,
        snapshot.tasks[task],
        {
          provider: body.provider,
          baseUrl: body.baseUrl,
          model: body.model,
          apiKey: body.apiKey,
          apiKeyEnv: body.apiKeyEnv,
          contextWindowTokens: body.contextWindowTokens,
          comfyWorkflow: body.comfyWorkflow,
        },
        app.deps.clock.now().toISOString(),
      );
      if (!result.ok) {
        throw new ApiRejection(400, "bad_request", result.message, {
          field: result.field,
        });
      }
      await registry.write(task, result.config);
      const saved: ModelRegistrySnapshot = {
        tasks: { ...snapshot.tasks, [task]: result.config },
      };
      // Qué se guardó, nunca la key: al log van sólo tarea, proveedor y modelo.
      request.log.info(
        { task, provider: result.config.provider, model: result.config.model },
        "model task updated",
      );
      return data(taskView(task, saved, env));
    },
  );

  // ── DELETE /models/:task ──
  //
  // `P1-JUDGE-004`: sólo los overrides de juicio por punto de decisión
  // (`judgment.autopilot`, `.brand`, `.engagement`). Borrarlo es «volver a usar
  // el modelo de juicio general», que es lo que la pantalla ofrece al destildar
  // «Use a different model for…». Las tareas base no se borran por acá: dejar
  // `text` sin entrada apagaría la cola de Blitz con un click.
  app.delete("/models/:task", { schema: { params: taskParams } }, async (request) => {
    const { task } = request.params;
    if (!isModelTask(task) || !isJudgmentOverrideTask(task)) {
      throw new ApiRejection(404, "not_found", "model task not found");
    }
    await registry.write(task, null);
    const snapshot = await registry.read();
    request.log.info({ task }, "model task override cleared");
    return data(taskView(task, snapshot, env));
  });

  // ── POST /models/test ──
  app.post(
    "/models/test",
    { schema: { body: testModelConnectionRequestSchema } },
    async (request) => {
      const body = request.body;
      const base = checkBaseUrl(
        body.baseUrl.trim() === ""
          ? (providerPreset(body.provider).baseUrl ?? "")
          : body.baseUrl,
      );
      if (!base.ok) throw badBaseUrl(base.message);

      const { key, source } = await keyFor(body.apiKey, body.task, base.baseUrl);

      // `PU-MODEL-003`/`004`: Higgsfield y fal no hablan OpenAI. La lista es
      // el catálogo verificado; la prueba, una llamada autenticada que no
      // genera (el estimador de Higgsfield, la API de precios de fal).
      const genProvider = body.provider;
      if (isGenProvider(genProvider)) {
        const models: ModelListOutcome = {
          ok: true,
          models: genModelsFor(genProvider, body.task),
        };
        let completion: ModelCompletionOutcome | null = null;
        // ComfyUI es local y sin key: «Test connection» es `GET /system_stats`
        // y no depende del workflow (`PU-LATER-003`).
        const local = genProvider === "comfyui";
        if (body.model !== undefined || local) {
          if (key === undefined && !local) {
            completion = {
              ok: false,
              error: { code: "unauthorized", message: "Paste the API key to test it." },
            };
          } else {
            try {
              const client = (deps.genClientFor ?? createGenClient)({
                provider: genProvider,
                baseUrl: base.baseUrl,
                apiKey: key ?? "",
              });
              const model = body.model ?? "ComfyUI";
              const done = await client.checkCredentials(model);
              completion = { ok: true, model, latencyMs: done.latencyMs };
            } catch (error) {
              request.log.info(
                { probe: "genai", code: probeError(error).code },
                "generation provider test failed",
              );
              completion = { ok: false, error: probeError(error) };
            }
          }
        }
        const result: ModelConnectionTest = {
          ok: completion === null || completion.ok,
          keySource: source,
          models,
          completion,
        };
        return data(result);
      }

      const models = await list(base.baseUrl, key);

      let completion: ModelCompletionOutcome | null = null;
      if (body.model !== undefined) {
        try {
          const done = await catalog.testConnection({
            baseUrl: base.baseUrl,
            model: body.model,
            ...(key === undefined ? {} : { apiKey: key }),
          });
          completion = { ok: true, model: done.model, latencyMs: done.latencyMs };
        } catch (error) {
          request.log.info(
            { probe: "completion", code: probeError(error).code },
            "model provider test failed",
          );
          completion = { ok: false, error: probeError(error) };
        }
      }

      const result: ModelConnectionTest = {
        ok: models.ok && (completion === null || completion.ok),
        keySource: source,
        models,
        completion,
      };
      return data(result);
    },
  );

  // ── GET /models/providers/:provider/models ──
  app.get(
    "/models/providers/:provider/models",
    { schema: { params: providerParams, querystring: providerModelsQuerySchema } },
    async (request) => {
      const { provider } = request.params;
      if (!isModelProvider(provider)) {
        throw new ApiRejection(404, "not_found", "model provider not found");
      }
      const query = request.query;
      const raw = query.baseUrl ?? providerPreset(provider).baseUrl;
      if (raw === null || raw.trim() === "") {
        throw badBaseUrl("This provider needs a base URL.");
      }
      const base = checkBaseUrl(raw);
      if (!base.ok) throw badBaseUrl(base.message);

      const { key, source } = await keyFor(undefined, query.task, base.baseUrl);
      const result: ProviderModels = {
        provider,
        baseUrl: base.baseUrl,
        keySource: source,
        result: isGenProvider(provider)
          ? { ok: true, models: genModelsFor(provider, query.task) }
          : await list(base.baseUrl, key),
      };
      return data(result);
    },
  );
}
