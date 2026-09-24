/**
 * El handler de `discovery-refill` — PRD §9.5.2, `AI-002`, `FR-030`,
 * `P2-DISC-001`.
 *
 * ## Qué tapón destapa
 *
 * Hasta acá **nada en todo el repo insertaba una fila en `suggestions`**. Las
 * piezas estaban todas: `planSuggestion` implementa la selección ponderada de
 * `AI-002` con sus tests, `TARGET_QUEUED_ITEMS` fija la cola en 5, la tabla
 * existe con su índice parcial sobre `queued`, y la política del job estaba en
 * el catálogo. Lo que faltaba era el consumidor, y el síntoma era que
 * `POST /blitz` respondía «cola vacía» siempre y toda la sección de Blitz no
 * tenía nada que mostrar.
 *
 * ## La forma: leer corto, planificar y escribir la copy fuera, escribir corto
 *
 * ```
 *   [tx 1]  preferencias + ángulos + influencers + perfil + Media Bank + conteo   ~ms
 *           planificar las que faltan (CPU puro)                                   µs
 *           una copy por sugerencia (LLM, sin transacción)                         s
 *   [tx 2]  lock del workspace, contar e insertar                                  ~ms
 * ```
 *
 * Igual que `content/build-handler.ts`: el paso del medio dura segundos y
 * **depende de un estado que no se puede tener bloqueado** mientras tanto.
 *
 * El conteo de la transacción 1 decide cuántas se planifican (ver abajo) y
 * permite saltearse todo con la cola llena. **Nunca** es la guarda: quien
 * decide cuántas entran es la sentencia de la transacción 2, que cuenta e
 * inserta a la vez y descarta las que sobran.
 *
 * ## La guarda contra la reentrega
 *
 * pg-boss puede entregar el mismo job dos veces, y este handler es idempotente
 * por **convergencia**: no «inserta 5», lleva la cola a 5. Una segunda entrega
 * cuenta 5, calcula 0 y no inserta nada.
 *
 * Eso se rompe si las dos entregas cuentan **a la vez**, y un `INSERT` no
 * bloquea contra nada: las dos verían 0 y las dos insertarían 5. Quien cierra
 * esa carrera es `discoveryQueueStore.lockCompanyRefill` —un advisory lock de
 * transacción por workspace— y está explicado en la cabecera de
 * `packages/db/src/repositories/discovery-queue.ts`, incluido por qué la
 * sentencia atómica **sola** no alcanzaría acá aunque sí alcance para el
 * reembolso de créditos.
 *
 * ## Qué guarda cada fila (desde la migración `0011`)
 *
 * Una sugerencia **construible**: la media concreta del Media Bank y la copy,
 * en `build_plan`, además de `generatedText` y `aiExplanation`. Antes la fila
 * no llevaba con qué construir y `POST /blitz` creaba piezas que fallaban
 * después de cobrar. Las piezas:
 *
 *  - **La selección** (`planBlitzSuggestion` de `core`): las seis tiradas de
 *    `AI-002`, los formatos sin media afuera del sorteo, el fallback a regular
 *    de un influencer sin media, y la media concreta. CPU pura.
 *  - **La copy y los bullets de `Why This Content?`**: `SuggestionCopywriter`
 *    sobre el puerto `Llm`. Segundos por sugerencia, **fuera** de las dos
 *    transacciones.
 *
 * ## Sin LLM no se encola nada — y se dice una vez
 *
 * `AI-002`: la sugerencia *es* `contentType` + `generatedText` +
 * `aiExplanation`, y los cuatro formatos dibujan texto (`FR-070`: `text` es
 * obligatorio). Una sugerencia sin copy no es una pieza a medio hacer: es una
 * que no se puede construir. Encolarla llevaría al usuario a aceptarla, pagar
 * y recibir un video sin texto — o a nada. Sin `copywriter` el handler no
 * planifica ni escribe, y lo loguea **una vez por proceso** (con `warn`), no
 * una por job: `POST /blitz` pide un relleno por minuto mientras el deck está
 * abierto.
 *
 * ## Ahora se planifican las que faltan, no `target`
 *
 * Con el dado solo, planificar de más era aritmética. Con un LLM por sugerencia
 * son tokens y segundos: se planifican `target - queued` (el conteo de la
 * transacción 1). **La guarda sigue siendo la sentencia de la transacción 2**,
 * que recorta: si otra entrega llenó la cola mientras tanto, entran menos. El
 * peor caso es haber pagado alguna copy de más, nunca una cola excedida.
 *
 * ## Lo que este handler sigue sin hacer, y por qué no se inventa
 *
 * - **`remixSourceUrl` y `sourceTrendingItemId` quedan `null`** incluso cuando
 *   la tirada dice remix. *Qué* remixar es `DP-005`/`JV-6` (PRD §25), sin
 *   implementación. La pieza sale original y la explicación lo dice.
 * - **Con varios influencers candidatos no se elige ninguno**: es el mismo
 *   `DP-005`/`JV-6`. Ver `plan-blitz-suggestion.ts`.
 * - **La librería compartida no existe**: la media sale siempre del Media Bank,
 *   y cuando la tirada de `ownMediaPercentage` pidió la librería, la
 *   explicación lo dice. Ver `blitz-media.ts`.
 */

import {
  DomainError,
  DEFAULT_BLITZ_PREFERENCES,
  TARGET_QUEUED_ITEMS,
  buildMediaBank,
  composeAiExplanation,
  finalizeBuildPlan,
  generatedTextOf,
  parseDiscoveryRefillJob,
  planBlitzSuggestion,
  reconcileAngleWeights,
  type BlitzPlanningContext,
  type BlitzPreferences,
  type CopyAngle,
  type CopyBrandProfile,
  type CopyRemixReference,
  type DiscoveryRefillJob,
  type EligibleInfluencer,
  type PlannedBlitzSuggestion,
  type TextStylePreset,
} from "@fastgram/core";
import {
  blitzPreferencesRepository,
  companyProfileRepository,
  companyRepository,
  contentAngleRepository,
  discoveryQueueStore,
  influencerRepository,
  withCompany,
  type Database,
  type QueuedSuggestionDraft,
  type Transaction,
} from "@fastgram/db";
import { PortError, type JobContext, type JobHandler, type Rng } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import type { SuggestionCopywriter } from "./copywriter.js";

export interface DiscoveryRefillDeps {
  readonly db: Database;
  /**
   * La fuente de azar de `AI-002`. En producción `systemRng`; en los tests, un
   * `SeededRng`, que es lo que hace reproducible una sugerencia rara que
   * reportó un usuario.
   *
   * **Se comparte entre entregas concurrentes**, porque el handler se construye
   * una vez al arrancar. Con `systemRng` da igual: no tiene estado. Con un
   * `SeededRng` no: dos jobs a la vez consumen la misma secuencia entrelazada y
   * el determinismo se pierde. Es correcto para lo que el seed existe —repetir
   * **una** corrida— y conviene saberlo antes de sembrarlo en producción.
   */
  readonly rng: Rng;
  /**
   * La copy de `AI-002` (`OpenAiCompatibleLlm` detrás), o `null` si el entorno
   * no configura el LLM. Con `null` no se encola nada: ver la cabecera.
   *
   * También puede ser una **función que la resuelve en cada job**
   * (`PU-MODEL-001`): así un modelo configurado desde la pantalla de Modelos
   * llega al próximo relleno sin reiniciar el worker, y uno que se borra deja
   * de usarse. `null` desde la función es lo mismo que `null` fijo.
   */
  readonly copywriter: SuggestionCopywriter | null | CopywriterProvider;
  /**
   * Rol para el `SET LOCAL ROLE` de cada transacción. Sin él, un proceso
   * conectado como superusuario **saltea RLS por completo** y el aislamiento
   * deja de existir sin que nada avise.
   */
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  /**
   * La cola objetivo. Default `TARGET_QUEUED_ITEMS` (5, `AI-002`).
   *
   * Es parámetro y no constante porque los tests necesitan colas de 1 y de 2
   * para que un fallo se lea; **no** es configuración de producto: `FR-055`
   * regla 7 dice que `settingsApplication` es de sólo lectura, así que nadie
   * puede cambiarlo desde la API.
   */
  readonly targetQueuedItems?: number;
  /**
   * `PU-MEDIA-002`: se llama cuando la selección no pudo planificar porque el
   * Media Bank no tiene media para ningún formato del mix. `handlers.ts` lo
   * conecta a encolar `brand-backgrounds` (una vez en la vida de la marca, ver
   * `brand-kit/mount.ts`). No lanza: el refill termina igual que antes.
   */
  readonly onMediaBankEmpty?: ((companyId: string) => Promise<void>) | undefined;
}

/** La copy resuelta en el momento del job. Ver {@link DiscoveryRefillDeps.copywriter}. */
export type CopywriterProvider = () => Promise<SuggestionCopywriter | null>;

/**
 * Por qué no se encola sin LLM. Va al log una vez por proceso — o, con un
 * {@link CopywriterProvider}, una vez cada vez que el LLM **deja** de estar.
 */
export const REFILL_WITHOUT_LLM_WHY =
  "no hay LLM para la tarea `text` (ni en Settings → Models ni en LLM_BASE_URL + " +
  "LLM_API_KEY + LLM_MODEL + LLM_CONTEXT_WINDOW_TOKENS): una sugerencia sin copy " +
  "(AI-002) no se puede construir, así que discovery-refill no encola nada y " +
  "Blitz responde «cola vacía»";

/**
 * Lo que la transacción 1 trae, ya listo para planificar. Lo usa también
 * «crear desde prompt» (`prompt-handler.ts`): misma selección, misma copy.
 */
export interface RefillSubject {
  readonly preferences: BlitzPreferences;
  readonly planning: BlitzPlanningContext;
  readonly angles: ReadonlyMap<string, CopyAngle>;
  readonly businessName: string;
  readonly profile: CopyBrandProfile;
  readonly queued: number;
}

/**
 * `HARD_CAPS.contentAngles` es 100 y `activeInfluencers` 50, así que una página
 * de 100 trae el workspace entero. El bucle existe igual, con el mismo criterio
 * que `listAllAngles` en la API: el cap lo hace cumplir la ruta de creación y no
 * la base, así que una fila escrita por una migración o un import podría
 * pasarlo. El tope convierte ese caso en un error ruidoso en vez de en una
 * selección hecha sobre datos incompletos.
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export function createDiscoveryRefillHandler(
  deps: DiscoveryRefillDeps,
): JobHandler<unknown> {
  const target = deps.targetQueuedItems ?? TARGET_QUEUED_ITEMS;
  let avisadoSinLlm = false;

  const inCompany = <T>(
    companyId: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> =>
    withCompany(
      deps.db,
      companyId,
      fn,
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );

  /** Transacción 1: leer todo lo que la selección y la copy necesitan, y soltar. */
  async function read(job: DiscoveryRefillJob): Promise<RefillSubject> {
    return inCompany(job.companyId, (tx) => readRefillSubject(tx, job.companyId));
  }

  /** Transacción 2: el lock, el conteo que decide y la inserción. */
  async function write(
    job: DiscoveryRefillJob,
    drafts: readonly QueuedSuggestionDraft[],
  ): Promise<{ queuedBefore: number; inserted: number }> {
    return inCompany(job.companyId, async (tx) => {
      const scope = { companyId: job.companyId };
      // **Antes** de contar, no después: si el lock se tomara después, dos
      // entregas ya habrían contado lo mismo y el lock sólo ordenaría dos
      // inserciones que ya decidieron de más.
      await discoveryQueueStore.lockCompanyRefill(tx, scope);
      const result = await discoveryQueueStore.refillQueue(tx, scope, target, drafts);
      return {
        queuedBefore: result.queuedBefore,
        inserted: result.insertedIds.length,
      };
    });
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parseDiscoveryRefillJob(ctx.payload);
    if (!parsed.ok) {
      // No se relanza, por lo mismo que en `content-build`: reintentar un
      // payload roto da el mismo error tres veces y después parece un fallo de
      // infraestructura en la dead-letter. Es un bug del productor.
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de discovery-refill inválido",
      );
      return;
    }

    const job = parsed.payload;
    const base = { jobId: ctx.jobId, companyId: job.companyId };

    const copywriter =
      typeof deps.copywriter === "function" ? await deps.copywriter() : deps.copywriter;
    if (copywriter === null) {
      if (!avisadoSinLlm) {
        avisadoSinLlm = true;
        deps.logger.warn({ ...base }, REFILL_WITHOUT_LLM_WHY);
      }
      return;
    }
    // Volvió a haber LLM: si se va otra vez, se vuelve a avisar.
    avisadoSinLlm = false;

    let subject: RefillSubject;
    try {
      subject = await read(job);
    } catch (error: unknown) {
      if (error instanceof DomainError) {
        deps.logger.error(
          { ...base, code: error.code, reason: error.message },
          "refill imposible: el estado del workspace no permite planificar",
        );
        return;
      }
      throw error;
    }

    // El atajo, no la guarda: quien decide cuántas entran es la sentencia de
    // `write`, que cuenta en el mismo `WITH` en el que inserta.
    const missing = target - subject.queued;
    if (missing <= 0) {
      deps.logger.info(
        { ...base, queued: subject.queued, target },
        "refill omitido: la cola ya está en el objetivo",
      );
      return;
    }

    let planned: PlannedBlitzSuggestion[];
    try {
      planned = Array.from({ length: missing }, () =>
        planBlitzSuggestion(deps.rng, subject.preferences, subject.planning),
      );
    } catch (error: unknown) {
      // `DomainError` = estado del workspace (pesos de ángulo que no cubren a
      // ningún activo, o un Media Bank sin media para ningún formato del mix).
      // No mejora reintentando.
      if (error instanceof DomainError) {
        deps.logger.error(
          { ...base, code: error.code, reason: error.message, details: error.details },
          "refill imposible: la selección no pudo decidir",
        );
        // `availableFormats` sólo viene en el error de «ningún formato del mix
        // tiene media» (`plan-suggestion.ts`); el de ángulos no lo trae.
        if (deps.onMediaBankEmpty !== undefined && error.details?.["availableFormats"]) {
          await deps.onMediaBankEmpty(job.companyId);
        }
        return;
      }
      throw error;
    }

    const drafts: QueuedSuggestionDraft[] = [];
    let lastRetryable: PortError | null = null;
    for (const p of planned) {
      try {
        const draft = await withCopy(copywriter, subject, p);
        if (draft.ok) {
          drafts.push(draft.draft);
        } else {
          deps.logger.warn(
            { ...base, contentType: p.plan.contentType, reason: draft.reason },
            "sugerencia descartada: la copy del modelo no sirve",
          );
        }
      } catch (error: unknown) {
        if (!(error instanceof PortError)) throw error;
        // El mensaje del `PortError` no lleva la API key (lo garantiza el
        // adaptador); el código es lo que sirve para diagnosticar.
        deps.logger.warn(
          { ...base, contentType: p.plan.contentType, code: error.code },
          "sugerencia descartada: el LLM falló",
        );
        if (error.isRetryable) lastRetryable = error;
      }
    }

    if (drafts.length === 0) {
      // Todas fallaron. Si alguna fue transitoria, que la cola reintente con
      // backoff (§9.5.2); si no, no hay nada que reintentar.
      if (lastRetryable !== null) throw lastRetryable;
      deps.logger.error({ ...base, planned: planned.length }, "refill sin sugerencias");
      return;
    }

    const { queuedBefore, inserted } = await write(job, drafts);

    deps.logger.info(
      {
        ...base,
        queuedBefore,
        inserted,
        planned: planned.length,
        written: drafts.length,
        target,
      },
      inserted === 0
        ? "refill sin efecto: otra entrega llenó la cola primero"
        : "cola rellenada",
    );
  };
}

/**
 * Transacción 1 del refill: todo lo que la selección y la copy necesitan.
 * Exportada para «crear desde prompt» (`PU-BLITZ-003`), que planifica sobre
 * exactamente el mismo estado.
 */
export async function readRefillSubject(
  tx: Transaction,
  companyId: string,
): Promise<RefillSubject> {
  const scope = { companyId };
  const angleRows = await listAllPages((page) =>
    contentAngleRepository.listByPage(tx, scope, { page, limit: PAGE_SIZE }),
  );
  const activeAngles = angleRows.filter((row) => row.isActive);

  // Sólo los activos: `eligibleInfluencers` descarta el resto igual, y un
  // workspace Pro puede tener 2000 personajes creados contra 50 activos.
  const rows = await listAllPages((page) =>
    influencerRepository.listByPage(tx, scope, {
      page,
      limit: PAGE_SIZE,
      filter: { isActive: { eq: true } },
    }),
  );
  const influencers: EligibleInfluencer[] = rows.map((row) => ({
    id: row.id,
    isActive: row.isActive,
    // `isTrained` no es una columna: `DATA-013` modela el entrenamiento como
    // el enum de estado, y `ready` es el único que significa entrenado.
    isTrained: row.status === "ready",
    gender: row.gender,
  }));

  const bankRows = await discoveryQueueStore.listPlanningMedia(tx, scope);
  const company = await companyRepository.load(tx, scope);
  // `company_profiles` tiene un único índice por `companyId`: la primera
  // fila es la fila.
  const profile = (await companyProfileRepository.list(tx, scope, { limit: 1 })).items[0];

  return {
    preferences: resolvePreferences(
      await blitzPreferencesRepository.findById(tx, scope, companyId),
      activeAngles.map((a) => a.id),
    ),
    planning: {
      activeAngleIds: activeAngles.map((a) => a.id),
      influencers,
      bank: buildMediaBank(bankRows.media, bankRows.influencerSets),
      angleTitles: new Map(activeAngles.map((a) => [a.id, a.title])),
      influencerNames: new Map(rows.map((row) => [row.id, row.name])),
    },
    angles: new Map(
      activeAngles.map((a) => [
        a.id,
        {
          title: a.title,
          description: a.description,
          targetAudience: a.targetAudience,
        },
      ]),
    ),
    businessName: company?.name ?? "",
    profile: profile ?? {},
    queued: await discoveryQueueStore.countQueued(tx, scope),
  };
}

/**
 * La copy de una sugerencia planificada, y la fila que resulta. En un
 * slideshow el modelo puede devolver hasta tantos textos como imágenes
 * candidatas, y quedan tantos slides como textos (`finalizeBuildPlan`).
 */
export async function withCopy(
  copywriter: SuggestionCopywriter,
  subject: RefillSubject,
  p: PlannedBlitzSuggestion,
  /** `PU-BLITZ-003`: el tema del usuario, directiva principal de la copy. */
  topic?: string,
  /** Inspiration «Remix this»: la referencia, como dato (`suggestion-copy.ts`). */
  remix?: CopyRemixReference,
): Promise<
  | { readonly ok: true; readonly draft: QueuedSuggestionDraft }
  | { readonly ok: false; readonly reason: string }
> {
  const maxTexts = p.media.format === "slideshow" ? p.media.slides.length : 1;
  const outcome = await copywriter.write({
    contentType: p.plan.contentType,
    mentionBusiness: p.plan.mentionBusiness,
    businessName: subject.businessName,
    profile: subject.profile,
    angle: p.plan.angleId === null ? null : (subject.angles.get(p.plan.angleId) ?? null),
    maxTexts,
    ...(topic === undefined ? {} : { topic }),
    ...(remix === undefined ? {} : { remix }),
  });
  if (!outcome.ok) return { ok: false, reason: outcome.reason };

  const buildPlan = finalizeBuildPlan(p.media, outcome.copy.texts);
  return {
    ok: true,
    draft: {
      contentType: p.plan.contentType,
      generatedText: generatedTextOf(buildPlan.texts),
      aiExplanation: composeAiExplanation(outcome.copy.explanation, p.derivedExplanation),
      angleId: p.plan.angleId,
      influencerId: p.influencerId,
      textStylePresetId: p.plan.textStylePresetId,
      buildPlan,
    },
  };
}

/**
 * Las preferencias del workspace, o los defaults sintetizados de `DATA-006`.
 *
 * `angleWeights` es la parte con trampa. Cuando **no hay fila**, el mapa vacío
 * más ángulos activos haría que `planSuggestion` lance `invalid_state` —su
 * `pickAngle` grita cuando los pesos no cubren a ningún activo— y el workspace
 * recién creado nunca vería una sugerencia. Así que se sintetiza con
 * `reconcileAngleWeights`, que es **exactamente** lo que la transacción de
 * reconcile habría escrito, no un reparto a ojo.
 *
 * Cuando **sí hay fila** y sus pesos no cubren a los activos, se deja que
 * `planSuggestion` grite. Ese caso no es «faltan defaults»: es el bug de
 * reconcile que `plan-suggestion.ts` pide no tapar. Repartir en silencio ahí lo
 * escondería para siempre.
 */
function resolvePreferences(
  row: {
    slideshowWeight: number;
    wallOfTextWeight: number;
    greenScreenWeight: number;
    videoHookWeight: number;
    remixPercentage: number;
    ownMediaPercentage: number;
    mentionBusinessPercentage: number;
    influencerChance: number;
    smartTextPositioning: boolean;
    genderFilter: "man" | "woman" | null;
    angleWeights: unknown;
    textStyleWeights: unknown;
  } | null,
  activeAngleIds: readonly string[],
): BlitzPreferences {
  if (row === null) {
    return {
      ...DEFAULT_BLITZ_PREFERENCES,
      angleWeights: reconcileAngleWeights(activeAngleIds),
      textStyleWeights: {},
    };
  }
  return {
    slideshowWeight: row.slideshowWeight,
    wallOfTextWeight: row.wallOfTextWeight,
    greenScreenWeight: row.greenScreenWeight,
    videoHookWeight: row.videoHookWeight,
    remixPercentage: row.remixPercentage,
    ownMediaPercentage: row.ownMediaPercentage,
    mentionBusinessPercentage: row.mentionBusinessPercentage,
    influencerChance: row.influencerChance,
    smartTextPositioning: row.smartTextPositioning,
    genderFilter: row.genderFilter,
    // Las dos columnas son `jsonb`, o sea `unknown` para el tipo. Se estrechan
    // acá y no más adentro porque `core` las valida cuando se escriben
    // (`assertValidAngleWeights`, `assertValidTextStyleWeights`): lo que sale
    // de la base ya pasó por ahí.
    angleWeights: (row.angleWeights ?? {}) as Readonly<Record<string, number>>,
    textStyleWeights: (row.textStyleWeights ?? {}) as Readonly<
      Record<TextStylePreset, number>
    >,
  };
}

/** Todas las filas de un listado paginado, con tope ruidoso. Ver `MAX_PAGES`. */
async function listAllPages<TRow>(
  fetchPage: (
    page: number,
  ) => Promise<{ readonly items: readonly TRow[]; readonly hasMore: boolean }>,
): Promise<TRow[]> {
  const all: TRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await fetchPage(page);
    all.push(...result.items);
    if (!result.hasMore) return all;
  }
  throw new Error(
    `El workspace tiene más de ${PAGE_SIZE * MAX_PAGES} filas donde el cap del PRD ` +
      "dice 100. Planificar sobre una lista incompleta dejaría candidatos fuera sin " +
      "avisar, así que se corta acá.",
  );
}
