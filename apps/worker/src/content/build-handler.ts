/**
 * El handler de `content-build` — PRD §9.5.3, `FR-050`, IMPL §2.3.
 *
 * Es el que cierra el círculo. Hasta acá `POST /content` creaba la pieza,
 * **cobraba el content save** y encolaba el job, y del otro lado no había
 * nadie: la pieza quedaba en `BUILDING` para siempre y el save cobrado no se
 * devolvía nunca, porque quien tiene que devolverlo es justamente el build que
 * falla.
 *
 * ## La forma: leer corto, trabajar largo, escribir corto
 *
 * ```
 *   [tx 1]  bloquear la fila, leer buildPayload            ~ms
 *           render + subida a storage                      30 s – 2 min
 *   [tx 2]  bloquear otra vez, comprobar, escribir         ~ms
 * ```
 *
 * El render **no** puede ocurrir dentro de una transacción. `NFR-001` acota un
 * build a 30 s – 2 min: una transacción abierta ese tiempo mantiene la fila
 * bloqueada contra el `PATCH` del usuario, retiene una conexión del pool por
 * cada build en vuelo y, si el proceso se cae, deja la transacción colgada
 * hasta que el servidor la limpie. Con `NFR-025` hablando de 10 builds por
 * minuto, eso es el pool entero.
 *
 * El precio de partirlo en dos es que entre las dos transacciones el mundo se
 * mueve, y de ahí sale casi todo lo demás que hace este archivo.
 *
 * ## Las cuatro cosas que no se pueden romper
 *
 * 1. **La `revision` se comprueba al escribir, no sólo al leer.** Si entre las
 *    dos transacciones el usuario editó la pieza, la revisión subió y hay otro
 *    build en camino. Escribir el resultado viejo publicaría el render
 *    **anterior** a la edición, con la `revision` nueva puesta — y sin error.
 *    Se descarta el resultado y se borra lo subido.
 *
 * 2. **El reembolso ocurre una sola vez.** El puerto `Queue` dice que el
 *    handler puede reintentarse; sin guarda, cada reintento sería un save
 *    gratis. La guarda es `contents.saveRefundedAt`, se lee con la fila
 *    bloqueada y la base la sostiene con un CHECK.
 *
 * 3. **Un fallo transitorio se reintenta; el último intento marca `FAILED`.**
 *    Relanzar siempre deja la pieza en `BUILDING` cuando la cola se rinde, que
 *    es el bug que este archivo existe para cerrar. Por eso el último intento
 *    no relanza: cierra la pieza y devuelve el save. `maxAttempts` sale del
 *    job, no de una constante escrita acá — ver {@link JobContext}.
 *
 * 4. **Un fallo permanente no se reintenta nunca.** Un `buildPayload` que no
 *    parsea no va a parsear la tercera vez; reintentarlo sólo retrasa el
 *    reembolso y ensucia la dead-letter con algo que no es un fallo de
 *    infraestructura.
 *
 * ## Lo que este handler NO hace todavía
 *
 * - **`prompt` / `mentionBusiness` fuera de `regenerate` y `create`** — un
 *   job de otro `reason` que los traiga los ignora.
 *
 * ## `custom`: normalización, no render (sprint 7)
 *
 * Las piezas de `POST /content/custom/video` guardan la clave del archivo en
 * `buildPayload.customVideo`. Su build es normalización + thumbnail (§9.5 #7)
 * con el renderer **de normalización** (`deps.normalizer`), no un render: ver
 * `custom-video.ts`. Una fila vieja sin esa clave cierra `FAILED` con
 * `custom_not_renderable`, como antes (no cobran save: nada que devolver).
 *
 * ## `create` con `prompt`: el texto lo escribe la IA (Content Studio)
 *
 * `POST /content/studio` con `ai` encola `reason: "create"` + `prompt`. Pasa
 * por el mismo camino que `regenerate` —el LLM reescribe las cajas derivadas
 * del payload **antes** de renderizar, y las cajas se guardan con el
 * render—, pero cierra como **build**: si el modelo falta o falla, `FAILED` +
 * reembolso, nunca una pieza con el borrador como si fuera el texto de la IA.
 *
 * ## `regenerate` (`AI-004`): el copy se reescribe acá
 *
 * Un job con `reason: "regenerate"` pasa por el LLM **antes** de renderizar:
 *
 * ```
 *   [tx 1]  bloquear, leer cajas (guardadas o derivadas) + perfil de marca
 *           LLM (fuera de transacción, como el render)
 *           render con las cajas nuevas + subida
 *   [tx 2]  bloquear, comprobar revisión, guardar las cajas nuevas, CREATED
 * ```
 *
 * Las cajas nuevas se escriben **en la transacción 2**, con los archivos, y no
 * apenas contesta el modelo: si el render fallara después, la pieza volvería a
 * `CREATED` con los archivos viejos y las cajas nuevas — el editor mostraría un
 * texto que el video no tiene. Juntas, o las dos o ninguna. Y como el `PATCH`,
 * se guardan **todas** las cajas (las derivadas también): son el estado
 * completo del texto que después lee `GET /content/:id/editable`.
 *
 * Un fallo del modelo cierra como cualquier rebuild fallido (`CREATED`, los
 * archivos de antes, sin reembolso) con un código propio: `llm_not_configured`
 * sin modelo para la tarea `text`, `llm_failed` si el proveedor falló (se
 * reintenta si el error es transitorio), `copy_rejected` si la respuesta no
 * pasó la validación de `core`.
 *
 * ## El mismo motor sirve a `content-rebuild`
 *
 * {@link createContentRenderHandler} es el motor; `content-build` y
 * `content-rebuild` (`rebuild-handler.ts`) son dos entradas. Leer, renderizar,
 * subir y escribir son idénticos. Lo que cambia es **cómo se cierra un fallo**,
 * y ahí está el dinero:
 *
 * | | build (`FR-050`) | rebuild (`FR-051`) |
 * |---|---|---|
 * | cobró un save | sí, `POST /content` | **no** (PRD:1186, FLOW-008) |
 * | fallo definitivo | `FAILED` + reembolso | `CREATED` con los `files` anteriores + `lastEdit` fallido (PRD:1204) |
 *
 * Un rebuild que reembolsara devolvería el save **del build original, que sí
 * se entregó**: un save gratis por cada edición que falla. Y marcarlo `FAILED`
 * mataría una pieza que el PRD dice que sigue usable.
 *
 * El modo lo decide la cola **o** el `reason` del job: un job de edición que
 * haya quedado en la cola `content-build` —la API los encolaba ahí antes de que
 * existiera `content-rebuild`— se cierra como rebuild igual.
 */

import {
  brandDefaultLogo,
  brandTextFamilies,
  effectiveLogo,
  isBlitzContentType,
  parseContentBuildJob,
  readDesignSystemTokens,
  readStoredAssets,
  readStoredFontFiles,
  stampBrandLook,
  type BlitzContentType,
  type ContentBuildJob,
  type ContentTextBox,
  type CopyBrandProfile,
  type SaveBucket,
} from "@fastgram/core";
import {
  brandStrategyRepository,
  companyProfileRepository,
  companyRepository,
  contentBuildStore,
  contentRepository,
  contentTextBoxRepository,
  designSystemRepository,
  withCompany,
  type Database,
  type Transaction,
} from "@fastgram/db";
import {
  PortError,
  type Clock,
  type JobContext,
  type JobHandler,
  type MediaRenderer,
  type RenderedMedia,
  type Storage,
  type StorageKey,
} from "@fastgram/ports";
import { canonicalObjectUrl } from "@fastgram/adapters";
import { mediaUrlsOf, workspaceMediaAuthorization } from "./media-authorization.js";

import { refundContentSave } from "../support/quota.js";
import {
  regenerateTextBoxes,
  regenerationBoxesOf,
  type CopyLlmProvider,
} from "./regenerate.js";
import { contentBuildPayloadSchema } from "@fastgram/contracts";
import {
  toEditedRenderJob,
  toRenderJob,
  withBrandLook,
  type ActiveBrandLook,
} from "./render-job.js";
import { isReelRenderer, reelMediaAuthorization, reelSpecOf } from "./reel-job.js";
import {
  buildCustomVideo,
  parseCustomVideoPayload,
  type CustomVideoBuild,
  type CustomVideoSource,
} from "./custom-video.js";

/** Lo mínimo que el handler necesita loguear. `pino` lo cumple. */
export interface BuildLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface ContentBuildDeps {
  readonly db: Database;
  readonly renderer: MediaRenderer;
  readonly storage: Storage;
  readonly clock: Clock;
  /**
   * Rol para el `SET LOCAL ROLE` de cada transacción. Sin él, un proceso
   * conectado como superusuario **saltea RLS por completo** y el aislamiento
   * deja de existir sin que nada avise.
   */
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  /** Prefijo de las claves del bucket, sin barra final. */
  readonly objectPrefix?: string;
  /**
   * `AI-004`: el LLM de la tarea `text`, resuelto **en cada job**. Sin él (o si
   * devuelve `null`) un `regenerate` cierra con `llm_not_configured` y la
   * versión anterior: nunca se renderiza el copy viejo declarándolo regenerado
   * (trampa 30).
   */
  readonly copyLlm?: CopyLlmProvider | undefined;
  /** Sólo tests: la marca del contenedor de `containUntrusted`. */
  readonly fence?: (() => string) | undefined;
  /**
   * Sprint 7: el renderer de **normalización** para las piezas `custom`
   * (`custom-video.ts`). `null`/ausente = sin servicio de render: la pieza
   * queda con el original y la marca `not_normalized`.
   */
  readonly normalizer?: MediaRenderer | null | undefined;
}

/**
 * Códigos de `PortError` que vale la pena reintentar.
 *
 * El resto —`bad_request`, `not_found`, `provider_contract_violation`— son
 * deterministas: la segunda corrida produce el mismo error. `not_found` es el
 * que más tienta a reintentar, y es el que menos conviene: significa que una
 * URL del payload no resuelve, y esperar 15 segundos no la va a hacer aparecer.
 */
const RETRYABLE_PORT_CODES: ReadonlySet<string> = new Set([
  "provider_unavailable",
  "timeout",
  "rate_limited",
]);

/** Un fallo que ya sabe si merece otro intento. */
interface BuildFailure {
  /** Para el log. Puede llevar el mensaje del proveedor. */
  readonly reason: string;
  /**
   * Código estable, sin texto del proveedor. Es lo que el rebuild deja en
   * `lastEdit`, que **sale por la API** tal cual (`toContent`).
   */
  readonly code: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

const permanent = (reason: string, code: string, cause?: unknown): BuildFailure =>
  cause === undefined
    ? { reason, code, retryable: false }
    : { reason, code, retryable: false, cause };

function classify(error: unknown): BuildFailure {
  if (error instanceof PortError) {
    return {
      reason: `${error.code}: ${error.message}`,
      code: error.code,
      retryable: RETRYABLE_PORT_CODES.has(error.code),
      cause: error,
    };
  }
  // Un error que no es del puerto es un bug nuestro o una caída de la base.
  // Se marca reintentable porque la mayoría de las caídas de infraestructura
  // caen acá, y un bug determinista termina igual en `FAILED` al último intento.
  return {
    reason: error instanceof Error ? error.message : "unknown build error",
    code: "internal_error",
    retryable: true,
    cause: error,
  };
}

/**
 * Qué cola trajo el job. `rebuild` = `content-rebuild`; ver la cabecera.
 */
export type ContentJobQueueKind = "build" | "rebuild";

/**
 * Los `reason` que describen una edición de una pieza que ya se construyó.
 *
 * Un job con uno de éstos se cierra como rebuild aunque venga por la cola
 * `content-build`: es una pieza con una versión anterior usable y un save que
 * se cobró y **se entregó**.
 */
const EDIT_REASONS: ReadonlySet<string> = new Set(["edit", "regenerate"]);

/**
 * Qué `kind` de `lastEdit` escribir al cerrar un rebuild fallido.
 *
 * La API escribe `minor` o `regenerate` al aceptar la edición; se conserva el
 * mismo vocabulario para que el fallo se lea como el fallo **de esa** edición.
 */
function editKindOf(job: ContentBuildJob, lastEdit: unknown): string {
  if (job.reason === "edit") return "minor";
  if (job.reason === "regenerate") return "regenerate";
  if (typeof lastEdit === "object" && lastEdit !== null) {
    const kind = (lastEdit as Record<string, unknown>)["kind"];
    if (typeof kind === "string") return kind;
  }
  return "rebuild";
}

/** Lo que se lee de la fila antes de trabajar. */
interface BuildSubject {
  readonly buildPayload: unknown;
  readonly contentType: string;
  readonly revision: number;
  /**
   * Sólo en un rebuild: las cajas del editor (`content_text_boxes`), leídas con
   * la fila bloqueada. Si hay, se aplican sobre `buildPayload` antes de
   * renderizar (`toEditedRenderJob`). Vacío = pieza sin cajas, el payload va
   * tal cual.
   */
  readonly textBoxes?: readonly ContentTextBox[];
  /**
   * Sólo en un rebuild: `contents.studioState`, donde viven los swaps de media
   * del editor (`PU-EDIT-003`). `toEditedRenderJob` los aplica sobre el
   * `buildPayload` original.
   */
  readonly studioState?: unknown;
  /**
   * Sólo en un `regenerate`: lo que el LLM necesita, leído con la fila
   * bloqueada. `boxes` son las guardadas o, si no hay, las derivadas del
   * payload — las mismas que el editor ve en `GET /content/:id/editable`.
   */
  readonly regenerate?: {
    readonly contentType: BlitzContentType;
    readonly boxes: readonly ContentTextBox[];
    readonly businessName: string;
    readonly profile: CopyBrandProfile;
    /** Sprint 7: el idioma de la estrategia guardada (`null` = el de los textos). */
    readonly language?: string | null;
  };
}

/**
 * Sprint 9 (S): lo que el build clásico lleva de la marca. `look` = el design
 * system activo (fuentes y logo para el render); `stamped` = el payload con la
 * marca estampada en el primer build, que el commit persiste.
 */
interface BrandContext {
  readonly look: ActiveBrandLook | null;
  readonly stamped: Record<string, unknown> | null;
}

type ReadOutcome =
  | {
      readonly kind: "build";
      readonly subject: BuildSubject;
      readonly brand?: BrandContext;
    }
  /** Una pieza `custom` con su archivo localizado: normalización, no render. */
  | {
      readonly kind: "custom";
      readonly source: CustomVideoSource;
      readonly buildPayload: Record<string, unknown>;
    }
  /** No hay nada que hacer y no es un error: la pieza se borró, ya está lista, o el job es viejo. */
  | { readonly kind: "skip"; readonly why: string }
  | { readonly kind: "fail"; readonly failure: BuildFailure };

/** El tope del repositorio (`PAGINATION.limitMax`). Pedir más lo recorta igual. */
const TEXT_BOX_PAGE_SIZE = 100;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Todas las cajas de la pieza, **no la primera página**: un slideshow de 20
 * slides con seis cajas pasa de 100, y quedarse con la página 1 renderizaría
 * una pieza a la que le faltan textos. Mismo recorrido que `listAllTextBoxes`
 * de la API (`routes/v1/content.ts`).
 *
 * Las columnas `jsonb` vuelven como `unknown`. Acá sólo se comprueba que sean
 * objetos —para que la validación de `core` no explote con un `TypeError` sobre
 * un `null`—; los rangos y las claves los valida `applyTextBoxesToBuildPayload`
 * con `assertValidTextBoxes`, la misma regla que aceptó el `PATCH`. Una fila
 * con forma rota se entrega igual y `core` la rechaza con código estable.
 */
async function listAllTextBoxes(
  tx: Transaction,
  companyId: string,
  contentId: string,
): Promise<ContentTextBox[]> {
  const all: ContentTextBox[] = [];
  let cursor: string | undefined;
  for (;;) {
    const chunk = await contentTextBoxRepository.list(
      tx,
      { companyId },
      {
        filter: { contentId: { eq: contentId } },
        limit: TEXT_BOX_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      },
    );
    for (const row of chunk.items) {
      const shaped =
        isRecord(row.position) &&
        isRecord(row.font) &&
        isRecord(row.stroke) &&
        (row.background === null || isRecord(row.background));
      // Una caja con JSON que no es objeto se manda con geometría imposible:
      // `assertValidTextBoxes` la rechaza y el rebuild cierra con código
      // estable en vez de un `TypeError` reintentable.
      all.push({
        id: row.id,
        ...(row.slideIndex === null ? {} : { slideIndex: row.slideIndex }),
        text: row.text,
        // Los `as` están acotados a columnas `jsonb` cuya forma valida `core`
        // (`assertValidTextBoxes`) antes de usarlas.
        position: (shaped
          ? row.position
          : { x: Number.NaN, y: Number.NaN }) as ContentTextBox["position"],
        widthPercent: row.widthPercent,
        font: (shaped ? row.font : {}) as ContentTextBox["font"],
        color: row.color,
        stroke: (shaped ? row.stroke : {}) as ContentTextBox["stroke"],
        background: (shaped ? row.background : null) as ContentTextBox["background"],
      });
    }
    // `cursor === null` con `hasMore` no debería pasar; si pasara, el bucle no
    // tendría por dónde avanzar.
    if (!chunk.hasMore || chunk.cursor === null) return all;
    cursor = chunk.cursor;
  }
}

/**
 * Sprint 9 (S), `PU-S9-003`: el design system activo de la marca en la forma
 * que usa el build. `null` sin design system. Los logos son media viva de la
 * marca (`media/{companyId}/design-system/…`); uno borrado del Media Bank ya no
 * se ofrece.
 */
async function readActiveBrandLook(
  tx: Transaction,
  companyId: string,
): Promise<ActiveBrandLook | null> {
  const scope = { companyId };
  const row = await designSystemRepository.findActive(tx, scope);
  if (row === null) return null;
  const logoIds = readStoredAssets(row.assets)
    .filter((a) => a.kind === "logo")
    .map((a) => a.mediaId);
  const live = await designSystemRepository.liveMediaByIds(tx, scope, logoIds);
  const byId = new Map(live.map((m) => [m.mediaId, m.r2Url]));
  const logoUrls = [
    ...new Set(logoIds.map((id) => byId.get(id)).filter((u): u is string => !!u)),
  ].slice(0, 4);
  return {
    tokens: readDesignSystemTokens(row.tokens),
    fontFiles: readStoredFontFiles(row.fonts).filter((f) =>
      // Una fila editada a mano no puede hacer leer fuentes de otra marca.
      f.storageKey.startsWith(`fonts/${companyId}/`),
    ),
    logoUrls,
  };
}

/**
 * El payload de una pieza nueva con la marca estampada (familias por defecto
 * del design system y logo si la marca lo pidió), o `null` si no cambia nada.
 * Ver `core/content/brand-look.ts`: por qué en el primer build y persistido.
 */
function stampedPayloadOf(
  raw: unknown,
  look: ActiveBrandLook | null,
): Record<string, unknown> | null {
  if (look === null || look.tokens === null) return null;
  const parsed = contentBuildPayloadSchema.safeParse(raw);
  if (!parsed.success || "reel" in parsed.data) return null;
  const tokens = look.tokens;
  const { payload, changed } = stampBrandLook(parsed.data, {
    families: brandTextFamilies(tokens),
    logo: brandDefaultLogo(tokens, look.logoUrls.length > 0),
  });
  return changed ? (payload as Record<string, unknown>) : null;
}

export function createContentBuildHandler(deps: ContentBuildDeps): JobHandler<unknown> {
  return createContentRenderHandler(deps, "build");
}

/**
 * El motor de `content-build` y `content-rebuild`. Ver la cabecera: la única
 * diferencia entre los dos es cómo se cierra un fallo definitivo.
 */
export function createContentRenderHandler(
  deps: ContentBuildDeps,
  queueKind: ContentJobQueueKind,
): JobHandler<unknown> {
  const prefix = deps.objectPrefix ?? "content";

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

  /** Transacción 1: bloquear, decidir y soltar. */
  async function read(
    job: ContentBuildJob,
    mode: ContentJobQueueKind,
  ): Promise<ReadOutcome> {
    return inCompany(job.companyId, async (tx) => {
      const row = await contentBuildStore.lockContent(
        tx,
        { companyId: job.companyId },
        job.contentId,
      );

      if (row === null) return { kind: "skip", why: "la pieza no existe o fue borrada" };

      // Job viejo: la pieza ya avanzó. El build que corresponde a la revisión
      // actual está encolado o ya corrió.
      if (row.revision !== job.revision)
        return {
          kind: "skip",
          why: `el job construye la revisión ${String(job.revision)} y la pieza va por ${String(row.revision)}`,
        };

      // Reintento después de una corrida que sí terminó: el estado ya no es
      // `BUILDING`. Esto es lo que hace al handler idempotente de verdad.
      if (row.status !== "BUILDING")
        return { kind: "skip", why: `la pieza ya está en ${row.status}` };

      if (row.type === "custom") {
        const source = parseCustomVideoPayload(row.buildPayload, job.companyId);
        if (source === null)
          return {
            kind: "fail",
            failure: permanent(
              "la pieza `custom` no guarda la clave del objeto subido (fila " +
                "anterior al sprint 7): no hay de dónde leerlo",
              "custom_not_renderable",
            ),
          };
        return {
          kind: "custom",
          source,
          buildPayload: row.buildPayload as Record<string, unknown>,
        };
      }

      // Sprint 9 (S): la marca. En el primer build se estampa (y el commit lo
      // persiste); en un rebuild sólo se lee, para las fuentes y el logo.
      const look = await readActiveBrandLook(tx, job.companyId);
      const stamped = mode === "build" ? stampedPayloadOf(row.buildPayload, look) : null;
      const brand: BrandContext = { look, stamped };
      const buildPayload: unknown = stamped ?? row.buildPayload;

      // Content Studio (`POST /content/studio` con `ai`): el copy lo escribe
      // el modelo antes del primer render. Mismo armado que `regenerate`.
      if (mode === "build" && job.reason === "create" && job.prompt !== undefined) {
        const current = regenerationBoxesOf([], buildPayload);
        if (current.length === 0 || !isBlitzContentType(row.type))
          return {
            kind: "fail",
            failure: permanent(
              "una pieza del Studio con IA sin texto que escribir",
              "edit_not_renderable",
            ),
          };
        const scope = { companyId: job.companyId };
        const company = await companyRepository.load(tx, scope);
        const profile = (await companyProfileRepository.list(tx, scope, { limit: 1 }))
          .items[0];
        return {
          kind: "build",
          brand,
          subject: {
            buildPayload,
            contentType: row.type,
            revision: row.revision,
            textBoxes: current,
            regenerate: {
              contentType: row.type,
              boxes: current,
              businessName: company?.name ?? "",
              profile: profile ?? {},
            },
          },
        };
      }

      if (mode === "rebuild") {
        const boxes = await listAllTextBoxes(tx, job.companyId, job.contentId);

        // `regenerate` (AI-004) reescribe el copy con un modelo **antes** de
        // construir. Sea cual sea la pieza —con cajas guardadas o sin ellas—
        // pasa por el LLM: renderizar lo que ya estaba produciría la pieza de
        // antes con `lastEdit.kind = "regenerate"` y `outcome = "applied"`, una
        // regeneración que dice estar aplicada y no cambió una letra (trampa 30).
        if (job.reason === "regenerate") {
          const current = regenerationBoxesOf(boxes, row.buildPayload);
          if (current.length === 0 || !isBlitzContentType(row.type))
            return {
              kind: "fail",
              failure: permanent(
                "regenerate sobre una pieza sin texto que reescribir",
                "edit_not_renderable",
              ),
            };
          const scope = { companyId: job.companyId };
          const company = await companyRepository.load(tx, scope);
          // `company_profiles` tiene un único índice por `companyId`: la
          // primera fila es la fila (mismo criterio que el refill de Blitz).
          const profile = (await companyProfileRepository.list(tx, scope, { limit: 1 }))
            .items[0];
          return {
            kind: "build",
            brand,
            subject: {
              buildPayload: row.buildPayload,
              contentType: row.type,
              revision: row.revision,
              textBoxes: current,
              studioState: row.studioState,
              regenerate: {
                contentType: row.type,
                boxes: current,
                businessName: company?.name ?? "",
                profile: profile ?? {},
                // Sprint 7: el copy sale en el idioma de la estrategia guardada.
                language:
                  (await brandStrategyRepository.find(tx, scope))?.language ?? null,
              },
            },
          };
        }

        return {
          kind: "build",
          brand,
          subject: {
            buildPayload: row.buildPayload,
            contentType: row.type,
            revision: row.revision,
            textBoxes: boxes,
            studioState: row.studioState,
          },
        };
      }

      return {
        kind: "build",
        brand,
        subject: {
          buildPayload,
          contentType: row.type,
          revision: row.revision,
        },
      };
    });
  }

  /**
   * Transacción 2, camino feliz. Devuelve `false` si el resultado quedó obsoleto.
   *
   * Con `regenerated` (`AI-004`) guarda además las cajas nuevas, **en la misma
   * transacción** que los archivos y con la misma comprobación de `revision`:
   * como un `PATCH` del usuario, pero sólo si el render que las muestra llegó.
   */
  async function commit(
    job: ContentBuildJob,
    files: readonly string[],
    thumbnailUrl: string | undefined,
    regenerated: readonly ContentTextBox[] | null,
    extra: {
      /** `false` en un `create` con IA: no es una edición, no hay `lastEdit`. */
      readonly lastEdit: boolean;
      /** Sólo `custom`: el payload con la marca de normalización. */
      readonly buildPayload?: Record<string, unknown>;
    } = { lastEdit: true },
  ): Promise<boolean> {
    return inCompany(job.companyId, async (tx) => {
      const scope = { companyId: job.companyId };
      const row = await contentBuildStore.lockContent(tx, scope, job.contentId);
      if (row === null || row.revision !== job.revision || row.status !== "BUILDING")
        return false;

      if (regenerated !== null) {
        for (const box of regenerated) {
          // `upsert` y no `update`, por lo mismo que el `PATCH`: la PK es
          // `(contentId, id)` y dos piezas del workspace pueden tener las dos
          // una `slide-0-text-0`. Una pieza de Blitz no tiene filas todavía.
          const written = await contentTextBoxRepository.upsert(tx, scope, {
            id: box.id,
            contentId: job.contentId,
            ...(box.slideIndex === undefined ? {} : { slideIndex: box.slideIndex }),
            text: box.text,
            position: box.position,
            widthPercent: box.widthPercent,
            font: box.font,
            color: box.color,
            stroke: box.stroke,
            background: box.background,
          });
          // `null` = la fila existe en otro workspace. La pieza ya se resolvió
          // con scope, así que no debería pasar; si pasa, no se escribe nada.
          if (written === null)
            throw new Error("una caja regenerada choca con una fila de otro workspace");
        }
      }

      await contentRepository.update(tx, scope, job.contentId, {
        status: "CREATED",
        files: [...files],
        ...(thumbnailUrl === undefined ? {} : { thumbnailUrl }),
        ...(extra.buildPayload === undefined ? {} : { buildPayload: extra.buildPayload }),
        // La API ya lo dejó `applied` al encolar; se reescribe con la hora del
        // cierre para que diga cuándo llegó el copy nuevo.
        ...(regenerated === null || !extra.lastEdit
          ? {}
          : {
              lastEdit: {
                at: deps.clock.nowMs(),
                outcome: "applied",
                kind: "regenerate",
              },
            }),
      });
      return true;
    });
  }

  /**
   * Transacción 2, camino de fallo: `FAILED` **y reembolso**, juntos.
   *
   * Van en la misma transacción a propósito. Si el reembolso se confirmara
   * aparte, entre los dos pasos habría una ventana en la que el usuario ya
   * perdió el save y la pieza ya está muerta; y si fuera al revés, un reintento
   * que encuentra `FAILED` sin `saveRefundedAt` no sabría si devolver o no.
   */
  async function failBuild(
    job: ContentBuildJob,
    reason: string,
  ): Promise<"refunded" | "closed" | "skipped"> {
    return inCompany(job.companyId, async (tx) => {
      const row = await contentBuildStore.lockContent(
        tx,
        { companyId: job.companyId },
        job.contentId,
      );
      if (row === null || row.revision !== job.revision) return "skipped";
      if (row.status === "CREATED") return "skipped";

      const now = new Date(deps.clock.nowMs());

      // El cargo puede no existir: `POST /content/custom/video` no cobra save,
      // y una pieza sin `saveBucket` no tiene nada que devolver. El CHECK
      // `contents_save_bucket_with_period` garantiza que bucket y período van
      // de a dos, así que alcanza con mirar uno… pero se miran los dos, porque
      // el que sostiene la invariante es la base y esto es el consumidor.
      const bucket = row.saveBucket as SaveBucket | null;
      const period = row.savePeriod;
      const yaReembolsado = row.saveRefundedAt !== null;
      const reembolsa = bucket !== null && period !== null && !yaReembolsado;

      if (reembolsa) {
        await refundContentSave(
          tx,
          { companyId: job.companyId },
          period,
          bucket,
          deps.clock,
        );
      }

      await contentRepository.update(tx, { companyId: job.companyId }, job.contentId, {
        status: "FAILED",
        ...(reembolsa ? { saveRefundedAt: now } : {}),
        // Mismo dialecto que el resto de la API: la fecha en ms epoch, no
        // como `Date`, porque `lastEdit` sale tal cual por el contrato.
        lastEdit: {
          at: now.getTime(),
          outcome: "failed",
          kind: "rebuild",
          failureReason: reason,
        },
      });

      return reembolsa ? "refunded" : "closed";
    });
  }

  /**
   * Transacción 2, camino de fallo **de un rebuild**: vuelve a `CREATED`.
   *
   * FR-051 (PRD:1197, PRD:1204): durante el rebuild *"el contenido previo sigue
   * usable"* y, si falla, *"la versión anterior sigue siendo usable y se
   * reporta `lastEdit` fallido"*. Por eso **no** es `FAILED`: `files` y
   * `thumbnailUrl` no se tocan —la API no los limpia al encolar— y siguen
   * siendo los de la revisión anterior.
   *
   * **Y no hay reembolso**, a propósito: una edición no cobra (PRD:1186), así
   * que no hay nada que devolver. `saveBucket` en esta fila es el cargo del
   * build **original**, que sí se entregó. Devolverlo acá regalaría un save
   * por cada edición fallida. `saveRefundedAt` no se toca.
   *
   * Sólo cierra si la pieza sigue en `BUILDING` con la revisión del job: una
   * reentrega que la encuentra en `CREATED` no reescribe `lastEdit`.
   */
  async function revertRebuild(
    job: ContentBuildJob,
    code: string,
  ): Promise<"reverted" | "skipped"> {
    return inCompany(job.companyId, async (tx) => {
      const row = await contentBuildStore.lockContent(
        tx,
        { companyId: job.companyId },
        job.contentId,
      );
      if (row === null || row.revision !== job.revision || row.status !== "BUILDING")
        return "skipped";

      await contentRepository.update(tx, { companyId: job.companyId }, job.contentId, {
        status: "CREATED",
        lastEdit: {
          at: deps.clock.nowMs(),
          outcome: "failed",
          kind: editKindOf(job, row.lastEdit),
          // Código estable, no el mensaje: `lastEdit` sale por la API tal
          // cual, y un error crudo de proveedor no sale hacia afuera.
          failureReason: code,
        },
      });
      return "reverted";
    });
  }

  /** Sube el artefacto y devuelve su URL canónica. */
  async function upload(
    job: ContentBuildJob,
    result: RenderedMedia,
    index: number,
  ): Promise<{ key: StorageKey; url: string }> {
    // La clave lleva la revisión: un rebuild de la misma pieza **no** puede
    // sobrescribir el archivo de la revisión anterior, porque los `Post` ya
    // programados la referencian por URL (`FR-060`).
    const key = `${prefix}/${job.companyId}/${job.contentId}/${String(job.revision)}/${String(index)}`;
    const object = await deps.storage.put({
      key,
      body: result.body,
      contentType: result.contentType,
    });
    return { key: object.key, url: await canonicalObjectUrl(deps.storage, object.key) };
  }

  /** Best-effort, como pide §9.11: un huérfano en el bucket no puede romper el job. */
  async function discard(keys: readonly StorageKey[]): Promise<void> {
    for (const key of keys) {
      try {
        await deps.storage.delete(key);
      } catch (error: unknown) {
        deps.logger.warn({ key, error }, "no se pudo borrar un artefacto obsoleto");
      }
    }
  }

  /**
   * La rama `custom` (ver la cabecera y `custom-video.ts`). Cierra igual que
   * un build: reintento si el fallo es transitorio y no es el último intento;
   * si no, `FAILED` (sin reembolso: `custom` no cobra save).
   */
  async function handleCustom(
    ctx: JobContext<unknown>,
    job: ContentBuildJob,
    base: Record<string, unknown>,
    outcome: Extract<ReadOutcome, { kind: "custom" }>,
  ): Promise<void> {
    let built: CustomVideoBuild | null = null;
    let failure: BuildFailure | null = null;
    try {
      built = await buildCustomVideo(
        {
          normalizer: deps.normalizer ?? null,
          storage: deps.storage,
          logger: deps.logger,
        },
        {
          companyId: job.companyId,
          contentId: job.contentId,
          revision: job.revision,
          objectPrefix: prefix,
          source: outcome.source,
        },
      );
    } catch (error: unknown) {
      failure = classify(error);
    }

    if (built !== null) {
      const committed = await commit(job, built.files, built.thumbnailUrl, null, {
        lastEdit: false,
        buildPayload: {
          ...outcome.buildPayload,
          customVideo: { ...outcome.source, normalization: built.normalization },
        },
      });
      if (committed) {
        deps.logger.info(
          { ...base, normalization: built.normalization },
          "video propio listo",
        );
        return;
      }
      await discard(built.uploaded);
      deps.logger.info(base, "resultado descartado: la pieza cambió durante el build");
      return;
    }

    const f = failure ?? permanent("video propio sin resultado", "internal_error");
    if (f.retryable && ctx.attempt < ctx.maxAttempts) {
      deps.logger.warn(
        { ...base, attempt: ctx.attempt, reason: f.reason },
        "video propio fallido, se reintenta",
      );
      throw f.cause instanceof Error ? f.cause : new Error(f.reason);
    }
    const resultado = await failBuild(job, f.code);
    deps.logger.error(
      { ...base, attempt: ctx.attempt, reason: f.reason, resultado },
      "video propio fallido definitivamente",
    );
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parseContentBuildJob(ctx.payload);
    if (!parsed.ok) {
      // No se relanza: reintentar un payload roto da el mismo error tres veces
      // y después parece un fallo de infraestructura en la dead-letter. Es un
      // bug del productor y no hay pieza identificable que cerrar.
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de content-build inválido",
      );
      return;
    }

    const job = parsed.payload;
    const mode: ContentJobQueueKind =
      queueKind === "rebuild" ||
      (job.reason !== undefined && EDIT_REASONS.has(job.reason))
        ? "rebuild"
        : "build";
    const base = {
      jobId: ctx.jobId,
      contentId: job.contentId,
      revision: job.revision,
      mode,
    };

    const outcome = await read(job, mode);
    if (outcome.kind === "skip") {
      deps.logger.info({ ...base, why: outcome.why }, "build omitido");
      return;
    }

    if (outcome.kind === "custom") {
      await handleCustom(ctx, job, base, outcome);
      return;
    }

    let failure: BuildFailure | null = outcome.kind === "fail" ? outcome.failure : null;
    const uploaded: StorageKey[] = [];
    const files: string[] = [];
    let thumbnailUrl: string | undefined;
    let regenerated: readonly ContentTextBox[] | null = null;

    // `AI-004`: el copy nuevo, antes de mapear y renderizar. Fuera de toda
    // transacción, como el render: un modelo tarda segundos.
    const regen = outcome.kind === "build" ? outcome.subject.regenerate : undefined;
    if (regen !== undefined) {
      const llm = deps.copyLlm === undefined ? null : await deps.copyLlm();
      if (llm === null) {
        failure = permanent(
          "no hay LLM configurado para la tarea `text` (Settings → Models)",
          "llm_not_configured",
        );
      } else {
        try {
          const result = await regenerateTextBoxes(
            llm,
            {
              contentType: regen.contentType,
              boxes: regen.boxes,
              businessName: regen.businessName,
              profile: regen.profile,
              mentionBusiness: job.mentionBusiness,
              userPrompt: job.prompt,
              language: regen.language,
            },
            deps.fence,
          );
          if (result.ok) {
            regenerated = result.boxes;
            deps.logger.info({ ...base, model: result.model }, "copy regenerado");
          } else {
            failure = permanent(
              `el modelo ${result.model} devolvió un copy inválido: ${result.reason}`,
              "copy_rejected",
            );
          }
        } catch (error: unknown) {
          // Transitorio o no lo decide `classify`; el código que sale por
          // `lastEdit` es uno solo, sin texto del proveedor.
          failure = { ...classify(error), code: "llm_failed" };
        }
      }
    }

    // El thumbnail es IMPL §5 —«nunca servir el master para un preview»— y
    // **no** puede hundir el build: la pieza es utilizable sin miniatura, y
    // fallarla por eso reembolsaría un save por un preview. Se loguea y sigue.
    // Compartido con la rama de reels.
    const makeThumbnail = async (): Promise<void> => {
      try {
        // La autorización del thumbnail NO es la del render: su fuente es el
        // artefacto **recién subido**, no la media de entrada. Pasar `auth` acá
        // lo haría rechazar con `url_no_listada_en_grant`, dentro del `catch`
        // que loguea y sigue — o sea, todas las piezas sin miniatura.
        // La portada es el primer artefacto: en un slideshow, la miniatura de la
        // pieza es la del slide 1, no la de uno cualquiera.
        const portada = files[0];
        if (portada === undefined) throw new Error("build sin artefactos");

        const thumb = await deps.renderer.thumbnail(
          { url: portada, maxWidth: 480 },
          await workspaceMediaAuthorization(deps.storage, {
            companyId: job.companyId,
            objectPrefix: prefix,
            urls: [portada],
          }),
        );
        const key = `${prefix}/${job.companyId}/${job.contentId}/${String(job.revision)}/thumb`;
        const stored = await deps.storage.put({
          key,
          body: thumb.body,
          contentType: thumb.contentType,
        });
        uploaded.push(stored.key);
        thumbnailUrl = await canonicalObjectUrl(deps.storage, stored.key);
      } catch (error: unknown) {
        deps.logger.warn({ ...base, error }, "no se pudo generar el thumbnail");
      }
    };

    // Sprint 9 (`PU-S9-010`): el reel se renderiza con HyperFrames por su
    // propio puerto; no tiene cajas de `FR-051` ni pasa por `toRenderJob`.
    if (
      outcome.kind === "build" &&
      failure === null &&
      outcome.subject.contentType === "reel"
    ) {
      const reel = reelSpecOf(
        outcome.subject.buildPayload,
        outcome.subject.studioState ?? null,
      );
      if (!reel.ok) {
        failure = permanent(reel.reason, reel.code);
      } else if (!isReelRenderer(deps.renderer)) {
        failure = permanent(
          "el renderer montado no sabe hacer reels",
          "reel_renderer_unavailable",
        );
      } else {
        try {
          // Sprint 9 (U): fuentes de marca y biblioteca global en el grant.
          const auth = await reelMediaAuthorization(deps.storage, {
            companyId: job.companyId,
            objectPrefix: prefix,
            urls: reel.urls,
            fontUrls: reel.fontUrls,
          });
          const build = await deps.renderer.renderReel(
            {
              spec: reel.spec as unknown as Readonly<Record<string, unknown>>,
              quality: "delivery",
            },
            auth,
          );
          if (build.warnings.length > 0) {
            deps.logger.warn(
              { ...base, warnings: build.warnings },
              "reel con avisos del motor",
            );
          }
          const artifact = await upload(job, await build.artifact.open(), 0);
          uploaded.push(artifact.key);
          files.push(artifact.url);
          await makeThumbnail();
        } catch (error: unknown) {
          failure = classify(error);
        }
      }
    } else if (outcome.kind === "build" && failure === null) {
      const boxes = regenerated ?? outcome.subject.textBoxes ?? [];
      const studioState = outcome.subject.studioState ?? null;
      // Un rebuild pasa por el camino editado si hay cajas **o** swaps de
      // media: una pieza sin cajas también puede haber cambiado de fondo.
      const edited =
        boxes.length > 0 || (studioState !== null && studioState !== undefined);
      const mapped = edited
        ? toEditedRenderJob(
            outcome.subject.buildPayload,
            outcome.subject.contentType,
            boxes,
            studioState,
          )
        : toRenderJob(outcome.subject.buildPayload, outcome.subject.contentType);
      if (!mapped.ok) {
        failure = permanent(mapped.reason, mapped.code);
      } else {
        try {
          // El grant se acuña **por build** y autoriza exactamente la media de
          // este job: sin él, `services/render` no puede distinguir el
          // workspace 42 del 43 (`NFR-006`). Ver `media-authorization.ts`.
          // Sprint 9 (S): fuentes de marca (o sus reemplazos) y el logo. La capa
          // de logo vigente es la del editor si la tocó, si no la del payload.
          const brandLook = outcome.brand?.look ?? null;
          const renderJob = withBrandLook(
            mapped.job,
            brandLook,
            effectiveLogo(
              (outcome.subject.buildPayload as { logo?: unknown } | null)?.logo,
              studioState,
            ),
          );
          const auth = await workspaceMediaAuthorization(deps.storage, {
            companyId: job.companyId,
            objectPrefix: prefix,
            urls: mediaUrlsOf(renderJob),
          });

          // **`renderAll` y no `render`.** Un slideshow de N slides son N
          // imágenes y `RenderResult` transporta una: por `render()` un
          // slideshow multi-slide no se podía construir en absoluto — el
          // adaptador lanzaba `provider_contract_violation` en vez de devolver
          // el primero, porque devolver el primero publica una pieza de una
          // sola imagen sin error en ningún log.
          const build = await deps.renderer.renderAll(renderJob, auth);

          // **El orden es el del slideshow, no el de llegada.** `files` se
          // persiste tal cual y es lo que se publica: dos slides
          // intercambiados son una pieza mal armada que ningún test de
          // «el build terminó bien» detecta.
          const enOrden = [...build.artifacts].sort((a, b) => a.index - b.index);

          // De a uno, a propósito. Los artefactos son perezosos justamente
          // para no tener veinte cuerpos HTTP en vuelo sostenidos hasta que
          // termine de subirse el último (`NFR-013`).
          for (const ref of enOrden) {
            const media = await ref.open();
            const artifact = await upload(job, media, ref.index);
            uploaded.push(artifact.key);
            files.push(artifact.url);
          }

          // Que la cuenta de artefactos coincida con la de slides lo verifica
          // el adaptador al parsear la respuesta. No se repite acá: dos
          // defensas para la misma regla hacen que ninguna de las dos se pueda
          // testear por separado, y el test termina midiendo «que alguna
          // funcione».

          await makeThumbnail();
        } catch (error: unknown) {
          failure = classify(error);
        }
      }
    }

    if (failure === null) {
      const stamped = outcome.kind === "build" ? (outcome.brand?.stamped ?? null) : null;
      const committed = await commit(job, files, thumbnailUrl, regenerated, {
        lastEdit: mode === "rebuild",
        // Sprint 9 (S): el payload con la marca, para que el editor y los
        // rebuilds vean la familia y el logo con que salió el video.
        ...(stamped === null ? {} : { buildPayload: stamped }),
      });
      if (committed) {
        deps.logger.info({ ...base, files: files.length }, "build completado");
        return;
      }
      // La pieza se movió mientras construíamos. El render es basura y lo
      // subido también: borrarlo es lo que evita pagar storage por artefactos
      // que ninguna fila referencia.
      await discard(uploaded);
      deps.logger.info(base, "resultado descartado: la pieza cambió durante el build");
      return;
    }

    await discard(uploaded);

    const ultimoIntento = ctx.attempt >= ctx.maxAttempts;
    if (failure.retryable && !ultimoIntento) {
      deps.logger.warn(
        {
          ...base,
          attempt: ctx.attempt,
          maxAttempts: ctx.maxAttempts,
          reason: failure.reason,
        },
        "build fallido, se reintenta",
      );
      // Relanzar es lo que hace que la cola reintente con su backoff. La pieza
      // queda en `BUILDING`, que es correcto: todavía puede terminar bien.
      throw failure.cause instanceof Error ? failure.cause : new Error(failure.reason);
    }

    const resultado =
      mode === "rebuild"
        ? await revertRebuild(job, failure.code)
        : // El código, no `reason`: `lastEdit` sale tal cual por la API
          // (`toContent`), y `reason` lleva el mensaje del proveedor. El
          // mensaje queda en el log de abajo.
          await failBuild(job, failure.code);
    deps.logger.error(
      { ...base, attempt: ctx.attempt, reason: failure.reason, resultado },
      "build fallido definitivamente",
    );
  };
}
