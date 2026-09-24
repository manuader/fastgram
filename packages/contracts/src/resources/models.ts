/**
 * Registro de modelos por tarea — `PU-MODEL-001`, `PU-MODEL-002`,
 * `docs/PLAN-USO-PERSONAL.md` §4 y D-14, ADR-009.
 *
 *   GET  /models                                  configuración por tarea + presets
 *   PUT  /models/{task}                           guardar la de una tarea
 *   POST /models/test                             probar base URL + key + modelo
 *   GET  /models/providers/{provider}/models      lo que lista el proveedor
 *
 * **No está en el PRD**: la superficie v1 de §9.3 es la de Fastlane, y esta
 * pantalla es de la decisión D-14 (uso personal). La forma es derivada, con
 * dos reglas:
 *
 * 1. **Ninguna respuesta lleva una API key.** Sólo `hasKey` y los últimos
 *    cuatro caracteres (y ni eso si la key es corta). La key entra por
 *    `PUT` y no vuelve a salir.
 * 2. **Ningún id de modelo por defecto.** Lo escribe el usuario o lo elige de
 *    lo que el proveedor lista.
 *
 * ## Por qué probar y listar devuelven 200 aunque el proveedor falle
 *
 * Porque la petición a *esta* API salió bien: lo que falló es el proveedor, y
 * eso es el dato que la pantalla pidió. Traducirlo a un `401` rompería al
 * cliente web, que lee un `401` como «tu sesión venció». El resultado viaja en
 * `ok` + `error.code`, con los mismos códigos estables del puerto `Llm`.
 *
 * Las listas de tareas y proveedores repiten las de `packages/ports`
 * (`MODEL_TASKS`, `MODEL_PROVIDERS`) porque este paquete es standalone; el test
 * de rutas de `apps/api` las compara.
 */
import { z } from "zod";

export const modelTaskSchema = z.enum([
  "text",
  "judgment",
  "vision",
  "image",
  "video",
  "background_removal",
]);
export type ModelTask = z.infer<typeof modelTaskSchema>;

export const modelProviderSchema = z.enum([
  "openrouter",
  "groq",
  "gemini",
  "cerebras",
  "deepseek",
  "ollama",
  "lmstudio",
  "custom",
]);
export type ModelProvider = z.infer<typeof modelProviderSchema>;

export const modelProviderPresetSchema = z.object({
  id: modelProviderSchema,
  label: z.string(),
  /** `null` = sin default verificado (DeepSeek) o sin sentido (`custom`). */
  baseUrl: z.string().nullable(),
  requiresKey: z.boolean(),
  local: z.boolean(),
  note: z.string().nullable(),
});
export type ModelProviderPreset = z.infer<typeof modelProviderPresetSchema>;

export const modelKeyInfoSchema = z.object({
  hasKey: z.boolean(),
  last4: z.string().nullable(),
  /** `file` = guardada en el registro; `env` = de una variable de entorno. */
  source: z.enum(["file", "env"]).nullable(),
  envVar: z.string().nullable(),
});
export type ModelKeyInfo = z.infer<typeof modelKeyInfoSchema>;

export const modelTaskConfigSchema = z.object({
  task: modelTaskSchema,
  /** `llm` = habla la API de OpenAI; `reserved` = se guarda, sin adaptador. */
  kind: z.enum(["llm", "reserved"]),
  /** Algo en el código la usa hoy. */
  wired: z.boolean(),
  status: z.enum(["ready", "incomplete", "unset"]),
  /** Con qué corre de verdad: el registro, las `LLM_*` del entorno, o nada. */
  source: z.enum(["registry", "env", "none"]),
  /** `text` si `judgment` no tiene entrada propia y usa la de texto. */
  inheritsFrom: modelTaskSchema.nullable(),
  provider: modelProviderSchema.nullable(),
  baseUrl: z.string().nullable(),
  model: z.string().nullable(),
  contextWindowTokens: z.number().int().positive().nullable(),
  apiKey: modelKeyInfoSchema,
  apiKeyEnv: z.string().nullable(),
  missing: z.array(z.enum(["apiKey", "contextWindowTokens"])),
  providers: z.array(modelProviderSchema),
  updatedAt: z.string().nullable(),
});
export type ModelTaskConfig = z.infer<typeof modelTaskConfigSchema>;

export const modelsOverviewSchema = z.object({
  tasks: z.array(modelTaskConfigSchema),
  providers: z.array(modelProviderPresetSchema),
});
export type ModelsOverview = z.infer<typeof modelsOverviewSchema>;

/**
 * `PUT /models/{task}`. En los opcionales, **ausente = dejar lo que había** y
 * `null` = borrarlo: así se cambia el modelo sin reenviar la key, que el
 * cliente no tiene. Una key guardada **no se conserva** si la base URL cambia
 * de origen: hay que volver a escribirla (no viaja a otro host sin querer).
 */
export const updateModelTaskRequestSchema = z
  .object({
    provider: modelProviderSchema,
    /** Vacío o ausente = la del preset, si tiene una. */
    baseUrl: z.string().max(2048).optional(),
    model: z.string().trim().min(1).max(256),
    apiKey: z.string().max(1024).nullable().optional(),
    apiKeyEnv: z.string().max(128).nullable().optional(),
    contextWindowTokens: z.number().int().positive().nullable().optional(),
  })
  .strict();
export type UpdateModelTaskRequest = z.infer<typeof updateModelTaskRequestSchema>;

export const listedModelSchema = z.object({
  id: z.string(),
  /** Sólo si el proveedor la publica en `/models`. */
  contextWindowTokens: z.number().int().positive().optional(),
  ownedBy: z.string().optional(),
});
export type ListedModel = z.infer<typeof listedModelSchema>;

/** Los mismos códigos que el puerto `Llm` (`PortErrorCode`), estables. */
export const modelProbeErrorSchema = z.object({
  code: z.enum([
    "unauthorized",
    "not_found",
    "rate_limited",
    "quota_exceeded",
    "timeout",
    "provider_unavailable",
    "bad_request",
    "provider_contract_violation",
    "forbidden",
    "conflict",
  ]),
  message: z.string(),
});
export type ModelProbeError = z.infer<typeof modelProbeErrorSchema>;

export const modelListOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), models: z.array(listedModelSchema) }),
  z.object({ ok: z.literal(false), error: modelProbeErrorSchema }),
]);
export type ModelListOutcome = z.infer<typeof modelListOutcomeSchema>;

export const modelCompletionOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    model: z.string(),
    latencyMs: z.number().int().nonnegative(),
  }),
  z.object({ ok: z.literal(false), error: modelProbeErrorSchema }),
]);
export type ModelCompletionOutcome = z.infer<typeof modelCompletionOutcomeSchema>;

/** Con qué key se probó. `stored` = la guardada de `task`, sólo al mismo origen. */
export const modelKeySourceSchema = z.enum(["provided", "stored", "none"]);
export type ModelKeySource = z.infer<typeof modelKeySourceSchema>;

/**
 * `POST /models/test`. Sin `apiKey`, y con `task`, se usa la key guardada de
 * esa tarea **sólo si la base URL es del mismo origen** que la guardada.
 * Sin `model`, sólo se lista.
 */
export const testModelConnectionRequestSchema = z
  .object({
    task: modelTaskSchema.optional(),
    provider: modelProviderSchema,
    baseUrl: z.string().max(2048),
    apiKey: z.string().max(1024).optional(),
    model: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type TestModelConnectionRequest = z.infer<typeof testModelConnectionRequestSchema>;

export const modelConnectionTestSchema = z.object({
  /** Todo lo que se pidió probar anduvo. */
  ok: z.boolean(),
  keySource: modelKeySourceSchema,
  models: modelListOutcomeSchema,
  /** `null` si no se pidió modelo. */
  completion: modelCompletionOutcomeSchema.nullable(),
});
export type ModelConnectionTest = z.infer<typeof modelConnectionTestSchema>;

/** `GET /models/providers/{provider}/models`. Nunca lleva una key en la query. */
export const providerModelsQuerySchema = z
  .object({
    /** Ausente = la del preset. */
    baseUrl: z.string().max(2048).optional(),
    /** De qué tarea tomar la key guardada (mismo origen). */
    task: modelTaskSchema.optional(),
  })
  .strict();
export type ProviderModelsQuery = z.infer<typeof providerModelsQuerySchema>;

export const providerModelsSchema = z.object({
  provider: modelProviderSchema,
  baseUrl: z.string(),
  keySource: modelKeySourceSchema,
  result: modelListOutcomeSchema,
});
export type ProviderModels = z.infer<typeof providerModelsSchema>;
