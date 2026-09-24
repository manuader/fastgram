/**
 * Worker — consumidores de la cola (`ADR-005`, cola en Postgres).
 *
 * Hasta esta tanda este archivo imprimía *"sin handlers todavía"* y terminaba.
 * Eso tenía una consecuencia que no se veía desde acá: `POST /content` creaba
 * la pieza, **cobraba el content save** y encolaba el build, y la pieza se
 * quedaba en `BUILDING` para siempre con el save cobrado y sin devolver.
 *
 * Ahora consume `content-build` y `quota-reset`. Los otros 19 trabajos de §9.5
 * siguen sin handler, y eso se dice en el log al arrancar en vez de quedar
 * implícito: una cola con productor y sin consumidor es el peor modo de falla
 * que tiene este sistema, porque no falla nada.
 *
 * Orden de arranque, y por qué ése:
 *  1. **Validar el entorno.** Si falta algo, el proceso muere acá con el nombre
 *     de la variable.
 *  2. Abrir la base y construir los adaptadores.
 *  3. Registrar los handlers — antes de `start()`, porque el adaptador los
 *     encola y los registra al arrancar.
 *  4. Arrancar la cola.
 *  5. **Programar los recurrentes**, que va después de `start()` porque crean
 *     la cola si falta y pg-boss rechaza el DDL con el boss parado.
 *  6. Y recién entonces el apagado limpio.
 */
import {
  createPgBossQueue,
  drizzleTransactionToExecutor,
  FileModelRegistry,
  modelRegistryPath,
  S3Storage,
  systemClock,
  WebsiteReader,
} from "@fastgram/adapters";
import { ALL_JOB_QUEUES, JOB_QUEUES } from "@fastgram/core";
import { createDb } from "@fastgram/db";
import pino from "pino";

import { createBrandSourceAnalysisHandler } from "./brand/analysis-handler.js";
import { createLlmBrandSynthesizer } from "./brand/synthesizer.js";
import { createLlmCopywriter } from "./discovery/copywriter.js";
import {
  REFILL_WITHOUT_LLM_WHY,
  type CopywriterProvider,
} from "./discovery/refill-handler.js";
import { createHandlers, type BrandAnalysisMount } from "./handlers.js";
import { createAiStudioMount } from "./genai/mount.js";
import { createHealthServer, createWorkerHealth } from "./health/server.js";
import {
  brandReaderFromEnv,
  llmFromEnv,
  loadWorkerEnv,
  renderServiceFromEnv,
} from "./env.js";
import { createLlmSource, createResolvingLlm } from "./llm/registry-llm.js";
import { JOB_CATALOG, type JobPolicy } from "./jobs/catalog.js";
import { mountMediaImport } from "./media-import/mount.js";
import { mountPublishing } from "./publishing/mount.js";
import {
  createRenderServiceRenderers,
  selectWorkerRenderers,
} from "./media/render-service.js";

const env = loadWorkerEnv();
const logger = pino({ level: env.LOG_LEVEL });

const handle = createDb({ url: env.DATABASE_URL, max: env.DATABASE_POOL_MAX });
const clock = systemClock;
const appRole = env.DATABASE_APP_ROLE === "" ? undefined : env.DATABASE_APP_ROLE;

/**
 * La cola.
 *
 * `supervise: true` y `schedule: true`, al revés que en la API: el
 * mantenimiento (expirar, archivar) y el cron de §9.5 son trabajo del
 * consumidor. Si los hiciera la API, cada réplica de la API los haría en
 * paralelo con todas las demás.
 *
 * `migrate: false` sin bandera que lo cambie: el DDL del esquema de la cola lo
 * hace la API con `QUEUE_MIGRATE`. Dos procesos compitiendo por los mismos
 * objetos al arrancar es un modo de falla que no hace falta tener.
 */
const { queue } = createPgBossQueue({
  connectionString: env.DATABASE_URL,
  schema: env.QUEUE_SCHEMA,
  queues: [...ALL_JOB_QUEUES],
  toExecutor: drizzleTransactionToExecutor,
  migrate: false,
  supervise: true,
  schedule: true,
});

/**
 * El storage, **real** — `P1-STORAGE-007`, `ADR-006`.
 *
 * Acá estaba `MemoryStorage`. Con la API ya sobre S3 y el worker sobre memoria,
 * `contents.files` guardaría `memory://bucket/...`: URLs que no sirve nadie,
 * escritas en una columna persistida y devueltas por la API como si fueran
 * buenas.
 *
 * Campo por campo igual que `apps/api/src/support/storage.ts`. **No se importa
 * de ahí**: `apps/worker` no depende de `apps/api`, y si conviene que exista
 * una sola definición el sitio es `@fastgram/adapters` o `@fastgram/config` —
 * es una decisión de IMPL §2.2, no de un `import`.
 *
 * **Una diferencia real con la API, y no es cosmética:** la API nunca hace
 * `put()` —los bytes del usuario van directo al bucket por la URL firmada— y el
 * worker sí, al guardar el render. Ahí entra la deuda declarada del adaptador:
 * sin `@aws-sdk/lib-storage` no hay multipart, así que `put` con un
 * `AsyncIterable` **acumula en memoria** hasta `maxBufferedBytes` y falla
 * fuerte. En la API ese tope es inerte; acá es el que se va a tocar.
 */
const storage = new S3Storage({
  bucket: env.S3_BUCKET,
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

/**
 * Los renderers — `P2-RENDER-015`.
 *
 * Con `RENDER_SERVICE_URL` + `RENDER_MEDIA_GRANT_SECRET`: `HttpMediaRenderer`
 * contra `services/render` para `content-build` y `content-rebuild` (una
 * instancia) y otra para `media-normalization` (otro presupuesto de tiempo).
 * Sin ellas: `MemoryMediaRenderer` para los builds —bytes sintéticos, el
 * pipeline corre igual— y la normalización sin montar. Ver
 * `media/render-service.ts`, que es también donde está el porqué de que el
 * real ya no rompa los builds (las fuentes cargan desde `RENDER_FONT_DIR`).
 *
 * Con la configuración puesta, pide la versión del motor a
 * `GET /capabilities` **antes** de montar nada: si el servicio no contesta, el
 * worker no levanta.
 */
async function renderersFromEnv() {
  const config = renderServiceFromEnv(env);
  if (config === null) {
    logger.warn(
      "sin RENDER_SERVICE_URL: content-build y content-rebuild usan MemoryMediaRenderer " +
        "(artefactos sintéticos) y media-normalization no se monta",
    );
    return selectWorkerRenderers(null);
  }
  const created = await createRenderServiceRenderers(config);
  // Nunca el secreto: sólo a dónde se habla.
  logger.info(
    { baseUrl: config.baseUrl },
    "servicio de render para content-build, content-rebuild y media-normalization",
  );
  return selectWorkerRenderers(created);
}

const { renderer, normalizationRenderer } = await renderersFromEnv();

/**
 * El LLM — `PU-MODEL-001`. Ya no se arma una vez al arrancar: se resuelve en
 * cada job contra el registro de modelos (`models.json`, lo escribe Settings →
 * Models), con las cuatro `LLM_*` como fallback. Ver `llm/registry-llm.ts`.
 * Construirlo no toca disco ni red.
 */
const registryPath = modelRegistryPath(
  env.FASTGRAM_HOME === undefined ? {} : { FASTGRAM_HOME: env.FASTGRAM_HOME },
);
const llmSource = createLlmSource({
  registry: new FileModelRegistry({ path: registryPath }),
  legacy: llmFromEnv(env),
  // Para los `apiKeyEnv` del registro: la key de un proveedor puede vivir en
  // una variable que este esquema no conoce.
  secrets: process.env,
  logger,
});
logger.info({ path: registryPath }, "registro de modelos");

/** Cada cuánto se vuelve a mirar si apareció un LLM, para montar el análisis. */
const BRAND_ANALYSIS_LLM_POLL_MS = 30_000;

/**
 * `brand-source-analysis`: extractor de web (una instancia por `website` y
 * otra por `other_url`, `FR-011.1`), LLM y retención — o qué falta.
 *
 * Construir los adaptadores no toca red: `WebsiteReader` sólo valida su
 * configuración y **lanza** si es inválida, así que un número imposible tira
 * el arranque acá en vez del primer job. Sólo `website` y `other_url` tienen
 * extractor: las cinco plataformas sociales terminan en `unsupported_platform`
 * (ver el handler).
 *
 * El sintetizador recibe un `Llm` que **resuelve en cada llamada**: un modelo
 * nuevo en la pantalla llega al próximo análisis. Si al arrancar no hay LLM,
 * la cola no se monta —igual que antes— pero se vuelve a mirar cada
 * {@link BRAND_ANALYSIS_LLM_POLL_MS} y se monta en cuanto aparece (ver abajo,
 * después de `queue.start()`). Si el LLM se borra con la cola ya montada, cada
 * análisis falla con `llm_provider_unavailable`, que es reintentable.
 */
const brandReader = brandReaderFromEnv(env);
const textLlmAtStart = await llmSource.current("text");

function brandAnalysisHandlerDeps() {
  if (brandReader.kind === "missing") return null;
  const reader = (source: "website" | "other_url"): WebsiteReader =>
    new WebsiteReader({ source, ...brandReader.website });
  return {
    readers: { website: reader("website"), other_url: reader("other_url") },
    synthesizer: createLlmBrandSynthesizer({
      llm: createResolvingLlm(llmSource, "text"),
    }),
    rawRetentionDays: brandReader.rawRetentionDays,
  };
}

const NO_TEXT_LLM =
  "un LLM para la tarea `text` (Settings → Models, o LLM_BASE_URL + LLM_API_KEY + " +
  "LLM_MODEL + LLM_CONTEXT_WINDOW_TOKENS)";

function brandAnalysisMount(): BrandAnalysisMount {
  const missing = [
    ...(textLlmAtStart === null ? [NO_TEXT_LLM] : []),
    ...(brandReader.kind === "missing" ? brandReader.missing : []),
  ];
  const deps = brandAnalysisHandlerDeps();
  if (missing.length > 0 || deps === null) return { kind: "unmounted", missing };
  return { kind: "mounted", ...deps };
}

/**
 * La copy de `AI-002` para `discovery-refill`, resuelta **en cada job**: sin
 * LLM el handler no encola nada (como antes), y en cuanto se configura uno en
 * la pantalla, el próximo relleno lo usa.
 */
const copywriter: CopywriterProvider = async () => {
  const found = await llmSource.current("text");
  return found === null ? null : createLlmCopywriter({ llm: found.llm });
};
if (textLlmAtStart === null) {
  logger.warn(
    { cola: JOB_QUEUES.discoveryRefill },
    `${REFILL_WITHOUT_LLM_WHY} — se vuelve a mirar el registro en cada job`,
  );
}

/**
 * `media-import` (`PU-MEME-001`): `yt-dlp` y FFmpeg locales, y el registro de
 * modelos para etiquetar (`vision`) y recortar (`background_removal`).
 */
const mediaImport = await mountMediaImport({
  env: process.env,
  registry: new FileModelRegistry({ path: registryPath }),
  logger,
});
if (mediaImport.kind === "mounted") {
  logger.info({ ytDlp: mediaImport.ytDlpVersion }, "media-import con yt-dlp");
}

const { handlers: HANDLERS, unmounted } = createHandlers({
  db: handle.db,
  // AI-004: el modelo se relee en cada job, así cambiarlo en Settings → Models
  // aplica sin reiniciar el worker.
  copyLlm: async () => (await llmSource.current("text"))?.llm ?? null,
  renderer,
  normalizationRenderer,
  storage,
  clock,
  appRole,
  logger,
  brandAnalysis: brandAnalysisMount(),
  copywriter,
  // `PU-MEDIA-002`: para que el refill encole el kit de fondos de una marca sin media.
  queue,
  mediaImport,
  // `PU-PUB-003…008`: publicadores reales, tokens, túnel y guardas.
  publishing: mountPublishing({
    db: handle.db,
    appRole,
    storage,
    clock,
    env: process.env,
  }),
  // `PU-LATER-005`: AI Studio (Higgsfield, fal), polling y copia a storage.
  aiStudio: createAiStudioMount({
    db: handle.db,
    storage,
    appRole,
    logger,
    env: process.env,
  }).handler,
});

for (const [name, handler] of Object.entries(HANDLERS)) {
  await queue.work(name, handler, { concurrency: env.WORKER_CONCURRENCY });
}

const conHandler = Object.keys(HANDLERS);
const sinHandler = Object.values(JOB_CATALOG)
  .map((p) => p.name)
  .filter((name) => !(name in HANDLERS));

await queue.start();

/**
 * `brand-source-analysis` montado **tarde** — `PU-MODEL-001`. Si al arrancar
 * había extractor y retención pero no LLM, se mira el registro cada
 * {@link BRAND_ANALYSIS_LLM_POLL_MS} y, cuando aparece uno para `text`, se
 * registra el consumidor. Es seguro después de `start()`: el adaptador de
 * pg-boss registra al toque si ya arrancó. Los jobs que se encolaron mientras
 * tanto esperaban en la cola, así que se procesan en ese momento.
 */
let brandAnalysisPoll: ReturnType<typeof setInterval> | null = null;
if (!(JOB_QUEUES.brandSourceAnalysis in HANDLERS) && brandReader.kind === "configured") {
  let mounting = false;
  brandAnalysisPoll = setInterval(() => {
    if (mounting) return;
    mounting = true;
    void (async () => {
      try {
        if ((await llmSource.current("text")) === null) return;
        const deps = brandAnalysisHandlerDeps();
        if (deps === null) return;
        await queue.work(
          JOB_QUEUES.brandSourceAnalysis,
          createBrandSourceAnalysisHandler({
            db: handle.db,
            clock,
            appRole,
            logger,
            ...deps,
          }),
          { concurrency: env.WORKER_CONCURRENCY },
        );
        if (brandAnalysisPoll !== null) clearInterval(brandAnalysisPoll);
        brandAnalysisPoll = null;
        logger.info(
          { cola: JOB_QUEUES.brandSourceAnalysis },
          "apareció un LLM en el registro de modelos: brand-source-analysis montado",
        );
      } catch (error: unknown) {
        logger.error({ error }, "no se pudo montar brand-source-analysis");
      } finally {
        mounting = false;
      }
    })();
  }, BRAND_ANALYSIS_LLM_POLL_MS);
  // No mantiene vivo el proceso: el apagado no tiene que esperarlo.
  brandAnalysisPoll.unref();
}

/**
 * Los trabajos programados de §9.5.
 *
 * **Después de `start()`**, no antes: `scheduleRecurring` crea la cola si falta
 * y pg-boss rechaza el DDL con el boss parado. Es el mismo orden que la trampa
 * 21 deja escrito para `work()`.
 *
 * Y **sólo los que tienen handler.** Programar el cron de una cola que nadie
 * consume es el peor modo de falla de este sistema —el que no falla—: los jobs
 * se acumulan, nadie los toma, y el log de arranque diría que el trabajo está
 * programado. La lista de los que quedaran afuera va al log, igual que las
 * colas sin consumidor.
 *
 * El cron sale del catálogo y no de acá: es la política del consumidor y ya
 * está escrita con su razón. El adaptador lo registra **en UTC** (§16.2 fija
 * los resets a 00:00 UTC y una zona local los movería con el horario de verano).
 */
const programados: string[] = [];
const programablesSinHandler: string[] = [];
// Se ensancha a `JobPolicy` a propósito: `JOB_CATALOG` es `as const`, así que
// las entradas sin cron **no tienen** la propiedad `scheduled` en su tipo
// literal y la unión no la deja leer. El `satisfies` del catálogo garantiza que
// este ensanchamiento es correcto.
const policies: readonly JobPolicy[] = Object.values(JOB_CATALOG);
for (const policy of policies) {
  if (policy.scheduled === undefined) continue;
  if (!(policy.name in HANDLERS)) {
    programablesSinHandler.push(policy.name);
    continue;
  }
  await queue.scheduleRecurring({
    // `RecurringSpec.name` tiene que ser único y el adaptador lo indexa por
    // cola (una programación por cola, ver su cabecera), así que el nombre de
    // la cola es el nombre natural de la programación.
    name: policy.name,
    queue: policy.name,
    cron: policy.scheduled.cron,
    // Vacío a propósito: un barrido no se apunta a nadie. Ver el handler.
    payload: {},
  });
  programados.push(`${policy.name} (${policy.scheduled.cron} UTC)`);
}

logger.info(
  {
    colas: conHandler,
    sinHandler: sinHandler.length,
    programados,
    concurrency: env.WORKER_CONCURRENCY,
  },
  "worker arriba",
);
if (programablesSinHandler.length > 0) {
  logger.warn(
    { colas: programablesSinHandler },
    "trabajos con cron en el catálogo y sin handler: NO se programaron, " +
      "porque encolar contra una cola que nadie consume no falla nunca",
  );
}
// Una línea por cola que **tiene** handler y quedó afuera por configuración,
// con el porqué: `media-normalization` sin servicio de render y
// `brand-source-analysis` sin extractor, LLM o retención.
for (const { queue: name, why } of unmounted) {
  logger.warn({ cola: name }, `handler no montado: ${why}`);
}
// A nivel `warn` y con la lista entera: son 20 colas en las que la API ya
// encola y que nadie lee. Verlo cada vez que arranca el proceso es el punto.
logger.warn(
  { colas: sinHandler },
  "colas sin handler: lo que se encole ahí no lo consume nadie",
);

/**
 * Apagado limpio.
 *
 * `queue.stop()` deja de tomar trabajo nuevo y **espera a que terminen los jobs
 * activos**. Importa: un build a mitad de camino puede estar en la transacción
 * que reembolsa un save. La base se cierra después, no antes, por eso mismo.
 */
/**
 * La sonda de salud, **después** de `queue.start()`.
 *
 * `queueRunning` es una función y no un booleano capturado: tiene que reflejar
 * el apagado. Un worker que ya recibió SIGTERM y dejó de consumir debe decir
 * `unavailable` mientras termina, no `ok` hasta el último milisegundo.
 */
let queueRunning = true;
const healthServer =
  env.WORKER_HEALTH_PORT === 0
    ? null
    : createHealthServer(
        createWorkerHealth({
          db: handle.db,
          appRole,
          logger,
          queueRunning: () => queueRunning,
        }),
        logger,
      );

if (healthServer !== null) {
  healthServer.listen(env.WORKER_HEALTH_PORT, () => {
    logger.info({ port: env.WORKER_HEALTH_PORT }, "sonda de salud escuchando");
  });
}

let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "apagando");
    void (async () => {
      try {
        // Antes de nada: el worker deja de estar listo **en cuanto** empieza a
        // apagarse, no cuando termina.
        queueRunning = false;
        if (brandAnalysisPoll !== null) clearInterval(brandAnalysisPoll);
        healthServer?.close();
        await queue.stop();
        await handle.close();
        process.exit(0);
      } catch (error: unknown) {
        logger.error({ error }, "fallo durante el apagado");
        process.exit(1);
      }
    })();
  });
}
