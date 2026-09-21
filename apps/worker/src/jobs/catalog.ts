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
 */

/** Cómo espaciar los reintentos. */
export type BackoffKind =
  /** Mismo intervalo siempre. Para trabajo periódico. */
  | "fixed"
  /** Duplica el intervalo. Para fallos de proveedor. */
  | "exponential";

export interface JobPolicy {
  /** Nombre en la cola. Es contrato entre productor y consumidor. */
  readonly name: string;
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
    name: "website-analysis",
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
    name: "discovery-refill",
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
    name: "content-build",
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
    name: "content-rebuild",
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
    name: "influencer-pipeline",
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
    name: "ai-studio-generation",
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
    name: "media-normalization",
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
    name: "publishing",
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
    name: "tiktok-slow-lane-watcher",
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
  metricsSync: {
    name: "metrics-sync",
    what: "Refresca views, likes y comments por post.",
    prd: "§9.5.10, FR-120",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 300,
    timeoutSeconds: 120,
    concurrency: null,
    idempotent: true,
  },
  automationGeneration: {
    name: "automation-generation",
    what: "Genera los slots de una automation.",
    prd: "§9.5.11, FR-150",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 30,
    timeoutSeconds: 600,
    concurrency: null,
    idempotent: true,
  },
  automationBuildSchedule: {
    name: "automation-build-schedule",
    what: "Construye y programa los slots tras el launch.",
    prd: "§9.5.12, FR-150",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 30,
    timeoutSeconds: 900,
    concurrency: null,
    idempotent: true,
  },
  redditLeadDiscovery: {
    name: "reddit-lead-discovery",
    what: "Descubre leads en los subreddits configurados.",
    prd: "§9.5.13, FR-140",
    maxAttempts: 5,
    // El PRD pide backoff explícito ante rate limit: Reddit corta seguido.
    backoff: "exponential",
    retryDelaySeconds: 60,
    timeoutSeconds: 300,
    concurrency: null,
    idempotent: true,
  },
  redditThreadMonitoring: {
    name: "reddit-thread-monitoring",
    what: "Verifica el estado de los hilos en los que se respondió.",
    prd: "§9.5.14, FR-140",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 300,
    timeoutSeconds: 120,
    concurrency: null,
    idempotent: true,
  },
  banRiskComputation: {
    name: "ban-risk-computation",
    what: "Recalcula el nivel de riesgo de baneo.",
    prd: "§9.5.15, FR-140",
    maxAttempts: 2,
    backoff: "fixed",
    retryDelaySeconds: 120,
    timeoutSeconds: 60,
    concurrency: null,
    idempotent: true,
  },
  warmedAccountProvisioning: {
    name: "warmed-account-provisioning",
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
    name: "quota-reset",
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
    name: "brand-source-analysis",
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
    name: "brand-source-staleness-sweep",
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
    name: "snapshot-purge",
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
    name: "own-post-import",
    what: "Importa los posts propios del usuario al Media Bank (opt-in).",
    prd: "§9.5.21, FR-011.5.1",
    maxAttempts: 3,
    backoff: "exponential",
    retryDelaySeconds: 120,
    timeoutSeconds: 900,
    concurrency: null,
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
