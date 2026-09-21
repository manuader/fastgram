/**
 * Entidad `Content` y su ciclo de vida — PRD `DATA-008`, `FR-050`, `FR-051`.
 *
 * El ciclo es corto y engañoso:
 *
 *   BUILDING → CREATED | FAILED        (build inicial)
 *   CREATED  → BUILDING → CREATED      (edición: MISMO _id, revision + 1)
 *
 * Lo que hay que no romper, en orden de cuánto duele:
 *
 * 1. **Un build fallido reembolsa el content save** (`FR-050`, §16.2). Y lo
 *    reembolsa **al bucket del que salió**, que es por qué `saveBucket` se
 *    persiste con la pieza y no se recalcula. Ver `quota/content-saves.ts`.
 *
 * 2. **El reembolso ocurre una sola vez.** El handler de la cola puede
 *    reintentarse —el puerto `Queue` lo dice: «el handler debe ser
 *    idempotente»— y un `markBuildFailed` sin guarda convierte cada reintento
 *    en un save gratis. `saveRefundedAt` es esa guarda y no es decorativa: es
 *    la diferencia entre una cuota y una sugerencia.
 *
 * 3. **La edición no crea una fila nueva.** Mismo `_id`, `revision + 1`. Un
 *    "insert" en vez de un "update" duplicaría la pieza en Library, rompería
 *    los `Post` que la referencian y —lo peor— pasaría por la caja: cada
 *    corrección de una coma cobraría un content save. Ver `edit-content.ts`.
 */
import { DomainError, crossTenantAsNotFound } from "../errors.js";
import { HARD_CAPS } from "../quota/plans.js";
import { type SaveBucket, type SavesLedger, refundSave } from "../quota/content-saves.js";
import { TEXT_BOX_LIMITS, type ContentTextBox } from "./text-boxes.js";

/** `DATA-008.type`. `custom` es el de `POST /content/custom/video`. */
export const CONTENT_TYPES = [
  "slideshow",
  "wall-of-text",
  "green-screen",
  "video-hook",
  "custom",
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/**
 * Los cuatro tipos que Blitz sabe producir (`FR-050`, bloque **Validation**).
 * `custom` no está: llega por el endpoint de video propio, no por el deck.
 */
export const BLITZ_CONTENT_TYPES = [
  "slideshow",
  "wall-of-text",
  "green-screen",
  "video-hook",
] as const;
export type BlitzContentType = (typeof BLITZ_CONTENT_TYPES)[number];

/** `FR-050`: sólo aplica a slideshow. */
export const ASPECT_RATIOS = ["1:1", "4:5", "3:4", "9:16"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const CONTENT_STATUSES = ["BUILDING", "CREATED", "FAILED"] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/**
 * Códigos literales del PRD que no tienen un `DomainErrorCode` propio.
 *
 * Viajan en `details.code`, igual que `ANGLE_ERROR_CODES` en `angles/`. No se
 * inventa un código nuevo en `errors.ts` porque esa lista es el contrato
 * público y ampliarla es una decisión de API, no de dominio. La capa HTTP
 * mapea `conflict` + `details.code` a su `409 stale_revision`.
 */
export const CONTENT_ERROR_CODES = {
  staleRevision: "stale_revision",
  editInProgress: "content_edit_in_progress",
  hasLinkedPosts: "content_has_linked_posts",
  unsupportedState: "unsupported_content_state",
  notEditable: "content_not_editable",
  unavailableForType: "content_unavailable_for_type",
} as const;

export interface ContentLastEdit {
  readonly at: Date;
  readonly outcome: "applied" | "failed";
  readonly kind: "minor" | "regenerate" | "rebuild";
  /** Ya traducido. Nunca el error crudo de un proveedor (§10, regla 6). */
  readonly failureReason?: string | undefined;
}

export interface Content {
  readonly id: string;
  readonly companyId: string;
  readonly type: ContentType;
  readonly status: ContentStatus;
  /** URLs del resultado. Varias para slideshow, una para video. */
  readonly files: readonly string[];
  readonly thumbnailUrl?: string | undefined;
  /** Copy extraíble, normalizada, ≤ 2 000 caracteres (`DATA-008`). */
  readonly generatedText?: string | undefined;
  readonly remixSourceUrl?: string | undefined;
  /** Concurrencia optimista. Arranca en 0 y sube con cada edición aplicada. */
  readonly revision: number;
  readonly textBoxes: readonly ContentTextBox[];
  /** Slides de un slideshow. 1 para los formatos de una sola superficie. */
  readonly slideCount: number;
  /**
   * De qué bucket salió el content save. **Se persiste**: es lo único que
   * permite reembolsar al lugar correcto meses después.
   */
  readonly saveBucket: SaveBucket;
  /** Marca de reembolso ya aplicado. Ver el punto 2 de la cabecera. */
  readonly saveRefundedAt?: Date | undefined;
  readonly influencerId?: string | undefined;
  readonly angleId?: string | undefined;
  readonly suggestionId?: string | undefined;
  /** `FR-051`: `409 content_edit_in_progress` si ya hay una edición corriendo. */
  readonly editInProgress: boolean;
  /** `FR-051`: `409 content_has_linked_posts`. Cancelar no basta; hay que borrarlos. */
  readonly linkedPostCount: number;
  /**
   * `FR-051`: el contenido creado por `POST /content` con payload explícito
   * **no** es editable en el Studio. Se reenvía un payload ajustado.
   */
  readonly editable: boolean;
  readonly lastEdit?: ContentLastEdit | undefined;
  readonly deletedAt?: Date | undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Validación de la petición de Blitz
// ───────────────────────────────────────────────────────────────────────────

export function isBlitzContentType(value: string): value is BlitzContentType {
  return (BLITZ_CONTENT_TYPES as readonly string[]).includes(value);
}

/**
 * `FR-050` — **Validation**: `contentType` de los cuatro, `aspectRatio` de los
 * cuatro y **sólo aplica a slideshow**. Valor no reconocido → `400`.
 *
 * Lo que se equivoca solo es el "sólo aplica a slideshow": aceptar
 * `aspectRatio` en un `wall-of-text` no rompe nada visible, el render lo
 * ignora, y el usuario queda convencido de que eligió 4:5 hasta que ve el
 * resultado en 9:16. Rechazarlo es lo que hace que el contrato diga la verdad.
 */
export function assertValidBlitzRequest(request: {
  readonly contentType: string;
  readonly aspectRatio?: string | undefined;
}): void {
  if (!isBlitzContentType(request.contentType)) {
    throw new DomainError("out_of_range", "That content type isn't available.", {
      contentType: request.contentType,
      allowed: BLITZ_CONTENT_TYPES,
    });
  }
  if (request.aspectRatio === undefined) return;

  if (request.contentType !== "slideshow") {
    throw new DomainError("out_of_range", "Aspect ratio only applies to slideshows.", {
      contentType: request.contentType,
      aspectRatio: request.aspectRatio,
    });
  }
  if (!(ASPECT_RATIOS as readonly string[]).includes(request.aspectRatio)) {
    throw new DomainError("out_of_range", "That aspect ratio isn't available.", {
      aspectRatio: request.aspectRatio,
      allowed: ASPECT_RATIOS,
    });
  }
}

/** `HARD_CAPS.slidesPerSlideshow` = 20 (PRD §16.2). */
export function assertValidSlideCount(type: ContentType, slideCount: number): void {
  if (!Number.isInteger(slideCount) || slideCount < 1) {
    throw new DomainError("out_of_range", "A piece needs at least one slide.", {
      slideCount,
    });
  }
  if (type !== "slideshow" && slideCount !== 1) {
    throw new DomainError(
      "out_of_range",
      "Only slideshows can have more than one slide.",
      { type, slideCount },
    );
  }
  if (slideCount > HARD_CAPS.slidesPerSlideshow) {
    throw new DomainError(
      "out_of_range",
      `A slideshow can have up to ${HARD_CAPS.slidesPerSlideshow} slides.`,
      { slideCount, max: HARD_CAPS.slidesPerSlideshow },
    );
  }
}

/**
 * `green-screen` **nunca** usa influencer (`FR-050`, edge cases; `FR-055`
 * regla 5), y un influencer sin entrenar **se cae a contenido regular** en vez
 * de fallar.
 *
 * Las dos reglas apuntan a lo mismo: pedir influencer nunca es motivo de
 * error, es motivo de degradación. Un `422` acá dejaría el deck vacío para un
 * workspace que configuró un influencer y todavía no terminó de entrenarlo —
 * que son 15 a 20 minutos en los que el producto no debería estar roto.
 */
export function resolveInfluencerForType(
  type: BlitzContentType,
  influencer:
    | { readonly id: string; readonly isActive: boolean; readonly isTrained: boolean }
    | undefined,
): string | undefined {
  if (type === "green-screen") return undefined;
  if (influencer === undefined) return undefined;
  if (!influencer.isActive || !influencer.isTrained) return undefined;
  return influencer.id;
}

// ───────────────────────────────────────────────────────────────────────────
// Scope por workspace
// ───────────────────────────────────────────────────────────────────────────

/**
 * Toda lectura de una pieza pasa por acá. `404`, nunca `403` (§9.2).
 *
 * Existe como función y no como un `if` suelto en cada caso de uso para que
 * el intento cruzado quede en el log con `crossTenant: true` — sin eso, el
 * 404 legítimo y el sondeo de otro tenant son indistinguibles también para
 * nosotros, que es justo lo contrario de lo que queremos.
 */
export function assertContentInWorkspace(
  content: Pick<Content, "id" | "companyId">,
  companyId: string,
  actorId: string,
): void {
  if (content.companyId !== companyId) {
    throw crossTenantAsNotFound("content", content.id, actorId);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Ciclo de vida
// ───────────────────────────────────────────────────────────────────────────

export interface CreateBuildingContentParams {
  readonly id: string;
  readonly companyId: string;
  readonly type: ContentType;
  readonly saveBucket: SaveBucket;
  readonly textBoxes: readonly ContentTextBox[];
  readonly slideCount: number;
  readonly generatedText?: string | undefined;
  readonly remixSourceUrl?: string | undefined;
  readonly influencerId?: string | undefined;
  readonly angleId?: string | undefined;
  readonly suggestionId?: string | undefined;
  /** `false` para el payload explícito de `POST /content` (`FR-051`). */
  readonly editable?: boolean | undefined;
}

/**
 * Crea la pieza en `BUILDING`.
 *
 * `revision` arranca en **1**.
 *
 * El PRD **no dice** con cuánto empieza: dice *"cada edición aceptada
 * incrementa `revision`"* (PRD:1187) y *"`revision`+1"* (§2096), que se cumple
 * arrancando en cualquier número. Así que la elección la decide otra cosa: la
 * base ya tiene `default(1)` y un CHECK `revision >= 1`, con su test.
 *
 * Antes decía 0, y eso **no se podía persistir**: el INSERT lo rechazaba. El
 * argumento que lo acompañaba —que arrancar en 1 volvería indistinguible la
 * pieza recién creada de la editada una vez— no se sostiene: arrancando en 1,
 * la editada una vez está en 2. Lo encontró el agente que escribió
 * `PATCH /content/:id`, que es la primera ruta que usa el número de verdad.
 */
export function createBuildingContent(params: CreateBuildingContentParams): Content {
  assertValidSlideCount(params.type, params.slideCount);
  if (
    params.generatedText !== undefined &&
    params.generatedText.length > TEXT_BOX_LIMITS.generatedTextMaxChars
  ) {
    throw new DomainError(
      "out_of_range",
      `generatedText must be ${TEXT_BOX_LIMITS.generatedTextMaxChars} characters or fewer.`,
      { length: params.generatedText.length },
    );
  }

  return {
    id: params.id,
    companyId: params.companyId,
    type: params.type,
    status: "BUILDING",
    files: [],
    generatedText: params.generatedText,
    remixSourceUrl: params.remixSourceUrl,
    revision: 1,
    textBoxes: params.textBoxes,
    slideCount: params.slideCount,
    saveBucket: params.saveBucket,
    influencerId: params.influencerId,
    angleId: params.angleId,
    suggestionId: params.suggestionId,
    editInProgress: false,
    linkedPostCount: 0,
    editable: params.editable ?? true,
  };
}

export interface BuildResult {
  readonly files: readonly string[];
  readonly thumbnailUrl?: string | undefined;
  readonly generatedText?: string | undefined;
}

/** `BUILDING → CREATED`. */
export function markBuildSucceeded(content: Content, result: BuildResult): Content {
  if (content.status !== "BUILDING") {
    throw new DomainError("invalid_state", "Only a building piece can finish building.", {
      contentId: content.id,
      status: content.status,
    });
  }
  if (result.files.length === 0) {
    throw new DomainError("invalid_state", "A finished build must produce files.", {
      contentId: content.id,
    });
  }
  return {
    ...content,
    status: "CREATED",
    files: result.files,
    thumbnailUrl: result.thumbnailUrl ?? content.thumbnailUrl,
    generatedText: result.generatedText ?? content.generatedText,
    editInProgress: false,
  };
}

export interface BuildFailure {
  readonly content: Content;
  readonly saves: SavesLedger;
  /** `false` cuando el reembolso ya se había aplicado en un intento anterior. */
  readonly refunded: boolean;
}

/**
 * `BUILDING → FAILED`, **con reembolso del content save**.
 *
 * Invertir esto —marcar `FAILED` y reembolsar en otro paso, o en otra
 * transacción— es exactamente el fallo que ADR-005 y el encolado transaccional
 * existen para evitar: entre los dos pasos hay una ventana donde el usuario
 * perdió el save y la pieza ya está muerta. Acá van juntos y el llamador
 * persiste los dos resultados en la misma transacción.
 *
 * El reembolso es **idempotente**. Un handler de cola puede correr dos veces
 * (lo dice el puerto `Queue`); sin `saveRefundedAt`, la segunda corrida
 * devuelve un save que nadie gastó.
 */
export function markBuildFailed(
  content: Content,
  saves: SavesLedger,
  failureReason: string,
  now: Date,
): BuildFailure {
  if (content.status === "CREATED") {
    throw new DomainError(
      "invalid_state",
      "A piece that already built can't fail its build.",
      { contentId: content.id },
    );
  }

  if (content.saveRefundedAt !== undefined) {
    return {
      content: {
        ...content,
        status: "FAILED",
        editInProgress: false,
        lastEdit: { at: now, outcome: "failed", kind: "rebuild", failureReason },
      },
      saves,
      refunded: false,
    };
  }

  return {
    content: {
      ...content,
      status: "FAILED",
      editInProgress: false,
      saveRefundedAt: now,
      lastEdit: { at: now, outcome: "failed", kind: "rebuild", failureReason },
    },
    saves: refundSave(saves, content.saveBucket),
    refunded: true,
  };
}

/**
 * Borrado lógico.
 *
 * **No devuelve el content save**, y el PRD lo dice dos veces (`DATA-008` y
 * §16.2). La razón está en `quota/content-saves.ts`: si borrar reembolsara, la
 * cuota dejaría de medir generación —que es lo que cuesta— y pasaría a medir
 * almacenamiento. Esta función no toca el ledger a propósito; que no reciba
 * uno es la forma de que nadie lo intente.
 */
export function softDeleteContent(content: Content, now: Date): Content {
  if (content.deletedAt !== undefined) return content;
  return { ...content, deletedAt: now };
}
