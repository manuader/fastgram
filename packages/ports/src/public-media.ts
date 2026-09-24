/**
 * Puerto PublicMediaUrls — PRD D-17, `PU-RUN-005`.
 *
 * Instagram y las fotos de TikTok **traen la media por URL** («We cURL media
 * used in publishing attempts», doc de Instagram; `PULL_FROM_URL` en TikTok).
 * El bucket local (MinIO en `localhost`) no es público, así que quien publica
 * le pide acá una URL `https` que alguien de afuera pueda bajar.
 *
 * La implementación de uso personal es un túnel de Cloudflare desde la Mac que
 * apunta a un proceso chico que sólo sirve `GET /public-media/<token>`, con un
 * token firmado que lleva la clave del objeto y una expiración corta. Pero eso
 * es del adaptador: para el dominio es «dame una URL pública para este objeto».
 *
 * Errores: {@link PublicMediaUnavailableError} (`public_media_unavailable`)
 * cuando no hay túnel activo — la Mac no expone nada y publicar por URL no es
 * posible. `bad_request` (`PortError`) si la clave está fuera de los prefijos
 * servibles o el TTL está fuera de rango.
 *
 * Lo que este puerto NO hace: no comprueba que el objeto exista ni que sea del
 * workspace (eso es autorización y vive en `core`), y no garantiza que el
 * dominio sirva para TikTok: TikTok exige un dominio **verificado por DNS**,
 * y un quick tunnel (`*.trycloudflare.com`) no lo es.
 */

/** Default de vida de una URL pública: 1 hora (igual que `NFR-008`). */
export const DEFAULT_PUBLIC_MEDIA_TTL_SECONDS = 3600;

/**
 * Tope. TikTok da una hora para la descarga desde que arranca la tarea; con un
 * margen para la cola de publicación, 6 h alcanza y no deja capacidades
 * públicas vivas por días.
 */
export const MAX_PUBLIC_MEDIA_TTL_SECONDS = 6 * 3600;

/**
 * Sólo se sirven objetos bajo estos prefijos: media del usuario y piezas
 * renderizadas. Todo lo demás del bucket (snapshots de marca, sondas, etc.)
 * no sale por el túnel aunque el token esté bien firmado.
 */
export const PUBLIC_MEDIA_KEY_PREFIXES = ["media/", "content/"] as const;

export interface PublicMediaUrlOptions {
  /** Default {@link DEFAULT_PUBLIC_MEDIA_TTL_SECONDS}; máx. {@link MAX_PUBLIC_MEDIA_TTL_SECONDS}. */
  readonly ttlSeconds?: number;
}

export interface PublicMediaUrls {
  /**
   * `https://<túnel>/public-media/<token>`. Es una capacidad bearer: no se
   * loguea ni se persiste; se pide justo antes de publicar.
   */
  forObject(objectKey: string, options?: PublicMediaUrlOptions): Promise<string>;
}

/**
 * Código estable propio: no está en `PORT_ERROR_CODES` porque no es un fallo
 * de proveedor sino de configuración local (no se levantó el túnel), y quien
 * publica lo tiene que distinguir para decir «arrancá con `pnpm start --tunnel`»
 * en vez de reintentar.
 */
export const PUBLIC_MEDIA_UNAVAILABLE = "public_media_unavailable" as const;

export class PublicMediaUnavailableError extends Error {
  override readonly name = "PublicMediaUnavailableError";
  readonly code = PUBLIC_MEDIA_UNAVAILABLE;

  constructor(
    message = "No public media URL is available: start FastGram with a tunnel (pnpm start --tunnel)",
  ) {
    super(message);
  }

  toPublic(): { code: typeof PUBLIC_MEDIA_UNAVAILABLE; message: string } {
    return { code: this.code, message: this.message };
  }
}

export function isPublicMediaUnavailable(e: unknown): e is PublicMediaUnavailableError {
  return e instanceof PublicMediaUnavailableError;
}

/** `true` si la clave está bajo un prefijo servible y no trae trucos de ruta. */
export function isPublicMediaKey(objectKey: string): boolean {
  if (objectKey.length === 0 || objectKey.length > 1024) return false;
  if (!PUBLIC_MEDIA_KEY_PREFIXES.some((p) => objectKey.startsWith(p))) return false;
  // Sin `..`, sin barras dobles, sin control chars: la clave va tal cual a S3,
  // pero una normalización de ruta en el medio no tiene que poder sacarla del prefijo.
  if (objectKey.split("/").some((seg) => seg === ".." || seg === ".")) return false;
  if (objectKey.includes("//") || objectKey.includes("\\")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(objectKey)) return false;
  return true;
}
