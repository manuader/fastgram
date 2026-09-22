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
 * ## La forma: leer corto, planificar fuera, escribir corto
 *
 * ```
 *   [tx 1]  preferencias + ángulos + influencers + conteo      ~ms
 *           planificar hasta 5 sugerencias (CPU puro)          µs
 *   [tx 2]  lock del workspace, contar e insertar              ~ms
 * ```
 *
 * Igual que `content/build-handler.ts`, y acá el trabajo del medio es barato
 * —`planSuggestion` no hace I/O— así que la razón no es el tiempo: es que
 * **planificar depende de un estado que no se puede tener bloqueado**. Los
 * ángulos y los influencers del workspace se leen enteros; dejarlos bloqueados
 * mientras se planifica serializaría el refill contra cualquier edición de un
 * ángulo. Y cuando `AI-002` tenga su generador de copy de verdad —hoy no lo
 * tiene, ver más abajo— ese paso pasa a durar segundos y la forma ya está.
 *
 * ## Se planifican 5 y la base decide cuántas entran
 *
 * Es la parte contraintuitiva y es deliberada. El conteo de la transacción 1
 * **no decide** cuántas se generan: se generan siempre hasta `target`, y la
 * sentencia de la transacción 2 —que cuenta e inserta a la vez— se queda con
 * las que falten y descarta el resto.
 *
 * Si el conteo decidiera cuántas generar, habría una ventana entre contar y
 * escribir: contás 3, generás 2, otra entrega inserta 2 mientras tanto, y
 * terminás en 7. Generando de más y dejando que el `INSERT` recorte, ese error
 * no tiene dónde ocurrir. Lo único que cuesta es planificar de más, que es
 * aritmética.
 *
 * El conteo de la transacción 1 queda igual, para dos cosas: el log, y
 * saltearse el trabajo cuando la cola ya está llena. Es un atajo, **nunca** la
 * guarda.
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
 * ## Lo que este handler NO hace, y por qué no se inventa
 *
 * - **`generatedText` queda `null`.** `AI-002` dice que la sugerencia trae la
 *   copy generada, y generarla es un LLM con un prompt que todavía no existe.
 *   Escribir un texto de relleno en esa columna sería peor que dejarla vacía:
 *   el usuario lo vería en el deck como si fuera la copy propuesta.
 * - **`remixSourceUrl` y `sourceTrendingItemId` quedan `null`** incluso cuando
 *   la tirada dice remix. *Cuánto* remix lo deciden los pesos de `FR-055`;
 *   *qué* remixar es `DP-005`/`JV-6` (PRD §25), que ordena candidatos por
 *   encaje con la marca. No hay adaptador de `Judgment` para ese punto de
 *   decisión. La explicación guardada lo dice en vez de que la sugerencia salga
 *   como si fuera original.
 * - **El influencer se persiste sólo cuando hay un único candidato elegible.**
 *   Con uno, no hay nada que juzgar y cualquier procedimiento devuelve el
 *   mismo. Con varios, elegir es el mismo `DP-005`/`JV-6`, y resolverlo con un
 *   dado sería sustituir un juicio semántico por azar — exactamente lo que
 *   `EXT-008` existe para evitar, y lo que la cabecera de `plan-suggestion.ts`
 *   prohíbe por escrito.
 * - **`isRemix`, `useOwnMedia` y `mentionBusiness` no se persisten como
 *   flags**: `DATA-007` no tiene columnas para ellos. Sobreviven dentro de
 *   `aiExplanation`, que es texto, así que el `POST /blitz` que acepte la
 *   sugerencia **no puede leerlos**. Queda reportado.
 */

import {
  DomainError,
  DEFAULT_BLITZ_PREFERENCES,
  TARGET_QUEUED_ITEMS,
  explainSuggestion,
  parseDiscoveryRefillJob,
  planSuggestion,
  reconcileAngleWeights,
  type BlitzPreferences,
  type DiscoveryRefillJob,
  type EligibleInfluencer,
  type SuggestionPlan,
  type TextStylePreset,
} from "@fastgram/core";
import {
  blitzPreferencesRepository,
  contentAngleRepository,
  discoveryQueueStore,
  influencerRepository,
  withCompany,
  type Database,
  type QueuedSuggestionDraft,
  type Transaction,
} from "@fastgram/db";
import type { JobContext, JobHandler, Rng } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";

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
}

/** Lo que la transacción 1 trae, ya listo para planificar. */
interface RefillSubject {
  readonly preferences: BlitzPreferences;
  readonly activeAngles: readonly { readonly id: string; readonly title: string }[];
  readonly influencers: readonly EligibleInfluencer[];
  readonly influencerNames: ReadonlyMap<string, string>;
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

  /** Transacción 1: leer todo lo que la selección necesita, y soltar. */
  async function read(job: DiscoveryRefillJob): Promise<RefillSubject> {
    return inCompany(job.companyId, async (tx) => {
      const scope = { companyId: job.companyId };

      const angles = await listAllPages((page) =>
        contentAngleRepository.listByPage(tx, scope, { page, limit: PAGE_SIZE }),
      );
      const activeAngles = angles
        .filter((row) => row.isActive)
        .map((row) => ({ id: row.id, title: row.title }));

      // Sólo los activos: `eligibleInfluencers` descarta el resto igual, y un
      // workspace Pro puede tener 2000 personajes creados contra 50 activos.
      // Traer los 2000 para tirarlos en `core` sería el cuello que el cap de
      // activos existe para evitar.
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

      return {
        preferences: resolvePreferences(
          await blitzPreferencesRepository.findById(tx, scope, job.companyId),
          activeAngles.map((a) => a.id),
        ),
        activeAngles,
        influencers,
        influencerNames: new Map(rows.map((row) => [row.id, row.name])),
        queued: await discoveryQueueStore.countQueued(tx, scope),
      };
    });
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

    let subject: RefillSubject;
    try {
      subject = await read(job);
    } catch (error: unknown) {
      // `DomainError` acá es estado inconsistente del workspace —pesos de
      // ángulo que no cubren a ningún activo, que `plan-suggestion.ts` declara
      // bug de la transacción de reconcile— y no mejora reintentando. Todo lo
      // demás sí: es la base o un bug nuestro, y la cola sabe esperar.
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
    if (subject.queued >= target) {
      deps.logger.info(
        { ...base, queued: subject.queued, target },
        "refill omitido: la cola ya está en el objetivo",
      );
      return;
    }

    let drafts: readonly QueuedSuggestionDraft[];
    try {
      drafts = planDrafts(deps.rng, subject, target);
    } catch (error: unknown) {
      if (error instanceof DomainError) {
        deps.logger.error(
          { ...base, code: error.code, reason: error.message },
          "refill imposible: la selección no pudo decidir",
        );
        return;
      }
      throw error;
    }

    const { queuedBefore, inserted } = await write(job, drafts);

    deps.logger.info(
      {
        ...base,
        queuedBefore,
        inserted,
        planned: drafts.length,
        target,
      },
      inserted === 0
        ? "refill sin efecto: otra entrega llenó la cola primero"
        : "cola rellenada",
    );
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

/** Planifica `target` sugerencias. Es CPU puro: no toca la base. */
function planDrafts(
  rng: Rng,
  subject: RefillSubject,
  target: number,
): readonly QueuedSuggestionDraft[] {
  const titles = new Map(subject.activeAngles.map((a) => [a.id, a.title]));
  const context = {
    activeAngleIds: subject.activeAngles.map((a) => a.id),
    influencers: subject.influencers,
  };

  const drafts: QueuedSuggestionDraft[] = [];
  for (let i = 0; i < target; i += 1) {
    const plan = planSuggestion(rng, subject.preferences, context);
    drafts.push(toDraft(plan, titles, subject.influencerNames));
  }
  return drafts;
}

function toDraft(
  plan: SuggestionPlan,
  angleTitles: ReadonlyMap<string, string>,
  influencerNames: ReadonlyMap<string, string>,
): QueuedSuggestionDraft {
  // Con un solo candidato no hay juicio que emitir. Con varios sí, y es
  // `DP-005`/`JV-6`: ver la cabecera.
  const unico =
    plan.influencer.decision === "use" && plan.influencer.candidates.length === 1
      ? (plan.influencer.candidates[0] as string)
      : null;

  const angleTitle = plan.angleId === null ? undefined : angleTitles.get(plan.angleId);
  const influencerName = unico === null ? undefined : influencerNames.get(unico);
  const undecided =
    plan.influencer.decision === "use" && unico === null
      ? plan.influencer.candidates.length
      : 0;

  return {
    contentType: plan.contentType,
    aiExplanation: explainSuggestion(plan, {
      angleTitle,
      influencerName,
      undecidedCandidates: undecided,
    }),
    angleId: plan.angleId,
    influencerId: unico,
    textStylePresetId: plan.textStylePresetId,
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
