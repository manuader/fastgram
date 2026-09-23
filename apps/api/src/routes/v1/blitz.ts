/**
 * Blitz — `POST /blitz`, `GET|PATCH /blitz/preferences`.
 *
 * Fuente: PRD §9.3, FR-050, FR-055, DATA-006.
 *
 * ## El reconcile de `angleWeights` vive acá, y no en `angles.ts`
 *
 * §9.4 exige *"crear ángulo **y** reescribir `angleWeights` en la misma
 * transacción"*. El mapa de pesos es una columna de `blitz_preferences`, así que
 * escribirlo es una operación de **este** recurso aunque lo dispare una mutación de
 * ángulo. Por eso {@link persistAngleWeights} y {@link listAllAngles} se exportan
 * desde acá y `angles.ts` las importa: la dependencia va en una sola dirección y no
 * hay dos sitios que sepan cómo se materializa la fila de preferencias.
 *
 * ## `POST /blitz` — aceptar una sugerencia (`P2-BLITZ-014`)
 *
 * FR-050: aceptar *"descuenta **1 swipe diario** y **1 content save**, y lanza un
 * build asíncrono"*. Lo hace `acceptBlitzSuggestionUseCase` de `packages/core`,
 * que ya existía; esta ruta le da lo que le faltaba, y la cabecera anterior
 * listaba cuatro bloqueos que hoy están así:
 *
 *  1–2. **Plan, overage y ancla** salen de `companyRepository.billing`, a través de
 *       `lockLedger` (`support/quota.ts`), el mismo camino que usa `POST /content`
 *       para cobrar. No hay una segunda copia de los defaults del período.
 *  3.   **`quota_ledgers.period`** es `YYYY-MM-DD`, el inicio del ciclo:
 *       `billingPeriodKey` en `core/quota/reset.ts`, que lo decide y lo argumenta.
 *       El comentario del schema que dice *"PENDIENTE"* quedó viejo.
 *  4.   **`SwipesLedger.dailyLimit`**: *sin límite por ahora* — decisión del dueño
 *       del producto, PRD §2.4 (2026-09-23). Es `BLITZ_DAILY_SWIPE_LIMIT = null`
 *       en `core`: el swipe **se cuenta** (`quota_ledgers.daily_swipes_used`) y no
 *       se corta.
 *
 * ### Lo que queda sin poder comprobarse: el trial
 *
 * Un workspace Free no tiene cupo mensual: su contenido es el *trial allowance*
 * de por vida (§16.2, §16.7; la cabecera de `PLANS.free` en `core`), y §16.1 no
 * da el número (*"Limited content"*). Sin número no hay límite que comprobar, así
 * que para Free la ruta responde el `503 service_unavailable` de §9.6 / ERR-R06
 * con `details.quotaExhausted: false` — *"esto **no** significa cuota agotada"* —
 * **antes de escribir nada**. Cobrarle del cupo mensual (que para Free es 0)
 * daría un `429` falso; no cobrarle regalaría el driver de costo #1.
 *
 * ### Lo que va en una transacción, y en qué orden
 *
 *   perfil listo → sacar la sugerencia (`FOR UPDATE SKIP LOCKED`)
 *     → bloquear el ledger → gate de **saves y después swipes** (§16.2)
 *       → `Content` en `BUILDING` + contadores + `popped`
 *         → encolar `content-build` **en la misma transacción** (ADR-005)
 *
 * Si algo falla —cuota, cola, validación— la transacción entera vuelve atrás: ni
 * swipe ni save ni pieza. El reembolso del save cuando el **build** falla ya lo
 * hace el worker (`apps/worker/src/content/build-handler.ts`), con el
 * `saveBucket`/`savePeriod` que se escriben acá.
 *
 * ### Códigos de error
 *
 * El PRD fija `429` para los dos cortes de cuota de esta ruta — FR-050 *States*
 * (`blocked: swipes` / `blocked: saves`), ERR-R02, ERR-R03 y el OpenAPI de
 * `/blitz` del contrato—, con `count`/`limit`/`resetAt` para saves y `resetAt`
 * para swipes, en ms de epoch (`contentQuotaExceededDetailsSchema`). `core` lanza
 * `blitz_quota_blocked` con `details.quotaType`, y la traducción está en
 * {@link toBlitzRejection}.
 *
 * ### El `buildPayload` sale de la sugerencia, en la misma transacción
 *
 * Hasta el 2026-09-23 la pieza se creaba **sin** `buildPayload` y el worker la
 * cerraba `FAILED` con `invalid_build_payload` después de cobrar. Ahora, antes
 * de tocar la cuota, {@link prepareBuildPayload}: parsea `suggestions.build_plan`
 * (media + copy, escrito por el refill), verifica con `FOR SHARE` que la media
 * siga viva, compone el payload con `composeBlitzBuildPayload` de `core` y lo
 * valida contra `contentBuildPayloadSchema` — el mismo schema con el que el
 * worker lo revalida en `toRenderJob`.
 *
 * Una sugerencia que no pasa (vieja, sin `build_plan`; media borrada) **no se
 * cobra**: la transacción vuelve atrás, la sugerencia se descarta en una
 * transacción propia —si no, el rollback la devolvería a `queued` y el deck
 * quedaría trabado en ella— y la respuesta es `422 content_unavailable_for_type`
 * (FR-050, *"tipo válido pero no producible ahora"*) con `details.reason`. El
 * cliente reintenta y recibe la siguiente.
 *
 * ### `Idempotency-Key`: opcional
 *
 * FR-050 (aclaración del 2026-09-21): `POST /blitz` **no** está en la lista de §9.3
 * de key obligatoria, pero `NFR-004` la acepta en toda operación facturable. Sin
 * key no es idempotente —reintentar a ciegas cobra dos veces—; con key sí. Se usa
 * el `withIdempotency` de las demás rutas, no la reserva interna del caso de uso:
 * dos mecanismos de idempotencia sobre la misma petición serían dos verdades.
 */
import { randomUUID } from "node:crypto";

import {
  contentBuildPayloadSchema,
  optionalIdempotencyHeaderSchema,
  runBlitzRequestSchema,
  updateBlitzPreferencesRequestSchema,
  type BlitzQuotaExceededDetails,
  type ContentQuotaExceededDetails,
} from "@fastgram/contracts";
import {
  BLITZ_DAILY_SWIPE_LIMIT,
  DomainError,
  JOB_QUEUES,
  TRIAL_CONTENT_ALLOWANCE,
  acceptBlitzSuggestionUseCase,
  assertValidBlitzRequest,
  assertValidPreferencesPatch,
  composeBlitzBuildPayload,
  parseSuggestionBuildPlan,
  rebindMediaUrls,
  selectionMediaIds,
  currentSwipesLedger,
  isBlitzContentType,
  isDomainError,
  nextBillingResetUtc,
  trialAllowanceGoverns,
  type AngleWeights,
  type BlitzAcceptanceRepository,
  type BlitzQuotaSnapshot,
  type DiscoveryRefillJob,
  type Suggestion,
} from "@fastgram/core";
import {
  blitzPreferencesRepository,
  claimNextQueuedSuggestion,
  companyProfileRepository,
  discardQueuedSuggestion,
  lockLiveMedia,
  contentAngleRepository,
  contentRepository,
  markSuggestionPopped,
  quotaLedgerStore,
  type ContentRow,
  type SuggestionRow,
  type Transaction,
  type contentAngles,
} from "@fastgram/db";
import type { Clock, Queue } from "@fastgram/ports";

import { ApiRejection } from "../../http/errors.js";
import { rateLimit } from "../../plugins/rate-limit.js";
import { lockLedger } from "../../support/quota.js";
import { toBlitzPreferences, toContent } from "../../support/serializers.js";
import { data, idempotencyKeyOf, withIdempotency } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

export type AngleRow = (typeof contentAngles)["$inferSelect"];

/**
 * Defaults sintetizados de `BlitzPreferences` (DATA-006: *"Sintetiza defaults si no
 * existe fila"*).
 *
 * **Sólo dos de estos números están en el PRD**: `influencerChance` 50 (PRD:1273) y
 * `smartTextPositioning` true (AI-014). Los demás son asunciones documentadas:
 *  - los cuatro pesos de formato van 25/25/25/25 porque la única restricción del PRD es
 *    que sumen 100, y el reparto par es la única elección que no privilegia un formato
 *    sin que nadie lo haya pedido;
 *  - los tres porcentajes arrancan en 0 porque son opt-in: remixar contenido ajeno o
 *    mencionar el negocio son decisiones del usuario, no defaults razonables.
 *
 * Están fijadas por un test para que cambiarlas sea deliberado y no un descuido.
 */
export const DEFAULT_BLITZ_PREFERENCES = {
  slideshowWeight: 25,
  wallOfTextWeight: 25,
  greenScreenWeight: 25,
  videoHookWeight: 25,
  remixPercentage: 0,
  ownMediaPercentage: 0,
  mentionBusinessPercentage: 0,
  influencerChance: 50,
  smartTextPositioning: true,
  genderFilter: null,
} as const;

/** FR-055 (PRD:1288) — `settingsApplication` es sólo de respuesta y constante. */
export const SETTINGS_APPLICATION = {
  mode: "future_generations",
  targetQueuedItems: 5,
} as const;

/**
 * `HARD_CAPS.contentAngles` es 100, así que una página de 100 trae el workspace
 * entero. El bucle existe igual porque el cap lo hace cumplir la ruta de creación y
 * no la base: una fila escrita por una migración o por un import podría pasarlo, y
 * un reconcile que sólo viera las primeras 100 dejaría a las demás con peso 0 sin
 * decirlo. El tope de páginas convierte ese caso en un error ruidoso.
 */
const ANGLE_PAGE_SIZE = 100;
const MAX_ANGLE_PAGES = 10;

/** Todos los ángulos del workspace, en el orden del repositorio (más nuevo primero). */
export async function listAllAngles(
  tx: Transaction,
  companyId: string,
): Promise<AngleRow[]> {
  const all: AngleRow[] = [];
  for (let page = 1; page <= MAX_ANGLE_PAGES; page += 1) {
    const result = await contentAngleRepository.listByPage(
      tx,
      { companyId },
      { page, limit: ANGLE_PAGE_SIZE },
    );
    all.push(...result.items);
    if (!result.hasMore) return all;
  }
  throw new Error(
    `El workspace tiene más de ${ANGLE_PAGE_SIZE * MAX_ANGLE_PAGES} content angles, ` +
      "muy por encima del cap de FR-056. Reconciliar pesos con una lista incompleta " +
      "dejaría ángulos en 0 sin avisar, así que se corta acá.",
  );
}

/**
 * Ids de los ángulos activos, **en el orden de entrada**.
 *
 * El parámetro pide las dos columnas que mira y no la fila entera: es lo que la
 * función necesita, y obliga a que un test no tenga que fabricar nueve campos que no
 * participan del resultado.
 */
export const activeAngleIdsOf = (
  rows: readonly { readonly id: string; readonly isActive: boolean }[],
): string[] => rows.filter((row) => row.isActive).map((row) => row.id);

/**
 * Escribe `angleWeights` en `blitz_preferences`, creando la fila si no existe.
 *
 * **No usa `upsert` a secas y la diferencia importa**: `upsert` reescribe *todas* las
 * columnas que se le pasan, así que pasarle los defaults junto al mapa le borraría al
 * usuario el content mix que configuró a mano cada vez que toca un ángulo. Por eso va
 * primero el `update` del único campo que cambia, y el `upsert` con defaults queda
 * sólo para el workspace que todavía no tiene fila — el caso que DATA-006 describe
 * como normal.
 */
export async function persistAngleWeights(
  tx: Transaction,
  companyId: string,
  weights: AngleWeights,
): Promise<void> {
  const updated = await blitzPreferencesRepository.update(tx, { companyId }, companyId, {
    angleWeights: weights,
  });
  if (updated !== null) return;

  const created = await blitzPreferencesRepository.upsert(
    tx,
    { companyId },
    { ...DEFAULT_BLITZ_PREFERENCES, angleWeights: weights, textStyleWeights: {} },
  );
  if (created === null) {
    throw new Error(
      "El upsert de `blitz_preferences` no devolvió fila. La PK de la tabla es el " +
        "propio `companyId` y el scope es el mismo, así que un conflicto con otro " +
        "workspace no es alcanzable: si pasa, cambió el modelo de datos.",
    );
  }
}

/** Un campo ausente en el patch conserva su valor; `null` es un valor, no una ausencia. */
const patched = <T, U>(fromPatch: T | undefined, current: U): T | U =>
  fromPatch === undefined ? current : fromPatch;

/**
 * `influencerChance` es el único campo donde el contrato y el schema no coinciden:
 * FR-055 (PRD:1273) dice *"decimales aceptados"* y `blitz_preferences.influencer_chance`
 * es `integer`.
 *
 * Se rechaza con `400` en vez de redondear, por el mismo criterio que
 * `unsupportedFilter`: redondear cambia en silencio el valor que el usuario eligió y
 * nadie se entera; un `400` con el motivo es visible y se arregla. Queda reportado
 * como un cambio pendiente en `packages/db` o en el contrato — no es una decisión que
 * corresponda tomar desde una ruta.
 */
function assertStorableInfluencerChance(value: number | undefined): void {
  if (value === undefined || Number.isInteger(value)) return;
  throw new DomainError(
    "out_of_range",
    "influencerChance must be a whole number: the stored column is an integer.",
    { field: "influencerChance", value },
  );
}

// ───────────────────────────────────────────────────────────────────────────
// POST /blitz — aceptar una sugerencia (`P2-BLITZ-014`). Ver la cabecera.
// ───────────────────────────────────────────────────────────────────────────

/** Mensaje literal de FR-050, estado `empty`. La UI lo usa para esperar y reintentar. */
const EMPTY_QUEUE_MESSAGE =
  "discovery queue has no ready items yet. Try again shortly; the queue replenishes in the background.";

/**
 * La cola del workspace está vacía. Es un `ApiRejection` con nombre propio porque
 * el handler tiene que **reconocerlo** para pedir el relleno antes de devolverlo,
 * y comparar mensajes para eso sería frágil.
 */
class EmptyQueueRejection extends ApiRejection {
  constructor() {
    super(404, "not_found", EMPTY_QUEUE_MESSAGE);
  }
}

/**
 * §9.6 / ERR-R06: el límite **no se puede comprobar**. `quotaExhausted: false` lo
 * dice explícito, para que el cliente no lo trate como cuota agotada.
 */
function quotaUncheckable(message: string): ApiRejection {
  return new ApiRejection(503, "service_unavailable", message, {
    quotaExhausted: false,
  });
}

/**
 * `blitz_quota_blocked` de `core` → los dos códigos que el PRD fija para esta ruta.
 *
 * - `quotaType: "saves"` → `429 content_quota_exceeded` + `count`, `limit`, `resetAt`
 *   (FR-050 `blocked: saves`, ERR-R03; copy literal de ERR-R03).
 * - `quotaType: "swipes"` → `429 blitz_quota_exceeded` + `resetAt` (FR-050
 *   `blocked: swipes`, ERR-R02; copy literal de ERR-R02). Con
 *   `BLITZ_DAILY_SWIPE_LIMIT = null` hoy no se alcanza, y está igual: el día que
 *   haya un número, el error tiene que salir bien sin tocar esta ruta.
 *
 * `resetAt` viaja en **ms de epoch**, que es lo que tipan
 * `contentQuotaExceededDetailsSchema`/`blitzQuotaExceededDetailsSchema` y lo que lee
 * `quotaResetAt` en `apps/web`. `core` lo da en ISO: se convierte acá.
 *
 * Todo lo demás pasa sin tocar.
 */
export function toBlitzRejection(e: unknown): unknown {
  if (!isDomainError(e) || e.code !== "blitz_quota_blocked") return e;
  const details = e.details ?? {};
  const resetAtMs = Date.parse(String(details["resetAt"]));

  if (details["quotaType"] === "saves") {
    const publicDetails: ContentQuotaExceededDetails = {
      count: Number(details["count"]),
      limit: Number(details["limit"]),
      resetAt: resetAtMs,
    };
    return new ApiRejection(
      429,
      "content_quota_exceeded",
      "Monthly content quota reached for your plan",
      { ...publicDetails },
    );
  }

  if (details["quotaType"] === "swipes") {
    const publicDetails: BlitzQuotaExceededDetails = { resetAt: resetAtMs };
    return new ApiRejection(
      429,
      "blitz_quota_exceeded",
      "Daily blitz swipe limit reached",
      {
        ...publicDetails,
      },
    );
  }

  // Un `blitz_quota_blocked` sin `quotaType` es un cambio en `core` que no pasó por
  // acá. Se deja salir como lo mapea `http/errors.ts` (402) en vez de adivinar cuál
  // de los dos cortes fue.
  return e;
}

/**
 * La fila de `suggestions` en la forma que pide el caso de uso.
 *
 * Tres campos de `Suggestion` **no tienen columna** y se completan con lo único
 * que no inventa nada:
 *
 *  - `textBoxes: []` y `slideCount: 1`. El caso de uso sólo los usa para validar y
 *    para armar el `Content` de dominio; `contents` no los persiste (las cajas viven
 *    en `content_text_boxes`, que se escriben al editar). La cola de discovery no
 *    produce ninguno de los dos.
 *  - `generatedText`/`aiExplanation` vacíos cuando la columna es `null`: el tipo de
 *    dominio los pide `string`, y al persistir un vacío vuelve a ser `null`.
 */
function toDomainSuggestion(row: SuggestionRow): Suggestion {
  if (!isBlitzContentType(row.contentType)) {
    // El enum de la base y el de `core` son los mismos cuatro valores; si divergen,
    // es un cambio de schema que no pasó por acá.
    throw new Error(`La sugerencia ${row.id} tiene un contentType desconocido.`);
  }
  return {
    id: row.id,
    companyId: row.companyId,
    contentType: row.contentType,
    generatedText: row.generatedText ?? "",
    aiExplanation: row.aiExplanation ?? "",
    remixSourceUrl: row.remixSourceUrl ?? undefined,
    sourceTrendingItemId: row.sourceTrendingItemId ?? undefined,
    influencerId: row.influencerId ?? undefined,
    angleId: row.angleId ?? undefined,
    textStylePresetId: row.textStylePresetId ?? undefined,
    status: row.status,
    textBoxes: [],
    slideCount: 1,
  };
}

interface AcceptanceContext {
  readonly tx: Transaction;
  readonly companyId: string;
  readonly clock: Clock;
  /** La sugerencia ya tomada con `FOR UPDATE SKIP LOCKED` en esta transacción. */
  readonly claimed: SuggestionRow;
  /** Ya validado contra `contentBuildPayloadSchema`. Ver `prepareBuildPayload`. */
  readonly buildPayload: unknown;
}

/**
 * El puerto `BlitzAcceptanceRepository` de `core`, sobre **la** transacción de la
 * petición.
 *
 * Se construye por petición y cierra sobre `tx`: el parámetro `transaction` que
 * pasa el caso de uso tiene que ser esa misma, y se comprueba en vez de usarse. Un
 * método que escribiera sobre otra transacción sería exactamente la escritura
 * fuera de la transacción que ADR-005 existe para impedir.
 *
 * Devuelve además `created()`: la fila de `contents` que se insertó, que es lo que
 * serializa la respuesta. El `Content` de dominio no tiene la forma del contrato.
 */
function acceptanceRepository(ctx: AcceptanceContext): {
  repository: BlitzAcceptanceRepository;
  created: () => ContentRow;
} {
  const scope = { companyId: ctx.companyId };
  let period: string | undefined;
  let createdRow: ContentRow | undefined;

  const sameTx = (transaction: unknown): void => {
    if (transaction !== ctx.tx) {
      throw new Error(
        "acceptBlitzSuggestionUseCase pasó una transacción distinta de la de la " +
          "petición. Todo —cobro, pieza y encolado— tiene que ir en una sola.",
      );
    }
  };

  const repository: BlitzAcceptanceRepository = {
    async findSuggestion(companyId, suggestionId, transaction) {
      sameTx(transaction);
      if (companyId !== ctx.companyId || suggestionId !== ctx.claimed.id) return null;
      return toDomainSuggestion(ctx.claimed);
    },

    async loadQuota(companyId, transaction): Promise<BlitzQuotaSnapshot> {
      sameTx(transaction);
      const locked = await lockLedger(ctx.tx, { companyId }, ctx.clock);

      // Ver la cabecera: para Free el cupo es el trial allowance, y su tope no está
      // en el PRD. Se corta **antes** de decidir nada; la transacción vuelve atrás
      // y no queda ni el lock.
      if (trialAllowanceGoverns(locked.plan) && TRIAL_CONTENT_ALLOWANCE === null) {
        throw quotaUncheckable(
          "Blitz acceptance is temporarily unavailable: the trial content allowance can't be checked right now.",
        );
      }

      period = locked.period;
      return {
        saves: {
          plan: locked.plan,
          includedUsed: locked.row.contentSavesUsed,
          purchasedRemaining: locked.row.contentSavesPurchased,
          overageUsed: locked.row.overageUnits,
          overageEnabled: locked.company.apiOverageEnabled,
          resetAt: nextBillingResetUtc(locked.now, locked.company.billingAnchorDay),
        },
        swipes: currentSwipesLedger({
          storedUsed: locked.row.dailySwipesUsed,
          storedResetAt: locked.row.dailySwipeResetAt,
          now: locked.now,
          dailyLimit: BLITZ_DAILY_SWIPE_LIMIT,
        }),
      };
    },

    async saveQuota(companyId, quota, transaction) {
      sameTx(transaction);
      if (period === undefined) throw new Error("saveQuota antes de loadQuota.");
      await quotaLedgerStore.writeCounters(ctx.tx, { companyId }, period, {
        contentSavesUsed: quota.saves.includedUsed,
        contentSavesPurchased: quota.saves.purchasedRemaining,
        overageUnits: quota.saves.overageUsed,
      });
      // El contador y su instante de reset juntos: ver `writeDailySwipes`.
      await quotaLedgerStore.writeDailySwipes(
        ctx.tx,
        { companyId },
        period,
        quota.swipes.used,
        quota.swipes.resetAt,
      );
    },

    async insertContent(content, transaction) {
      sameTx(transaction);
      if (period === undefined) throw new Error("insertContent antes de loadQuota.");
      createdRow = await contentRepository.create(ctx.tx, scope, {
        id: content.id,
        type: content.type,
        status: content.status,
        generatedText:
          content.generatedText === undefined || content.generatedText === ""
            ? null
            : content.generatedText,
        remixSourceUrl: content.remixSourceUrl ?? null,
        revision: content.revision,
        // DATA-008: nunca sale por la API; es lo único que el worker lee.
        buildPayload: ctx.buildPayload,
        // De qué bucket salió y a qué período: es lo que usa el reembolso del
        // worker si el build falla. El CHECK de la tabla exige los dos juntos.
        saveBucket: content.saveBucket,
        savePeriod: period,
      });
    },

    async markSuggestionPopped(companyId, suggestionId, transaction) {
      sameTx(transaction);
      const popped = await markSuggestionPopped(ctx.tx, { companyId }, suggestionId);
      if (!popped) {
        throw new Error(
          `La sugerencia ${suggestionId} no estaba \`queued\` al marcarla: el ` +
            "`FOR UPDATE` de `claimNextQueuedSuggestion` tenía que impedirlo.",
        );
      }
    },

    // La idempotencia la resuelve `withIdempotency` en el borde (ver la cabecera),
    // así que el caso de uso se llama **sin** key y estos dos no se alcanzan.
    async findIdempotencyRecord() {
      throw new Error("La idempotencia de POST /blitz vive en withIdempotency.");
    },
    async putIdempotencyRecord() {
      throw new Error("La idempotencia de POST /blitz vive en withIdempotency.");
    },
  };

  return {
    repository,
    created: () => {
      if (createdRow === undefined)
        throw new Error("El caso de uso no insertó la pieza.");
      return createdRow;
    },
  };
}

/** Por qué una sugerencia no se puede construir. Viaja en `details.reason`. */
export type UnbuildableReason =
  /** Planificada antes de la migración `0011`: no tiene media ni copy elegidas. */
  | "missing_build_plan"
  /** El `build_plan` no se entiende, o compone un payload que el contrato rechaza. */
  | "invalid_build_plan"
  /** Algún asset que eligió el refill ya no está `ready` o se borró. */
  | "media_unavailable";

/**
 * La sugerencia tomada no se puede construir. **No** es un `ApiRejection`: el
 * handler la reconoce, descarta la sugerencia en otra transacción y recién ahí
 * responde. Ver la cabecera.
 */
class UnbuildableSuggestion extends Error {
  override readonly name = "UnbuildableSuggestion";
  constructor(
    readonly suggestionId: string,
    readonly reason: UnbuildableReason,
    /** Para el log. Nunca sale al cliente. */
    readonly detail: string,
  ) {
    super(`suggestion ${suggestionId} is not buildable: ${reason} (${detail})`);
  }
}

/**
 * El `buildPayload` de la sugerencia tomada, o {@link UnbuildableSuggestion}.
 * Corre **antes** del cobro y dentro de su transacción.
 */
async function prepareBuildPayload(
  tx: Transaction,
  companyId: string,
  claimed: SuggestionRow,
  aspectRatio: Parameters<typeof acceptBlitzSuggestionUseCase>[1]["aspectRatio"],
): Promise<unknown> {
  const type = claimed.contentType;
  const parsed = parseSuggestionBuildPlan(claimed.buildPlan, type);
  if (!parsed.ok) {
    throw new UnbuildableSuggestion(
      claimed.id,
      parsed.reason === "missing_build_plan"
        ? "missing_build_plan"
        : "invalid_build_plan",
      parsed.reason,
    );
  }
  const plan = parsed.plan;

  // La media, viva y **retenida** hasta el commit: ver `lockLiveMedia`.
  const ids = [...new Set(selectionMediaIds(plan.media))];
  const live = new Map(
    (await lockLiveMedia(tx, { companyId }, ids)).map((m) => [m.mediaId, m.url]),
  );
  const perdidas = ids.filter((id) => !live.has(id));
  if (perdidas.length > 0) {
    throw new UnbuildableSuggestion(
      claimed.id,
      "media_unavailable",
      `media ${perdidas.join(", ")} deleted or not ready`,
    );
  }

  let payload: unknown;
  try {
    payload = composeBlitzBuildPayload(rebindMediaUrls(plan, live), {
      // FR-050: `aspectRatio` sólo aplica a slideshow. Si llega con otro tipo,
      // el caso de uso lo rechaza con 400 más abajo.
      aspectRatio: type === "slideshow" ? aspectRatio : undefined,
      textStylePresetId: claimed.textStylePresetId,
    });
  } catch (error: unknown) {
    throw new UnbuildableSuggestion(
      claimed.id,
      "invalid_build_plan",
      error instanceof Error ? error.message : String(error),
    );
  }

  // El mismo schema que revalida el worker en `toRenderJob`. Si esto falla es
  // un bug de `composeBlitzBuildPayload`, y lo correcto es no cobrar.
  const checked = contentBuildPayloadSchema.safeParse(payload);
  if (!checked.success) {
    throw new UnbuildableSuggestion(
      claimed.id,
      "invalid_build_plan",
      checked.error.issues.map((i) => `${i.path.join(".")}: ${i.code}`).join("; "),
    );
  }
  return checked.data;
}

/**
 * Una aceptación entera, dentro de `tx`. Lanza `ApiRejection` para los rechazos
 * de la ruta (perfil, cola vacía, trial) y deja pasar los del dominio.
 */
async function acceptNextSuggestion(
  tx: Transaction,
  args: {
    readonly companyId: string;
    readonly actorId: string;
    readonly contentType: SuggestionRow["contentType"] | undefined;
    readonly aspectRatio: Parameters<
      typeof acceptBlitzSuggestionUseCase
    >[1]["aspectRatio"];
    readonly queue: Queue;
    readonly clock: Clock;
  },
): Promise<ContentRow> {
  const { companyId } = args;

  // PRD:1023 — *"Perfil incompleto/fallido → Blitz devuelve
  // `409 company_profile_not_ready`"*. `company_profiles` tiene un único índice
  // por `companyId`, así que la primera fila del listado es la fila.
  //
  // `partial` (AI-016, análisis sin OCR) se trata como no listo. El PRD no
  // distingue "incompleto por el usuario" de "parcial por un motor ausente";
  // queda anotado como abierto.
  const profiles = await companyProfileRepository.list(tx, { companyId }, { limit: 1 });
  const profile = profiles.items[0];
  if (profile === undefined || profile.status !== "ready") {
    throw new ApiRejection(
      409,
      "company_profile_not_ready",
      "Finish your brand profile before running Blitz.",
    );
  }

  const claimed = await claimNextQueuedSuggestion(
    tx,
    { companyId },
    { contentType: args.contentType },
  );
  if (claimed === null) throw new EmptyQueueRejection();

  const buildPayload = await prepareBuildPayload(
    tx,
    companyId,
    claimed,
    args.aspectRatio,
  );

  const { repository, created } = acceptanceRepository({
    tx,
    companyId,
    clock: args.clock,
    claimed,
    buildPayload,
  });

  await acceptBlitzSuggestionUseCase(
    {
      clock: args.clock,
      queue: args.queue,
      // `contents.id` es `uuid`: el prefijo del `IdGenerator` de `core` (`cnt_…`)
      // no entra en la columna. El prefijo es una ayuda de lectura, no un contrato.
      ids: { newId: () => randomUUID() },
      repository,
    },
    {
      companyId,
      actorId: args.actorId,
      suggestionId: claimed.id,
      transaction: tx,
      aspectRatio: args.aspectRatio,
    },
  );

  return created();
}

export function registerBlitzRoutes(app: ZodApp): void {
  const { limiter, queue, clock, idempotency } = app.deps;

  /**
   * Pide que se rellene la cola de descubrimiento de este workspace.
   *
   * ## Por qué desde acá, y no desde un cron
   *
   * El catálogo declara con `scheduled` los trabajos que dispara un reloj, y
   * `discoveryRefill` **no lo tiene**: es por evento. El PRD nombra el evento
   * tres veces —al terminar el onboarding «arrancar el relleno de la discovery
   * queue» (PRD:759, 1890, 2006)— pero el onboarding todavía no tiene rutas.
   *
   * El otro momento en que el PRD promete el relleno es **éste**: con la cola
   * vacía, `FR-050` manda responder *«the queue replenishes in the
   * background»*. Hasta hoy esa frase era falsa — nada en todo el repo
   * insertaba una fila en `suggestions`. Encolar acá es lo que la vuelve
   * cierta.
   *
   * ## La clave rota, y por qué no es fija
   *
   * `singletonKey` acota cuántos jobs se crean: sin ella, un workspace cuyo
   * relleno falla encola uno por cada petición, y `POST /blitz` es una ruta
   * caliente. Pero el adaptador deriva de la clave un **id determinista y
   * permanente**, así que una clave fija por workspace haría que el refill se
   * encolara **una sola vez en la vida** y nunca más.
   *
   * Por eso lleva un cubo de tiempo: **un relleno por workspace por minuto**.
   * El número sale de `FR-050`/PRD:783, que promete ≥1 sugerencia lista en ≤5
   * min; un minuto deja cinco intentos dentro de esa promesa.
   *
   * ## No puede hundir la respuesta
   *
   * Si encolar falla, el usuario tiene que seguir recibiendo su 404 con el
   * mensaje de espera. Un error de la cola **no cambia lo que es cierto**: la
   * cola está vacía. Se loguea y sigue.
   */
  async function pedirRelleno(
    request: { log: { warn: (obj: object, msg: string) => void } },
    companyId: string,
  ): Promise<void> {
    if (queue === undefined) return;
    const minuto = Math.floor(clock.nowMs() / 60_000);
    try {
      await queue.enqueue<DiscoveryRefillJob>({
        queue: JOB_QUEUES.discoveryRefill,
        payload: { companyId },
        options: {
          singletonKey: `${JOB_QUEUES.discoveryRefill}:${companyId}:${String(minuto)}`,
        },
      });
    } catch (error: unknown) {
      request.log.warn(
        { companyId, error, queue: JOB_QUEUES.discoveryRefill },
        "no se pudo pedir el relleno de la discovery queue",
      );
    }
  }

  // ── GET /blitz/preferences ──
  app.get("/blitz/preferences", async (request) => {
    const companyId = request.auth.companyId;

    // `blitzPreferences` es 1:1 con la company: su PK **es** el `companyId`, y el
    // repositorio lo refleja. Por eso el id que se le pasa es el propio companyId.
    const row = await request.tx((tx) =>
      blitzPreferencesRepository.findById(tx, { companyId }, companyId),
    );

    // DATA-006: sin fila, se sintetizan defaults. **No se crea la fila**: leer no
    // escribe, y materializarla acá fijaría todos los campos por un GET.
    if (row === null) {
      return data({
        ...DEFAULT_BLITZ_PREFERENCES,
        angleWeights: {},
        textStyleWeights: {},
        settingsApplication: SETTINGS_APPLICATION,
      });
    }
    return data(toBlitzPreferences(row));
  });

  // ── PATCH /blitz/preferences ──
  app.patch(
    "/blitz/preferences",
    {
      schema: { body: updateBlitzPreferencesRequestSchema },
      // §9.6: límite dedicado de 3/min para este endpoint. Va en `preHandler` y no
      // después, al revés que la generación de ángulos: acá el PRD cuenta
      // actualizaciones, no actualizaciones exitosas.
      preHandler: rateLimit(limiter, "blitzPreferencesUpdate"),
    },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const patch = request.body;

      assertStorableInfluencerChance(patch.influencerChance);

      const row = await request.tx(async (tx) => {
        // `angleWeights` no se puede validar contra el schema: la regla de FR-055 es
        // que cubra **todos los ángulos activos de este workspace**, y eso sólo se
        // sabe leyendo la base. Se lee sólo cuando el patch lo trae.
        const activeIds =
          patch.angleWeights === undefined
            ? []
            : activeAngleIdsOf(await listAllAngles(tx, companyId));
        assertValidPreferencesPatch(patch, activeIds);

        // El upsert reescribe todas las columnas que recibe, así que hay que
        // mandarle la fila entera: patch sobre lo que ya había, o sobre los defaults
        // sintetizados si el workspace todavía no tiene fila. Mandar sólo el patch
        // dejaría los demás campos en su default de schema —no en el de DATA-006— y
        // un PATCH de `remixPercentage` resetearía el content mix.
        const current = await blitzPreferencesRepository.findById(
          tx,
          { companyId },
          companyId,
        );
        const base =
          current === null
            ? { ...DEFAULT_BLITZ_PREFERENCES, angleWeights: {}, textStyleWeights: {} }
            : {
                slideshowWeight: current.slideshowWeight,
                wallOfTextWeight: current.wallOfTextWeight,
                greenScreenWeight: current.greenScreenWeight,
                videoHookWeight: current.videoHookWeight,
                remixPercentage: current.remixPercentage,
                ownMediaPercentage: current.ownMediaPercentage,
                mentionBusinessPercentage: current.mentionBusinessPercentage,
                influencerChance: current.influencerChance,
                smartTextPositioning: current.smartTextPositioning,
                genderFilter: current.genderFilter,
                angleWeights: current.angleWeights,
                textStyleWeights: current.textStyleWeights,
              };

        // El merge va campo a campo y no con un spread, por dos razones:
        //  - con `exactOptionalPropertyTypes`, `{...base, ...patch}` produce
        //    `number | undefined` en cada peso y no compila contra columnas `notNull`;
        //  - `genderFilter: null` es un valor **legítimo** ("sin filtro"), así que un
        //    `patch.genderFilter ?? base.genderFilter` lo descartaría y el usuario no
        //    podría quitar nunca el filtro. La comparación tiene que ser con
        //    `undefined`, no con nullish.
        const saved = await blitzPreferencesRepository.upsert(
          tx,
          { companyId },
          {
            slideshowWeight: patched(patch.slideshowWeight, base.slideshowWeight),
            wallOfTextWeight: patched(patch.wallOfTextWeight, base.wallOfTextWeight),
            greenScreenWeight: patched(patch.greenScreenWeight, base.greenScreenWeight),
            videoHookWeight: patched(patch.videoHookWeight, base.videoHookWeight),
            remixPercentage: patched(patch.remixPercentage, base.remixPercentage),
            ownMediaPercentage: patched(
              patch.ownMediaPercentage,
              base.ownMediaPercentage,
            ),
            mentionBusinessPercentage: patched(
              patch.mentionBusinessPercentage,
              base.mentionBusinessPercentage,
            ),
            influencerChance: patched(patch.influencerChance, base.influencerChance),
            smartTextPositioning: patched(
              patch.smartTextPositioning,
              base.smartTextPositioning,
            ),
            genderFilter: patched(patch.genderFilter, base.genderFilter),
            angleWeights: patched(patch.angleWeights, base.angleWeights),
            textStyleWeights: patched(patch.textStyleWeights, base.textStyleWeights),
          },
        );
        if (saved === null) {
          throw new Error(
            "El upsert de `blitz_preferences` no devolvió fila. Ver la nota de " +
              "`persistAngleWeights`: con la PK igual al `companyId` no es alcanzable.",
          );
        }
        return saved;
      });

      // FR-055 regla 1: la respuesta describe que el cambio aplica a generaciones
      // futuras. La cola existente **no** se toca, ni acá ni en un job disparado
      // desde acá.
      return reply.status(200).send(data(toBlitzPreferences(row)));
    },
  );

  // ── POST /blitz ──
  app.post(
    "/blitz",
    {
      schema: {
        body: runBlitzRequestSchema,
        // Opcional: FR-050 (aclaración del 2026-09-21) y NFR-004. Ver la cabecera.
        headers: optionalIdempotencyHeaderSchema,
      },
    },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const body = request.body;

      // FR-050 Validation: `aspectRatio` sólo aplica a slideshow. Sólo se puede
      // comprobar cuando el cliente fijó el tipo; sin `contentType` lo elige la cola,
      // y el caso de uso lo vuelve a comprobar contra la sugerencia que sale.
      if (body.contentType !== undefined) {
        assertValidBlitzRequest({
          contentType: body.contentType,
          aspectRatio: body.aspectRatio,
        });
      }

      if (queue === undefined) {
        // ADR-005: el build se encola **dentro** de la transacción que descuenta la
        // cuota. Sin cola, crear el `Content` en `BUILDING` lo dejaría colgado para
        // siempre — y sin job que falle, tampoco habría reembolso del save. Fallar
        // acá es estrictamente mejor que crear la fila.
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Content builds are temporarily unavailable.",
          },
        });
      }

      const accept = (): Promise<ReturnType<typeof toContent>> =>
        request.tx(async (tx) =>
          toContent(
            await acceptNextSuggestion(tx, {
              companyId,
              actorId: request.auth.userId ?? request.auth.apiKeyId ?? "unknown",
              contentType: body.contentType,
              aspectRatio: body.aspectRatio,
              queue,
              clock,
            }),
          ),
        );

      const key = idempotencyKeyOf(request.headers);
      try {
        if (key === "") return reply.status(202).send(data(await accept()));
        // Un rechazo (cuota, cola vacía, perfil) se lanza **dentro** de
        // `withIdempotency`, que libera la key en su `catch` (§9.3, regla 3): un
        // rechazo determinista nunca quema la key.
        return await withIdempotency(
          idempotency,
          request,
          reply,
          { key, route: "POST /blitz", body, successStatus: 202 },
          accept,
        );
      } catch (e: unknown) {
        if (e instanceof UnbuildableSuggestion) {
          // La transacción de la aceptación ya volvió atrás: nada se cobró. Se
          // descarta en una propia para que la próxima petición tome otra, y
          // se pide relleno porque la cola acaba de perder una.
          let discarded = false;
          try {
            discarded = await request.tx((tx) =>
              discardQueuedSuggestion(tx, { companyId }, e.suggestionId),
            );
          } catch (error: unknown) {
            request.log.error(
              { error, suggestionId: e.suggestionId },
              "no se pudo descartar la sugerencia no construible",
            );
          }
          request.log.warn(
            {
              suggestionId: e.suggestionId,
              reason: e.reason,
              detail: e.detail,
              discarded,
            },
            "sugerencia no construible: descartada sin cobrar",
          );
          await pedirRelleno(request, companyId);
          throw new ApiRejection(
            422,
            "content_unavailable_for_type",
            "That suggestion can't be built anymore, so it was skipped and nothing was charged. Try again to get the next one.",
            { reason: e.reason, suggestionId: e.suggestionId, discarded },
          );
        }
        if (e instanceof EmptyQueueRejection) {
          // **Lo que hace cierto al mensaje.** Ver `pedirRelleno`: sin esto,
          // «the queue replenishes in the background» era una promesa que nada
          // cumplía. Va fuera de la transacción, que ya volvió atrás.
          await pedirRelleno(request, companyId);
        }
        throw toBlitzRejection(e);
      }
    },
  );
}
