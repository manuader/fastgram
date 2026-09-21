/**
 * Puerto Storage — IMPL ADR-006, PRD §9.8, §9.11, `NFR-008`, `NFR-013`.
 *
 * Qué lo obliga: ADR-006 elige R2 por egress $0 y cierra con «es
 * S3-compatible, así que **el puerto `Storage` permite MinIO en local y
 * desarrollo**». O sea que ya hay dos implementaciones reales el día 1, que es
 * la barra que IMPL §7 pone para crear un puerto.
 *
 * La forma de la interfaz la fija §9.8, que es contrato público y no detalle:
 * el patrón obligatorio de tres pasos **reserva → PUT directo → finalización**.
 * El cliente sube directo al storage con una URL firmada; el backend nunca ve
 * los bytes. Por eso {@link Storage.createUploadUrl} devuelve `method` y
 * `headers` además de la URL: el cliente tiene que poder reproducir exactamente
 * la petición que la firma cubre.
 *
 * `NFR-008` gobierna la lectura: las URLs de playback son «capacidades bearer
 * firmadas con **1 hora** de vida: no loguear, no persistir, refrescar al
 * expirar». De ahí {@link MAX_SIGNED_URL_TTL_SECONDS}.
 *
 * Errores (`PortError`):
 *  - `not_found` — la clave no existe en una operación que la exige (`get`).
 *  - `provider_unavailable`, `timeout`, `rate_limited`.
 *  - `bad_request` — `contentType` no permitido, tamaño por encima del límite
 *    del plan de subida, `ttlSeconds` fuera de rango.
 *  - `unauthorized` — credenciales del bucket. Nunca sale hacia el cliente.
 *  - `quota_exceeded` — el proveedor rechazó por capacidad. **Ojo:** la cuota
 *    de storage por workspace (`402 payment_required`, §9.11) es de negocio y
 *    se comprueba en `core` **antes** de llamar acá; el puerto no conoce planes.
 *
 * Lo que este puerto NO hace: no valida que la URL pertenezca al workspace
 * (`P2-RENDER-009`, es autorización y vive en `core`), no lleva la cuota
 * agregada, y no decide la política best-effort de §9.11 — `delete` lanza si
 * falla y es quien borra la fila el que elige loguear y seguir.
 */

/** `NFR-008`: 1 hora. Pedir más es `bad_request`. */
export const MAX_SIGNED_URL_TTL_SECONDS = 3600;

/**
 * Clave del objeto dentro del bucket. Opaca para el dominio y **nunca
 * devuelta por la API** (`NFR-007`: «storage keys e ids internos nunca se
 * devuelven»).
 */
export type StorageKey = string;

export interface StorageObject {
  readonly key: StorageKey;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly lastModified: Date;
  /** Para el cache por hash de IMPL §5, cuando el proveedor lo expone. */
  readonly etag?: string;
}

export interface CreateUploadUrlRequest {
  readonly key: StorageKey;
  readonly contentType: string;
  /**
   * Tamaño declarado. El adaptador lo mete en la firma para que el objeto
   * subido no pueda exceder lo reservado. Los topes de negocio (`NFR-013`:
   * imágenes 10 MB, videos 50 MB) los comprueba `core`.
   */
  readonly sizeBytes: number;
  readonly ttlSeconds: number;
}

export interface PresignedUpload {
  readonly url: string;
  /** §9.8 fija `PUT`. Es parte del contrato público, no una preferencia. */
  readonly method: "PUT";
  /** Cabeceras que el cliente **debe** repetir o la firma no valida. */
  readonly headers: { readonly [name: string]: string };
  readonly expiresAt: Date;
}

export interface CreateDownloadUrlRequest {
  readonly key: StorageKey;
  /** Máx. {@link MAX_SIGNED_URL_TTL_SECONDS}. */
  readonly ttlSeconds: number;
  /** Fuerza descarga con ese nombre en vez de reproducción inline. */
  readonly downloadFilename?: string;
}

export interface SignedUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface PutObjectRequest {
  readonly key: StorageKey;
  /**
   * `AsyncIterable` y no un stream de Node: el puerto no puede importar tipos
   * de un runtime concreto, y un render de 50 MB no debería materializarse en
   * memoria sólo para cruzar la frontera.
   */
  readonly body: Uint8Array | AsyncIterable<Uint8Array>;
  readonly contentType: string;
  /** `Cache-Control`. Los previews del calendario dependen de esto (IMPL §5). */
  readonly cacheControl?: string;
}

export interface Storage {
  /** Paso 1 de §9.8. El backend no toca los bytes. */
  createUploadUrl(request: CreateUploadUrlRequest): Promise<PresignedUpload>;

  /**
   * Paso 3 de §9.8: «Fastlane verifies the R2 object» antes de finalizar.
   *
   * Devuelve `null` si no está, en vez de lanzar: que el objeto todavía no
   * exista es el caso esperado cuando el cliente aún no hizo el PUT, y §9.8 lo
   * traduce a `409 conflict`, no a un fallo de infraestructura.
   */
  head(key: StorageKey): Promise<StorageObject | null>;

  /** Subida server-side: salida del render, normalizaciones, thumbnails. */
  put(request: PutObjectRequest): Promise<StorageObject>;

  /** Lectura server-side. Lanza `not_found` si la clave no existe. */
  get(key: StorageKey): Promise<AsyncIterable<Uint8Array>>;

  /** Lectura para playback y preview. Ver `NFR-008`. */
  createDownloadUrl(request: CreateDownloadUrlRequest): Promise<SignedUrl>;

  /**
   * Borrado **idempotente**: una clave que no existe no es error.
   *
   * §9.11 dice que la limpieza es best-effort y que los fallos «se loguean
   * pero no bloquean el borrado de la fila». Eso es política del caso de uso,
   * no del puerto: acá un fallo real del proveedor lanza, y quien borra la
   * fila decide seguir.
   */
  delete(key: StorageKey): Promise<void>;
}
