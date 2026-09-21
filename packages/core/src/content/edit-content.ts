/**
 * Edición de una pieza — PRD `FR-051` y `AI-004`.
 *
 * La regla que este archivo existe para proteger, literal del PRD:
 *
 *   "Los cambios de copy/tipografía/color/posición son **minor edits**: no
 *    crean una nueva fila de contenido, no consumen content save, no generan
 *    un evento de facturación."
 *
 * Es fácil de romper y difícil de detectar. La implementación equivocada —un
 * `insert` en vez de un `update`— compila, se ve bien en la UI (aparece la
 * pieza editada) y rompe cuatro cosas a la vez: duplica la fila en Library,
 * deja los `Post` apuntando a la versión vieja, hace que el contador de piezas
 * no cuadre, y **cobra un content save por cada corrección de una coma**. Lo
 * último es lo que llega al cliente.
 *
 * Por eso `applyMinorEdit` devuelve la misma pieza con `revision + 1` y un
 * resultado que dice, en el tipo, que no cobra nada. No es ceremonia: es lo
 * que permite que el test afirme la regla en vez de afirmar la implementación.
 */
import { DomainError } from "../errors.js";
import { CONTENT_ERROR_CODES, type Content, type ContentLastEdit } from "./content.js";
import {
  assertNoUnknownFields,
  assertValidTextBoxes,
  type ContentTextBox,
} from "./text-boxes.js";

/** Campos de una caja que una edición menor puede tocar (`FR-051`). */
const MINOR_EDIT_FIELDS = [
  "id",
  "text",
  "position",
  "widthPercent",
  "font",
  "color",
  "stroke",
  "background",
] as const;

/** Un parche por caja. `id` identifica a cuál, el resto es opcional. */
export interface TextBoxPatch {
  readonly id: string;
  readonly text?: string | undefined;
  readonly position?: ContentTextBox["position"] | undefined;
  readonly widthPercent?: number | undefined;
  readonly font?: ContentTextBox["font"] | undefined;
  readonly color?: string | undefined;
  readonly stroke?: ContentTextBox["stroke"] | undefined;
  readonly background?: ContentTextBox["background"] | undefined;
}

export interface MinorEditResult {
  readonly content: Content;
  /**
   * Los tres literales del PRD, en el tipo.
   *
   * Un `boolean` aceptaría `true` sin que nada se queje; un literal `false`
   * convierte "esta edición cobra" en un error de compilación. Es la forma más
   * barata de que la regla sobreviva a un refactor apurado.
   */
  readonly consumesSave: false;
  readonly createsNewRow: false;
  readonly billable: false;
}

// ───────────────────────────────────────────────────────────────────────────
// Guardas
// ───────────────────────────────────────────────────────────────────────────

/**
 * Concurrencia optimista por `revision` (`FR-051`, §9.4).
 *
 * Se comprueba **antes** que las demás guardas a propósito. Si el cliente
 * trae una `revision` vieja, todo lo que cree saber de la pieza puede estar
 * desactualizado —incluido el motivo por el que no puede editarla—, así que el
 * error útil es el que le dice "recargá": cualquier otro mensaje lo mandaría a
 * resolver un problema que quizá ya no existe.
 */
export function assertRevisionMatches(content: Content, expected: number): void {
  if (content.revision !== expected) {
    throw new DomainError(
      "conflict",
      "Someone else changed this piece. Reload to get the latest version.",
      {
        code: CONTENT_ERROR_CODES.staleRevision,
        contentId: content.id,
        expected,
        actual: content.revision,
      },
    );
  }
}

/**
 * Las cuatro condiciones que bloquean una edición (`FR-051`, edge cases).
 *
 * El orden no es arbitrario: va de lo permanente a lo transitorio. Decirle a
 * alguien "ya hay una edición corriendo" sobre una pieza que **nunca** va a
 * ser editable lo manda a esperar a que pase algo que no va a pasar. Primero
 * "esta pieza no se edita", después "ahora no".
 */
export function assertContentEditable(content: Content): void {
  if (content.deletedAt !== undefined) {
    throw new DomainError("not_found", "Content not found.", {
      contentId: content.id,
    });
  }

  if (!content.editable) {
    throw new DomainError(
      "invalid_state",
      "This piece can't be edited here. Send an adjusted payload instead.",
      { code: CONTENT_ERROR_CODES.notEditable, contentId: content.id },
    );
  }

  if (content.status !== "CREATED") {
    throw new DomainError(
      "invalid_state",
      content.status === "BUILDING"
        ? "This piece is still building. Try again when it's ready."
        : "This piece failed to build, so there's nothing to edit.",
      {
        code: CONTENT_ERROR_CODES.unsupportedState,
        contentId: content.id,
        status: content.status,
      },
    );
  }

  if (content.editInProgress) {
    throw new DomainError("conflict", "There's already an edit running on this piece.", {
      code: CONTENT_ERROR_CODES.editInProgress,
      contentId: content.id,
    });
  }

  // "cancelar no basta, hay que borrarlos" — el PRD es explícito. Un post
  // cancelado sigue apuntando al media; si la pieza se rehace debajo, el
  // histórico deja de corresponderse con lo que se publicó.
  if (content.linkedPostCount > 0) {
    throw new DomainError(
      "conflict",
      "Delete the posts linked to this piece before editing it.",
      {
        code: CONTENT_ERROR_CODES.hasLinkedPosts,
        contentId: content.id,
        linkedPostCount: content.linkedPostCount,
      },
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Edición menor
// ───────────────────────────────────────────────────────────────────────────

/**
 * Aplica parches de copy, tipografía, color y posición.
 *
 * Valida **todo** antes de tocar nada (`FR-051`: «sin aplicar ningún cambio»).
 * La pieza resultante conserva `files`: el PRD dice que durante el rebuild
 * «el contenido previo sigue usable», así que el render viejo no se borra
 * hasta que el nuevo esté.
 */
export function applyMinorEdit(
  content: Content,
  expectedRevision: number,
  patches: readonly TextBoxPatch[],
  now: Date,
): MinorEditResult {
  assertRevisionMatches(content, expectedRevision);
  assertContentEditable(content);

  if (patches.length === 0) {
    throw new DomainError("out_of_range", "Nothing to change.", {
      contentId: content.id,
    });
  }

  const byId = new Map(content.textBoxes.map((b) => [b.id, b]));
  const seen = new Set<string>();

  // Pasada 1: sólo valida. Nada se escribe todavía.
  for (const patch of patches) {
    assertNoUnknownFields(patch, MINOR_EDIT_FIELDS, "text box patch");
    if (!byId.has(patch.id)) {
      throw new DomainError("out_of_range", "That text box isn't in this piece.", {
        contentId: content.id,
        boxId: patch.id,
      });
    }
    if (seen.has(patch.id)) {
      throw new DomainError("out_of_range", "Text box ids must be unique.", {
        contentId: content.id,
        boxId: patch.id,
      });
    }
    seen.add(patch.id);
  }

  // Pasada 2: arma el resultado candidato y lo valida entero. Si algo falla
  // acá, `content` sigue intacto porque nunca se mutó.
  const patchById = new Map(patches.map((p) => [p.id, p]));
  const nextBoxes: ContentTextBox[] = content.textBoxes.map((box) => {
    const patch = patchById.get(box.id);
    if (patch === undefined) return box;
    const { id: _id, ...changes } = patch;
    const merged: ContentTextBox = { ...box, ...stripUndefined(changes) };
    return merged;
  });

  assertValidTextBoxes(nextBoxes);

  const lastEdit: ContentLastEdit = { at: now, outcome: "applied", kind: "minor" };

  return {
    content: {
      ...content,
      textBoxes: nextBoxes,
      revision: content.revision + 1,
      status: "BUILDING",
      editInProgress: true,
      lastEdit,
    },
    consumesSave: false,
    createsNewRow: false,
    billable: false,
  };
}

/**
 * Quita las claves con valor `undefined`.
 *
 * Sin esto, `{...box, ...{background: undefined}}` deja `background` en
 * `undefined` y borra un fondo que el usuario no tocó. `null` sí se propaga:
 * en `DATA-009`, `background: null` significa "quitá el fondo" y es una
 * instrucción, no una omisión.
 */
function stripUndefined<T extends object>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = v;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

// ───────────────────────────────────────────────────────────────────────────
// Regeneración de copy — AI-004
// ───────────────────────────────────────────────────────────────────────────

export interface RegeneratedCopy {
  readonly boxId: string;
  readonly text: string;
}

export interface RegenerateResult {
  readonly content: Content;
  /** `AI-004`: usa la cuota de copy, **no** un content save. */
  readonly consumesSave: false;
  readonly billable: false;
}

/**
 * `Regenerate Text` — reescribe **todas** las cajas preservando la estructura.
 *
 * El PRD lo dice dos veces, en `FR-051` y en `AI-004`: «preservando media,
 * estructura de cajas, layout y estilo; en slideshows conserva el número
 * exacto de slides y cajas». Y lo pone como criterio de aceptación.
 *
 * Por qué es una regla y no una recomendación: la pieza ya está compuesta. Si
 * la regeneración devuelve tres cajas donde había cinco, el render no tiene
 * qué poner en dos superficies y la pieza sale con huecos; si devuelve seis,
 * la sexta no tiene posición ni estilo y hay que inventarle uno — que es
 * exactamente lo que el usuario acaba de pedir que NO se toque. Por eso acá se
 * exige cobertura exacta: ni una caja de más, ni una de menos.
 *
 * El estilo y la geometría **no** se tocan: sólo `text`.
 */
export function applyRegeneratedCopy(
  content: Content,
  expectedRevision: number,
  copy: readonly RegeneratedCopy[],
  now: Date,
): RegenerateResult {
  assertRevisionMatches(content, expectedRevision);
  assertContentEditable(content);

  const expectedIds = new Set(content.textBoxes.map((b) => b.id));
  const givenIds = new Set<string>();

  for (const item of copy) {
    if (givenIds.has(item.boxId)) {
      throw new DomainError("invalid_state", "Regeneration repeated a text box.", {
        contentId: content.id,
        boxId: item.boxId,
      });
    }
    givenIds.add(item.boxId);
    if (!expectedIds.has(item.boxId)) {
      throw new DomainError(
        "invalid_state",
        "Regeneration returned a text box that isn't in this piece.",
        { contentId: content.id, boxId: item.boxId },
      );
    }
  }

  for (const id of expectedIds) {
    if (!givenIds.has(id)) {
      throw new DomainError(
        "invalid_state",
        "Regeneration must rewrite every text box.",
        { contentId: content.id, missingBoxId: id },
      );
    }
  }

  const textById = new Map(copy.map((c) => [c.boxId, c.text]));
  const nextBoxes = content.textBoxes.map((box) => ({
    ...box,
    text: textById.get(box.id) as string,
  }));

  assertValidTextBoxes(nextBoxes);

  return {
    content: {
      ...content,
      textBoxes: nextBoxes,
      // `slideCount` y `files` se copian tal cual: es la mitad de la regla.
      revision: content.revision + 1,
      status: "BUILDING",
      editInProgress: true,
      lastEdit: { at: now, outcome: "applied", kind: "regenerate" },
    },
    consumesSave: false,
    billable: false,
  };
}

/**
 * Un rebuild de edición que falla.
 *
 * `FR-051`: «Si el rebuild falla, la versión anterior sigue siendo usable y se
 * reporta `lastEdit` fallido». Es decir: la pieza **no** pasa a `FAILED` —
 * vuelve a `CREATED` con sus archivos viejos. Mandarla a `FAILED` borraría de
 * la Library una pieza que funciona porque un cambio de color no compiló, y
 * además dispararía el reembolso del save de `markBuildFailed`, que acá no
 * corresponde: el save se cobró por el build original, que sí salió bien.
 */
export function markEditRebuildFailed(
  content: Content,
  failureReason: string,
  now: Date,
): Content {
  return {
    ...content,
    status: "CREATED",
    editInProgress: false,
    lastEdit: { at: now, outcome: "failed", kind: "rebuild", failureReason },
  };
}

/** El rebuild de una edición terminó bien. */
export function markEditRebuildSucceeded(
  content: Content,
  files: readonly string[],
  thumbnailUrl: string | undefined,
  now: Date,
): Content {
  if (files.length === 0) {
    throw new DomainError("invalid_state", "A finished rebuild must produce files.", {
      contentId: content.id,
    });
  }
  return {
    ...content,
    status: "CREATED",
    files,
    thumbnailUrl: thumbnailUrl ?? content.thumbnailUrl,
    editInProgress: false,
    lastEdit: { at: now, outcome: "applied", kind: "rebuild" },
  };
}
