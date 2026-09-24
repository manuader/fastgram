/**
 * De una sugerencia aceptada a su `buildPayload` — `FR-050`, `FR-070`,
 * `DATA-007`, `DATA-008`.
 *
 * ## El problema que cierra
 *
 * `POST /blitz` creaba la pieza **sin** `buildPayload`, y el worker la cerraba
 * `FAILED` con `invalid_build_payload` después de cobrar (y reembolsar) el
 * save. Una `Suggestion` (`DATA-007`) no llevaba nada con qué construir.
 *
 * ## Qué se persiste en la sugerencia y qué se calcula al aceptar
 *
 * Se **persiste** (`suggestions.build_plan`, migración `0011`) lo que se decide
 * al planificar y no se puede recalcular sin volver a tirar el dado o volver a
 * llamar al LLM: la media elegida ({@link MediaSelection}) y los textos
 * ({@link SuggestionBuildPlan.texts}). `AI-002`: la copy «se almacena con la
 * sugerencia, no se regenera».
 *
 * Se **calcula al aceptar** lo que depende de la petición: el canvas del
 * slideshow sale del `aspectRatio` que manda el cliente (`FR-050` Validation),
 * y el look del texto sale de `textStylePresetId`, que ya es una columna.
 *
 * ## Por qué vive en `core`
 *
 * La usan dos procesos: la API la ejecuta dentro de la transacción que cobra, y
 * el test de punta a punta del worker la pasa por `toRenderJob`. Una copia en
 * cada app sería la segunda definición de la geometría, y la trampa 19 del
 * handoff (un nombre de cola escrito de los dos lados) ya mostró cómo termina.
 *
 * `core` no importa `contracts` (no importa npm), así que el payload de acá es
 * **estructural**: la API lo valida contra `contentBuildPayloadSchema` antes de
 * escribirlo, y ese es el mismo schema que revalida el worker.
 */
import { DomainError } from "../errors.js";
import type { AspectRatio, BlitzContentType } from "../content/content.js";
import { TEXT_BOX_LIMITS } from "../content/text-boxes.js";
import { HARD_CAPS } from "../quota/plans.js";
import type { MediaRef, MediaSelection } from "./blitz-media.js";
import { TEXT_STYLE_PRESETS, type TextStylePreset } from "./blitz-preferences.js";

// ───────────────────────────────────────────────────────────────────────────
// El plan persistido
// ───────────────────────────────────────────────────────────────────────────

/**
 * Versión del formato de `build_plan`. Una sugerencia planificada con otra
 * versión **no se construye**: se descarta al aceptar (ver la API). Es la
 * diferencia entre «se rechaza antes de cobrar» y «falla el build después».
 */
export const SUGGESTION_BUILD_PLAN_VERSION = 1;

export interface SuggestionBuildPlan {
  readonly version: typeof SUGGESTION_BUILD_PLAN_VERSION;
  readonly media: MediaSelection;
  /**
   * Un texto por slide en `slideshow` (y tantos slides como textos); uno solo
   * en los otros tres formatos — `FR-070`: `text` en singular.
   */
  readonly texts: readonly string[];
  /**
   * Sprint 7 (audio): la pista de la biblioteca de la marca que el refill
   * sorteó para una pieza de video. Ausente = sin música (`FR-053.1`). Es
   * opcional y no sube la versión: un plan viejo sin la clave sigue siendo
   * válido y significa exactamente eso.
   */
  readonly audio?: BuildPlanAudio | undefined;
}

/** Una pista de la biblioteca de la marca, tal como se guarda en el plan. */
export interface BuildPlanAudio {
  readonly audioId: string;
  readonly url: string;
}

function parseAudio(v: unknown): BuildPlanAudio | null {
  if (!isObj(v)) return null;
  const { audioId, url } = v;
  if (typeof audioId !== "string" || audioId === "") return null;
  if (typeof url !== "string" || url === "") return null;
  return { audioId, url };
}

export type ParsedBuildPlan =
  | { readonly ok: true; readonly plan: SuggestionBuildPlan }
  | { readonly ok: false; readonly reason: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseRef(v: unknown): MediaRef | null {
  if (!isObj(v)) return null;
  const { mediaId, url } = v;
  if (typeof mediaId !== "string" || mediaId === "") return null;
  if (typeof url !== "string" || url === "") return null;
  return { mediaId, url };
}

/**
 * Valida un `build_plan` que vuelve de la base como `unknown` (`jsonb`).
 *
 * A mano y no con Zod por la regla `core-no-npm`. Devuelve un resultado en vez
 * de lanzar: quien llama tiene que poder **descartar** la sugerencia con un
 * motivo, no convertir el problema en un 500.
 */
export function parseSuggestionBuildPlan(
  raw: unknown,
  contentType: BlitzContentType,
): ParsedBuildPlan {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "missing_build_plan" };
  }
  if (!isObj(raw)) return { ok: false, reason: "build_plan is not an object" };
  if (raw["version"] !== SUGGESTION_BUILD_PLAN_VERSION) {
    return {
      ok: false,
      reason: `unsupported build_plan version ${String(raw["version"])}`,
    };
  }

  const textsRaw = raw["texts"];
  if (!Array.isArray(textsRaw) || textsRaw.length === 0) {
    return { ok: false, reason: "build_plan.texts is empty" };
  }
  const texts: string[] = [];
  for (const t of textsRaw) {
    if (typeof t !== "string" || t.trim() === "") {
      return { ok: false, reason: "build_plan.texts has an empty entry" };
    }
    if (t.length > TEXT_BOX_LIMITS.textMaxChars) {
      return { ok: false, reason: "build_plan.texts has an entry over the text limit" };
    }
    texts.push(t);
  }

  const m = raw["media"];
  if (!isObj(m)) return { ok: false, reason: "build_plan.media is missing" };
  if (m["format"] !== contentType) {
    return {
      ok: false,
      reason: `build_plan.media is for ${String(m["format"])}, the suggestion is ${contentType}`,
    };
  }

  let media: MediaSelection;
  switch (contentType) {
    case "slideshow": {
      const slidesRaw = m["slides"];
      if (!Array.isArray(slidesRaw)) return { ok: false, reason: "slides missing" };
      const slides = slidesRaw.map(parseRef);
      if (slides.some((s) => s === null)) return { ok: false, reason: "bad slide ref" };
      if (slides.length !== texts.length) {
        return { ok: false, reason: "slides and texts differ in length" };
      }
      if (slides.length > HARD_CAPS.slidesPerSlideshow) {
        return { ok: false, reason: "too many slides" };
      }
      media = { format: "slideshow", slides: slides as MediaRef[] };
      break;
    }
    case "wall-of-text": {
      const video = parseRef(m["video"]);
      if (video === null) return { ok: false, reason: "video missing" };
      media = { format: "wall-of-text", video };
      break;
    }
    case "green-screen": {
      const image = parseRef(m["image"]);
      const video = parseRef(m["video"]);
      if (image === null || video === null) {
        return { ok: false, reason: "image or video missing" };
      }
      media = { format: "green-screen", image, video };
      break;
    }
    case "video-hook": {
      const hookVideo = parseRef(m["hookVideo"]);
      const demoVideo = parseRef(m["demoVideo"]);
      if (hookVideo === null || demoVideo === null) {
        return { ok: false, reason: "hook or demo video missing" };
      }
      media = { format: "video-hook", hookVideo, demoVideo };
      break;
    }
  }
  if (contentType !== "slideshow" && texts.length !== 1) {
    return { ok: false, reason: `${contentType} carries exactly one text` };
  }
  // La música es un extra: una clave rota no descarta la sugerencia, sale sin
  // música. Un slideshow nunca la lleva (se exporta como imágenes).
  const audio =
    contentType === "slideshow" || raw["audio"] === undefined
      ? null
      : parseAudio(raw["audio"]);
  return {
    ok: true,
    plan: {
      version: SUGGESTION_BUILD_PLAN_VERSION,
      media,
      texts,
      ...(audio === null ? {} : { audio }),
    },
  };
}

/**
 * `generatedText` de la sugerencia y de la pieza: la copy extraíble
 * (`DATA-008`, ≤ 2 000). En un slideshow, los textos de los slides en orden.
 */
export function generatedTextOf(texts: readonly string[]): string {
  return texts.map((t) => t.trim()).join("\n\n");
}

// ───────────────────────────────────────────────────────────────────────────
// El look del texto: presets de caption (`FR-055`)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Lo que un preset fija del objeto de texto de `FR-070`.
 *
 * **Sin familia tipográfica, y no por olvido**: el objeto de texto del payload
 * de build (`FR-070`, contrato normativo) no lleva `fontFamily`, así que un
 * preset no puede cambiarla; el motor usa su default. Queda reportado.
 */
export interface CaptionStyle {
  readonly color: string;
  readonly fontWeight: number;
  readonly strokeWidth?: number;
  readonly strokeColor?: string;
  readonly backgroundColor?: string;
}

/**
 * `FR-051`: los valores que muestra el inspector por defecto — `Color #FFFFFF`,
 * `Stroke 3px`, `Stroke Color #000000`, `Weight Medium`. Son los únicos números
 * de estilo que da el PRD, y son el look de «el motor por defecto» cuando el
 * workspace no tiene mix de captions (`textStyleWeights = {}`).
 */
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  color: "#FFFFFF",
  fontWeight: 500,
  strokeWidth: 3,
  strokeColor: "#000000",
};

/**
 * Los siete presets de `FR-055`.
 *
 * **El PRD da los nombres y no los valores** («cada preset agrupa fuente,
 * color, stroke y fondo legibles sobre cualquier fondo»). Esta tabla es una
 * elección de diseño leída del nombre, no un dato: es el único lugar donde
 * vive, y cambiarla no toca nada más. Todos respetan los rangos normativos de
 * `FR-051` (stroke 0–8, `#RRGGBB`), que el contrato vuelve a validar.
 */
export const CAPTION_STYLES: Readonly<Record<TextStylePreset, CaptionStyle>> = {
  "tiktok-classic": DEFAULT_CAPTION_STYLE,
  "bold-impact": {
    color: "#FFFFFF",
    fontWeight: 700,
    strokeWidth: 6,
    strokeColor: "#000000",
  },
  snapchat: { color: "#FFFFFF", fontWeight: 500, backgroundColor: "#000000" },
  "white-box": { color: "#000000", fontWeight: 600, backgroundColor: "#FFFFFF" },
  "yellow-pop": {
    color: "#FFD600",
    fontWeight: 700,
    strokeWidth: 4,
    strokeColor: "#000000",
  },
  "clean-karaoke": {
    color: "#FFFFFF",
    fontWeight: 600,
    strokeWidth: 2,
    strokeColor: "#000000",
  },
  "script-playful": {
    color: "#FFFFFF",
    fontWeight: 400,
    strokeWidth: 2,
    strokeColor: "#000000",
  },
};

/** El estilo de una sugerencia: su preset, o el default si no tiene. */
export function captionStyleFor(presetId: string | null | undefined): CaptionStyle {
  if (presetId === null || presetId === undefined) return DEFAULT_CAPTION_STYLE;
  if (!(TEXT_STYLE_PRESETS as readonly string[]).includes(presetId)) {
    // Un id desconocido en la columna es un cambio de la lista sin migrar las
    // sugerencias viejas. Construir con el default sería esconderlo.
    throw new DomainError("invalid_state", "Unknown caption style on the suggestion.", {
      presetId,
    });
  }
  return CAPTION_STYLES[presetId as TextStylePreset];
}

// ───────────────────────────────────────────────────────────────────────────
// La geometría
// ───────────────────────────────────────────────────────────────────────────

/** `FR-070`: *"canvas = {width, height} en píxeles (p. ej. 1080×1920)"*. */
export const BLITZ_VIDEO_CANVAS = { width: 1080, height: 1920 } as const;

/** `FR-070`: *"para slideshows la ratio objetivo por defecto es 4:5"*. */
export const DEFAULT_SLIDESHOW_ASPECT_RATIO: AspectRatio = "4:5";

const ASPECT_FRACTIONS: Readonly<Record<AspectRatio, readonly [number, number]>> = {
  "1:1": [1, 1],
  "4:5": [4, 5],
  "3:4": [3, 4],
  "9:16": [9, 16],
};

/** Mismo cálculo que `canvasForAspect` de `services/render`: ancho 1080, alto par. */
export function slideshowCanvas(aspectRatio: AspectRatio): {
  width: number;
  height: number;
} {
  const [w, h] = ASPECT_FRACTIONS[aspectRatio];
  const width = BLITZ_VIDEO_CANVAS.width;
  const raw = Math.round((width * h) / w);
  return { width, height: raw % 2 === 0 ? raw : raw - 1 };
}

/**
 * Tamaño del texto en unidades de editor (`FR-051`, 8–72). **18** es el único
 * valor que da el PRD (`Size: <18px>` en el inspector) y el default del schema
 * de `services/render`. Que se lea bien en 1080 px de ancho no está verificado
 * mirando un frame: queda reportado.
 */
export const BLITZ_CAPTION_FONT_SIZE = 18;

/**
 * Ancho de la caja: 90 % del canvas. Elección de layout sin número en el PRD;
 * el único límite normativo es `widthPercent` ∈ [25, 100] (`FR-051`).
 */
const TEXT_WIDTH_RATIO = 0.9;

/**
 * Altura del **centro** de la caja (el servicio de render interpreta
 * `position` como centro), como fracción del canvas. Elecciones de layout, sin
 * número en el PRD, una por formato:
 *  - `slideshow` y `wall-of-text`: centrado; el texto **es** la pieza.
 *  - `green-screen`: arriba, como caption de meme sobre el clip.
 *  - `video-hook`: sobre la mitad del hook, que ocupa la mitad de arriba.
 */
const TEXT_CENTER_Y: Readonly<Record<BlitzContentType, number>> = {
  slideshow: 0.5,
  "wall-of-text": 0.5,
  "green-screen": 0.15,
  "video-hook": 0.25,
};

// ───────────────────────────────────────────────────────────────────────────
// El payload — la forma de `contentBuildPayloadSchema` (`FR-070`)
// ───────────────────────────────────────────────────────────────────────────

export interface BlitzBuildText {
  readonly content: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly fontSize: number;
  readonly color: string;
  readonly textAlign: "left" | "center" | "right";
  readonly fontWeight?: number;
  readonly strokeWidth?: number;
  readonly strokeColor?: string;
  readonly backgroundColor?: string;
}

export interface BlitzMediaElement {
  readonly url: string;
  readonly drawX: number;
  readonly drawY: number;
  readonly drawW: number;
  readonly drawH: number;
  /** Sin él, `cover`. Ver el green screen en `composeBlitzBuildPayload`. */
  readonly fit?: "contain";
}

export type BlitzBuildPayload =
  | {
      readonly num_images: number;
      readonly images: readonly {
        readonly canvas: { width: number; height: number; aspectRatio: AspectRatio };
        readonly image: BlitzMediaElement;
        readonly texts: readonly BlitzBuildText[];
      }[];
    }
  | {
      readonly canvas: { width: number; height: number };
      readonly video: BlitzMediaElement;
      readonly audio?: { readonly url: string };
      readonly text: BlitzBuildText;
    }
  | {
      readonly canvas: { width: number; height: number };
      readonly image: BlitzMediaElement;
      readonly video: BlitzMediaElement;
      readonly audio?: { readonly url: string };
      readonly text: BlitzBuildText;
    }
  | {
      readonly canvas: { width: number; height: number };
      readonly hook_video: BlitzMediaElement;
      readonly demo_video: BlitzMediaElement;
      readonly audio?: { readonly url: string };
      readonly text: BlitzBuildText;
    };

function textFor(
  content: string,
  canvas: { width: number; height: number },
  format: BlitzContentType,
  style: CaptionStyle,
): BlitzBuildText {
  return {
    content,
    x: Math.round(canvas.width / 2),
    y: Math.round(canvas.height * TEXT_CENTER_Y[format]),
    width: Math.round(canvas.width * TEXT_WIDTH_RATIO),
    fontSize: BLITZ_CAPTION_FONT_SIZE,
    color: style.color,
    textAlign: "center",
    fontWeight: style.fontWeight,
    ...(style.strokeWidth === undefined ? {} : { strokeWidth: style.strokeWidth }),
    ...(style.strokeColor === undefined ? {} : { strokeColor: style.strokeColor }),
    ...(style.backgroundColor === undefined
      ? {}
      : { backgroundColor: style.backgroundColor }),
  };
}

/**
 * `FR-070` v1: *"stretch-to-canvas"* — la media ocupa el rectángulo pedido.
 * Es el contrato del PRD, con la distorsión que él mismo documenta (`EXT-006`
 * lo mejoraría).
 */
/**
 * Dónde empieza el tramo del meme en un green screen, en fracción del alto.
 * El caption va al 15 % (`TEXT_TOP`); 0,35 le deja lugar a tres líneas.
 */
export const GREEN_SCREEN_CLIP_TOP = 0.35;

const fill = (
  m: MediaRef,
  rect: { x: number; y: number; w: number; h: number },
): BlitzMediaElement => ({
  url: m.url,
  drawX: rect.x,
  drawY: rect.y,
  drawW: rect.w,
  drawH: rect.h,
});

export interface ComposeOptions {
  /** Sólo aplica a slideshow (`FR-050`). Default `4:5` (`FR-070`). */
  readonly aspectRatio?: AspectRatio | undefined;
  readonly textStylePresetId?: string | null | undefined;
}

/**
 * El payload de build de una sugerencia. Con bloque `audio` sólo si el plan
 * trae una pista de la biblioteca de la marca (sprint 7); sin ella, `No audio`
 * (`FR-053.1`).
 */
export function composeBlitzBuildPayload(
  plan: SuggestionBuildPlan,
  options: ComposeOptions = {},
): BlitzBuildPayload {
  const style = captionStyleFor(options.textStylePresetId);
  const media = plan.media;
  const first = plan.texts[0] as string;

  if (media.format === "slideshow") {
    const aspectRatio = options.aspectRatio ?? DEFAULT_SLIDESHOW_ASPECT_RATIO;
    const canvas = slideshowCanvas(aspectRatio);
    const images = media.slides.map((slide, i) => ({
      canvas: { ...canvas, aspectRatio },
      image: fill(slide, { x: 0, y: 0, w: canvas.width, h: canvas.height }),
      texts: [textFor(plan.texts[i] as string, canvas, "slideshow", style)],
    }));
    return { num_images: images.length, images };
  }

  const canvas = { ...BLITZ_VIDEO_CANVAS };
  const full = { x: 0, y: 0, w: canvas.width, h: canvas.height };
  const audio = plan.audio === undefined ? {} : { audio: { url: plan.audio.url } };

  switch (media.format) {
    case "wall-of-text":
      return {
        canvas,
        video: fill(media.video, full),
        ...audio,
        text: textFor(first, canvas, "wall-of-text", style),
      };
    case "green-screen":
      // El fondo ocupa el canvas y el clip con croma se compone **encima**
      // (`FR-070`). Hasta el sprint 7 el clip iba `cover` a canvas completo:
      // un meme 16:9 en un lienzo 9:16 perdía ~70 % de los costados (visto en
      // la app con un clip real). Ahora entra **entero** (`contain`) en el
      // tramo de abajo, debajo del caption, como en Fastlane.
      return {
        canvas,
        image: fill(media.image, full),
        video: {
          ...fill(media.video, {
            x: 0,
            y: Math.round(canvas.height * GREEN_SCREEN_CLIP_TOP),
            w: canvas.width,
            h: canvas.height - Math.round(canvas.height * GREEN_SCREEN_CLIP_TOP),
          }),
          fit: "contain",
        },
        ...audio,
        text: textFor(first, canvas, "green-screen", style),
      };
    case "video-hook": {
      // «Hook arriba, demo abajo» (`FR-070`). El PRD no fija el reparto; mitad
      // y mitad es también el default de `services/render` (`hookHeightRatio`).
      const half = canvas.height / 2;
      return {
        canvas,
        hook_video: fill(media.hookVideo, { x: 0, y: 0, w: canvas.width, h: half }),
        demo_video: fill(media.demoVideo, { x: 0, y: half, w: canvas.width, h: half }),
        ...audio,
        text: textFor(first, canvas, "video-hook", style),
      };
    }
  }
}

/**
 * El plan que se persiste, una vez que hay copy. En un slideshow quedan
 * **tantos slides como textos** devolvió el modelo (`FR-070`: `num_images`
 * igual a `images.length`), tomando las primeras candidatas en su orden.
 */
export function finalizeBuildPlan(
  media: MediaSelection,
  texts: readonly string[],
): SuggestionBuildPlan {
  if (texts.length === 0) throw new Error("un plan sin textos no se construye");
  if (media.format === "slideshow") {
    if (texts.length > media.slides.length) {
      throw new Error(
        `${String(texts.length)} textos para ${String(media.slides.length)} imágenes`,
      );
    }
    return {
      version: SUGGESTION_BUILD_PLAN_VERSION,
      media: { format: "slideshow", slides: media.slides.slice(0, texts.length) },
      texts: [...texts],
    };
  }
  if (texts.length !== 1) throw new Error(`${media.format} lleva un solo texto`);
  return { version: SUGGESTION_BUILD_PLAN_VERSION, media, texts: [...texts] };
}

/**
 * El plan con las URLs **de hoy** de cada media.
 *
 * `POST /blitz` relee la media al aceptar (para saber que sigue viva) y usa la
 * URL que tiene ahora: si algo la reescribió entre planificar y aceptar, la
 * que vale es la de la fila, no la copiada en el plan. Un id que no esté en
 * `urls` es un error de quien llama: ya tenía que haber verificado que existe.
 */
export function rebindMediaUrls(
  plan: SuggestionBuildPlan,
  urls: ReadonlyMap<string, string>,
): SuggestionBuildPlan {
  const at = (r: MediaRef): MediaRef => {
    const url = urls.get(r.mediaId);
    if (url === undefined) throw new Error(`media ${r.mediaId} sin URL viva`);
    return { mediaId: r.mediaId, url };
  };
  const m = plan.media;
  const media: MediaSelection =
    m.format === "slideshow"
      ? { format: m.format, slides: m.slides.map(at) }
      : m.format === "wall-of-text"
        ? { format: m.format, video: at(m.video) }
        : m.format === "green-screen"
          ? { format: m.format, image: at(m.image), video: at(m.video) }
          : { format: m.format, hookVideo: at(m.hookVideo), demoVideo: at(m.demoVideo) };
  return { ...plan, media };
}

/**
 * Sorteo de la música de una pieza nueva (sprint 7, refill de Blitz).
 *
 * Cada pista candidata pesa 1 (las que el dueño sacó del sorteo, `autoUse =
 * false`, ni llegan acá: peso 0). Sin candidatas, o en un slideshow, no hay
 * música. Recibe `pick` y no el puerto `Rng` para no atar este archivo a él:
 * quien llama pasa `rng.weightedPick`.
 */
export function pickBuildPlanAudio(
  contentType: BlitzContentType,
  tracks: readonly BuildPlanAudio[],
  pick: (items: readonly { value: BuildPlanAudio; weight: number }[]) => BuildPlanAudio,
): BuildPlanAudio | null {
  if (contentType === "slideshow" || tracks.length === 0) return null;
  return pick(tracks.map((value) => ({ value, weight: 1 })));
}
