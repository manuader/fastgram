/**
 * Errores del motor de render.
 *
 * Regla del repo (IMPL §4): nunca se propaga el error crudo de un proveedor.
 * FFmpeg escribe en stderr cosas como `Filter not found` o dumps de 200 líneas;
 * nada de eso sale hacia afuera. Se traduce a un `RenderErrorCode` estable y el
 * texto original queda en `cause`, que sólo se loguea del lado del servidor.
 */

export const RENDER_ERROR_STATUS = {
  /** Payload que no pasa el esquema (rangos del PRD incluidos). */
  bad_request: 400,
  /** `P2-RENDER-009`: la URL no pertenece al workspace ni a la librería compartida. */
  media_url_not_allowed: 400,
  /** El grant firmado falta, está vencido o la firma no verifica. */
  media_grant_invalid: 400,
  /** Falta un input obligatorio del formato (p. ej. `video-hook` sin demo). */
  content_unavailable_for_type: 422,
  /** El archivo existe pero el contenedor/codec no es utilizable. */
  unsupported_media_format: 422,
  /** ffprobe no pudo leer el medio. */
  media_probe_failed: 502,
  /** El binario ffmpeg no está en el PATH. */
  ffmpeg_unavailable: 500,
  /** El build de ffmpeg no trae un filtro que el pipeline necesita. */
  render_capability_missing: 500,
  /** La familia/peso tipográfico pedido no se puede cargar de verdad. */
  font_unavailable: 500,
  /** ffmpeg/sharp falló durante el encode. */
  render_failed: 500,
  /**
   * ffmpeg salió con código 0 y no escribió nada (o escribió 0 bytes).
   * Esta es la trampa de `services/vision/app/frames.py`: el código de salida
   * no alcanza como prueba de que hubo salida.
   */
  render_empty_output: 500,
  /** El render excedió el presupuesto de tiempo. */
  render_timeout: 504,
} as const;

export type RenderErrorCode = keyof typeof RENDER_ERROR_STATUS;

export interface RenderErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class RenderError extends Error {
  override readonly name = "RenderError";
  readonly code: RenderErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: RenderErrorCode, message: string, options: RenderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = RENDER_ERROR_STATUS[code];
    this.details = options.details ?? {};
  }

  /** Forma segura para el cliente: nunca incluye `cause`. */
  toWire(): { code: RenderErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: { ...this.details } };
  }
}

export function isRenderError(value: unknown): value is RenderError {
  return value instanceof RenderError;
}
