/**
 * `AcceptBlitzSuggestion` — el flujo central del producto.
 * PRD `FR-050`; IMPL §2.3 y ADR-005.
 *
 * La secuencia, literal de IMPL §2.3, **toda dentro de una transacción**:
 *
 *   valida cuota (saves y luego swipes)
 *     → reserva idempotencia
 *       → crea Content(status=BUILDING)
 *         → encola el job de build **en la MISMA transacción**
 *
 * El último paso es la razón de ser de media arquitectura y conviene no
 * perderla de vista al leer este archivo:
 *
 *   El PRD exige que un build fallido **reembolse** el content save. Para
 *   reembolsar con certeza hay que saber que el job existe. Si el encolado
 *   ocurriera fuera de la transacción —una cola en Redis, por ejemplo—, un
 *   fallo entre el commit y el push deja **cuota consumida sin trabajo**: el
 *   usuario pagó un save por una pieza que nadie va a construir, y como no hay
 *   job, tampoco hay nada que falle y dispare el reembolso. El save se pierde
 *   en silencio y no hay forma de detectarlo desde adentro.
 *
 * Por eso este caso de uso **recibe la transacción y no la abre**. Quien la
 * abre es el borde, que también decide el aislamiento y el reintento. Si el
 * caso de uso la abriera, sería imposible componerlo con nada —programar un
 * post junto con aceptar, por ejemplo— sin transacciones anidadas.
 *
 * Y por eso `queue.enqueue` va **último**: es la operación que puede fallar
 * por una causa externa (la cola no responde). Fallando último, todo lo demás
 * ya está en la transacción y el `throw` la aborta entera. Fallando primero,
 * habría que deshacer a mano.
 */
import type { Clock, EnqueuedJob, Queue, QueueTransaction } from "@fastgram/ports";
import { JOB_QUEUES } from "../jobs/queues.js";
import type { ContentBuildJob } from "../jobs/content-build.js";
import { DomainError, crossTenantAsNotFound } from "../errors.js";
import type { IdGenerator } from "../ids.js";
import {
  acceptBlitzSuggestion as gateBlitzQuota,
  type SavesLedger,
  type SwipesLedger,
} from "../quota/content-saves.js";
import {
  completeIdempotency,
  reserveIdempotency,
  type IdempotencyRecord,
} from "../idempotency.js";
import {
  assertValidBlitzRequest,
  createBuildingContent,
  type AspectRatio,
  type BlitzContentType,
  type Content,
} from "./content.js";
import { assertValidTextBoxes, type ContentTextBox } from "./text-boxes.js";

/**
 * Nombre de la cola — §9.5 #3. Sale de {@link JOB_QUEUES}, que es la lista que
 * el catálogo del worker consume.
 *
 * Acá decía `"build-content"`, tomado del diagrama de IMPL §2.3, mientras el
 * catálogo escuchaba `"content-build"`. El worker que consume tiene que usar
 * exactamente el mismo string: con dos, el job entra en una cola que nadie lee,
 * la pieza queda en `BUILDING` para siempre y —esto es lo malo— **nunca
 * falla**, así que el save tampoco se reembolsa. Ganó el catálogo porque es la
 * enumeración completa de los 21 y es lo que el consumidor escucha; el diagrama
 * de IMPL quedó corregido.
 */
export const CONTENT_BUILD_QUEUE = JOB_QUEUES.contentBuild;

/** El endpoint que reserva la key. `DATA-027.endpoint`. */
export const BLITZ_ACCEPT_ENDPOINT = "POST /blitz";

/** `DATA-007`. La cola de descubrimiento (`AI-002`) la produce. */
export interface Suggestion {
  readonly id: string;
  readonly companyId: string;
  readonly contentType: BlitzContentType;
  readonly generatedText: string;
  /**
   * `FR-050`, criterio 3: «muestra el racional almacenado con la sugerencia,
   * **nunca uno generado al vuelo**». Por eso viaja con ella y no se recalcula.
   */
  readonly aiExplanation: string;
  readonly remixSourceUrl?: string | undefined;
  readonly sourceTrendingItemId?: string | undefined;
  readonly influencerId?: string | undefined;
  readonly angleId?: string | undefined;
  readonly textStylePresetId?: string | undefined;
  readonly status: "queued" | "popped" | "discarded";
  readonly textBoxes: readonly ContentTextBox[];
  readonly slideCount: number;
}

export interface BlitzQuotaSnapshot {
  readonly saves: SavesLedger;
  readonly swipes: SwipesLedger;
}

/**
 * El payload que recibe el worker de build.
 *
 * Vive en `jobs/content-build.ts` y se re-exporta acá porque este archivo lo
 * tenía primero. La forma que había —con `suggestionId` obligatorio y
 * `contentType` acotado a los tipos de Blitz— **no la podía usar
 * `POST /content`**, así que esa ruta inventó la suya y la cola terminó con dos
 * payloads y ningún consumidor que reconociera a los dos. Ver ahí el porqué.
 */
export type { ContentBuildJob };

/**
 * Puerto de salida del caso de uso.
 *
 * Cada método lleva `transaction` porque **todo ocurre en la misma**. Un
 * método sin ese parámetro sería una escritura fuera de la transacción, que es
 * precisamente el bug que este diseño existe para hacer imposible.
 */
export interface BlitzAcceptanceRepository {
  findSuggestion(
    companyId: string,
    suggestionId: string,
    transaction: QueueTransaction,
  ): Promise<Suggestion | null>;

  loadQuota(
    companyId: string,
    transaction: QueueTransaction,
  ): Promise<BlitzQuotaSnapshot>;

  saveQuota(
    companyId: string,
    quota: BlitzQuotaSnapshot,
    transaction: QueueTransaction,
  ): Promise<void>;

  insertContent(content: Content, transaction: QueueTransaction): Promise<void>;

  markSuggestionPopped(
    companyId: string,
    suggestionId: string,
    transaction: QueueTransaction,
  ): Promise<void>;

  findIdempotencyRecord(
    companyId: string,
    key: string,
    transaction: QueueTransaction,
  ): Promise<IdempotencyRecord | null>;

  putIdempotencyRecord(
    record: IdempotencyRecord,
    transaction: QueueTransaction,
  ): Promise<void>;
}

export interface AcceptBlitzSuggestionDeps {
  readonly clock: Clock;
  readonly queue: Queue;
  readonly ids: IdGenerator;
  readonly repository: BlitzAcceptanceRepository;
}

export interface AcceptBlitzSuggestionInput {
  readonly companyId: string;
  /** Quién lo pide. Sólo se usa para el log del intento cruzado. */
  readonly actorId: string;
  readonly suggestionId: string;
  /** La abre el borde. Ver la cabecera. */
  readonly transaction: QueueTransaction;
  readonly aspectRatio?: AspectRatio | undefined;
  /**
   * `NFR-004` la hace obligatoria en toda operación facturable, y aceptar una
   * sugerencia lo es. `FR-050` dice además que la operación «no es
   * idempotente: nunca reintentar automáticamente un timeout o 5xx».
   *
   * No se contradicen, y la resolución es la que implementa este campo: **sin
   * key la operación no es idempotente** —reintentar a ciegas cobra dos
   * saves—, y **con key sí lo es**. Por eso es opcional y por eso el mensaje
   * del cliente es "no reintentes solo", no "no existe la idempotencia".
   */
  readonly idempotencyKey?: string | undefined;
  /** Huella del cuerpo, calculada en el borde. Ver `idempotency.ts`. */
  readonly requestHash?: string | undefined;
}

export interface AcceptBlitzSuggestionOutput {
  readonly content: Content;
  readonly saves: SavesLedger;
  readonly swipes: SwipesLedger;
  readonly job: EnqueuedJob;
  /** `true` si la respuesta salió de una reserva de idempotencia ya cerrada. */
  readonly replayed: boolean;
}

/**
 * El caso de uso.
 *
 * Se llama `...UseCase` y no `acceptBlitzSuggestion` porque ese nombre ya lo
 * tiene la función de `quota/content-saves.ts`, que es la que decide los dos
 * ledgers. Son cosas distintas y conviene que se noten distintas: aquélla es
 * pura y decide cuánto se cobra; ésta orquesta la transacción entera.
 */
export async function acceptBlitzSuggestionUseCase(
  deps: AcceptBlitzSuggestionDeps,
  input: AcceptBlitzSuggestionInput,
): Promise<AcceptBlitzSuggestionOutput> {
  const { repository, queue, clock, ids } = deps;
  const now = clock.now();

  // ── 0. La sugerencia, con scope ──────────────────────────────────────────
  const suggestion = await repository.findSuggestion(
    input.companyId,
    input.suggestionId,
    input.transaction,
  );
  if (suggestion === null) {
    throw new DomainError("not_found", "Suggestion not found.", {
      suggestionId: input.suggestionId,
    });
  }
  // Segunda capa de defensa (IMPL §2.4). El repositorio ya filtra por
  // `companyId`; esto cubre el día en que a una consulta le falte el `WHERE`.
  // Cuesta una comparación y evita una fuga cruzada silenciosa.
  if (suggestion.companyId !== input.companyId) {
    throw crossTenantAsNotFound("suggestion", suggestion.id, input.actorId);
  }

  if (suggestion.status !== "queued") {
    throw new DomainError(
      "invalid_state",
      suggestion.status === "popped"
        ? "That suggestion was already used."
        : "That suggestion was discarded.",
      { suggestionId: suggestion.id, status: suggestion.status },
    );
  }

  assertValidBlitzRequest({
    contentType: suggestion.contentType,
    aspectRatio: input.aspectRatio,
  });
  // Las cajas se validan **si vienen**. `DATA-007` (PRD:2081) no le da cajas a una
  // `Suggestion` —`generatedText` y nada de layout— y la cola de discovery no las
  // produce: la composición del texto es trabajo del build (FR-050, *"dibujado de
  // overlays"*), no un dato de la sugerencia. Exigir al menos una acá hacía
  // imposible aceptar cualquier sugerencia real (`POST /blitz` respondía `400`
  // `A piece needs at least one text box.`, visto en `blitz-accept.int.test.ts`).
  if (suggestion.textBoxes.length > 0) assertValidTextBoxes(suggestion.textBoxes);

  // ── 1. ¿Es un replay? ────────────────────────────────────────────────────
  // La LECTURA de la key va antes del gate de cuota y la ESCRITURA va después,
  // y la separación es deliberada: si esta petición ya se completó, cobrarle
  // el save y el swipe antes de darnos cuenta sería exactamente el doble cobro
  // que la key existe para evitar. Que el gate sea una función pura ayuda,
  // pero no hay que depender de eso.
  const useKey = input.idempotencyKey !== undefined;
  let reservation: IdempotencyRecord | undefined;

  if (useKey) {
    if (input.requestHash === undefined) {
      throw new DomainError(
        "conflict",
        "An idempotency key needs a request fingerprint.",
        { key: input.idempotencyKey },
      );
    }
    const existing = await repository.findIdempotencyRecord(
      input.companyId,
      input.idempotencyKey as string,
      input.transaction,
    );
    const decision = reserveIdempotency(existing, {
      key: input.idempotencyKey as string,
      companyId: input.companyId,
      endpoint: BLITZ_ACCEPT_ENDPOINT,
      requestHash: input.requestHash,
      now,
    });
    if (decision.kind === "replay") {
      // `responseSnapshot` es `unknown` porque el repositorio lo guardó como
      // JSON y el dominio no puede probar su forma. El `as` es el único de
      // este archivo y está acotado a eso: quien deserializa es el adaptador,
      // y si algún día cambia la forma de la respuesta, el snapshot viejo se
      // devuelve tal cual —que es lo correcto: la idempotencia promete
      // **aquella** respuesta, no una traducida a la versión de hoy.
      return {
        ...(decision.response as Omit<AcceptBlitzSuggestionOutput, "replayed">),
        replayed: true,
      };
    }
    reservation = decision.record;
  }

  // ── 2. Cuota: saves y LUEGO swipes ───────────────────────────────────────
  // El orden lo fija `quota/content-saves.ts` y está argumentado ahí: sin
  // saves la acción no puede completarse, así que cobrar el swipe primero le
  // gasta al usuario un swipe diario —que no se recupera hasta mañana— por una
  // operación que igual iba a fallar.
  const quota = await repository.loadQuota(input.companyId, input.transaction);
  const gated = gateBlitzQuota(quota.saves, quota.swipes);

  // ── 3. Reserva de idempotencia ───────────────────────────────────────────
  if (reservation !== undefined) {
    await repository.putIdempotencyRecord(reservation, input.transaction);
  }

  // ── 4. La pieza, en BUILDING ─────────────────────────────────────────────
  const content = createBuildingContent({
    id: ids.newId("cnt"),
    companyId: input.companyId,
    type: suggestion.contentType,
    saveBucket: gated.bucket,
    textBoxes: suggestion.textBoxes,
    slideCount: suggestion.slideCount,
    generatedText: suggestion.generatedText,
    remixSourceUrl: suggestion.remixSourceUrl,
    angleId: suggestion.angleId,
    suggestionId: suggestion.id,
    // `green-screen` nunca lleva influencer y uno sin entrenar degrada a
    // contenido regular: las dos reglas viven en `resolveInfluencerForType`.
    // Acá la sugerencia ya trae el influencer resuelto por `AI-002`, así que
    // sólo queda la guarda de formato.
    influencerId:
      suggestion.contentType === "green-screen" ? undefined : suggestion.influencerId,
  });

  await repository.insertContent(content, input.transaction);
  await repository.saveQuota(
    input.companyId,
    { saves: gated.saves, swipes: gated.swipes },
    input.transaction,
  );
  await repository.markSuggestionPopped(
    input.companyId,
    suggestion.id,
    input.transaction,
  );

  // ── 5. El encolado, EN LA MISMA TRANSACCIÓN y último ──────────────────────
  const payload: ContentBuildJob = {
    companyId: input.companyId,
    contentId: content.id,
    contentType: suggestion.contentType,
    aspectRatio: input.aspectRatio,
    suggestionId: suggestion.id,
    influencerId: content.influencerId,
    revision: content.revision,
    reason: "blitz",
  };

  const job = await queue.enqueue<ContentBuildJob>({
    queue: CONTENT_BUILD_QUEUE,
    payload,
    options: {
      transaction: input.transaction,
      // Un build por pieza. El id de la pieza es nuevo en cada aceptación, así
      // que esto no deduplica aceptaciones distintas — deduplica reintentos
      // del mismo encolado, que es lo que puede pasar si la transacción se
      // reintenta por un deadlock.
      singletonKey: `${CONTENT_BUILD_QUEUE}:${content.id}`,
      retryLimit: 2,
      retryBackoff: true,
    },
  });

  const output: Omit<AcceptBlitzSuggestionOutput, "replayed"> = {
    content,
    saves: gated.saves,
    swipes: gated.swipes,
    job,
  };

  if (reservation !== undefined) {
    await repository.putIdempotencyRecord(
      completeIdempotency(reservation, output),
      input.transaction,
    );
  }

  return { ...output, replayed: false };
}
