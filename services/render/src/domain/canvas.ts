/**
 * Canvas y aspect ratios.
 *
 * `F-068` / `FR-050`: `aspectRatio` ∈ {1:1, 4:5, 3:4, 9:16}, sólo aplica a
 * slideshow, default `4:5` (`FR-070`: "para slideshows la ratio objetivo por
 * defecto es 4:5").
 */
import { z } from "zod";

export const ASPECT_RATIOS = ["1:1", "4:5", "3:4", "9:16"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/** `FR-070`: la ratio por defecto del slideshow. */
export const DEFAULT_SLIDESHOW_ASPECT: AspectRatio = "4:5";

/** `FR-070` usa 1080×1920 como ejemplo de canvas; 1080 de ancho es la base. */
export const DEFAULT_CANVAS_WIDTH = 1080;

export const ASPECT_RATIO_FRACTIONS: Readonly<
  Record<AspectRatio, readonly [number, number]>
> = {
  "1:1": [1, 1],
  "4:5": [4, 5],
  "3:4": [3, 4],
  "9:16": [9, 16],
};

export const aspectRatioSchema = z.enum(ASPECT_RATIOS);

export const canvasSchema = z
  .object({
    width: z.number().int().min(16).max(4096),
    height: z.number().int().min(16).max(4096),
  })
  .strict();

export type Canvas = z.infer<typeof canvasSchema>;

/**
 * Los encoders H.264 en yuv420p exigen dimensiones pares. Se redondea hacia
 * abajo al par más cercano en vez de dejar que ffmpeg falle con
 * `width not divisible by 2`.
 */
export function toEvenDimension(value: number): number {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

/**
 * `P2-RENDER-016` — El canvas de un build de VIDEO tiene que ser par.
 *
 * ── Qué pasaba ───────────────────────────────────────────────────────────────
 * Medido por el adaptador contra este servicio: `canvas: {width: 1081, height:
 * 1921}` moría dentro de ffmpeg con
 *
 *     [libx264] width not divisible by 2 (1081x1921)
 *     exit 187
 *
 * `classifyStderr` no tenía patrón para eso, así que salía como `render_failed`
 * (500). El adaptador clasifica `render_failed` como **reintentable**: la pieza
 * quemaba tres encodes completos —descarga, escalado, libx264, las tres veces—
 * antes de fallar y devolver el content save. Un error de payload cobrado como
 * si fuera un fallo transitorio del motor.
 *
 * ── Por qué se RECHAZA y no se redondea ──────────────────────────────────────
 * `toEvenDimension` ya redondea en dos lugares, y podría haberse extendido acá:
 *
 *   · `formats.ts:targetRect` — el `draw` explícito del payload.
 *   · `formats.ts:planVideoHookBase` — el reparto hook/demo.
 *
 * Pero esos dos números y el canvas no son la misma clase de número, y ahí está
 * el corte:
 *
 *   · `draw` y el reparto son **geometría interna**. Cuando el payload no trae
 *     `draw`, el servicio lo calcula entero con `fit`; ajustarlo un píxel es
 *     seguir haciendo lo que ya hace, y nadie afuera declaró ese número.
 *   · el canvas es **la forma declarada del artefacto**. El adaptador
 *     (`http-media-renderer.ts`) devuelve `width`/`height` del canvas PEDIDO
 *     sin medir el archivo, y dejó escrito que eso es exacto justamente porque
 *     hoy un canvas impar no produce pieza. Si acá se redondeara, ese contrato
 *     pasaría a mentir 1 px en silencio en cada pieza impar: el sesgo que el
 *     adaptador verificó que NO existe lo introduciríamos nosotros.
 *
 * Además el canvas no lo tipea una persona: `core` lo calcula desde el
 * `aspectRatio` del editor, y `canvasForAspect` ya devuelve par. Un canvas impar
 * que llega hasta acá es un bug de quien arma el payload, y un `400` en la
 * validación —antes de tocar red, disco o ffmpeg— es lo que lo hace visible en
 * un intento en vez de en tres.
 *
 * El slideshow queda afuera **a propósito**: no pasa por libx264, sale por sharp
 * a JPEG y un canvas impar rinde perfecto. La regla vale donde vale el encoder.
 */
export function isEvenCanvas(canvas: Canvas): boolean {
  return canvas.width % 2 === 0 && canvas.height % 2 === 0;
}

export const evenCanvasSchema = canvasSchema.superRefine((canvas, ctx) => {
  for (const axis of ["width", "height"] as const) {
    if (canvas[axis] % 2 === 0) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [axis],
      // El mensaje trae el valor par más cercano hacia abajo porque es lo que
      // quien llama va a tener que mandar, y sin eso el 400 obliga a adivinar
      // en qué dirección redondear.
      message:
        `canvas.${axis} (${canvas[axis]}) debe ser par: h264 no acepta ` +
        `dimensiones impares. El par más cercano es ${toEvenDimension(canvas[axis])}`,
    });
  }
});

export function canvasForAspect(
  aspect: AspectRatio,
  width: number = DEFAULT_CANVAS_WIDTH,
): Canvas {
  const fraction = ASPECT_RATIO_FRACTIONS[aspect];
  const w = toEvenDimension(width);
  const h = toEvenDimension((w * fraction[1]) / fraction[0]);
  return { width: w, height: h };
}

/** Ratio efectiva de un canvas concreto, con tolerancia de 1 px por el redondeo a par. */
export function aspectOfCanvas(canvas: Canvas): AspectRatio | null {
  for (const aspect of ASPECT_RATIOS) {
    const expected = canvasForAspect(aspect, canvas.width);
    if (Math.abs(expected.height - canvas.height) <= 1) return aspect;
  }
  return null;
}
