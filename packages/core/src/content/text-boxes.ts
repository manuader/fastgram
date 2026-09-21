/**
 * Cajas de texto de una pieza — PRD `DATA-009` y `FR-051` (bloque **Validation**).
 *
 * Todos los números de este archivo son literales del PRD. Están acá y no
 * repartidos por los casos de uso porque el PRD exige una propiedad que sólo
 * se puede cumplir si la validación es **una sola pasada previa**:
 *
 *   "Se rechazan campos desconocidos, IDs duplicados, IDs inexistentes,
 *    geometría inválida y `textBoxes` vacío, **sin aplicar ningún cambio**."
 *
 * Ese "sin aplicar ningún cambio" es la parte que se rompe sola si cada regla
 * se comprueba justo antes de mutar su campo: una edición de 8 cajas donde la
 * séptima tiene `widthPercent: 10` dejaría seis cajas movidas y un error. El
 * usuario ve la pieza a medio editar y no tiene forma de volver: el editor ya
 * no sabe cuál era el estado anterior. Por eso todo lo de acá **valida y no
 * muta**, y el caso de uso llama primero a validar y después a aplicar.
 */
import { DomainError } from "../errors.js";

/**
 * Familias tipográficas permitidas y sus pesos — `FR-051`.
 *
 * La tabla no es uniforme y el PRD lo dice explícitamente: las seis primeras
 * aceptan 300–700 en pasos de 100, `playfair` y `caveat` arrancan en 400, y
 * las cuatro display sólo tienen 400. Modelarlo como "un rango 300–700 para
 * todas" compila, pasa la revisión y produce un render con `anton` en 300 que
 * el motor de fuentes resuelve a otra cosa — un fallo que sólo se ve mirando
 * el video final.
 */
export const FONT_WEIGHTS: Readonly<Record<string, readonly number[]>> = {
  tiktok: [300, 400, 500, 600, 700],
  snapchat: [300, 400, 500, 600, 700],
  montserrat: [300, 400, 500, 600, 700],
  poppins: [300, 400, 500, 600, 700],
  inter: [300, 400, 500, 600, 700],
  oswald: [300, 400, 500, 600, 700],
  playfair: [400, 500, 600, 700],
  caveat: [400, 500, 600, 700],
  anton: [400],
  bebas: [400],
  bangers: [400],
  pacifico: [400],
} as const;

export const FONT_FAMILIES = Object.keys(FONT_WEIGHTS) as readonly FontFamily[];

export type FontFamily = keyof typeof FONT_WEIGHTS;

export const BACKGROUND_STYLES = ["pill", "full-width"] as const;
export type BackgroundStyle = (typeof BACKGROUND_STYLES)[number];

/** Rangos literales de `FR-051` y `DATA-009`. Cada uno tiene su test. */
export const TEXT_BOX_LIMITS = {
  /** `text` ≤ 5 000 caracteres, **puede estar vacío**. */
  textMaxChars: 5_000,
  positionMin: 0,
  positionMax: 100,
  widthPercentMin: 25,
  widthPercentMax: 100,
  fontSizeMin: 8,
  fontSizeMax: 72,
  strokeWidthMin: 0,
  strokeWidthMax: 8,
  backgroundOpacityMin: 0,
  backgroundOpacityMax: 1,
  /** `prompt` de regeneración ≤ 500 caracteres (`FR-051`, `AI-004`). */
  regenerationPromptMaxChars: 500,
  /** `generatedText` normalizado ≤ 2 000 caracteres (`DATA-008`). */
  generatedTextMaxChars: 2_000,
} as const;

export interface TextBoxPosition {
  readonly x: number;
  readonly y: number;
}

export interface TextBoxFont {
  readonly family: FontFamily;
  readonly weight: number;
  readonly size: number;
}

export interface TextBoxStroke {
  readonly width: number;
  readonly color: string;
}

export interface TextBoxBackground {
  readonly color: string;
  readonly opacity: number;
  readonly style: BackgroundStyle;
}

export interface ContentTextBox {
  /** Estable entre ediciones. Ej. `slide-0-text-0` (`DATA-009`). */
  readonly id: string;
  /** Sólo en slideshows. `undefined` en los formatos de una sola superficie. */
  readonly slideIndex?: number | undefined;
  readonly text: string;
  readonly position: TextBoxPosition;
  readonly widthPercent: number;
  readonly font: TextBoxFont;
  readonly color: string;
  readonly stroke: TextBoxStroke;
  /** `null` **elimina** el fondo. No es lo mismo que omitirlo. */
  readonly background: TextBoxBackground | null;
}

/** `#RRGGBB`, exactamente. Ni `#RGB`, ni `rgba()`, ni nombres CSS. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function fail(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new DomainError("out_of_range", message, details);
}

function assertRange(
  value: unknown,
  min: number,
  max: number,
  field: string,
  boxId: string,
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${field} must be a number.`, { boxId, field, value });
  }
  const n = value as number;
  if (n < min || n > max) {
    fail(`${field} must be between ${min} and ${max}.`, { boxId, field, value: n });
  }
}

function assertHexColor(value: unknown, field: string, boxId: string): void {
  if (typeof value !== "string" || !HEX_COLOR.test(value)) {
    fail(`${field} must be a #RRGGBB colour.`, { boxId, field, value });
  }
}

/**
 * Rechaza claves que el contrato no declara.
 *
 * El PRD lo pide literalmente ("se rechazan campos desconocidos") y la razón
 * es de seguridad, no de higiene: sin esto, un `PATCH` con `{"status":
 * "CREATED"}` viajaría hasta el repositorio como un campo más del parche. Con
 * esto, el contrato de la pieza es cerrado.
 */
export function assertNoUnknownFields(
  value: object,
  allowed: readonly string[],
  where: string,
): void {
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) {
      throw new DomainError("out_of_range", `Unknown field "${key}" in ${where}.`, {
        field: key,
        where,
      });
    }
  }
}

const TEXT_BOX_FIELDS = [
  "id",
  "slideIndex",
  "text",
  "position",
  "widthPercent",
  "font",
  "color",
  "stroke",
  "background",
] as const;

/** Valida **una** caja. No muta y no mira a las demás. */
export function assertValidTextBox(box: ContentTextBox): void {
  assertNoUnknownFields(box, TEXT_BOX_FIELDS, "textBox");

  if (typeof box.id !== "string" || box.id.length === 0) {
    fail("Each text box needs a stable id.", { boxId: box.id });
  }

  // El texto vacío es válido: el PRD lo dice. Una caja vacía es una caja que
  // el usuario todavía no escribió, no un error de validación.
  if (typeof box.text !== "string") {
    fail("text must be a string.", { boxId: box.id });
  }
  if (box.text.length > TEXT_BOX_LIMITS.textMaxChars) {
    fail(`text must be ${TEXT_BOX_LIMITS.textMaxChars} characters or fewer.`, {
      boxId: box.id,
      length: box.text.length,
    });
  }

  if (box.slideIndex !== undefined) {
    if (!Number.isInteger(box.slideIndex) || box.slideIndex < 0) {
      fail("slideIndex must be a non-negative whole number.", {
        boxId: box.id,
        slideIndex: box.slideIndex,
      });
    }
  }

  assertNoUnknownFields(box.position, ["x", "y"], "position");
  assertRange(
    box.position.x,
    TEXT_BOX_LIMITS.positionMin,
    TEXT_BOX_LIMITS.positionMax,
    "position.x",
    box.id,
  );
  assertRange(
    box.position.y,
    TEXT_BOX_LIMITS.positionMin,
    TEXT_BOX_LIMITS.positionMax,
    "position.y",
    box.id,
  );
  assertRange(
    box.widthPercent,
    TEXT_BOX_LIMITS.widthPercentMin,
    TEXT_BOX_LIMITS.widthPercentMax,
    "widthPercent",
    box.id,
  );

  assertNoUnknownFields(box.font, ["family", "weight", "size"], "font");
  const weights = FONT_WEIGHTS[box.font.family as string];
  if (weights === undefined) {
    fail(`"${String(box.font.family)}" is not an allowed font family.`, {
      boxId: box.id,
      family: box.font.family,
      allowed: FONT_FAMILIES,
    });
  }
  if (!weights.includes(box.font.weight)) {
    fail(`${String(box.font.family)} does not come in weight ${box.font.weight}.`, {
      boxId: box.id,
      family: box.font.family,
      weight: box.font.weight,
      allowed: weights,
    });
  }
  assertRange(
    box.font.size,
    TEXT_BOX_LIMITS.fontSizeMin,
    TEXT_BOX_LIMITS.fontSizeMax,
    "font.size",
    box.id,
  );

  assertHexColor(box.color, "color", box.id);

  assertNoUnknownFields(box.stroke, ["width", "color"], "stroke");
  assertRange(
    box.stroke.width,
    TEXT_BOX_LIMITS.strokeWidthMin,
    TEXT_BOX_LIMITS.strokeWidthMax,
    "stroke.width",
    box.id,
  );
  assertHexColor(box.stroke.color, "stroke.color", box.id);

  if (box.background !== null) {
    assertNoUnknownFields(box.background, ["color", "opacity", "style"], "background");
    assertHexColor(box.background.color, "background.color", box.id);
    assertRange(
      box.background.opacity,
      TEXT_BOX_LIMITS.backgroundOpacityMin,
      TEXT_BOX_LIMITS.backgroundOpacityMax,
      "background.opacity",
      box.id,
    );
    if (!BACKGROUND_STYLES.includes(box.background.style)) {
      fail("background.style must be pill or full-width.", {
        boxId: box.id,
        style: box.background.style,
      });
    }
  }
}

/**
 * Valida el conjunto. Es la puerta que usan los casos de uso.
 *
 * `textBoxes` vacío es un error por una razón concreta: una pieza sin ninguna
 * caja no es una pieza sin texto, es una pieza que el render no sabe componer.
 * Para quitar el texto se pone `text: ""`, que sí es válido.
 */
export function assertValidTextBoxes(boxes: readonly ContentTextBox[]): void {
  if (boxes.length === 0) {
    throw new DomainError("out_of_range", "A piece needs at least one text box.", {
      count: 0,
    });
  }

  const seen = new Set<string>();
  for (const box of boxes) {
    if (seen.has(box.id)) {
      throw new DomainError("out_of_range", "Text box ids must be unique.", {
        boxId: box.id,
      });
    }
    seen.add(box.id);
    assertValidTextBox(box);
  }
}

/** `prompt` opcional de `Regenerate Text` (`FR-051`, `AI-004`). */
export function assertValidRegenerationPrompt(prompt: string | undefined): void {
  if (prompt === undefined) return;
  if (prompt.length > TEXT_BOX_LIMITS.regenerationPromptMaxChars) {
    throw new DomainError(
      "out_of_range",
      `The instructions must be ${TEXT_BOX_LIMITS.regenerationPromptMaxChars} characters or fewer.`,
      { length: prompt.length },
    );
  }
}
