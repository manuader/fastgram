/**
 * De las cajas del editor al `buildPayload` — `FR-051`, `FR-070`, `DATA-009`,
 * `PU-EDIT-002`.
 *
 * ## El hueco que cierra
 *
 * `PATCH /content/:id` escribe `content_text_boxes` y el render lee sólo
 * `buildPayload`. Sin este mapeo, `content-rebuild` rehacía la misma pieza de
 * antes —o la cerraba con `edit_not_renderable`—: ninguna edición llegaba al
 * video.
 *
 * ## El mapeo (decisión del dueño, 2026-09-24, PRD FR-051)
 *
 * | caja (unidades de editor)        | payload de build (`FR-070`)                  |
 * |----------------------------------|----------------------------------------------|
 * | `position.x` (% del ancho)       | `x` = **centro** de la caja, px de canvas    |
 * | `position.y` (% del alto)        | `y` = **centro** de la caja, px de canvas    |
 * | `widthPercent` (% del ancho)     | `width` = ancho de la caja, px de canvas     |
 * | `font.size`, `stroke.width`      | `fontSize`, `strokeWidth` **tal cual**       |
 *
 * `fontSize` y `strokeWidth` NO se multiplican acá: siguen en unidades de
 * editor y el que escala por `canvas.width / 360` es el render
 * (`services/render`, `editorUnitsToCanvasPx`, decisión 2026-09-23). Escalar en
 * los dos lados daría ×9 en 1080. El test lo fija.
 *
 * Que `x`/`y` del payload sean el centro no es una elección de este archivo:
 * el adaptador (`render-wire.ts`) pasa `x/width` a % sin moverlos y el servicio
 * interpreta `position` como centro (`textLayer.ts`). Blitz ya escribe así
 * (`blitz-build.ts`, `textFor`). Este archivo sólo es la inversa exacta.
 *
 * ## Qué NO puede viajar, y por qué
 *
 * El objeto de texto de `FR-070` es cerrado (`.strict()` en el contrato) y no
 * tiene lugar para tres atributos de la caja:
 *
 *  - `font.family` — se devuelve **aparte** ({@link EditedBuild.fontFamilies})
 *    para que el worker lo ponga en `RenderText.fontFamily`, que el puerto sí
 *    tiene. Si se metiera en el payload, el contrato lo rechazaría.
 *  - `background.opacity` y `background.style` — el puerto sólo lleva
 *    `backgroundColor` y el adaptador lo manda como `pill` opaco. Se respetan
 *    el color y el «sin fondo»; la opacidad y `full-width` **no llegan**.
 *    Única excepción: opacidad 0 se trata como sin fondo, porque un fondo
 *    invisible dibujado opaco es lo opuesto a lo que el usuario ve.
 *
 * ## Qué se conserva del payload original
 *
 * Todo lo que no es texto (media, canvas, audio) va tal cual: una edición menor
 * no toca la media (`FR-051`). De cada texto original se conserva además
 * `textAlign`, que `DATA-009` no tiene: la k-ésima caja de una superficie
 * hereda la alineación del k-ésimo texto original de esa superficie; si no hay,
 * `center` (el default del servicio y del inspector).
 *
 * ## Decisiones que el PRD no cubre (conservadoras)
 *
 *  - **Formato de una superficie con más de una caja** (`wall-of-text`,
 *    `green-screen`, `video-hook`): el contrato de `FR-070` es `text`
 *    **singular**. Quedarse con la primera tiraría texto que el usuario ve en
 *    el editor; unir las cajas movería texto que el usuario puso en otro lado.
 *    Se rechaza (`multiple_boxes_on_single_text_format`) y el rebuild cierra
 *    como fallido, con la versión anterior usable.
 *  - **Slide sin cajas**: conserva los textos originales de ese slide. Las
 *    cajas describen lo que se editó; un slide que no tiene ninguna no se
 *    editó.
 *  - **Caja de slideshow sin `slideIndex`, o con uno que no existe**: se
 *    rechaza. Adivinar el slide mueve texto a otra imagen.
 *  - **Orden**: por `slideIndex` y después por `id` con comparación numérica
 *    (`slide-0-text-2` antes que `slide-0-text-10`). No depende del orden en
 *    que la base devuelva las filas, que no está garantizado.
 *
 * Función pura: no lanza por datos (devuelve un resultado) y no muta nada.
 * `core` no importa `contracts`: los tipos de acá son estructurales, y el
 * worker revalida el resultado con `contentBuildPayloadSchema` antes de
 * renderizar.
 */
import { DomainError } from "../errors.js";
import { assertValidTextBoxes, type ContentTextBox } from "./text-boxes.js";

/** El objeto de texto de `FR-070`, estructural. Espejo de `buildTextSchema`. */
export interface EditableBuildText {
  readonly content: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly fontSize: number;
  readonly color: string;
  readonly textAlign: "left" | "center" | "right";
  readonly fontWeight?: number | undefined;
  readonly strokeWidth?: number | undefined;
  readonly strokeColor?: string | undefined;
  readonly backgroundColor?: string | undefined;
}

interface CanvasLike {
  readonly width: number;
  readonly height: number;
}

/**
 * Lo mínimo que este archivo necesita de un payload. El resto de las claves
 * (media, audio, `aspectRatio`) viaja intacto por spread.
 */
export type EditableBuildPayload =
  | {
      readonly num_images: number;
      readonly images: readonly {
        readonly canvas: CanvasLike;
        readonly texts: readonly EditableBuildText[];
      }[];
    }
  | { readonly canvas: CanvasLike; readonly text: EditableBuildText };

/**
 * Familias tipográficas, alineadas a los textos del payload resultante:
 * `[superficie][texto]`. Los formatos de una superficie tienen una sola, con un
 * solo texto. `undefined` = el texto no salió de una caja (slide sin cajas) y
 * el render usa su default.
 */
export type TextFontFamilies = readonly (readonly (string | undefined)[])[];

export interface EditedBuild<P> {
  readonly payload: P;
  readonly fontFamilies: TextFontFamilies;
}

export type TextBoxesToPayloadResult<P> =
  | ({ readonly ok: true } & EditedBuild<P>)
  | { readonly ok: false; readonly code: TextBoxMappingError; readonly reason: string };

/** Códigos estables: son lo que el rebuild puede dejar en `lastEdit`. */
export type TextBoxMappingError =
  | "invalid_text_boxes"
  | "multiple_boxes_on_single_text_format"
  | "text_box_slide_out_of_range";

/**
 * Cuatro decimales: 0,0001 px no se ve, y sin redondeo `33.3 * 1080 / 100` sale
 * `359.64000000000004`, que entra en la clave de cache del render como un
 * número distinto de `359.64`.
 */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Caja → texto de `FR-070` sobre `canvas`. Exportada para los tests. */
export function textBoxToBuildText(
  box: ContentTextBox,
  canvas: CanvasLike,
  textAlign: EditableBuildText["textAlign"],
): EditableBuildText {
  const background =
    box.background !== null && box.background.opacity > 0 ? box.background : null;
  return {
    content: box.text,
    x: round4((box.position.x * canvas.width) / 100),
    y: round4((box.position.y * canvas.height) / 100),
    width: round4((box.widthPercent * canvas.width) / 100),
    fontSize: box.font.size,
    color: box.color,
    textAlign,
    fontWeight: box.font.weight,
    strokeWidth: box.stroke.width,
    strokeColor: box.stroke.color,
    ...(background === null ? {} : { backgroundColor: background.color }),
  };
}

const byId = new Intl.Collator("en", { numeric: true });

function ordered(boxes: readonly ContentTextBox[]): ContentTextBox[] {
  return [...boxes].sort(
    (a, b) => (a.slideIndex ?? 0) - (b.slideIndex ?? 0) || byId.compare(a.id, b.id),
  );
}

const alignAt = (
  originals: readonly EditableBuildText[],
  index: number,
): EditableBuildText["textAlign"] => originals[index]?.textAlign ?? "center";

/**
 * Aplica las cajas editadas sobre el `buildPayload` original.
 *
 * Con `boxes` vacío devuelve el payload tal cual: una pieza sin cajas no tiene
 * nada del editor que aplicar (el camino que ya renderizaba).
 */
export function applyTextBoxesToBuildPayload<P extends EditableBuildPayload>(
  payload: P,
  boxes: readonly ContentTextBox[],
): TextBoxesToPayloadResult<P> {
  if (boxes.length === 0) {
    return { ok: true, payload, fontFamilies: familiesOf(payload) };
  }

  try {
    assertValidTextBoxes(boxes);
  } catch (error: unknown) {
    if (error instanceof DomainError) {
      return { ok: false, code: "invalid_text_boxes", reason: error.message };
    }
    throw error;
  }

  const sorted = ordered(boxes);

  if ("num_images" in payload) {
    const perSlide = new Map<number, ContentTextBox[]>();
    for (const box of sorted) {
      const slide = box.slideIndex;
      if (slide === undefined || slide >= payload.images.length) {
        return {
          ok: false,
          code: "text_box_slide_out_of_range",
          reason:
            `la caja ${box.id} tiene slideIndex ${String(slide)} y el slideshow ` +
            `tiene ${String(payload.images.length)} slide(s)`,
        };
      }
      const list = perSlide.get(slide) ?? [];
      list.push(box);
      perSlide.set(slide, list);
    }

    const families: (string | undefined)[][] = [];
    const images = payload.images.map((slide, index) => {
      const own = perSlide.get(index);
      if (own === undefined) {
        families.push(slide.texts.map(() => undefined));
        return slide;
      }
      families.push(own.map((b) => b.font.family));
      return {
        ...slide,
        texts: own.map((b, k) =>
          textBoxToBuildText(b, slide.canvas, alignAt(slide.texts, k)),
        ),
      };
    });
    // El spread conserva `num_images` y cualquier otra clave; el `as` es
    // porque TypeScript no puede probar que reemplazar `images` por uno de la
    // misma forma devuelve `P`. La forma la revalida el worker con el contrato.
    return { ok: true, payload: { ...payload, images } as P, fontFamilies: families };
  }

  if (sorted.length > 1) {
    return {
      ok: false,
      code: "multiple_boxes_on_single_text_format",
      reason:
        `el formato lleva un solo texto (FR-070) y la pieza tiene ` +
        `${String(sorted.length)} cajas`,
    };
  }
  const box = sorted[0] as ContentTextBox;
  if (box.slideIndex !== undefined && box.slideIndex !== 0) {
    return {
      ok: false,
      code: "text_box_slide_out_of_range",
      reason: `la caja ${box.id} tiene slideIndex ${String(box.slideIndex)} en un formato de una superficie`,
    };
  }
  const text = textBoxToBuildText(box, payload.canvas, payload.text.textAlign);
  return {
    ok: true,
    payload: { ...payload, text } as P,
    fontFamilies: [[box.font.family]],
  };
}

function familiesOf(payload: EditableBuildPayload): TextFontFamilies {
  if ("num_images" in payload)
    return payload.images.map((s) => s.texts.map(() => undefined));
  return [[undefined]];
}
