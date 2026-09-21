/**
 * `P2-RENDER-003` — Objeto de texto compartido por los cuatro formatos.
 *
 * Los rangos son los de `FR-051` y son NORMATIVOS. Cada número tiene su test en
 * `text.test.ts` (regla de IMPL §4: toda regla de negocio con un número del PRD
 * lleva un test que fija ese número):
 *
 *   text          ≤ 5 000 caracteres, puede estar vacío
 *   position.x/y  ∈ [0, 100]      (unidades de editor, no píxeles)
 *   widthPercent  ∈ [25, 100]
 *   font.size     ∈ [8, 72]
 *   stroke.width  ∈ [0, 8]
 *   colores       #RRGGBB
 *   background    opacity ∈ [0,1]; style ∈ {pill, full-width}; null elimina el fondo
 *
 * Campos desconocidos → rechazo (`.strict()`), como exige `FR-051`.
 *
 * ABIERTO: `FR-070` describe además una forma plana en píxeles
 * (`{content, x, y, width, fontSize, textAlign, fontWeight, strokeWidth,
 * strokeColor, backgroundColor}`) para el payload de `POST /content`. El PRD no
 * dice en qué unidades están `x/y/width` ahí, así que NO se implementa la
 * conversión: adivinarla sería inventar. Ver reporte.
 */
import { z } from "zod";
import { FONT_FAMILIES, isWeightAllowed, type FontFamily } from "./fonts.js";

export const MAX_TEXT_LENGTH = 5000;
export const POSITION_MIN = 0;
export const POSITION_MAX = 100;
export const WIDTH_PERCENT_MIN = 25;
export const WIDTH_PERCENT_MAX = 100;
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 72;
export const STROKE_WIDTH_MIN = 0;
export const STROKE_WIDTH_MAX = 8;

/** `FR-051`: los colores se expresan `#RRGGBB`. */
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const hexColorSchema = z.string().regex(HEX_COLOR, "debe ser un color #RRGGBB");

export const textAlignSchema = z.enum(["left", "center", "right"]);
export type TextAlign = z.infer<typeof textAlignSchema>;

export const backgroundStyleSchema = z.enum(["pill", "full-width"]);
export type BackgroundStyle = z.infer<typeof backgroundStyleSchema>;

export const textBackgroundSchema = z
  .object({
    color: hexColorSchema,
    opacity: z.number().min(0).max(1),
    style: backgroundStyleSchema,
  })
  .strict();

export const fontSpecSchema = z
  .object({
    family: z.enum(FONT_FAMILIES),
    weight: z.number().int(),
    /** Default 18 — es el valor que muestra el inspector de `FR-051` (`Size: <18px>`). */
    size: z.number().int().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX).default(18),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!isWeightAllowed(value.family, value.weight)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["weight"],
        message: `peso ${value.weight} no permitido para la familia ${value.family}`,
      });
    }
  });

export const strokeSchema = z
  .object({
    width: z.number().min(STROKE_WIDTH_MIN).max(STROKE_WIDTH_MAX),
    color: hexColorSchema,
  })
  .strict();

export const positionSchema = z
  .object({
    x: z.number().min(POSITION_MIN).max(POSITION_MAX),
    y: z.number().min(POSITION_MIN).max(POSITION_MAX),
  })
  .strict();

export const textObjectSchema = z
  .object({
    id: z.string().min(1),
    /** Puede estar vacío (`FR-051`). Una caja vacía no dibuja nada. */
    text: z.string().max(MAX_TEXT_LENGTH),
    position: positionSchema,
    widthPercent: z.number().min(WIDTH_PERCENT_MIN).max(WIDTH_PERCENT_MAX),
    align: textAlignSchema.default("center"),
    font: fontSpecSchema,
    /** Defaults literales del inspector de `FR-051`: `#FFFFFF` y `Stroke: 3px` / `#000000`. */
    color: hexColorSchema.default("#FFFFFF"),
    stroke: strokeSchema.default({ width: 3, color: "#000000" }),
    /** `null` elimina el fondo (`FR-051`). */
    background: textBackgroundSchema.nullable().default(null),
  })
  .strict();

export type TextObject = z.infer<typeof textObjectSchema>;
export type TextObjectInput = z.input<typeof textObjectSchema>;

/**
 * Lista de cajas de un layer. `FR-051` rechaza `textBoxes` vacío y los IDs
 * duplicados, **sin aplicar ningún cambio**.
 */
export const textObjectListSchema = z
  .array(textObjectSchema)
  .min(1, "textBoxes no puede estar vacío")
  .superRefine((boxes, ctx) => {
    const seen = new Set<string>();
    for (const [index, box] of boxes.entries()) {
      if (seen.has(box.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "id"],
          message: `id duplicado: ${box.id}`,
        });
      }
      seen.add(box.id);
    }
  });

export function fontFamilyOf(box: TextObject): FontFamily {
  return box.font.family;
}
