import {
  AUTOPILOT_SWEEP_CRON,
  AUTOMATION_BUILD_SWEEP_CRON,
  ENGAGEMENT_CRONS,
  JOB_QUEUES,
  METRICS_SYNC_CRON,
  type JobQueueName,
} from "@fastgram/core";

/**
 * Catálogo de jobs — PRD §9.5.
 *
 * El PRD enumera 21 trabajos asíncronos. Este archivo los declara con su
 * política, en un solo lugar, por una razón concreta: **los plazos son muy
 * distintos entre sí y no se parecen a un default razonable.** El watcher del
 * carril lento de TikTok reintenta hasta **72 horas**; un build de contenido
 * que no termina en minutos está roto. Con una política única, o se abandona
 * al de TikTok a las pocas horas —y el post se pierde sin que nadie se
 * entere— o se deja a los builds reintentando un día entero contra un fallo
 * permanente.
 *
 * Estas políticas son la especificación, no la implementación: el adaptador
 * de `Queue` las traduce a lo que su motor entienda.
 *
 * **Los nombres no viven acá.** Vienen de `JOB_QUEUES` en `@fastgram/core`,
 * porque el nombre es contrato con el productor —que es la API, otro proceso—
 * y un literal escrito de los dos lados ya había divergido una vez
 * (`build-content` contra `content-build`). Lo que sí vive acá es la política,
 * que es asunto del consumidor.
 */

/** Cómo espaciar los reintentos. */
export type BackoffKind =
  /** Mismo intervalo siempre. Para trabajo periódico. */
  | "fixed"
  /** Duplica el intervalo. Para fallos de proveedor. */
  | "exponential";

export interface JobPolicy {
  /** Nombre en la cola. Es contrato entre productor y consumidor. */
  readonly name: JobQueueName;
  /** Qué hace, en una línea. */
  readonly what: string;
  /** Dónde lo especifica el PRD. */
  readonly prd: string;
  /**
   * Intentos totales, incluido el primero. `1` = sin reintentos.
   *
   * Un job **no idempotente** no puede tener más de 1: reintentarlo duplicaría
   * el efecto. Los que publican en una red social son el caso peligroso, y por
   * eso `idempotent` es un campo y no una suposición.
   */
  readonly maxAttempts: number;
  readonly backoff: BackoffKind;
  /** Espera antes del primer reintento. */
  readonly retryDelaySeconds: number;
  /**
   * Cuánto puede durar un intento antes de darlo por colgado.
   *
   * Salen de los plazos que el PRD declara, con margen: *"30 s – 2 min"* para
   * un build, *"15–20 minutos"* para el pipeline de influencer.
   */
  readonly timeoutSeconds: number;
  /** Cuántos pueden correr a la vez. `null` = sin tope propio. */
  readonly concurrency: number | null;
  /**
   * Si reejecutarlo con el mismo payload produce el mismo resultado.
   *
   * **Un job con `idempotent: false` y `maxAttempts > 1` es un bug**, y hay un
   * test que lo verifica sobre todo el catálogo. Es el chequeo que evita que
   * un reintento publique dos veces el mismo post.
   */
  readonly idempotent: boolean;
  /** Si lo dispara un cron en vez de un evento. */
  readonly scheduled?: { readonly cron: string; readonly why: string };
}

/**
 * Los 21 jobs del PRD §9.5, en su orden.
 *
 * Están todos, incluso los que todavía no tienen handler: la lista completa
 * dice qué falta construir mejor que una lista de lo ya hecho.
 */
export const JOB_CATALOG = {
  websiteAnalysis: {
    name: JOB_QUEUES.websiteAnalysis,
    what: "Scraping + LLM → Company Profile, en el alta.",
    prd: "§9.5.1, FR-010",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 30,
    timeoutSeconds: 180,
    concurrency: null,
    idempotent: true,
  },
  discoveryRefill: {
    name: JOB_QUEUES.discoveryRefill,
    what: "Mantiene ~5 sugerencias en la cola de Blitz.",
    prd: "§9.5.2, AI-002",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 10,
    timeoutSeconds: 120,
    // El PRD dice que los refills son concurrentes y pueden exceder el
    // objetivo transitoriamente. No se serializa a propósito: una cola vacía
    // es peor experiencia que una cola de 7.
    concurrency: null,
    idempotent: true,
  },
  contentBuild: {
    name: JOB_QUEUES.contentBuild,
    what: "Compone imágenes, renderiza video, dibuja overlays y sube a storage.",
    prd: "§9.5.3, FR-050",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 15,
    // El PRD dice 30 s – 2 min. 5 min es margen para un video largo; más que
    // eso es un cuelgue, y conviene fallar y **reembolsar** el save antes que
    // dejar al usuario mirando un spinner.
    timeoutSeconds: 300,
    concurrency: null,
    idempotent: true,
  },
  contentRebuild: {
    name: JOB_QUEUES.contentRebuild,
    what: "Reconstruye tras una edición o una regeneración.",
    prd: "§9.5.4, FR-051",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 15,
    timeoutSeconds: 300,
    concurrency: null,
    idempotent: true,
  },
  influencerPipeline: {
    name: JOB_QUEUES.influencerPipeline,
    what: "Genera variaciones y entrena el LoRA del personaje. Reporta progress.",
    prd: "§9.5.5, FR-080",
    // Sólo 2 intentos: cuesta 250 créditos y 15–20 minutos de GPU, que es el
    // driver de costo #1 del producto (COST-MODEL §6). Reintentar tres veces
    // un fallo permanente quema una hora de GPU para llegar al mismo error.
    maxAttempts: 2,
    backoff: "exponential",
    retryDelaySeconds: 120,
    // El PRD dice 15–20 min. 45 cubre un proveedor lento sin colgarse un día.
    timeoutSeconds: 2_700,
    concurrency: null,
    idempotent: true,
  },
  aiStudioGeneration: {
    name: JOB_QUEUES.aiStudioGeneration,
    what: "Genera imágenes o video de AI Studio.",
    prd: "§9.5.6, FR-090",
    maxAttempts: 2,
    backoff: "exponential",
    retryDelaySeconds: 30,
    timeoutSeconds: 600,
    // El PRD fija 10 en vuelo POR WORKSPACE. Este número es el tope global del
    // worker; el de workspace lo aplica `core` antes de encolar, porque acá no
    // se sabe de quién es el job.
    concurrency: 10,
    idempotent: true,
  },
  mediaNormalization: {
    name: JOB_QUEUES.mediaNormalization,
    what: "MOV→MP4, HDR→SDR, faststart.",
    prd: "§9.5.7, NFR-014",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 20,
    timeoutSeconds: 600,
    concurrency: null,
    idempotent: true,
  },
  publishing: {
    name: JOB_QUEUES.publishing,
    what: "Ejecuta el post a la hora programada.",
    prd: "§9.5.8, FR-060",
    // UNO SOLO. Publicar no es idempotente del lado de la plataforma: un
    // reintento a ciegas puede dejar dos posts en la cuenta del usuario, y eso
    // no se deshace desde acá. Un fallo marca el post como fallido y se lo
    // muestra; reintentar es decisión de una persona.
    maxAttempts: 1,
    backoff: "fixed",
    retryDelaySeconds: 0,
    timeoutSeconds: 300,
    concurrency: null,
    idempotent: false,
  },
  tiktokSlowLaneWatcher: {
    name: JOB_QUEUES.tiktokSlowLaneWatcher,
    what: "Vigila un post en el carril lento de TikTok hasta que aparece.",
    prd: "§9.5.9, INT-001",
    // El PRD: hasta 72 HORAS. TikTok puede tardar 24–48 h en publicar del
    // carril lento. Abandonar antes deja el post en limbo sin que nadie se
    // entere. 72 h a 30 min por intento son 144 intentos.
    maxAttempts: 144,
    backoff: "fixed",
    retryDelaySeconds: 1_800,
    timeoutSeconds: 60,
    concurrency: null,
    idempotent: true,
  },
  /**
   * `PU-AUTO-004`: `{}` es el barrido del cron (encola una corrida por marca
   * con clave por hora) y `{companyId}` la corrida de una marca (sync de los
   * posts debidos + auto-tune semanal del mix si está prendido). Idempotente:
   * reescribir métricas con lo último que dio la plataforma no duplica nada.
   */
  metricsSync: {
    name: JOB_QUEUES.metricsSync,
    what: "Refresca views, likes, comments y shares por post y ajusta el mix si la marca lo pidió.",
    prd: "§9.5.10, FR-120, PU-AUTO-004",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 300,
    timeoutSeconds: 120,
    concurrency: null,
    idempotent: true,
    scheduled: {
      cron: METRICS_SYNC_CRON,
      why:
        "Cada hora porque los posts de menos de 48 h se leen cada hora (es cuando " +
        "el número cambia); los más viejos, cada 24 h, y la política vive en " +
        "`core` (`isMetricsSyncDue`), no en el cron. A los 7 minutos para no " +
        "caer en la hora en punto con el resto de los barridos.",
    },
  },
  /**
   * Reusada por el piloto automático (`PU-AUTO-001/002`): `{}` es el barrido
   * del cron y `{companyId}` la corrida de una marca (relleno de la cola al
   * objetivo de su estrategia + pre-chequeo y aprobación si está en piloto).
   * Idempotente por convergencia (el relleno lleva la cola a N) y por el
   * `UNIQUE (suggestion_id)` de `autopilot_decisions`.
   *
   * 900 s y no 600: una corrida puede rellenar hasta 30 sugerencias (una
   * llamada al LLM cada una) y juzgar hasta 6 con timeout duro de 30 s, y con
   * un modelo local de 7B eso son minutos.
   */
  automationGeneration: {
    name: JOB_QUEUES.automationGeneration,
    what: "Piloto automático: barrido de marcas, cola de Blitz al objetivo de la estrategia y aprobación con pre-chequeo.",
    prd: "§9.5.11, FR-150, PU-AUTO-001/002",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 30,
    timeoutSeconds: 900,
    concurrency: null,
    idempotent: true,
    scheduled: {
      cron: AUTOPILOT_SWEEP_CRON,
      why:
        "La cola de cada marca tiene que estar llena antes de que el piloto o " +
        "el humano la necesiten, sin que nadie abra Blitz. Cada 15 min: el " +
        "barrido sólo encola una corrida por marca (con clave por ventana), y " +
        "la corrida no hace nada si la cola ya está en el objetivo.",
    },
  },
  /**
   * `{companyId, automationId}` lo encola el launch y se re-arma cada minuto
   * mientras la campaña esté `BUILDING`; `{}` es el barrido del cron, la red
   * por si una cadena se corta y lo que cierra las campañas `ACTIVE`
   * (`automations/build-schedule-handler.ts`). Idempotente por convergencia:
   * mira el estado de cada pieza y mueve lo que haya que mover.
   */
  automationBuildSchedule: {
    name: JOB_QUEUES.automationBuildSchedule,
    what: "Mira los builds de las campañas lanzadas: slots SCHEDULED/FAILED, campaña ACTIVE/COMPLETED.",
    prd: "§9.5.12, FR-150",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 30,
    timeoutSeconds: 900,
    concurrency: null,
    idempotent: true,
    scheduled: {
      cron: AUTOMATION_BUILD_SWEEP_CRON,
      why:
        "Una campaña lanzada se sigue sola (el job se re-arma), pero un worker " +
        "reiniciado corta la cadena y nada cerraría las campañas ACTIVE. Cada " +
        "5 min: barrido de las campañas BUILDING/ACTIVE de todas las marcas.",
    },
  },
  redditLeadDiscovery: {
    name: JOB_QUEUES.redditLeadDiscovery,
    what: "Descubre leads en los subreddits configurados.",
    prd: "§9.5.13, FR-140",
    maxAttempts: 5,
    // El PRD pide backoff explícito ante rate limit: Reddit corta seguido.
    backoff: "exponential",
    retryDelaySeconds: 60,
    // 600 s: una corrida son ≤ 25 llamadas a Reddit con 1 s entre cada una y
    // hasta 15 juicios de un LLM local. También lleva la generación del
    // borrador (`kind: "reply"`, ver `core/engagement/jobs.ts`).
    timeoutSeconds: 600,
    concurrency: null,
    idempotent: true,
    scheduled: {
      cron: ENGAGEMENT_CRONS.discovery,
      why:
        "F-191: descubrimiento periódico. Cada hora: con ≤ 10 subreddits son ≤ 25 " +
        "llamadas por marca, lejos del límite documentado (60/min). El barrido sólo " +
        "encola una corrida por marca con cuenta de Reddit activa, con clave por hora.",
    },
  },
  redditThreadMonitoring: {
    name: JOB_QUEUES.redditThreadMonitoring,
    what: "Verifica el estado de los hilos en los que se respondió.",
    prd: "§9.5.14, FR-140",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 300,
    timeoutSeconds: 120,
    concurrency: null,
    idempotent: true,
    scheduled: {
      cron: ENGAGEMENT_CRONS.threadMonitoring,
      why:
        "F-198: seguir los hilos respondidos en los últimos 7 días (hasta 20 por " +
        "marca). Cada 2 h alcanza para ver respuestas y comentarios filtrados.",
    },
  },
  banRiskComputation: {
    name: JOB_QUEUES.banRiskComputation,
    what: "Recalcula el nivel de riesgo de baneo.",
    prd: "§9.5.15, FR-140",
    maxAttempts: 2,
    backoff: "fixed",
    retryDelaySeconds: 120,
    // 300 s y no 60: etiquetar hasta 20 respuestas con un LLM local (JV-5).
    timeoutSeconds: 300,
    concurrency: null,
    idempotent: true,
    scheduled: {
      cron: ENGAGEMENT_CRONS.banRisk,
      why:
        "DP-003: la ventana de 30 días se mueve aunque nadie envíe nada. Una vez " +
        "por día recalcula el nivel (en código) y etiqueta lo que quedó sin tono.",
    },
  },
  warmedAccountProvisioning: {
    name: JOB_QUEUES.warmedAccountProvisioning,
    what: "Orquesta la provisión con el proveedor o el equipo humano.",
    prd: "§9.5.16, FR-130",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 600,
    timeoutSeconds: 300,
    concurrency: null,
    idempotent: true,
  },
  quotaReset: {
    name: JOB_QUEUES.quotaReset,
    what: "Barrido de contadores vencidos.",
    prd: "§9.5.17, §16.2",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 60,
    timeoutSeconds: 300,
    concurrency: null,
    idempotent: true,
    scheduled: {
      cron: "0 0 * * *",
      why:
        "Red, no mecanismo. El reset real se calcula en lectura contra el " +
        "reloj (`core/quota/reset.ts`), porque si dependiera de este cron la " +
        "cuota de un cliente dependería de que el cron haya corrido. Esto " +
        "sólo limpia contadores de cuentas inactivas que nadie consultó.",
    },
  },
  brandSourceAnalysis: {
    name: JOB_QUEUES.brandSourceAnalysis,
    what: "Resuelve el tier, recoge señales, corre OCR y sintetiza con LLM.",
    prd: "§9.5.18, §9.14, AI-016",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 60,
    timeoutSeconds: 900,
    concurrency: null,
    idempotent: true,
  },
  brandSourceStalenessSweep: {
    name: JOB_QUEUES.brandSourceStalenessSweep,
    what: "Marca `stale` los snapshots de más de 90 días.",
    prd: "§9.5.19, §9.14",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 300,
    timeoutSeconds: 300,
    concurrency: null,
    idempotent: true,
    scheduled: {
      cron: "0 3 * * *",
      why:
        "De madrugada porque marcar `stale` le dispara al usuario la " +
        "propuesta de `Re-analyse`, y ese re-análisis compite por la misma " +
        "capacidad de LLM y OCR que las altas en curso. En hora pico, el " +
        "barrido le agregaría cola al alta de alguien que está esperando.",
    },
  },
  snapshotPurge: {
    name: JOB_QUEUES.snapshotPurge,
    what: "Borra el material crudo al vencer `rawRetentionExpiresAt`.",
    prd: "§9.5.20, §9.14",
    maxAttempts: 5,
    backoff: "exponential",
    retryDelaySeconds: 300,
    timeoutSeconds: 600,
    concurrency: null,
    idempotent: true,
    scheduled: {
      cron: "0 4 * * *",
      why:
        "Es una obligación de retención, no una optimización: si falla hay " +
        "que reintentarlo, no saltearlo. Por eso 5 intentos y no 3.",
    },
  },
  ownPostImport: {
    name: JOB_QUEUES.ownPostImport,
    what: "Importa los posts propios del usuario al Media Bank (opt-in).",
    prd: "§9.5.21, FR-011.5.1",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 120,
    timeoutSeconds: 900,
    concurrency: null,
    idempotent: true,
  },
  /**
   * `PU-MEDIA-002` — no está en §9.5: sale del plan de uso personal (una marca
   * nueva sin media no puede usar Blitz). Idempotente por construcción: las
   * claves de storage son deterministas por semilla y el handler sólo genera
   * las piezas que todavía no tienen fila (`apps/worker/src/brand-kit`).
   */
  brandBackgrounds: {
    name: JOB_QUEUES.brandBackgrounds,
    what: "Genera fondos de marca (imágenes y loops) en services/render y los suma al Media Bank.",
    prd: "PLAN-USO-PERSONAL §2 paso 3, PU-MEDIA-002 (fuera de §9.5)",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 30,
    // Ocho imágenes (~0,3 s c/u) y tres loops de 8 s (~4 s c/u) medidos en una
    // M-series; diez minutos es margen para una máquina lenta o cargada.
    timeoutSeconds: 600,
    // Encodear video es CPU pura: uno a la vez no le quita el render a los builds.
    concurrency: 1,
    idempotent: true,
  },
  /**
   * `PU-MEME-001`/`002`/`003` — no está en §9.5: sale del plan de uso personal
   * (D-12). Idempotente: el `mediaId` viene en el payload, así que un
   * reintento encuentra la fila ya creada y no duplica el clip.
   */
  mediaImport: {
    name: JOB_QUEUES.mediaImport,
    what: "Baja un video o audio por link con yt-dlp, lo sube al Media Bank, lo etiqueta y recorta su fondo.",
    prd: "PLAN-USO-PERSONAL §6 D-12, PU-MEME-001 (fuera de §9.5)",
    // Dos intentos: un sitio caído a veces vuelve, pero un link roto no, y
    // cada intento puede pagar un recorte en fal.
    maxAttempts: 2,
    backoff: "exponential",
    retryDelaySeconds: 30,
    // Bajada con tope duro de 5 min (`MEDIA_IMPORT_TIMEOUT_MS`) + el recorte
    // en fal, que encola del lado de ellos. 20 min es el techo de todo junto.
    timeoutSeconds: 1_200,
    // yt-dlp y FFmpeg son CPU y red; y el índice de metadata por marca se
    // escribe desde acá: uno a la vez.
    concurrency: 1,
    idempotent: true,
  },
  /**
   * `PU-PUB-008` / `P3-PUB-002` — no está en §9.5 como job propio: el PRD pone
   * la reanudación de `AWAITING_RECONNECT` dentro del job de publicación
   * (§9.5.8), y los slots planificados salen del plan de uso personal.
   * Idempotente: reanudar un post que ya no está en `AWAITING_RECONNECT` o
   * convertir un slot que ya no está `planned` no hace nada (los dos se
   * deciden con la fila bloqueada o con un `UPDATE … WHERE status = …`).
   */
  publishingSweep: {
    name: JOB_QUEUES.publishingSweep,
    what: "Reanuda los posts en AWAITING_RECONNECT y convierte slots planificados en posts, por marca.",
    prd: "FR-060 AWAITING_RECONNECT, NFR-015, PU-PUB-008 (fuera de §9.5)",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 60,
    timeoutSeconds: 300,
    concurrency: 1,
    idempotent: true,
  },
} as const satisfies Record<string, JobPolicy>;

export type JobKey = keyof typeof JOB_CATALOG;
export type JobName = (typeof JOB_CATALOG)[JobKey]["name"];

/**
 * Cuánto esperar antes del intento `attempt` (1 = el primero, sin espera).
 *
 * El tope de 1 hora evita que un backoff exponencial con muchos intentos
 * termine programando el siguiente para dentro de varios días.
 */
export function retryDelaySeconds(policy: JobPolicy, attempt: number): number {
  if (attempt <= 1) return 0;
  if (policy.backoff === "fixed") return policy.retryDelaySeconds;
  const exponential = policy.retryDelaySeconds * 2 ** (attempt - 2);
  return Math.min(exponential, 3_600);
}

/** Cuánto puede tardar en total antes de agotar los intentos. */
export function maxLifetimeSeconds(policy: JobPolicy): number {
  let total = 0;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    total += retryDelaySeconds(policy, attempt) + policy.timeoutSeconds;
  }
  return total;
}
