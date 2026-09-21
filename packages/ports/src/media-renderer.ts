/**
 * Puerto MediaRenderer — IMPL ADR-007 e IMPL §5, PRD `FR-070`, `NFR-014`,
 * `NFR-025`, `ERR-P11`.
 *
 * Qué lo obliga: ADR-007 es la decisión mejor argumentada del plan y la que
 * más caro sale revisar. Remotion cobra **$0,01 por render con mínimo de
 * $100/mes** bajo su licencia «Automators»; a un millón de renders son
 * $10.000. La conclusión del ADR es la razón de este puerto: «**El render *es*
 * el producto: no puede tener un peaje por unidad**». Un motor que se elige
 * por licencia y por costo es un motor que se va a querer cambiar, y el ADR
 * deja además una decisión abierta (`P1-REPO-004`: construir FFmpeg sin
 * componentes GPL). Con el motor incrustado en el dominio, esa revisión sería
 * una refactorización.
 *
 * La segunda razón es de costo operativo, no de licencia. IMPL §5 pone el CPU
 * de render como driver #2 y prescribe «cachear por hash del payload de build:
 * si sólo cambió el texto, no re-encodear el video de fondo». Ese hash no lo
 * puede calcular `core` solo: tiene que incluir la versión del motor, porque
 * un upgrade de FFmpeg que mueve la tipografía **debe** invalidar el cache.
 * Por eso {@link MediaRenderer.fingerprint} vive acá y no en el dominio.
 *
 * Los payloads son los de `FR-070`, que el PRD marca como **contrato
 * normativo** (`[DEV POST /content]`). Se respetan los nombres tal cual,
 * incluida la asimetría entre `text` (uno) en los tres formatos de video y
 * `texts` (varios) por slide en `slideshow`: es lo que dice el contrato, y
 * «mejorarlo» acá lo desincronizaría del payload real.
 *
 * Errores (`PortError`):
 *  - `bad_request` — payload inválido: `num_images` que no coincide con
 *    `images.length`, más de {@link MAX_SLIDES} slides, `fontSize` fuera de
 *    `[8, 72]`, `aspectRatio` no reconocido (`400 bad_request` en `FR-051`),
 *    `video-hook` sin demo (`422 content_unavailable_for_type`).
 *  - `not_found` — una URL de media del payload no resuelve.
 *  - `timeout` — el render excedió su presupuesto. `NFR-001` acota el build a
 *    30 s–2 min y la UI nunca espera; el timeout es del worker.
 *  - `provider_unavailable` — `services/render` caído o sin capacidad
 *    (`NFR-025`: cuellea por CPU).
 *  - `provider_contract_violation` — el motor devolvió un artefacto que no es
 *    del `contentType` pedido.
 *
 * Lo que este puerto NO hace: **no valida que la media pertenezca al
 * workspace**. `P2-RENDER-009` exige rechazar una URL ajena «antes de iniciar
 * el build», y eso es autorización: vive en `core`, con el scope de
 * `companyId`. Un renderer que además autorizara sería un renderer que hay que
 * auditar dos veces. Tampoco sube el resultado: IMPL §2.3 separa render y
 * subida a propósito, para poder cachear entre ambos pasos.
 */

/** `FR-070`, SUPPORTED. */
export const MAX_SLIDES = 20;

/** `DATA-009` / `FR-051`, rangos normativos del objeto de texto. */
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 72;

/** `F-068` / `FR-051`: sólo aplica a `slideshow`; default `4:5`. */
export const SLIDE_ASPECT_RATIOS = ["1:1", "4:5", "3:4", "9:16"] as const;
export type SlideAspectRatio = (typeof SLIDE_ASPECT_RATIOS)[number];
export const DEFAULT_SLIDE_ASPECT_RATIO: SlideAspectRatio = "4:5";

export type ContentFormat = "slideshow" | "wall-of-text" | "green-screen" | "video-hook";

/* ------------------------------------------------------------------------ *
 * Primitivas del payload de build (`FR-070`, contrato normativo)
 * ------------------------------------------------------------------------ */

export type TextAlign = "left" | "center" | "right";

/**
 * Objeto de texto común a los cuatro formatos (`P2-RENDER-003`).
 *
 * **Píxeles de canvas, no unidades de editor.** `DATA-009` guarda
 * `position{x,y}` 0–100 y `widthPercent` 25–100 porque el editor de `FR-051`
 * trabaja en porcentajes; la conversión a píxeles la hace `core` al armar el
 * payload. Si el renderer aceptara porcentajes, habría dos lugares donde vive
 * la misma regla de layout.
 */
export interface RenderText {
  readonly content: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  /** `[MIN_FONT_SIZE, MAX_FONT_SIZE]`. */
  readonly fontSize: number;
  /** `#RRGGBB`. */
  readonly color: string;
  readonly textAlign: TextAlign;
  /** 100–900. Las 12 familias de `P2-RENDER-008` las valida `core`. */
  readonly fontWeight?: number;
  readonly fontFamily?: string;
  /** `[0, 8]` según `DATA-009`. */
  readonly strokeWidth?: number;
  readonly strokeColor?: string;
  readonly backgroundColor?: string;
}

export interface Canvas {
  readonly width: number;
  readonly height: number;
}

export interface SlideCanvas extends Canvas {
  readonly aspectRatio: SlideAspectRatio;
}

/** Rectángulo de destino dentro del canvas. Nombres literales de `FR-070`. */
export interface DrawBox {
  readonly drawX: number;
  readonly drawY: number;
  readonly drawW: number;
  readonly drawH: number;
}

export interface RenderImage extends DrawBox {
  /** URL firmada y de vida corta del storage propio (`NFR-008`). */
  readonly url: string;
}

export interface RenderVideo extends DrawBox {
  readonly url: string;
}

export interface RenderAudio {
  /** `FR-070`: «El audio sólo puede venir de la librería compartida». */
  readonly url: string;
}

/* ------------------------------------------------------------------------ *
 * Los cuatro formatos
 * ------------------------------------------------------------------------ */

export interface SlideshowSlide {
  readonly canvas: SlideCanvas;
  readonly image: RenderImage;
  readonly texts: readonly RenderText[];
}

export interface SlideshowJob {
  readonly format: "slideshow";
  /** Debe coincidir con `images.length` (`FR-070`), máx. {@link MAX_SLIDES}. */
  readonly num_images: number;
  readonly images: readonly SlideshowSlide[];
}

export interface WallOfTextJob {
  readonly format: "wall-of-text";
  readonly canvas: Canvas;
  readonly video: RenderVideo;
  readonly audio: RenderAudio;
  readonly text: RenderText;
}

export interface GreenScreenJob {
  readonly format: "green-screen";
  readonly canvas: Canvas;
  /** Fondo. El video con croma se compone **encima** (`FR-070`). */
  readonly image: RenderImage;
  readonly video: RenderVideo;
  readonly text: RenderText;
}

export interface VideoHookJob {
  readonly format: "video-hook";
  readonly canvas: Canvas;
  /** Arriba. */
  readonly hook_video: RenderVideo;
  /** Abajo. Sin esto el formato no se puede generar (`ERR-P07`). */
  readonly demo_video: RenderVideo;
  readonly audio: RenderAudio;
  readonly text: RenderText;
}

export type RenderJob = SlideshowJob | WallOfTextJob | GreenScreenJob | VideoHookJob;

/* ------------------------------------------------------------------------ *
 * Resultados
 * ------------------------------------------------------------------------ */

export interface RenderedMedia {
  /**
   * El artefacto. Quien llama lo sube con `Storage`: IMPL §2.3 separa render
   * de subida para poder cachear por {@link MediaRenderer.fingerprint} entre
   * los dos pasos.
   */
  readonly body: AsyncIterable<Uint8Array>;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds?: number;
}

export interface RenderResult extends RenderedMedia {
  /** El mismo que devolvería {@link MediaRenderer.fingerprint} para este job. */
  readonly fingerprint: string;
  readonly renderMs: number;
}

/** `ERR-P11`: «We couldn't read this video's details». */
export interface MediaProbe {
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds?: number;
  readonly hasAudio: boolean;
  /** `NFR-014`: si es HDR hay que pasarlo a SDR antes de usarlo. */
  readonly isHdr: boolean;
  /** `false` ⇒ el archivo necesita `faststart` para streaming progresivo. */
  readonly isFastStart: boolean;
}

export interface NormalizeRequest {
  readonly url: string;
  /** `NFR-014`: MOV→MP4, HDR→SDR, faststart. */
  readonly targetContentType: string;
}

export interface ThumbnailRequest {
  readonly url: string;
  /** Segundos desde el inicio. Ignorado en imágenes. */
  readonly atSeconds?: number;
  readonly maxWidth: number;
}

export interface MediaRenderer {
  /**
   * Un build. Síncrono desde el punto de vista del worker; quien lo invoca ya
   * está en background (`NFR-001`: la UI nunca espera un render).
   */
  render(job: RenderJob): Promise<RenderResult>;

  /**
   * Hash estable del job **más la versión del motor**.
   *
   * IMPL §5: mismo payload ⇒ mismo frame ⇒ no re-encodear. Incluir la versión
   * del motor es lo que hace que un upgrade de FFmpeg invalide el cache en vez
   * de servir frames viejos con tipografía distinta — que es exactamente lo
   * que los golden-file tests de `P2-RENDER-011` buscan detectar.
   *
   * Puro: no toca red ni disco, y dos llamadas con el mismo job dan lo mismo.
   */
  fingerprint(job: RenderJob): string;

  /** `NFR-014` / `P2-RENDER-013`. */
  normalize(request: NormalizeRequest): Promise<RenderedMedia>;

  /** Metadatos antes de aceptar un upload. `ERR-P11` sale de acá. */
  probe(url: string): Promise<MediaProbe>;

  /** IMPL §5: «Nunca servir el master para un preview». */
  thumbnail(request: ThumbnailRequest): Promise<RenderedMedia>;
}
