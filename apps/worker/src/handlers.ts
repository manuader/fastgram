/**
 * Qué colas consume este worker, y con qué — sacado de `main.ts` para poder
 * testearlo sin arrancar pg-boss ni abrir una base.
 *
 * Construir un handler no toca red ni disco: cada `create…Handler` sólo cierra
 * sobre sus dependencias. Así que {@link createHandlers} es pura en lo que
 * importa acá —**qué claves tiene el mapa**— y `handlers.test.ts` la llama con
 * dobles para comprobar qué se monta en cada configuración.
 */
import type {
  BrandSourceType,
  Clock,
  JobHandler,
  MediaRenderer,
  SocialPublisher,
  SocialReader,
  Storage,
} from "@fastgram/ports";
import { JOB_QUEUES, type JobQueueName } from "@fastgram/core";
import type { Database } from "@fastgram/db";
import { systemRng } from "@fastgram/adapters";

import { createBrandSourceAnalysisHandler } from "./brand/analysis-handler.js";
import { createBrandStalenessHandler } from "./brand/staleness-handler.js";
import type { BrandSynthesizer } from "./brand/synthesizer.js";
import { createSnapshotPurgeHandler } from "./brand/snapshot-purge-handler.js";
import { createContentBuildHandler, type BuildLogger } from "./content/build-handler.js";
import { createContentRebuildHandler } from "./content/rebuild-handler.js";
import type { SuggestionCopywriter } from "./discovery/copywriter.js";
import {
  REFILL_WITHOUT_LLM_WHY,
  createDiscoveryRefillHandler,
} from "./discovery/refill-handler.js";
import { createInfluencerPipelineHandler } from "./influencers/pipeline-handler.js";
import { createQuotaResetHandler } from "./jobs/quota-reset-handler.js";
import { createMediaNormalizationHandler } from "./media/normalization-handler.js";
import { createPublishHandler } from "./publishing/publish-handler.js";

export interface WorkerHandlerDeps {
  readonly db: Database;
  /**
   * El de `content-build` **y** `content-rebuild`. Hoy `MemoryMediaRenderer`:
   * ver `main.ts`.
   */
  readonly renderer: MediaRenderer;
  /**
   * El de `media-normalization`, **otra instancia** y a propósito: un
   * `HttpMediaRenderer` contra `services/render`, o `null` si el entorno no lo
   * configura. Ver el bloque de `media-normalization` más abajo.
   */
  readonly normalizationRenderer: MediaRenderer | null;
  readonly storage: Storage;
  readonly clock: Clock;
  readonly appRole: string | undefined;
  readonly logger: BuildLogger;
  /**
   * Lo de `brand-source-analysis`, o **qué falta** para montarlo. Ver el
   * bloque de esa cola más abajo.
   */
  readonly brandAnalysis: BrandAnalysisMount;
  /**
   * La copy de `AI-002` para `discovery-refill`, o `null` sin LLM configurado.
   * Con `null` el handler **se monta igual** y no encola nada (ver su
   * cabecera): no registrarlo dejaría los jobs acumulándose, uno por minuto
   * mientras el deck está abierto.
   */
  readonly copywriter: SuggestionCopywriter | null;
}

export type BrandAnalysisMount =
  | {
      readonly kind: "mounted";
      readonly readers: Readonly<Partial<Record<BrandSourceType, SocialReader>>>;
      readonly synthesizer: BrandSynthesizer;
      readonly rawRetentionDays: number;
    }
  | { readonly kind: "unmounted"; readonly missing: readonly string[] };

export function brandAnalysisUnmountedWhy(missing: readonly string[]): string {
  return (
    `faltan ${missing.join("; ")}: las brand sources quedan en \`pending\` y sus ` +
    "jobs esperan en la cola hasta que un worker con extractor de web, LLM y " +
    "retención de snapshots configurados los tome"
  );
}

/** Una cola que tiene handler escrito y que esta configuración no monta. */
export interface UnmountedQueue {
  readonly queue: JobQueueName;
  readonly why: string;
}

export interface WorkerHandlers {
  readonly handlers: Readonly<Record<string, JobHandler<unknown>>>;
  /**
   * Para el log de arranque. Distinto de «sin handler»: éstas **tienen** handler
   * y quedan afuera por configuración, y eso es lo primero que hay que saber
   * cuando un video se queda en `processing`.
   */
  readonly unmounted: readonly UnmountedQueue[];
}

export const NORMALIZATION_UNMOUNTED_WHY =
  "RENDER_SERVICE_URL y RENDER_MEDIA_GRANT_SECRET no están configuradas: " +
  "los videos subidos quedan en `processing` y sus jobs esperan en la cola " +
  "hasta que un worker con el servicio de render configurado los tome";

/**
 * Publicadores por plataforma — **vacío, y a propósito**.
 *
 * No hay ni un adaptador real de `SocialPublisher`: `MemorySocialPublisher`
 * existe para los tests de contrato y montarlo acá marcaría posts como `POSTED`
 * con un permalink inventado. Eso es **mentir en los datos del usuario**, que es
 * peor que no publicar: el de memoria es un artefacto sintético aceptable para
 * un render —se ve que no es un video— pero un post "publicado" que no existe en
 * ninguna cuenta no se distingue de uno real hasta que alguien lo busca.
 *
 * Con el mapa vacío, el handler falla la fila con `provider_unavailable` y un
 * mensaje seguro de mostrar. **Eso sí es honesto**: el usuario programó algo,
 * llegó la hora, y se le dice que publicar no está disponible. La alternativa
 * —no registrar el handler— deja el post en `SCHEDULED` para siempre sin que
 * nada falle, que es exactamente el modo de falla que este worker existe para
 * cerrar.
 */
const PUBLISHERS: Readonly<Record<string, SocialPublisher>> = {};

/**
 * Los handlers, en **un solo lugar**.
 *
 * El mapa existe para que la lista de colas que sí se consumen no se escriba
 * dos veces: una al registrar y otra al reportar. Lo tenía duplicado y lo
 * encontré rompiéndolo a propósito — con el `work()` apuntando a otra cola, el
 * log seguía diciendo que `content-build` tenía handler. Un reporte de arranque
 * que miente sobre esto es peor que no tenerlo, porque es exactamente donde uno
 * va a mirar cuando una pieza se quede en `BUILDING`.
 */
export function createHandlers(deps: WorkerHandlerDeps): WorkerHandlers {
  const { db, renderer, storage, clock, appRole, logger } = deps;

  const handlers: Record<string, JobHandler<unknown>> = {
    [JOB_QUEUES.contentBuild]: createContentBuildHandler({
      db,
      renderer,
      storage,
      clock,
      appRole,
      logger,
    }),
    /**
     * **Con el MISMO `renderer` que `content-build`, no con el de
     * normalización.** Un rebuild es el mismo render con otra revisión: con otro
     * motor, una edición que no cambia nada produciría una pieza que se ve
     * distinta. Hoy es el de memoria, así que el rebuild que llega a renderizar
     * deja un artefacto sintético igual que el build; el día que `content-build`
     * pase a `services/render`, éste pasa con él sin tocar esta línea.
     *
     * Montarlo no es opcional desde que la API encola acá: sin handler, cada
     * edición dejaría la pieza en `BUILDING` para siempre, sin fallar.
     */
    [JOB_QUEUES.contentRebuild]: createContentRebuildHandler({
      db,
      renderer,
      storage,
      clock,
      appRole,
      logger,
    }),
    [JOB_QUEUES.publishing]: createPublishHandler({
      db,
      publishers: PUBLISHERS,
      clock,
      appRole,
      logger,
    }),
    /**
     * **Sin generador, y por eso mismo hay que montarlo.**
     *
     * No hay adaptador de `MediaGeneration`: el pipeline de `FR-080` son 15–20
     * minutos de GPU contra un proveedor que todavía no se eligió. Pero
     * `POST /influencers` **ya cobra 250 créditos**, así que no registrar el
     * handler deja al personaje en `generating_variations` para siempre y al
     * cargo sin devolver — el mismo agujero que el content save tuvo hasta hace
     * dos tandas. Con el handler montado y sin generador, el personaje se cierra
     * como `failed` y los 250 vuelven.
     */
    [JOB_QUEUES.influencerPipeline]: createInfluencerPipelineHandler({
      db,
      clock,
      appRole,
      logger,
    }),
    /**
     * `discovery-refill` — lo encola `POST /blitz` con la cola vacía, un job por
     * workspace por minuto.
     *
     * Rellena con sugerencias **construibles** (media del Media Bank + copy del
     * LLM, `AI-002`). Sin LLM se monta igual y no escribe nada —una sugerencia
     * sin copy no se puede construir— y el arranque lo dice en `unmounted`.
     */
    [JOB_QUEUES.discoveryRefill]: createDiscoveryRefillHandler({
      db,
      // `systemRng` y no uno sembrado: la instancia se comparte entre entregas
      // concurrentes, así que un `SeededRng` acá no daría el determinismo que
      // promete — daría una secuencia compartida y entrelazada.
      rng: systemRng,
      copywriter: deps.copywriter,
      appRole,
      logger,
    }),
    /**
     * **El primer trabajo programado que de verdad hace algo cada noche.**
     *
     * El dominio sabía decidir la staleness desde hace tandas y nadie la
     * aplicaba: sin handler, el bloque de abajo no programaba su cron, así que
     * ninguna fuente envejecía nunca. Montarlo es lo que enciende el cron.
     */
    [JOB_QUEUES.brandSourceStalenessSweep]: createBrandStalenessHandler({
      db,
      clock,
      appRole,
      logger,
    }),
    /**
     * **Una obligación de retención, no una optimización** (`DATA-032`, §9.14).
     *
     * Montarlo es lo que enciende su cron: el bloque de abajo sólo programa las
     * colas con handler. Hoy **nada escribe snapshots** —el análisis de brand
     * sources todavía no persiste `brand_source_snapshots`—, así que cada noche
     * va a purgar cero. Se monta igual: el día que aparezca el productor, la
     * retención ya se está cumpliendo en vez de quedar como tarea pendiente.
     */
    [JOB_QUEUES.snapshotPurge]: createSnapshotPurgeHandler({
      db,
      clock,
      appRole,
      logger,
    }),
    [JOB_QUEUES.quotaReset]: createQuotaResetHandler({
      db,
      clock,
      appRole,
      logger,
    }),
  };

  /*
   * `media-normalization` — **montado sólo si el servicio de render está
   * configurado**, y con su **propio** renderer.
   *
   * Con el `MemoryMediaRenderer` de `content-build` no se puede: `probe`
   * responde `not_found` para toda URL que no se le sembró —o sea, para todo
   * upload real— y el handler marcaría **cada video del usuario `failed`** con
   * `media_unreadable`. Eso es mentir en sus datos: el archivo está bien, lo
   * que falta es el motor. La trampa 30 dice que se monta sin proveedor *si lo
   * que escribe es verdad*, y esto no lo sería.
   *
   * Con un `HttpMediaRenderer` aparte sí: `probe`/`normalize` no necesitan las
   * fuentes que bloquean `content-build` en `P2-RENDER-015`. Y es **otra
   * instancia**, no el mismo `renderer`: cambiar el de `content-build` rompería
   * todos los builds por esas fuentes.
   *
   * Sin configuración, el video queda `processing`, que **sí** es verdad (no
   * está normalizado), y los jobs esperan en la cola a que aparezca un
   * consumidor. Por eso va en `unmounted` y el arranque lo dice.
   */
  const unmounted: UnmountedQueue[] = [];
  if (deps.copywriter === null) {
    // Montado, pero inerte: va en la lista para que el arranque lo diga con
    // las variables que faltan.
    unmounted.push({ queue: JOB_QUEUES.discoveryRefill, why: REFILL_WITHOUT_LLM_WHY });
  }
  if (deps.normalizationRenderer === null) {
    unmounted.push({
      queue: JOB_QUEUES.mediaNormalization,
      why: NORMALIZATION_UNMOUNTED_WHY,
    });
  } else {
    handlers[JOB_QUEUES.mediaNormalization] = createMediaNormalizationHandler({
      db,
      renderer: deps.normalizationRenderer,
      storage,
      clock,
      appRole,
      logger,
    });
  }

  /*
   * `brand-source-analysis` — **montado sólo con extractor de web, LLM y
   * retención configurados**.
   *
   * La nota de `P1-BRAND-006` en `tasks.md` explica por qué no se montó sin
   * extractor: ningún motivo del enum era verdad. Con `WebsiteReader` sí hay
   * verdades para escribir, y las plataformas sin extractor terminan en
   * `failed`/`unsupported_platform` (ver la cabecera del handler).
   *
   * Pero con cualquiera de las tres piezas ausente, lo que escribiría sería
   * falso: sin extractor de web, **una web** terminaría `unsupported_platform`
   * —esta instalación sí la soporta, sólo no está configurada—; sin LLM, cada
   * fuente fallaría por algo que no es de la fuente; sin retención, cada
   * snapshot guardaría material de terceros sin fecha de purga. Sin montar, la
   * fuente queda `pending`, que es verdad: nadie la analizó.
   */
  if (deps.brandAnalysis.kind === "mounted") {
    handlers[JOB_QUEUES.brandSourceAnalysis] = createBrandSourceAnalysisHandler({
      db,
      readers: deps.brandAnalysis.readers,
      synthesizer: deps.brandAnalysis.synthesizer,
      rawRetentionDays: deps.brandAnalysis.rawRetentionDays,
      clock,
      appRole,
      logger,
    });
  } else {
    unmounted.push({
      queue: JOB_QUEUES.brandSourceAnalysis,
      why: brandAnalysisUnmountedWhy(deps.brandAnalysis.missing),
    });
  }

  return { handlers, unmounted };
}
