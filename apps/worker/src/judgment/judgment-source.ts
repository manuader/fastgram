/**
 * De dónde sale el `Judgment` de cada punto de decisión — sprint 9 (O), D-18.
 *
 * Hasta acá cada call-site (JV-6, el piloto, la marca, Engagement) armaba
 * `new LlmJudgmentAdapter(found.llm, …)` a mano. Con D-18 la tarea de juicio
 * puede apuntar a un motor **SystemOne** (Laya local, Jev de TypeSafe), así
 * que la elección se centraliza acá: según el registro de modelos devuelve el
 * adaptador SystemOne o el LLM, **siempre** envuelto en `RecordingJudgment`
 * (cada llamada deja su fila en `judgment_records`, `DATA-033`).
 *
 * ## Cómo resuelve
 *
 * `resolveJudgmentConfig` de `core` sobre el registro: la primera entrada
 * completa de la cadena `judgment.x` → `judgment` gana; si es SystemOne, el
 * adaptador SystemOne; si no, el LLM que `llmSource` resuelve para la tarea
 * (que sabe de `text` y de las `LLM_*`). El registro se relee con el mismo
 * cache corto que el LLM: un cambio en Settings → Models llega al próximo job.
 *
 * ## `engine`
 *
 * El handle dice con qué motor se juzga. **No** es para ramificar sobre la
 * respuesta (el puerto lo prohíbe): es para elegir **qué preguntar**, por
 * costo. Con un SystemOne, el decisor de assets hace N juicios chicos (0,1 s
 * cada uno en Laya); con un LLM local eso serían N llamadas de segundos, y el
 * `choice` único de JV-6 es la forma barata. Ver `discovery/jv6.ts`.
 */
import { createHash } from "node:crypto";

import {
  FileModelRegistry,
  LlmJudgmentAdapter,
  RecordingJudgment,
  SystemOneJudgmentAdapter,
  modelRegistryPath,
  systemOneOptions,
  type JudgmentSink,
  type JudgmentSubject,
} from "@fastgram/adapters";
import {
  resolveJudgmentConfig,
  type ResolvedSystemOneConfig,
  type SecretEnv,
} from "@fastgram/core";
import { createJudgmentSink, type Database } from "@fastgram/db";
import type {
  Judgment,
  JudgmentTask,
  ModelRegistry,
  ModelRegistrySnapshot,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { LLM_REGISTRY_TTL_MS, type LlmSource } from "../llm/registry-llm.js";

export type JudgmentEngine = "llm" | "systemone";

export interface ResolvedJudgmentHandle {
  /** Ya envuelto en `RecordingJudgment`. */
  readonly judgment: Judgment;
  /** Ver la cabecera: para elegir qué preguntar, nunca para leer la respuesta. */
  readonly engine: JudgmentEngine;
}

export interface JudgmentSource {
  /**
   * El juicio de `task` para `subject`, o `null` si no hay ningún motor.
   *
   * `llmOnly`: para las preguntas que sólo un LLM puede contestar bien —el
   * `choice` de JV-6 con opciones opacas (`option_1…`) que remiten a campos
   * del estado: un System One lee la descripción de la opción, no cruza
   * referencias—. Si la tarea resuelve a SystemOne, se usa el LLM de fallback
   * de D-18 (el de la misma tarea, sin la entrada SystemOne).
   */
  resolve(
    task: JudgmentTask,
    subject: JudgmentSubject,
    options?: { readonly llmOnly?: boolean },
  ): Promise<ResolvedJudgmentHandle | null>;
}

export interface JudgmentSourceDeps {
  readonly llmSource: LlmSource;
  readonly db: Database;
  readonly appRole: string | undefined;
  readonly logger: BuildLogger;
  /**
   * El registro de modelos. Ausente = el archivo de siempre
   * (`FASTGRAM_HOME/models.json`), el mismo que lee `llmSource` en `main.ts`.
   */
  readonly registry?: ModelRegistry;
  /** Para los `apiKeyEnv` (la key de Jev puede vivir en una variable). */
  readonly secrets?: SecretEnv;
  readonly ttlMs?: number;
  readonly nowMs?: () => number;
  /** Sólo tests. */
  readonly sink?: JudgmentSink;
  /** Sólo tests: con qué construir el adaptador SystemOne. */
  readonly buildSystemOne?: (config: ResolvedSystemOneConfig) => Judgment;
  /** `null` apaga el precalentamiento de Laya. Default {@link LAYA_KEEP_WARM_MS}. */
  readonly keepWarmMs?: number | null;
}

/**
 * Plazo por defecto de una llamada SystemOne cuando quien llama no pasa uno.
 * La primera a un checkpoint frío de Laya tarda 8–10 s en la Mac (medido): con
 * menos, el primer juicio después de un rato quieto siempre vencería.
 */
export const SYSTEMONE_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Cada cuánto se le hace a Laya una pregunta trivial para que no se enfríe.
 *
 * Medido en la Mac del dueño (sprint 9, con otros cinco agentes corriendo): la
 * primera llamada después de unos minutos quieto tarda 7–10 s —el sistema pagina
 * los pesos del checkpoint— y las siguientes 0,05–0,7 s. Con el plazo de 10 s
 * del decisor, una decisión «en frío» terminaba siempre en el ranking textual.
 * Dos preguntas cada 30 s (una en inglés y una en castellano, para los dos
 * checkpoints que el router usa) cuestan ~0,1 s de inferencia: nada.
 *
 * Sólo Laya: a Jev se le paga cada llamada.
 */
export const LAYA_KEEP_WARM_MS = 30_000;

export function createJudgmentSource(deps: JudgmentSourceDeps): JudgmentSource {
  const secrets = deps.secrets ?? process.env;
  const registry =
    deps.registry ?? new FileModelRegistry({ path: modelRegistryPath(process.env) });
  const ttl = deps.ttlMs ?? LLM_REGISTRY_TTL_MS;
  const now = deps.nowMs ?? Date.now;
  const sink =
    deps.sink ??
    createJudgmentSink(deps.db, deps.appRole === undefined ? {} : { role: deps.appRole });

  let cached: { readonly at: number; readonly snapshot: ModelRegistrySnapshot } | null =
    null;
  let lastGood: ModelRegistrySnapshot = { tasks: {} };
  const built = new Map<string, Judgment>();
  const announced = new Map<JudgmentTask, string>();

  async function snapshot(): Promise<ModelRegistrySnapshot> {
    const t = now();
    if (cached !== null && t - cached.at < ttl) return cached.snapshot;
    try {
      lastGood = await registry.read();
    } catch (error) {
      // Mismo criterio que `llmSource`: un archivo roto no tira la cola. Sin
      // SystemOne legible, cada tarea cae al LLM (que tiene su propio aviso).
      deps.logger.warn(
        { reason: error instanceof Error ? error.message : String(error) },
        "no se pudo leer el registro de modelos para el juicio: sigo con la última lectura buena",
      );
    }
    cached = { at: t, snapshot: lastGood };
    return lastGood;
  }

  function systemOne(config: ResolvedSystemOneConfig): Judgment {
    // La key entra hasheada a la huella: la huella vive en un `Map` del
    // proceso y no se loguea, pero una key en claro más es una key más.
    const key = JSON.stringify([
      config.provider,
      config.baseUrl,
      config.model,
      createHash("sha256").update(config.apiKey).digest("hex"),
    ]);
    let adapter = built.get(key);
    if (adapter === undefined) {
      if (built.size >= 8) built.clear();
      // (los precalentadores de los que se borran se apagan solos, ver `keepWarm`)
      if (deps.buildSystemOne !== undefined) {
        adapter = deps.buildSystemOne(config);
      } else {
        adapter = new SystemOneJudgmentAdapter({
          ...systemOneOptions(config),
          defaultTimeoutMs: SYSTEMONE_DEFAULT_TIMEOUT_MS,
          onWarning: (w) => {
            deps.logger.warn(
              { ...w },
              "juicio SystemOne con muchas opciones: Laya recorta las descripciones",
            );
          },
        });
        if (config.provider === "laya") keepWarm(key, adapter);
      }
      built.set(key, adapter);
    }
    return adapter;
  }

  const warmers = new Map<string, ReturnType<typeof setInterval>>();
  function keepWarm(key: string, adapter: Judgment): void {
    const every = deps.keepWarmMs === undefined ? LAYA_KEEP_WARM_MS : deps.keepWarmMs;
    if (every === null || warmers.has(key)) return;
    const ping = (text: string) =>
      adapter
        .noul({
          decisionPoint: "DP-005",
          state: { candidate: text },
          question: {
            id: "warm",
            kind: "noul",
            instructions: "Is this content not safe for work?",
            criteria: { true: "NSFW.", false: "Safe for work." },
          },
          timeoutMs: SYSTEMONE_DEFAULT_TIMEOUT_MS,
        })
        .catch(() => undefined);
    const timer = setInterval(() => {
      // Si la configuración cambió, este adaptador ya no se usa: se apaga.
      if (!built.has(key)) {
        clearInterval(timer);
        warmers.delete(key);
        return;
      }
      void ping("a sunset over the sea").then(() => ping("un atardecer sobre el mar"));
    }, every);
    // No mantiene vivo al proceso: el worker se baja igual con SIGTERM.
    timer.unref();
    warmers.set(key, timer);
  }

  function wrap(inner: Judgment, subject: JudgmentSubject): Judgment {
    return new RecordingJudgment(inner, sink, subject, {
      onError: (error) => {
        deps.logger.warn(
          {
            ...subject,
            reason: error instanceof Error ? error.message : String(error),
          },
          "no se pudo guardar el juicio en judgment_records (la decisión sigue)",
        );
      },
    });
  }

  return {
    async resolve(task, subject, options = {}) {
      // `legacy: null`: acá sólo interesa si la cadena termina en un SystemOne.
      // El LLM (con las `LLM_*` de fallback) lo resuelve `llmSource`.
      const resolved =
        options.llmOnly === true
          ? null
          : resolveJudgmentConfig(task, await snapshot(), null, secrets);
      if (resolved?.engine === "systemone") {
        const mark = `systemone:${resolved.provider}:${resolved.baseUrl}:${resolved.model}`;
        if (announced.get(task) !== mark) {
          announced.set(task, mark);
          // Nunca la key: proveedor, base y modelo.
          deps.logger.info(
            {
              task,
              entry: resolved.entry,
              provider: resolved.provider,
              baseUrl: resolved.baseUrl,
              model: resolved.model,
            },
            "juicio en uso: SystemOne",
          );
        }
        return { judgment: wrap(systemOne(resolved), subject), engine: "systemone" };
      }
      // `llmSource` ya ignora las entradas SystemOne (`resolveLlmConfig`).
      const found = await deps.llmSource.current(task);
      if (found === null) return null;
      if (options.llmOnly !== true) announced.set(task, "llm");
      return {
        judgment: wrap(
          new LlmJudgmentAdapter(found.llm, { model: found.config.model }),
          subject,
        ),
        engine: "llm",
      };
    },
  };
}

/**
 * Un `JudgmentSource` por proceso para quien no recibe uno por parámetro: los
 * factories de JV-3/JV-4/JV-5/JV-6 se arman en `main.ts` con `llmSource`, y así
 * pasan a la fábrica sin cambiar su firma ni `main.ts`. La clave es el
 * `llmSource`: con otro (un test), otra fuente.
 */
const shared = new WeakMap<LlmSource, JudgmentSource>();

export function judgmentSourceFor(
  deps: Omit<JudgmentSourceDeps, "registry" | "secrets" | "ttlMs" | "nowMs">,
): JudgmentSource {
  let source = shared.get(deps.llmSource);
  if (source === undefined) {
    source = createJudgmentSource(deps);
    shared.set(deps.llmSource, source);
  }
  return source;
}
