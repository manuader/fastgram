/**
 * Traducción de `RenderJob` (puerto) al payload de `services/render`
 * — `FR-070`, `FR-051`, `DATA-009`.
 *
 * ## Por qué este archivo existe separado del adaptador
 *
 * **Son dos formas distintas que se parecen, y ahí está el peligro.** El puerto
 * discrimina por `format` y el servicio por `type`; el puerto dice
 * `num_images`/`images` y el servicio `numImages`/`slides`; el puerto dice
 * `hook_video` y el servicio `hookVideo`; el puerto trae el texto **plano y en
 * píxeles de canvas** y el servicio lo quiere **estructurado y en unidades de
 * editor** (`position` 0–100, `widthPercent` 25–100). Si uno asume que son la
 * misma forma porque se parecen, el servicio responde `bad_request` y el build
 * falla en producción **sobre un payload perfectamente válido**. Esa clase de
 * divergencia entre dos procesos ya mordió dos veces (trampa 19 y la del
 * `audio`), así que el mapeo es explícito, campo por campo, y vive en un
 * archivo que se puede testear sin red.
 *
 * ## Los tipos `Wire*` son un espejo escrito a mano
 *
 * La fuente de verdad es `services/render/src/domain/payload.ts` (zod). Acá hay
 * un espejo en TypeScript porque `packages/adapters` no puede importar de un
 * servicio. **Es el punto débil conocido de este adaptador**: nada obliga a que
 * el espejo siga al schema. Lo que lo detecta hoy es el test de mapeo, que fija
 * el JSON exacto que se manda, más la suite de contrato contra el servicio
 * levantado. La solución de fondo —publicar el schema del servicio en un
 * paquete compartido— está reportada.
 *
 * ## Divergencias que el mapeo no puede resolver solo
 *
 *  - **`audio` es opcional en el puerto y obligatorio en el servicio.**
 *    `FR-053.1` dice que elegir *No audio* omite el bloque entero, y el puerto
 *    lo modela así a propósito. `wallOfTextPayloadSchema` y
 *    `videoHookPayloadSchema` lo piden siempre. Acá se mapea honesto —si no
 *    hay audio no se manda la clave— y el servicio va a contestar
 *    `bad_request`. **No se inventa un audio de relleno y no se rechaza
 *    localmente**: rechazar acá haría que la pieza siga fallando incluso
 *    después de que el servicio lo arregle, y un audio inventado saldría
 *    publicado. Reportado.
 *  - **`texts` del servicio tiene `.min(1)`**; un slide sin texto es
 *    representable en el puerto. Se manda la lista vacía tal cual y el
 *    servicio decide. Reportado.
 *  - **`font.family` no viene en ningún payload real.** El contrato público de
 *    `POST /content` no lleva `fontFamily` (ver `apps/worker/src/content/
 *    render-job.ts`), pero el servicio lo exige como enum de las 12 familias de
 *    `FR-051`. Entra por configuración ({@link DEFAULT_MAPPING}) porque el PRD
 *    no dice cuál es la familia por defecto.
 */

import {
  PortError,
  type Canvas,
  type RenderJob,
  type RenderText,
  type SlideAspectRatio,
  type TextAlign,
} from "@fastgram/ports";

/* ------------------------------------------------------------------------ *
 * Espejo del schema de `services/render`
 * ------------------------------------------------------------------------ */

export interface WireDrawRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WireMediaRef {
  readonly url: string;
  /**
   * Cuando falta, el servicio calcula la geometría con `fit` (default `cover`).
   * El puerto trae siempre el rectángulo, así que siempre se manda: estirar o
   * recortar es decisión de `core`, no del motor.
   */
  readonly draw?: WireDrawRect;
  /** Sin él, el servicio usa `cover`. */
  readonly fit?: "cover" | "contain" | "stretch";
}

export interface WireAudioRef {
  readonly url: string;
}

export interface WireCanvas {
  readonly width: number;
  readonly height: number;
}

export interface WireSlideCanvas extends WireCanvas {
  readonly aspectRatio: SlideAspectRatio;
}

export interface WireTextObject {
  readonly id: string;
  readonly text: string;
  /** Unidades de editor, 0–100. */
  readonly position: { readonly x: number; readonly y: number };
  /** 25–100. */
  readonly widthPercent: number;
  readonly align: TextAlign;
  readonly font: {
    readonly family: string;
    readonly weight: number;
    readonly size: number;
  };
  readonly color: string;
  readonly stroke?: { readonly width: number; readonly color: string };
  readonly background?: {
    readonly color: string;
    readonly opacity: number;
    readonly style: TextBackgroundStyle;
  };
}

export interface WireSlide {
  readonly canvas: WireSlideCanvas;
  readonly image: WireMediaRef;
  readonly texts: readonly WireTextObject[];
}

export interface WireSlideshowPayload {
  readonly type: "slideshow";
  readonly numImages: number;
  readonly slides: readonly WireSlide[];
}

export interface WireWallOfTextPayload {
  readonly type: "wall-of-text";
  readonly canvas: WireCanvas;
  readonly video: WireMediaRef;
  /** Obligatorio del lado del servicio. Ver la nota de divergencias. */
  readonly audio?: WireAudioRef;
  readonly texts: readonly WireTextObject[];
}

export interface WireGreenScreenPayload {
  readonly type: "green-screen";
  readonly canvas: WireCanvas;
  readonly image: WireMediaRef;
  readonly video: WireMediaRef;
  /** Sprint 7: música que el servicio mezcla con el audio del clip. */
  readonly audio?: WireAudioRef;
  readonly texts: readonly WireTextObject[];
}

export interface WireVideoHookPayload {
  readonly type: "video-hook";
  readonly canvas: WireCanvas;
  readonly hookVideo: WireMediaRef;
  readonly demoVideo: WireMediaRef;
  readonly audio?: WireAudioRef;
  readonly texts: readonly WireTextObject[];
}

export type WirePayload =
  | WireSlideshowPayload
  | WireWallOfTextPayload
  | WireGreenScreenPayload
  | WireVideoHookPayload;

/* ------------------------------------------------------------------------ *
 * Configuración del mapeo: lo que el PRD no dice
 * ------------------------------------------------------------------------ */

export type TextBackgroundStyle = "pill" | "full-width";

export interface RenderMappingConfig {
  /**
   * Familia por defecto. **El PRD no elige una**: `FR-051` lista las 12
   * permitidas y el payload de build de `FR-070` no lleva `fontFamily`, así que
   * alguien tiene que decidir y queda expuesto en la configuración.
   *
   * `inter` y no `tiktok` por una razón concreta: `FONT_REGISTRY` del servicio
   * marca `tiktok` y `snapchat` con `licence: "unresolved"` y sin archivo
   * distribuible, así que con `RENDER_FONT_STRICT=true` fallan con
   * `font_unavailable`. Un default que no se puede renderizar sería un default
   * que rompe todos los builds.
   */
  readonly defaultFontFamily: string;
  /**
   * Peso por defecto. 400 es el único peso que aceptan **las 12** familias
   * (`anton`, `bebas`, `bangers` y `pacifico` sólo tienen ese), así que es el
   * único default que no puede producir un `bad_request` por combinación
   * familia/peso.
   */
  readonly defaultFontWeight: number;
  /**
   * `RenderText.backgroundColor` es un color plano; el servicio quiere
   * `{color, opacity, style}`. `pill` porque un color de fondo en una caja de
   * texto se lee como la caja detrás del texto, no como una banda de ancho
   * completo. Decisión del adaptador: `FR-051` define los dos estilos pero no
   * dice cuál corresponde a un color suelto.
   */
  readonly textBackgroundStyle: TextBackgroundStyle;
  /** Opaco: el puerto no transporta alpha. */
  readonly textBackgroundOpacity: number;
}

export const DEFAULT_MAPPING: RenderMappingConfig = {
  defaultFontFamily: "inter",
  defaultFontWeight: 400,
  textBackgroundStyle: "pill",
  textBackgroundOpacity: 1,
};

/** `FR-051`, rangos normativos de las unidades de editor. */
const POSITION_MIN = 0;
const POSITION_MAX = 100;
const WIDTH_PERCENT_MIN = 25;
const WIDTH_PERCENT_MAX = 100;

/**
 * Tolerancia, en puntos porcentuales, con la que se pega un valor derivado al
 * borde de su rango.
 *
 * **No es cosmética y no es paranoia.** El camino real es
 * `widthPercent (25–100) → píxeles (entero) → widthPercent`: `core` guarda
 * porcentajes (`DATA-009`) y convierte a píxeles al armar el payload
 * (`FR-070`). Si el canvas no es múltiplo de 4, esa ida y vuelta pierde
 * precisión: 25 % de 1081 px son 270,25 px, que redondeados a 270 px vuelven
 * como **24,977 %** — debajo del piso de 25 de `FR-051`. Sin esta tolerancia,
 * una pieza perfectamente válida falla con `bad_request` por el redondeo de
 * otro proceso, y el mensaje de error apunta a un número que el usuario nunca
 * escribió.
 *
 * 0,1 punto porcentual son ~1 px sobre un canvas de 1080: alcanza para
 * absorber el redondeo y es demasiado chico para tapar un error real de
 * layout, que se mide en decenas de píxeles.
 */
const RANGE_SNAP_EPSILON = 0.1;

/* ------------------------------------------------------------------------ *
 * El mapeo
 * ------------------------------------------------------------------------ */

export function toWirePayload(
  job: RenderJob,
  config: RenderMappingConfig,
  source: string,
): WirePayload {
  switch (job.format) {
    case "slideshow":
      return {
        type: "slideshow",
        numImages: job.num_images,
        slides: job.images.map((slide) => ({
          canvas: {
            ...wireCanvas(slide.canvas, source),
            aspectRatio: slide.canvas.aspectRatio,
          },
          image: wireMediaRef(slide.image, source),
          texts: slide.texts.map((text, index) =>
            wireText(text, slide.canvas, index, config, source),
          ),
        })),
      };
    case "wall-of-text":
      return {
        type: "wall-of-text",
        canvas: wireCanvas(job.canvas, source),
        video: wireMediaRef(job.video, source),
        ...(job.audio === undefined ? {} : { audio: { url: job.audio.url } }),
        texts: [wireText(job.text, job.canvas, 0, config, source)],
      };
    case "green-screen":
      return {
        type: "green-screen",
        canvas: wireCanvas(job.canvas, source),
        image: wireMediaRef(job.image, source),
        video: wireMediaRef(job.video, source),
        ...(job.audio === undefined ? {} : { audio: { url: job.audio.url } }),
        // `chromaKey` no se manda: el puerto no lo transporta y los defaults
        // del servicio (verde puro, tolerancia media) son su decisión
        // declarada. Mandar los nuestros sería fijar acá un número que allá
        // está marcado ABIERTO.
        texts: [wireText(job.text, job.canvas, 0, config, source)],
      };
    case "video-hook":
      return {
        type: "video-hook",
        canvas: wireCanvas(job.canvas, source),
        hookVideo: wireMediaRef(job.hook_video, source),
        demoVideo: wireMediaRef(job.demo_video, source),
        ...(job.audio === undefined ? {} : { audio: { url: job.audio.url } }),
        // `hookHeightRatio` tampoco se manda. El puerto trae el rectángulo de
        // cada video, que es más específico que un reparto vertical; el default
        // del servicio (0,5) sólo gobierna la geometría que no se le dio.
        texts: [wireText(job.text, job.canvas, 0, config, source)],
      };
  }
}

function wireCanvas(canvas: Canvas, source: string): WireCanvas {
  return {
    width: integer(canvas.width, "canvas.width", source),
    height: integer(canvas.height, "canvas.height", source),
  };
}

function wireMediaRef(
  media: { readonly url: string } & {
    readonly drawX: number;
    readonly drawY: number;
    readonly drawW: number;
    readonly drawH: number;
    readonly fit?: "cover" | "contain" | "stretch";
  },
  source: string,
): WireMediaRef {
  return {
    url: media.url,
    draw: {
      x: integer(media.drawX, "drawX", source),
      y: integer(media.drawY, "drawY", source),
      width: integer(media.drawW, "drawW", source),
      height: integer(media.drawH, "drawH", source),
    },
    ...(media.fit === undefined ? {} : { fit: media.fit }),
  };
}

function wireText(
  text: RenderText,
  canvas: Canvas,
  index: number,
  config: RenderMappingConfig,
  source: string,
): WireTextObject {
  return {
    // Determinista por posición, y **nunca** aleatorio. El `id` entra en el
    // `overlayKey` del servicio (`domain/hash.ts` hashea `texts` completo), así
    // que un `randomUUID()` acá no rompería nada visible: simplemente haría que
    // la cache de overlay del servicio **nunca acierte**, que es plata de CPU
    // que se va sin que aparezca en ningún log.
    id: `t${String(index)}`,
    text: text.content,
    position: {
      x: editorUnits(text.x, canvas.width, POSITION_MIN, POSITION_MAX, "x", source),
      y: editorUnits(text.y, canvas.height, POSITION_MIN, POSITION_MAX, "y", source),
    },
    widthPercent: editorUnits(
      text.width,
      canvas.width,
      WIDTH_PERCENT_MIN,
      WIDTH_PERCENT_MAX,
      "width",
      source,
    ),
    align: text.textAlign,
    font: {
      family: text.fontFamily ?? config.defaultFontFamily,
      weight: text.fontWeight ?? config.defaultFontWeight,
      // `fontSize` ya viene validado en `[8, 72]` por `job-rules`; acá sólo se
      // hace entero, que es lo que el schema del servicio exige.
      size: Math.round(text.fontSize),
    },
    color: text.color,
    ...wireStroke(text),
    ...(text.backgroundColor === undefined
      ? {}
      : {
          background: {
            color: text.backgroundColor,
            opacity: config.textBackgroundOpacity,
            style: config.textBackgroundStyle,
          },
        }),
  };
}

/**
 * `strokeWidth` y `strokeColor` son opcionales y sueltos en el puerto; el
 * servicio los pide juntos o no los pide.
 *
 * Si no viene ninguno **se omite la clave entera** en vez de mandar un stroke
 * de ancho 0: así el default normativo de `FR-051` (3 px, `#000000`) queda en
 * un solo lugar —el schema del servicio— y no duplicado acá. Si viene uno solo,
 * el que falta toma ese mismo default.
 */
function wireStroke(
  text: RenderText,
): { stroke: { width: number; color: string } } | Record<string, never> {
  if (text.strokeWidth === undefined && text.strokeColor === undefined) return {};
  return {
    stroke: {
      width: text.strokeWidth ?? 3,
      color: text.strokeColor ?? "#000000",
    },
  };
}

/* ------------------------------------------------------------------------ *
 * La marca: al lado del payload, no adentro (sprint 9, S)
 * ------------------------------------------------------------------------ */

/** `brandFonts` del request de `POST /render` (espejo de `brandFontRefSchema`). */
export interface WireBrandFont {
  readonly id: string;
  readonly weight: number;
  readonly style: "normal" | "italic";
  readonly url: string;
}

/** `logo` del request de `POST /render` (espejo de `logoRequestSchema` de `engine.ts`). */
export interface WireLogo {
  readonly images: readonly { readonly url: string }[];
  readonly corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  readonly size: "small" | "medium" | "large";
  readonly opacity: number;
}

export interface WireBrandFields {
  readonly brandFonts?: readonly WireBrandFont[];
  readonly logo?: WireLogo;
}

/**
 * Las claves de marca del request. Van **al lado** de `payload` y no adentro
 * porque así las definió el servicio (M, `renderRequestSchema`): el payload de
 * `services/render` es de `FR-070` y las fuentes no son de la pieza sino de la
 * marca. Sin marca no se manda ninguna clave: el request es byte a byte el de
 * antes y la cache del servicio sigue acertando.
 */
export function toWireBrand(job: RenderJob): WireBrandFields {
  const brand = job.brand;
  if (brand === undefined) return {};
  const fonts = brand.fonts ?? [];
  const logo = brand.logo;
  return {
    ...(fonts.length === 0
      ? {}
      : {
          brandFonts: fonts.map((f) => ({
            id: f.id,
            weight: f.weight,
            style: f.style,
            url: f.url,
          })),
        }),
    ...(logo === undefined || logo.images.length === 0
      ? {}
      : {
          logo: {
            images: logo.images.map((i) => ({ url: i.url })),
            corner: logo.corner,
            size: logo.size,
            opacity: logo.opacity,
          },
        }),
  };
}

/* ------------------------------------------------------------------------ *
 * Conversión de unidades
 * ------------------------------------------------------------------------ */

/**
 * Píxeles de canvas → unidades de editor de `FR-051`.
 *
 * El rango se valida **acá y no sólo en el servicio**, aunque el servicio lo
 * vuelva a validar. La razón es de diagnóstico: el valor que se manda es
 * *derivado*, así que un `bad_request` remoto diría «`texts.0.position.x` debe
 * ser ≤ 100» y quien lo lea va a mirar el job del puerto, donde dice
 * `x: 1200`, sin ninguna pista de que hubo una conversión en el medio. El
 * mensaje de acá nombra las dos cosas.
 */
function editorUnits(
  pixels: number,
  extent: number,
  min: number,
  max: number,
  field: string,
  source: string,
): number {
  if (!Number.isFinite(pixels)) {
    throw new PortError("bad_request", `text ${field} is not a finite number`, {
      source,
    });
  }
  if (!Number.isFinite(extent) || extent <= 0) {
    throw new PortError("bad_request", "canvas without dimensions", { source });
  }

  // Seis decimales: suficiente para que 1 px sobre 4096 no se pierda, y
  // determinista, que es lo que la cache del servicio necesita.
  const raw = Math.round((pixels / extent) * 100 * 1e6) / 1e6;
  const snapped = snapToRange(raw, min, max);
  if (snapped < min || snapped > max) {
    throw new PortError(
      "bad_request",
      `text ${field} of ${String(pixels)} px maps to ${String(raw)}% of a ` +
        `${String(extent)} px canvas, outside the FR-051 range [${String(min)}, ${String(max)}]`,
      { source },
    );
  }
  return snapped;
}

function snapToRange(value: number, min: number, max: number): number {
  if (value < min && value >= min - RANGE_SNAP_EPSILON) return min;
  if (value > max && value <= max + RANGE_SNAP_EPSILON) return max;
  return value;
}

/**
 * El schema del servicio pide enteros en el canvas y en el rectángulo de
 * dibujo (`z.number().int()`), y el puerto tipa `number`.
 *
 * Se redondea en vez de rechazar: medio píxel es invisible y un `bad_request`
 * no lo es. Lo que **no** se hace es recortar al rango `[16, 4096]` del
 * servicio: redondear es una coerción de tipo, recortar sería cambiar la pieza
 * en silencio. Un canvas fuera de rango tiene que fallar, y falla allá.
 */
function integer(value: number, field: string, source: string): number {
  if (!Number.isFinite(value)) {
    throw new PortError("bad_request", `${field} is not a finite number`, { source });
  }
  return Math.round(value);
}
