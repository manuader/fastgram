/**
 * Puerto Ocr — IMPL ADR-011, PRD `INT-016`, `FR-011.3`, `AI-016`, §25.3 `JV-1`.
 *
 * Qué lo obliga: ADR-002 aísla el único componente que no es TypeScript
 * —`services/vision`, en Python— «detrás de HTTP y de los puertos `Ocr` /
 * `Asr`». El dominio no puede depender de que haya un servicio Python vivo
 * para poder testearse, y `P1-VISION-005` exige que un fallo de OCR degrade a
 * `partial` sin abortar: eso sólo se puede probar con un adaptador que falle a
 * voluntad.
 *
 * Por qué existe el OCR: `D-03` lo mete en Fase 1 porque «en short-form el
 * hook vive en el overlay, no en la caption: es la señal de mayor rendimiento
 * por unidad de coste» (`FR-011.3`). Y §25.3 `JV-1` lo marca como dependencia
 * dura del clasificador del catálogo: «un adaptador basado en un modelo
 * text-only no puede ver el video: **todo lo visual debe llegar ya convertido
 * a texto**». Este puerto es esa conversión.
 *
 * Errores (`PortError`):
 *  - `provider_unavailable`, `timeout`, `rate_limited` — `services/vision`
 *    caído o saturado. `AI-016` obliga a que el consumidor degrade a `partial`,
 *    nunca a `failed`.
 *  - `bad_request` — media no soportada, ilegible, o fuera de los límites de
 *    `NFR-013`.
 *  - `provider_contract_violation` — respuesta que no encaja en este contrato.
 *
 * Retención: quien llama pasa los bytes en memoria y los descarta. `FR-011` y
 * `DATA-032` son tajantes: «los binarios de terceros **no se persisten**: se
 * procesan en memoria y se descartan». El puerto no recibe una clave de
 * storage para que esa regla no pueda romperse por accidente.
 */

/** Caja del texto en la imagen, en píxeles desde arriba-izquierda. */
export interface TextBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface OcrBlock {
  readonly text: string;
  /** [0, 1] según el motor. */
  readonly confidence: number;
  readonly box?: TextBox;
}

/** `P1-VISION-004`: el idioma detectado alimenta `toneOfVoice` (`FR-011.3`). */
export interface DetectedLanguage {
  /** BCP-47. Ej. `es`, `en`, `pt-BR`. */
  readonly code: string;
  readonly confidence: number;
}

export interface OcrResult {
  /**
   * Los bloques concatenados en orden de lectura. Es lo que consume `JV-1`
   * como `ocrText` y `AI-016` como señal de contenido.
   */
  readonly text: string;
  readonly blocks: readonly OcrBlock[];
  /** Ordenados por confianza descendente. Vacío si no se pudo determinar. */
  readonly languages: readonly DetectedLanguage[];
  readonly latencyMs: number;
}

export interface OcrImageRequest {
  readonly bytes: Uint8Array;
  /** `image/jpeg` · `image/png` · `image/webp` (`NFR-013`). */
  readonly contentType: string;
  /**
   * Pista de idioma, cuando se conoce por el perfil. No es una restricción:
   * un perfil en español puede tener overlays en inglés.
   */
  readonly languageHint?: string;
}

export interface OcrVideoRequest {
  readonly bytes: Uint8Array;
  /** `video/mp4` · `video/quicktime` (`NFR-013`). */
  readonly contentType: string;
  /**
   * Cuántos frames muestrear. El coste crece linealmente con esto, igual que
   * el de §9.14 con los ítems por fuente; no hay número normativo en el PRD.
   */
  readonly maxFrames?: number;
  readonly languageHint?: string;
}

export interface OcrVideoFrame extends OcrResult {
  /** Segundos desde el inicio. */
  readonly atSeconds: number;
}

export interface OcrVideoResult {
  /**
   * Texto único deduplicado entre frames. Un overlay que dura tres segundos
   * aparece en varios frames y no debe contar tres veces al medir señal.
   */
  readonly text: string;
  readonly frames: readonly OcrVideoFrame[];
  readonly languages: readonly DetectedLanguage[];
  readonly latencyMs: number;
}

export interface Ocr {
  /** Imágenes, carruseles y miniaturas (`FR-011.3`). */
  recognizeImage(request: OcrImageRequest): Promise<OcrResult>;

  /** `P1-VISION-003`: overlays de video, muestreando frames. */
  recognizeVideoFrames(request: OcrVideoRequest): Promise<OcrVideoResult>;
}
