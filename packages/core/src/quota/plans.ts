/**
 * Catálogo de planes — PRD §16.1 y §16.2.
 *
 * El PRD advierte, arriba de la sección: *"Todos los precios y límites de esta
 * sección están tomados literalmente de la página de precios oficial. No se ha
 * inventado ningún valor."* Acá se conservan tal cual. Cambiar un número de
 * este archivo sin cambiar el PRD rompe un test a propósito.
 *
 * `null` significa **ilimitado**, no "sin definir". Lo que no se sabe está
 * marcado con `UNKNOWN_*` y explicado.
 */

export const PLAN_IDS = ["free", "starter", "growth", "pro"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanLimits {
  /** Precio mensual en centavos de USD. */
  readonly monthlyPriceCents: number;
  /** Content saves por período. `null` = ilimitado (Pro). */
  readonly contentSaves: number | null;
  /** Créditos de AI Studio por mes. */
  readonly aiStudioCredits: number;
  readonly workspaces: number;
  /** Personajes de AI UGC. `null` = ilimitado. */
  readonly aiUgcCharacters: number | null;
  /** Videos de UGC humano incluidos. 0 = no incluye. */
  readonly humanUgcVideos: number;
  readonly unlimitedSocials: boolean;
  readonly unlimitedScheduling: boolean;
  readonly multiLanguageContent: boolean;
}

export const PLANS: Readonly<Record<PlanId, PlanLimits>> = {
  free: {
    monthlyPriceCents: 0,
    // El PRD dice "Limited content" sin dar el número. No se inventa: se usa
    // el trial allowance de por vida, que sí está especificado como
    // mecanismo. El número concreto está en UNKNOWN_FREE_CONTENT_SAVES.
    contentSaves: 0,
    aiStudioCredits: 10,
    workspaces: 1,
    aiUgcCharacters: 0,
    humanUgcVideos: 0,
    unlimitedSocials: false,
    unlimitedScheduling: false,
    multiLanguageContent: false,
  },
  starter: {
    monthlyPriceCents: 2_900,
    contentSaves: 20,
    aiStudioCredits: 250,
    workspaces: 1,
    aiUgcCharacters: 25,
    humanUgcVideos: 0,
    unlimitedSocials: false,
    unlimitedScheduling: false,
    multiLanguageContent: false,
  },
  growth: {
    monthlyPriceCents: 4_900,
    contentSaves: 100,
    aiStudioCredits: 500,
    workspaces: 3,
    // El PRD dice "500+". Se toma 500 como piso garantizado: prometer de menos
    // y cumplir de más es recuperable; al revés es un incumplimiento.
    aiUgcCharacters: 500,
    humanUgcVideos: 100,
    unlimitedSocials: true,
    unlimitedScheduling: false,
    multiLanguageContent: false,
  },
  pro: {
    monthlyPriceCents: 14_900,
    contentSaves: null,
    aiStudioCredits: 2_000,
    workspaces: 10,
    aiUgcCharacters: 2_000,
    humanUgcVideos: 2_000,
    unlimitedSocials: true,
    unlimitedScheduling: true,
    multiLanguageContent: true,
  },
} as const;

/**
 * Coste en créditos de AI Studio por tipo de generación — PRD §16.2.
 * Son exactos y están confirmados.
 */
export const AI_STUDIO_COST = {
  image: 4,
  video: 60,
  /** El entrenamiento completo de un influencer. */
  influencer: 250,
  baseImage: 4,
} as const;

export type AiStudioOperation = keyof typeof AI_STUDIO_COST;

/**
 * Caps que NO dependen del plan — PRD §16.2 y §5.
 * Son límites técnicos del producto, iguales para todos.
 */
export const HARD_CAPS = {
  /** Content angles por workspace. */
  contentAngles: 100,
  /** Angles por influencer. */
  anglesPerInfluencer: 10,
  /**
   * Influencers ACTIVOS por workspace. El PRD lo marca como cap técnico
   * separado del límite de personajes por plan: un workspace Pro puede tener
   * 2000 personajes creados pero sólo 50 activos a la vez.
   */
  activeInfluencers: 50,
  /** Slides por slideshow. */
  slidesPerSlideshow: 20,
  /** Generaciones de AI Studio en vuelo por workspace. */
  inFlightGenerations: 10,
  /** Ids por operación en lote. */
  idsPerBatch: 100,
  /** Fuentes de marca por workspace (EXT-001). */
  brandSources: 5,
  /** Re-análisis por fuente y día. Configurable por plan; default 3. */
  reanalysesPerSourcePerDay: 3,
  /** Ítems de contenido analizados por fuente (AI-016). Configurable. */
  itemsPerBrandAnalysis: 24,
} as const;

export type HardCaps = typeof HARD_CAPS;
export type CapName = keyof HardCaps;

/**
 * Caps efectivos por plan — `EXT-005`.
 *
 * ## Qué resuelve y qué deliberadamente no
 *
 * `EXT-005` pide *"caps configurables por plan en vez de hardcodeados"*, porque
 * *"en el original son opacos"*. Eso es una extensión sobre Fastlane, no una
 * descripción de él, así que lo que corresponde construir es **el mecanismo**.
 *
 * Los **valores** son otra cosa: `OQ-14` dice que los números exactos por plan
 * se desconocen, y su línea de hipótesis —*"varían por plan"*— es justamente
 * eso, una hipótesis. Por eso este mapa está **vacío**, y hay un test que
 * comprueba que siga vacío. Llenarlo con números plausibles convertiría una
 * pregunta abierta en una respuesta que nadie verificó, y la diferencia entre
 * "no lo sabemos" y "lo inventamos" se borra en cuanto el número existe.
 *
 * Cuando aparezca la evidencia: se agrega acá, se actualiza `OQ-14` en el PRD
 * y se ajusta el test. Los tres pasos, no el primero solo.
 */
export const PLAN_CAP_OVERRIDES: Readonly<
  Partial<Record<PlanId, Readonly<Partial<HardCaps>>>>
> = {};

/**
 * Los caps que aplican a un plan.
 *
 * Devuelve `HARD_CAPS` con los overrides del plan encima. Hoy, sin overrides,
 * devuelve exactamente `HARD_CAPS` para todos los planes — que es lo correcto
 * mientras `OQ-14` siga abierta.
 *
 * `overrides` es un parámetro y no una lectura del módulo para que un test
 * pueda ejercitar el mecanismo sin tener que inventar un plan de mentira en la
 * constante compartida.
 */
export function capsForPlan(
  planId: PlanId,
  overrides: Readonly<
    Partial<Record<PlanId, Readonly<Partial<HardCaps>>>>
  > = PLAN_CAP_OVERRIDES,
): HardCaps {
  return { ...HARD_CAPS, ...(overrides[planId] ?? {}) };
}

/**
 * Valores que el PRD marca explícitamente como UNKNOWN.
 *
 * Existen como constantes, y no como números puestos a ojo, para que quien
 * los descubra sepa dónde cambiarlos y para que nadie los confunda con un
 * valor verificado. El PRD los lista en §16.2 con el literal de UI pero sin
 * número.
 */
export const UNKNOWN_LIMITS = {
  /** `<N> active keys per workspace.` — valor exacto desconocido. */
  apiKeysPerWorkspace: null,
  /** `Connection limit reached` — valor exacto desconocido. */
  connectionsPerWorkspace: null,
  /** "Limited content" en el plan Free — sin número en la fuente oficial. */
  freeContentSaves: null,
  /** Storage agregado por plan — el PRD dice "por plan" sin dar cifras. */
  storageBytesPerPlan: null,
} as const;

/** Un plan con `contentSaves: null` no consume cuota de saves. */
export function hasUnlimitedSaves(plan: PlanId): boolean {
  return PLANS[plan].contentSaves === null;
}
