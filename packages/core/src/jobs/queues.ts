/**
 * Nombres de cola — PRD §9.5, los 21 trabajos asíncronos.
 *
 * ## Por qué están acá y no sólo en el catálogo del worker
 *
 * El nombre de la cola es **contrato entre productor y consumidor**, y el
 * productor y el consumidor viven en procesos distintos: la API encola, el
 * worker consume. `apps/worker/src/jobs/catalog.ts` los tenía, pero un
 * paquete de `apps/` no es importable desde otra app, así que cada ruta que
 * encolaba escribía su propio literal.
 *
 * Eso ya había divergido, y no en teoría: `core` encolaba en `"build-content"`
 * mientras el catálogo escucha `"content-build"`. Dos strings parecidos, los
 * dos plausibles, y el efecto es que **el job entra en una cola que nadie
 * lee**. No falla nada: el POST devuelve 201, el contenido queda en
 * `BUILDING`, y se queda ahí para siempre. Es el peor modo de falla que hay,
 * porque ni siquiera aparece en un log de errores.
 *
 * Tres rutas escritas en paralelo inventaron cada una su literal
 * (`build-content`, `publish-post`, `influencer-pipeline`), y una de las tres
 * coincidió con el catálogo por casualidad.
 *
 * ## La regla
 *
 * **Nadie escribe un nombre de cola a mano.** Ni las rutas, ni el catálogo, ni
 * el worker. El catálogo de `apps/worker` sigue siendo el dueño de la
 * *política* —reintentos, timeouts, concurrencia, que son cosas del consumidor—
 * pero toma los nombres de acá. Hay un invariante en `scripts/check-consistency.mjs`
 * que compara las dos listas.
 */

export const JOB_QUEUES = {
  /** `FR-010` — análisis del sitio en el onboarding. */
  websiteAnalysis: "website-analysis",
  /** `FR-030` — rellenar la cola de discovery. */
  discoveryRefill: "discovery-refill",
  /** `FR-050` — construir una pieza nueva. */
  contentBuild: "content-build",
  /** `FR-051` — rehacer una pieza editada. Mismo `_id`, `revision` + 1. */
  contentRebuild: "content-rebuild",
  /** `FR-080` — pipeline de creación de influencer (incluye el LoRA). */
  influencerPipeline: "influencer-pipeline",
  /** `FR-090` — generación de AI Studio. */
  aiStudioGeneration: "ai-studio-generation",
  /** `FR-100` — normalización de un video subido. */
  mediaNormalization: "media-normalization",
  /** `FR-060` — publicar. **No idempotente**: `maxAttempts` 1. */
  publishing: "publishing",
  /** `NFR-015` — carril lento de TikTok, hasta 72 h. */
  tiktokSlowLaneWatcher: "tiktok-slow-lane-watcher",
  /** `FR-110` — traer métricas de los posts publicados. */
  metricsSync: "metrics-sync",
  automationGeneration: "automation-generation",
  automationBuildSchedule: "automation-build-schedule",
  redditLeadDiscovery: "reddit-lead-discovery",
  redditThreadMonitoring: "reddit-thread-monitoring",
  banRiskComputation: "ban-risk-computation",
  warmedAccountProvisioning: "warmed-account-provisioning",
  /** §16.2 — reset en el día ancla de facturación, no el 1 del mes. */
  quotaReset: "quota-reset",
  /** `EXT-001` — análisis de una brand source. */
  brandSourceAnalysis: "brand-source-analysis",
  brandSourceStalenessSweep: "brand-source-staleness-sweep",
  snapshotPurge: "snapshot-purge",
  ownPostImport: "own-post-import",
  /**
   * `PU-MEDIA-002` — fondos de marca generados por `services/render` (sin
   * proveedor) para que una marca sin media pueda usar Blitz. No es de §9.5:
   * es del plan de uso personal.
   */
  brandBackgrounds: "brand-backgrounds",
  /**
   * `PU-MEME-001` — importar un video o un audio por link con `yt-dlp`, más el
   * recorte de fondo y el etiquetado (`PU-MEME-002`, `PU-MEME-003`). Del plan
   * de uso personal (D-12), no de §9.5.
   */
  mediaImport: "media-import",
  /**
   * `PU-PUB-008` / `P3-PUB-002` — por marca: reanuda los posts en
   * `AWAITING_RECONNECT` cuando la conexión vuelve y convierte los slots
   * planificados en posts cuando la marca ya tiene la conexión. Del plan de
   * uso personal, no de §9.5.
   */
  publishingSweep: "publishing-sweep",
} as const;

export type JobQueueKey = keyof typeof JOB_QUEUES;
export type JobQueueName = (typeof JOB_QUEUES)[JobQueueKey];

/** Las 21, para registrarlas al arrancar: encolar exige la cola preexistente. */
export const ALL_JOB_QUEUES: readonly JobQueueName[] = Object.values(JOB_QUEUES);
