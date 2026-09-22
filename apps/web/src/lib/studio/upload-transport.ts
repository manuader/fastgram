/**
 * El paso 2 de §9.8 (PRD:2347): el **PUT directo** del navegador contra la URL
 * firmada, con progreso.
 *
 * ## Por qué `XMLHttpRequest` y no `fetch`
 *
 * `fetch` no publica el progreso de **subida**. Hay `ReadableStream` como
 * cuerpo de petición, pero requiere `duplex: "half"`, HTTP/2 y no está en
 * Safari; hoy la única forma portable de saber cuántos bytes salieron es
 * `xhr.upload.onprogress`. Y hace falta: el tope de un video custom son 50 MB
 * (NFR-013), que en un enlace doméstico de subida son entre uno y dos minutos.
 * Un spinner indeterminado durante ese rato es indistinguible de una pantalla
 * colgada, y lo que hace la gente con una pantalla colgada es recargarla — o
 * sea, tirar los megabytes que ya habían salido y empezar de cero.
 *
 * El otro motivo es el **abort**: `xhr.abort()` corta la transferencia de
 * verdad, así que `Cancel` deja de ser un botón que sólo esconde la barra.
 *
 * ## Por qué no pasa por `lib/api/client.ts`
 *
 * `apiRequest` prefija `API_BASE_URL` y manda `credentials: "include"`. Las dos
 * cosas están mal acá: la URL firmada es absoluta y apunta a **otro origen**
 * (el storage), y mandarle la cookie de sesión de la shell sería filtrar la
 * sesión a un tercero. Este módulo habla con el storage; `client.ts` habla con
 * la API. No son la misma conversación.
 *
 * ## `Content-Length` se descarta, y no es un olvido
 *
 * La reserva devuelve `headers` con `Content-Type` **y** `Content-Length`
 * (`apps/api/test/media-upload.int.test.ts` los fija). Los dos están dentro de
 * la firma SigV4, así que la tentación es reenviar el bloque entero tal cual —
 * que es justo lo que hace un cliente de Node. En un navegador no se puede:
 * `Content-Length` es un **forbidden header name**, `setRequestHeader` lo
 * ignora en silencio y en jsdom lanza. No pasa nada porque el navegador lo pone
 * él a partir del `Blob`, y vale lo mismo que el `sizeBytes` que se declaró en
 * la reserva — son el mismo archivo.
 *
 * `Content-Type` sí se manda, y es **obligatorio**: la trampa 11 del general
 * dice que la API firma `content-type` a propósito, así que un PUT sin él —o
 * con otro— es un `403` del storage, no un `200`.
 */

/** Los headers que el navegador no deja poner: los calcula él. */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  "content-length",
  "host",
  "connection",
]);

/** `null` cuando el navegador no sabe el total (respuesta sin `Content-Length`). */
export type UploadProgress = (percent: number | null) => void;

export interface SignedUploadRequest {
  readonly url: string;
  /** Siempre `PUT` según §9.8; se pasa el de la reserva y no un literal. */
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Blob;
  readonly onProgress?: UploadProgress | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Un PUT que no llegó a `2xx`.
 *
 * **No es un `ApiRequestError`.** Lo que responde acá es el storage, no la API
 * v1: no hay sobre `{error:{code}}` ni códigos del PRD que traducir. Meterlo en
 * el mismo tipo obligaría a inventar un código —un `403` del storage es una
 * firma vencida o un `Content-Type` cambiado, no el `forbidden` de ERR-U01— y
 * la pantalla acabaría diciendo "Access Denied" sobre un problema de subida.
 * El `status` se guarda para el log; a pantalla va copy propia.
 */
export class SignedUploadError extends Error {
  /** `0` cuando no hubo respuesta (fallo de red). */
  readonly status: number;
  readonly aborted: boolean;

  constructor(init: { status: number; aborted?: boolean; message?: string }) {
    super(init.message ?? `Signed upload failed (HTTP ${String(init.status)})`);
    this.name = "SignedUploadError";
    this.status = init.status;
    this.aborted = init.aborted ?? false;
  }
}

export function isSignedUploadError(value: unknown): value is SignedUploadError {
  return value instanceof SignedUploadError;
}

/**
 * Sube los bytes a la URL firmada. Resuelve con `2xx`; lanza
 * `SignedUploadError` en cualquier otro caso, incluido el abort.
 */
export function putSignedUpload(request: SignedUploadRequest): Promise<void> {
  const { url, method, headers, body, onProgress, signal } = request;

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new SignedUploadError({ status: 0, aborted: true, message: "aborted" }));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);

    for (const [name, value] of Object.entries(headers)) {
      if (FORBIDDEN_HEADERS.has(name.toLowerCase())) continue;
      xhr.setRequestHeader(name, value);
    }

    if (onProgress !== undefined) {
      xhr.upload.addEventListener("progress", (event: ProgressEvent) => {
        // `lengthComputable` es `false` mientras el navegador no sabe el total.
        // Se propaga como `null` en vez de como `0`: una barra clavada en 0 %
        // durante un minuto dice "roto", y no lo está.
        onProgress(
          event.lengthComputable && event.total > 0
            ? Math.min(100, Math.round((event.loaded / event.total) * 100))
            : null,
        );
      });
    }

    const cleanup = (): void => {
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
    };

    function onAbort(): void {
      xhr.abort();
    }

    xhr.addEventListener("load", () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        // El último `progress` puede quedarse corto por buffering: al terminar
        // se afirma el 100 %, que es lo cierto.
        onProgress?.(100);
        resolve();
        return;
      }
      reject(new SignedUploadError({ status: xhr.status }));
    });

    xhr.addEventListener("error", () => {
      cleanup();
      reject(new SignedUploadError({ status: 0, message: "network error" }));
    });

    xhr.addEventListener("timeout", () => {
      cleanup();
      reject(new SignedUploadError({ status: 0, message: "timeout" }));
    });

    xhr.addEventListener("abort", () => {
      cleanup();
      reject(new SignedUploadError({ status: 0, aborted: true, message: "aborted" }));
    });

    if (signal !== undefined) signal.addEventListener("abort", onAbort);

    xhr.send(body);
  });
}
