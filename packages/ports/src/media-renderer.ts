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

/**
 * Los cuatro formatos que el renderer sabe construir (`FR-070`).
 *
 * En runtime y no sólo como unión para que `scripts/check-consistency.mjs`
 * pueda compararla con sus gemelos —el enum `suggestion_content_type` de
 * `packages/db`, `blitzContentTypeSchema` de `packages/contracts` y
 * `BLITZ_CONTENT_TYPES` de `packages/core`—, que es lo que `ports` no puede
 * hacer porque no importa ninguno de los tres. `custom` no está a propósito: es
 * video propio subido (`POST /content/custom/video`), no se renderiza. Mismo
 * orden que el `CREATE TYPE` de la base.
 */
export const RENDER_FORMATS = [
  "slideshow",
  "wall-of-text",
  "green-screen",
  "video-hook",
] as const;
export type ContentFormat = (typeof RENDER_FORMATS)[number];

/* ------------------------------------------------------------------------ *
 * Primitivas del payload de build (`FR-070`, contrato normativo)
 * ------------------------------------------------------------------------ */

/**
 * `FR-070`. Gemelos: `textAlignSchema` de `packages/contracts` (lo que acepta la
 * API) y el de `services/render` (lo que dibuja el motor). En runtime para que
 * `scripts/check-consistency.mjs` vea las tres a la vez.
 */
export const TEXT_ALIGNS = ["left", "center", "right"] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];

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
  /** Sin él, `cover`. Sprint 7: `contain` para el meme del green screen. */
  readonly fit?: "cover" | "contain" | "stretch";
}

export interface RenderImage extends DrawBox {
  /** URL firmada y de vida corta del storage propio (`NFR-008`). */
  readonly url: string;
}

export interface RenderVideo extends DrawBox {
  readonly url: string;
}

export interface RenderAudio {
  /**
   * `FR-070`: «El audio sólo puede venir de la librería». Desde el sprint 7 la
   * librería es la de **la marca** (`audio/{companyId}/`), que el grant firma
   * en `sharedPrefixes`.
   */
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
  /**
   * **Opcional**: `FR-053.1` (PRD:1234) dice que elegir *No audio* omite el
   * bloque entero. Estaba obligatorio acá, y el contrato público
   * (`contentBuildPayloadSchema`) ya lo tenía opcional — así que una pieza
   * perfectamente válida creada por `POST /content` no se podía ni escribir
   * como {@link RenderJob}. El que manda es el PRD.
   */
  readonly audio?: RenderAudio | undefined;
  readonly text: RenderText;
}

export interface GreenScreenJob {
  readonly format: "green-screen";
  readonly canvas: Canvas;
  /** Fondo. El video con croma se compone **encima** (`FR-070`). */
  readonly image: RenderImage;
  readonly video: RenderVideo;
  /**
   * Sprint 7: música de la biblioteca de la marca. El servicio la **mezcla**
   * con el audio del clip de croma (clip al 100 %, música al 30 %); sin clip
   * con audio, la música va sola. Ausente = sólo el audio del clip.
   */
  readonly audio?: RenderAudio | undefined;
  readonly text: RenderText;
}

export interface VideoHookJob {
  readonly format: "video-hook";
  readonly canvas: Canvas;
  /** Arriba. */
  readonly hook_video: RenderVideo;
  /** Abajo. Sin esto el formato no se puede generar (`ERR-P07`). */
  readonly demo_video: RenderVideo;
  /** Opcional por la misma razón que en {@link WallOfTextJob}. */
  readonly audio?: RenderAudio | undefined;
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

/* ------------------------------------------------------------------------ *
 * Autorización
 * ------------------------------------------------------------------------ */

/**
 * Quién pide el render y qué media tiene permitido leer.
 *
 * ── Por qué viaja AL LADO del job y no adentro ──────────────────────────────
 *
 * `services/render` es sin estado: no tiene base y no puede preguntar si el
 * asset `abc` es del workspace 42. La autoridad vive afuera y llega en el
 * pedido. Pero meterla dentro de {@link RenderJob} rompería dos cosas:
 *
 *  1. **El cache.** {@link MediaRenderer.fingerprint} hashea el job, y toda
 *     autorización lleva vencimiento. Un `expiresAt` adentro del job haría que
 *     dos builds idénticos con diez minutos de diferencia tengan fingerprints
 *     distintos: el cache de IMPL §5 dejaría de acertar **nunca**, y el
 *     síntoma sería una factura de CPU, no un error.
 *  2. **El significado.** Un `RenderJob` describe qué dibujar. Quién puede
 *     leer los bytes es otra pregunta, y mezclarlas hace que la respuesta a la
 *     segunda entre en el hash de la primera.
 *
 * Dos workspaces que rindan el mismo job **comparten el artefacto** cacheado, y
 * está bien: si las URLs de media difieren, el job difiere y el fingerprint
 * también. Lo que se comparte es un artefacto idéntico byte a byte.
 *
 * ── Por qué no es opcional ──────────────────────────────────────────────────
 *
 * Todo acceso a datos lleva scope de `companyId`, y un render lee media del
 * workspace. Si esto fuera opcional, olvidarlo compilaría y fallaría en
 * producción con un error de proveedor opaco en cada build. Siendo obligatorio,
 * el compilador obliga a cada llamada a decir de quién es la media.
 *
 * El puerto transporta **intención**, no mecanismo: acá no hay firma, ni
 * secreto, ni vencimiento. El adaptador es el que sabe cómo su servicio quiere
 * que se demuestre esto (hoy, un grant HMAC con TTL propio).
 */
export interface MediaAuthorization {
  readonly companyId: string;
  /** Prefijos del Media Bank del workspace (origen + comienzo de ruta). */
  readonly mediaPrefixes: readonly string[];
  /** Prefijos de la librería compartida. Único origen válido para audio. */
  readonly sharedPrefixes: readonly string[];
  /**
   * Si viene, la URL además tiene que estar textualmente en esta lista.
   * Es el cierre más estrecho: autoriza estas URLs y ninguna otra.
   */
  readonly urls?: readonly string[] | undefined;
}

/**
 * Un build con **N** artefactos.
 *
 * Existe porque un slideshow de N slides son N imágenes y {@link RenderResult}
 * transporta una. Mientras el puerto no supo expresarlo, el adaptador HTTP
 * tenía que elegir entre devolver el primero —publicando una pieza de una sola
 * imagen, sin error en ningún log— y fallar. Fallaba, que era lo correcto y
 * dejaba el formato sin construir.
 */
export type RenderArtifactKind = "video" | "image";

/**
 * Un artefacto del build, **sin bajar**.
 *
 * Es perezoso y no una {@link RenderedMedia} ya abierta porque un slideshow
 * llega a 20 slides: devolverlos abiertos serían 20 cuerpos HTTP en vuelo a la
 * vez, sostenidos hasta que quien llama termine de subir el último. Quien
 * consume esto los abre y los sube de a uno.
 */
export interface RenderArtifactRef {
  readonly kind: RenderArtifactKind;
  /** Posición dentro del build. Un slideshow los entrega en orden de slide. */
  readonly index: number;
  /** Lo que el motor dice que pesa. Se verifica al abrir. */
  readonly sizeBytes: number;
  /**
   * Baja el artefacto. **Una sola vez por referencia** y **en el mismo flujo**
   * que el build: devuelve un stream, no un buffer, y del otro lado la cache
   * puede ser local a una réplica. Guardar la referencia para después es un
   * bug con demora.
   */
  readonly open: () => Promise<RenderedMedia>;
}

export interface RenderBuild {
  readonly artifacts: readonly RenderArtifactRef[];
  /** El mismo que devolvería {@link MediaRenderer.fingerprint} para este job. */
  readonly fingerprint: string;
  readonly renderMs: number;
}

export interface MediaRenderer {
  /**
   * Un build. Síncrono desde el punto de vista del worker; quien lo invoca ya
   * está en background (`NFR-001`: la UI nunca espera un render).
   */
  render(job: RenderJob, auth: MediaAuthorization): Promise<RenderResult>;

  /**
   * El mismo build, con todos sus artefactos.
   *
   * `render` es el caso de uno y falla si el motor devuelve más; esto es el
   * caso general. Un slideshow de más de un slide **sólo** se puede construir
   * por acá: quien llama sube los N objetos.
   */
  renderAll(job: RenderJob, auth: MediaAuthorization): Promise<RenderBuild>;

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
  normalize(request: NormalizeRequest, auth: MediaAuthorization): Promise<RenderedMedia>;

  /** Metadatos antes de aceptar un upload. `ERR-P11` sale de acá. */
  probe(url: string, auth: MediaAuthorization): Promise<MediaProbe>;

  /** IMPL §5: «Nunca servir el master para un preview». */
  thumbnail(request: ThumbnailRequest, auth: MediaAuthorization): Promise<RenderedMedia>;
}

/* ------------------------------------------------------------------------ *
 * Reels (sprint 9, `PU-S9-009`, `D-20`) — puerto aparte y aditivo
 * ------------------------------------------------------------------------ */

/**
 * Un render de reel. El `spec` viaja **opaco** (`ReelSpec` de
 * `@fastgram/contracts`, validado por la API al guardarlo y por el servicio al
 * recibirlo): `ports` no importa `contracts` ni `core`, y duplicar acá las
 * seis clases de capa sería una tercera copia que mantener.
 *
 * Es un puerto aparte y no un quinto miembro de {@link RenderJob} para no
 * tocar `RENDER_FORMATS` (que `check-consistency` compara con el enum de
 * sugerencias: un reel no es una sugerencia de Blitz todavía) ni los adaptadores
 * de los cuatro formatos base.
 */
export interface ReelRenderJob {
  readonly spec: Readonly<Record<string, unknown>>;
  /** `draft` para previews/iterar, `delivery` para la pieza final. */
  readonly quality: "draft" | "delivery";
}

export interface ReelCaptionWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface ReelRenderBuild {
  /** El MP4 (1080×1920, 30 fps), sin bajar: mismas reglas que {@link RenderArtifactRef}. */
  readonly artifact: RenderArtifactRef;
  /**
   * Subtítulos que el motor transcribió en ESTE render, por id de capa. Quien
   * llama los guarda en el spec para que el editor los muestre y los corrija;
   * vacío en un cache hit.
   */
  readonly captions: Readonly<Record<string, readonly ReelCaptionWord[]>>;
  readonly warnings: readonly string[];
  readonly renderMs: number;
}

export interface ReelPreview {
  /** La composición HTML, la misma del render, lista para un iframe. */
  readonly html: string;
  readonly durationSec: number;
  readonly warnings: readonly string[];
}

export interface ReelRenderer {
  renderReel(job: ReelRenderJob, auth: MediaAuthorization): Promise<ReelRenderBuild>;
  previewReel(
    spec: Readonly<Record<string, unknown>>,
    auth: MediaAuthorization,
  ): Promise<ReelPreview>;
}
