/**
 * Del `buildPayload` a las cajas del editor — la inversa de
 * {@link applyTextBoxesToBuildPayload} (`FR-051`, `FR-070`, `DATA-009`).
 *
 * ## El hueco que cierra
 *
 * Una pieza aceptada desde Blitz (y cualquier `POST /content`) nace con
 * `content_text_boxes` vacío: el texto vive sólo en el payload de build. El
 * editor pedía `GET /content/:id/editable`, recibía `textBoxes: []` y mostraba
 * *"This piece has no editable text boxes"*. Con esto la ruta devuelve las cajas
 * **derivadas** del payload (sin escribirlas) y la primera edición las guarda.
 *
 * ## El contrato: ida y vuelta
 *
 * `applyTextBoxesToBuildPayload(p, deriveTextBoxesFromBuildPayload(p))` tiene
 * que renderizar **lo mismo** que `p`. No "parecido": el primer `PATCH` sin
 * cambios no puede mover nada en el video. El test de propiedad lo fija sobre
 * los cuatro formatos y varios canvas. Lo que eso exige de cada campo:
 *
 * | payload (`FR-070`)           | caja (unidades de editor)                          |
 * |------------------------------|----------------------------------------------------|
 * | `x`, `y` (centro, px)        | `position` = px / lado · 100, **6 decimales**      |
 * | `width` (px)                 | `widthPercent` = px / ancho · 100, en [25, 100]    |
 * | `fontSize`, `strokeWidth`    | **tal cual**: el payload ya está en unidades de editor |
 * | `fontWeight` ausente         | 400 — el default del adaptador (`DEFAULT_MAPPING`) |
 * | stroke ausente               | `3` / `#000000` — el default del servicio de render |
 * | `backgroundColor`            | `{color, opacity: 1, style: "pill"}` — lo que el adaptador manda |
 * | `fontFamily` (sprint 9)      | tal cual; ausente → `inter` (`DEFAULT_MAPPING`)    |
 *
 * **Por qué 6 decimales y no el número crudo**: el adaptador (`render-wire.ts`)
 * redondea el porcentaje a 6 decimales y `apply` redondea los px a 4. Con 6
 * decimales el error de ida es ≤ 5·10⁻⁷ % = 2·10⁻⁵ px en un lienzo de 4096, por
 * debajo del medio paso de `round4` (5·10⁻⁵): la vuelta cae en el mismo px para
 * todo payload con ≤ 4 decimales (Blitz escribe enteros). Redondear a 4 decimales
 * de porcentaje, en cambio, rompe: `333 / 1080` → `30.8333` → `332.9996` px.
 *
 * **Por qué los defaults explícitos no cambian el render**: donde el payload
 * omite un campo, la caja lleva exactamente el valor que el render iba a usar
 * por omisión (adaptador: familia `inter`, peso 400, fondo `pill` opaco;
 * servicio: stroke 3/`#000000`). El wire que llega al servicio es el mismo, así
 * que también la clave de cache.
 *
 * ## Normalización (decisiones que el PRD no cubre, conservadoras)
 *
 * El contrato del `PATCH` es más estrecho que el del payload. Lo derivado tiene
 * que pasar el `PATCH` tal cual, así que se acota a lo válido más cercano:
 *
 *  - **Familia**: el payload no la lleva → `inter` (arriba).
 *  - **Peso**: el payload admite 100–900; `inter` sólo 300–700 en centenas. Se
 *    toma el permitido más cercano (empate → el más liviano). Un payload con 800
 *    ya no renderizaba (el servicio rechaza `inter` 800), así que no se pierde un
 *    render que existía.
 *  - **`widthPercent` < 25 o > 100**, posición fuera de [0, 100], `fontSize`
 *    fuera de [8, 72], `strokeWidth` fuera de [0, 8]: se acotan. El adaptador
 *    rechazaba esos mismos payloads, así que tampoco se pierde un render.
 *  - **Colores** que no son `#RRGGBB` (el tipo estructural de `core` no lo
 *    garantiza; el contrato sí): texto → `#FFFFFF`, stroke → `#000000`, y un
 *    fondo inválido se descarta. Son los defaults del inspector de `FR-051`.
 *  - **Ids**: `slide-<i>-text-<j>`, también en los formatos de una superficie
 *    (`slide-0-text-0`, `slideIndex: 0`), que es el esquema que ya usan los
 *    fixtures y el editor (`slideIndex ?? 0`). `apply` ordena por id numérico,
 *    así que el orden j se conserva.
 *  - **`textAlign`** no está en la caja (`DATA-009`): no hace falta, `apply`
 *    hereda la alineación del k-ésimo texto original de la superficie, que es
 *    justamente el que derivó la k-ésima caja.
 *
 * Función pura: no lanza y no muta.
 */
import { TEXT_BOX_LIMITS, allowedWeightsOf, type ContentTextBox } from "./text-boxes.js";
import type {
  EditableBuildPayload,
  EditableBuildText,
} from "./text-boxes-to-build-payload.js";

/** Familia que usa el render cuando el texto no trae una (`DEFAULT_MAPPING`). */
export const DERIVED_FONT_FAMILY = "inter";
/** Peso que usa el render cuando el texto no trae uno (`DEFAULT_MAPPING`). */
export const DERIVED_FONT_WEIGHT = 400;
/** Stroke por defecto del servicio de render e inspector de `FR-051`. */
export const DERIVED_STROKE = { width: 3, color: "#000000" } as const;
/** Default del inspector de `FR-051` para un color de texto ilegible. */
const DEFAULT_TEXT_COLOR = "#FFFFFF";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Porcentaje de `extent` en [min, max], con 6 decimales (ver cabecera). */
function percentOf(
  px: number,
  extent: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(extent) || extent <= 0) return fallback;
  return clamp(round6((px / extent) * 100), min, max, fallback);
}

/** El peso permitido de `family` más cercano a `weight`; empate → el menor. */
export function nearestAllowedWeight(family: string, weight: number): number {
  const allowed = allowedWeightsOf(family) ?? [DERIVED_FONT_WEIGHT];
  let best = allowed[0] ?? DERIVED_FONT_WEIGHT;
  for (const w of allowed) {
    if (Math.abs(w - weight) < Math.abs(best - weight)) best = w;
  }
  return best;
}

const hexOr = (value: string | undefined, fallback: string): string =>
  value !== undefined && HEX_COLOR.test(value) ? value : fallback;

/** Un texto de `FR-070` → una caja del editor sobre `canvas`. Exportada para los tests. */
export function buildTextToTextBox(
  text: EditableBuildText,
  canvas: { readonly width: number; readonly height: number },
  id: string,
  slideIndex: number,
): ContentTextBox {
  const L = TEXT_BOX_LIMITS;
  // Sprint 9 (S): el payload ya puede traer la familia (`fontFamily`, una de
  // las 12 o `brand:<id>`). Una que no se reconoce cae al default del render,
  // que es lo que el render iba a dibujar igual.
  const family =
    text.fontFamily !== undefined && allowedWeightsOf(text.fontFamily) !== undefined
      ? text.fontFamily
      : DERIVED_FONT_FAMILY;
  const background =
    text.backgroundColor !== undefined && HEX_COLOR.test(text.backgroundColor)
      ? { color: text.backgroundColor, opacity: 1, style: "pill" as const }
      : null;
  return {
    id,
    slideIndex,
    text: text.content.slice(0, L.textMaxChars),
    position: {
      x: percentOf(text.x, canvas.width, L.positionMin, L.positionMax, 50),
      y: percentOf(text.y, canvas.height, L.positionMin, L.positionMax, 50),
    },
    widthPercent: percentOf(
      text.width,
      canvas.width,
      L.widthPercentMin,
      L.widthPercentMax,
      80,
    ),
    font: {
      family,
      weight: nearestAllowedWeight(family, text.fontWeight ?? DERIVED_FONT_WEIGHT),
      size: clamp(text.fontSize, L.fontSizeMin, L.fontSizeMax, 18),
    },
    color: hexOr(text.color, DEFAULT_TEXT_COLOR),
    stroke: {
      width: clamp(
        text.strokeWidth ?? DERIVED_STROKE.width,
        L.strokeWidthMin,
        L.strokeWidthMax,
        DERIVED_STROKE.width,
      ),
      color: hexOr(text.strokeColor, DERIVED_STROKE.color),
    },
    background,
  };
}

const boxId = (slide: number, text: number): string =>
  `slide-${String(slide)}-text-${String(text)}`;

/**
 * Las cajas del editor que describen el texto de `payload`, en el orden en que
 * `applyTextBoxesToBuildPayload` las vuelve a aplicar.
 *
 * Un slideshow sin textos (o con slides sin textos) da menos cajas o ninguna:
 * no hay nada que inventar.
 */
export function deriveTextBoxesFromBuildPayload(
  payload: EditableBuildPayload,
): ContentTextBox[] {
  if ("num_images" in payload) {
    return payload.images.flatMap((slide, i) =>
      slide.texts.map((t, j) => buildTextToTextBox(t, slide.canvas, boxId(i, j), i)),
    );
  }
  return [buildTextToTextBox(payload.text, payload.canvas, boxId(0, 0), 0)];
}
