/**
 * Puertos de la importación por link — `PU-MEME-001`, `PU-MEME-003`,
 * `docs/PLAN-USO-PERSONAL.md` §6 (D-12).
 *
 * Tres piezas, las tres detrás de un puerto porque las tres hablan con algo
 * que no es nuestro:
 *
 * - {@link MediaDownloader}: baja un clip de una URL de terceros (hoy `yt-dlp`
 *   como proceso hijo, `packages/adapters/src/media-import`).
 * - {@link ClipInspector}: mide el archivo bajado y saca cuadros (FFmpeg local).
 * - {@link ClipTagger}: le pone etiquetas mirando cuadros (un modelo con visión
 *   compatible con OpenAI, la tarea `vision` del registro de modelos).
 *
 * ## Por qué el downloader no usa `PortError` para sus fallos
 *
 * `PortError` tiene diez códigos neutrales y ninguno dice «es muy largo» o «es
 * muy pesado». Los cuatro motivos de {@link MediaImportFailureCode} son los que
 * el usuario tiene que leer para saber qué cambiar (otro link, otro recorte), y
 * aplastarlos en `bad_request` borraría justo esa diferencia. Por eso el
 * resultado es una unión: el fallo esperado es un dato, no una excepción. Un
 * `PortError` sigue siendo posible para lo que no es culpa del link (no se
 * pudo lanzar el binario).
 */

/** Qué se importa. `audio` no tiene fila en `media` todavía: ver el reporte de la tarea. */
export type MediaImportKind = "video" | "audio";

/**
 * Motivos estables de un import fallido. Son los únicos que salen por la API:
 * el stderr del downloader **nunca**.
 */
export const MEDIA_IMPORT_FAILURE_CODES = [
  /** No es http(s), apunta a la red local, o el downloader no la reconoce. */
  "unsupported_url",
  /** Dura más que el tope. */
  "too_long",
  /** Pesa más que el tope. */
  "too_large",
  /** Cualquier otra cosa: red, sitio caído, formato no disponible, timeout. */
  "download_failed",
] as const;

export type MediaImportFailureCode = (typeof MEDIA_IMPORT_FAILURE_CODES)[number];

export interface MediaDownloadRequest {
  readonly url: string;
  readonly kind: MediaImportKind;
  /** Directorio temporal **de quien llama**; el adaptador escribe sólo ahí adentro. */
  readonly directory: string;
  readonly maxDurationSeconds: number;
  readonly maxBytes: number;
  /** Tope duro de todo el proceso, en milisegundos. Vencido, se mata. */
  readonly timeoutMs: number;
}

export interface DownloadedClip {
  /** Ruta absoluta dentro de `directory`. */
  readonly path: string;
  /** `video/mp4`, `audio/mp4` (m4a) o `audio/mpeg`. */
  readonly contentType: string;
  /** Extensión sin punto, para el nombre del objeto: `mp4`, `m4a`, `mp3`. */
  readonly extension: string;
  readonly sizeBytes: number;
  /** Lo que declaró el sitio, si lo declaró. Se verifica aparte con el inspector. */
  readonly durationSeconds: number | null;
  /** Título del sitio, recortado. Es texto de terceros: se trata como dato. */
  readonly title: string | null;
}

export type MediaDownloadOutcome =
  | { readonly ok: true; readonly clip: DownloadedClip }
  | { readonly ok: false; readonly code: MediaImportFailureCode };

export interface MediaDownloader {
  download(request: MediaDownloadRequest): Promise<MediaDownloadOutcome>;
}

/* ------------------------------------------------------------------------ *
 * Inspección local
 * ------------------------------------------------------------------------ */

export interface ClipProbe {
  readonly durationSeconds: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
}

/** Un color RGB promedio, 0–255 por canal. */
export interface RgbSample {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface ClipInspector {
  probe(path: string): Promise<ClipProbe>;
  /**
   * `count` cuadros JPEG repartidos a lo largo del clip, con el lado mayor en
   * `maxSide` px. Para el etiquetado: chicos a propósito (tokens de imagen).
   */
  frames(path: string, count: number, maxSide: number): Promise<readonly Uint8Array[]>;
  /**
   * Muestras de color del **borde** de `count` cuadros: el marco exterior de
   * cada uno, reducido a una grilla chica. Es lo que decide «¿es un clip de
   * pantalla verde?» (`packages/core/src/media-import/green-screen.ts`).
   */
  borderSamples(path: string, count: number): Promise<readonly RgbSample[]>;
}

/* ------------------------------------------------------------------------ *
 * Etiquetado
 * ------------------------------------------------------------------------ */

/** Lo que el modelo devuelve, ya validado. `PU-MEME-003`. */
export interface ClipTags {
  readonly emotion: string;
  readonly situation: string;
  readonly people: number;
  readonly tags: readonly string[];
}

/**
 * Errores (`PortError`): `unauthorized`, `rate_limited`, `timeout`,
 * `provider_unavailable`, `bad_request` (el modelo no acepta imágenes) y
 * `provider_contract_violation` (no devolvió el JSON pedido).
 */
export interface ClipTagger {
  tag(frames: readonly Uint8Array[]): Promise<ClipTags>;
}
