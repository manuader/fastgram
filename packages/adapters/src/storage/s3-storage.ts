/**
 * Adaptador `Storage` S3-compatible — ADR-006, PRD §9.8, §9.11, `NFR-008`.
 *
 * **Un solo adaptador para los tres proveedores.** R2, MinIO y S3 hablan el
 * mismo protocolo; lo que cambia es configuración: endpoint, credenciales y
 * estilo de ruta. Es la parte de ADR-006 que se sostiene sola —«R2 es
 * S3-compatible, así que el puerto `Storage` permite MinIO en local»— y la
 * única que sigue en pie después de que `P1-INFRA-001` refutara la premisa
 * del egress (ver `COST-MODEL.md` §4.3). Si mañana la decisión se mueve a
 * B2 + bunny.net, este archivo no cambia: cambia el `.env`.
 *
 * La forma de la interfaz la fija §9.8 y es contrato público: **reserva → PUT
 * directo → finalización**. El backend no toca los bytes de la subida del
 * usuario. Por eso {@link S3Storage.createUploadUrl} devuelve `method` y
 * `headers`: el cliente tiene que poder reproducir exactamente la petición que
 * la firma cubre, y con SigV4 una cabecera de más o de menos invalida la firma.
 *
 * ## Dos cosas que conviene saber antes de tocar esto
 *
 * **1 · `put` con un `AsyncIterable` materializa en memoria.** El puerto acepta
 * `Uint8Array | AsyncIterable<Uint8Array>` justamente para no obligar a
 * materializar un render de 50 MB. Subir un stream de longitud desconocida a
 * S3 requiere **multipart**, y eso vive en `@aws-sdk/lib-storage`, que **no
 * está declarado en este paquete** (ver el reporte de la tarea). Con sólo
 * `client-s3`, `PutObjectCommand` exige `ContentLength` — sin él el SDK falla
 * con «Cannot determine length of stream».
 *
 * Así que por ahora se acumula, con un tope explícito
 * ({@link S3StorageConfig.maxBufferedBytes}) que falla fuerte en vez de comerse
 * la memoria del worker. **Esto es deuda declarada, no una decisión**: el día
 * que entre `lib-storage`, `put` pasa a `Upload` y el tope desaparece.
 *
 * **2 · El `etag` de MinIO y el de R2 no significan lo mismo.** Con subida
 * simple los dos son el MD5 del contenido; con multipart, no. IMPL §5 quiere
 * usarlo como cache por hash: eso sólo es válido mientras no haya multipart.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  MAX_SIGNED_URL_TTL_SECONDS,
  PortError,
  type CreateDownloadUrlRequest,
  type CreateUploadUrlRequest,
  type PresignedUpload,
  type PutObjectRequest,
  type SignedUrl,
  type Storage,
  type StorageKey,
  type StorageObject,
} from "@fastgram/ports";

const SOURCE = "Storage/s3";

/** 64 MiB. Por encima de `NFR-013` (videos 50 MB) con margen para el render. */
const DEFAULT_MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

export interface S3StorageConfig {
  /** `S3_BUCKET`. */
  readonly bucket: string;
  /** `S3_ENDPOINT`. Ausente ⇒ AWS S3 real. */
  readonly endpoint?: string;
  /** `S3_REGION`. R2 usa `auto`. */
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * `true` para MinIO y para R2 con endpoint de cuenta; `false` para S3 con
   * bucket en el host. MinIO **necesita** path-style o devuelve `NoSuchBucket`
   * con un mensaje que parece de permisos.
   */
  readonly forcePathStyle?: boolean;
  /** Ver la nota 1 de la cabecera. */
  readonly maxBufferedBytes?: number;
  /** Para inyectar un cliente ya configurado (tests, credenciales rotativas). */
  readonly client?: S3Client;
}

export class S3Storage implements Storage {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #maxBufferedBytes: number;

  constructor(config: S3StorageConfig) {
    if (config.bucket.length === 0) {
      throw new PortError("bad_request", "Storage bucket is not configured", {
        source: SOURCE,
      });
    }
    this.#bucket = config.bucket;
    this.#maxBufferedBytes = config.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.#client = config.client ?? new S3Client(clientConfig(config));
  }

  async createUploadUrl(request: CreateUploadUrlRequest): Promise<PresignedUpload> {
    assertTtl(request.ttlSeconds);
    if (!Number.isFinite(request.sizeBytes) || request.sizeBytes < 0) {
      throw new PortError("bad_request", "sizeBytes must be a non-negative number", {
        source: SOURCE,
      });
    }
    assertKey(request.key);

    /**
     * `ContentLength` entra en la firma a propósito.
     *
     * §9.8 dice que el objeto subido no puede exceder lo reservado. Con
     * `ContentLength` firmado, un cliente que suba más bytes de los que
     * reservó rompe la firma y S3 lo rechaza — la restricción la aplica el
     * proveedor, no un chequeo nuestro que se puede saltear.
     */
    const command = new PutObjectCommand({
      Bucket: this.#bucket,
      Key: request.key,
      ContentType: request.contentType,
      ContentLength: request.sizeBytes,
    });

    const url = await wrap(
      () =>
        getSignedUrl(this.#client, command, {
          expiresIn: request.ttlSeconds,
          /**
           * **`signableHeaders` no es opcional acá, y esto lo encontró un
           * test.**
           *
           * Por defecto `@aws-sdk/s3-request-presigner` firma
           * `content-length;host` y **deja `content-type` afuera**, aunque el
           * comando lo declare. O sea que una reserva hecha para `image/png`
           * acepta igual un PUT con `application/zip`: el cliente reserva un
           * tipo y sube otro, con la misma URL.
           *
           * Verificado contra MinIO: con la firma por defecto el PUT con
           * `Content-Type` cambiado devuelve 200; con estas dos cabeceras
           * firmadas, 403.
           */
          signableHeaders: new Set(["content-type", "content-length"]),
        }),
      "creating an upload URL",
    );

    return {
      url,
      method: "PUT",
      // Sin estas dos cabeceras, exactas, la firma no valida.
      headers: {
        "Content-Type": request.contentType,
        "Content-Length": String(request.sizeBytes),
      },
      expiresAt: new Date(Date.now() + request.ttlSeconds * 1000),
    };
  }

  async head(key: StorageKey): Promise<StorageObject | null> {
    assertKey(key);
    try {
      const response = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      return {
        key,
        sizeBytes: response.ContentLength ?? 0,
        contentType: response.ContentType ?? "application/octet-stream",
        lastModified: response.LastModified ?? new Date(0),
        ...(response.ETag === undefined ? {} : { etag: response.ETag }),
      };
    } catch (error) {
      // `null`, no excepción: §9.8 traduce «el objeto todavía no está» a
      // `409 conflict`, que es recuperable, y «es de otro workspace» a `404`.
      // Si el adaptador lanzara acá, esa distinción se perdería.
      if (isNotFound(error)) return null;
      throw translate(error, "reading object metadata");
    }
  }

  async put(request: PutObjectRequest): Promise<StorageObject> {
    assertKey(request.key);
    const body =
      request.body instanceof Uint8Array
        ? request.body
        : await this.#collect(request.body);

    const response = await wrap(
      () =>
        this.#client.send(
          new PutObjectCommand({
            Bucket: this.#bucket,
            Key: request.key,
            Body: body,
            ContentType: request.contentType,
            ContentLength: body.byteLength,
            ...(request.cacheControl === undefined
              ? {}
              : { CacheControl: request.cacheControl }),
          }),
        ),
      "uploading an object",
    );

    return {
      key: request.key,
      sizeBytes: body.byteLength,
      contentType: request.contentType,
      // El proveedor no devuelve `LastModified` en el PUT. Se usa la hora de
      // pared y no un `Clock` inyectado: es un dato del objeto remoto, y la
      // alternativa —hacer un `head` extra— es una ida más por cada subida.
      lastModified: new Date(),
      ...(response.ETag === undefined ? {} : { etag: response.ETag }),
    };
  }

  async get(key: StorageKey): Promise<AsyncIterable<Uint8Array>> {
    assertKey(key);
    const response = await wrap(
      () => this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key })),
      "reading an object",
    );
    const body = response.Body;
    if (body === undefined) {
      throw new PortError(
        "provider_contract_violation",
        "The object storage returned no body",
        {
          source: SOURCE,
        },
      );
    }
    return toAsyncIterable(body);
  }

  async createDownloadUrl(request: CreateDownloadUrlRequest): Promise<SignedUrl> {
    assertTtl(request.ttlSeconds);
    assertKey(request.key);

    const command = new GetObjectCommand({
      Bucket: this.#bucket,
      Key: request.key,
      ...(request.downloadFilename === undefined
        ? {}
        : {
            ResponseContentDisposition: `attachment; filename="${sanitizeFilename(request.downloadFilename)}"`,
          }),
    });

    const url = await wrap(
      () => getSignedUrl(this.#client, command, { expiresIn: request.ttlSeconds }),
      "creating a download URL",
    );

    // `NFR-008`: estas URLs son capacidades bearer. No loguearlas, no
    // persistirlas, refrescarlas al expirar. El adaptador no puede impedirlo;
    // queda escrito acá para que quien la reciba lo sepa.
    return { url, expiresAt: new Date(Date.now() + request.ttlSeconds * 1000) };
  }

  async delete(key: StorageKey): Promise<void> {
    assertKey(key);
    try {
      await this.#client.send(
        new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
    } catch (error) {
      // Idempotente: borrar algo que no está no es error. S3 ya devuelve 204
      // en ese caso, pero un proveedor compatible podría no hacerlo.
      if (isNotFound(error)) return;
      // Un fallo real sí lanza. La política best-effort de §9.11 —«se loguea
      // pero no bloquea el borrado de la fila»— es del caso de uso, no del
      // puerto.
      throw translate(error, "deleting an object");
    }
  }

  async #collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of chunks) {
      total += chunk.byteLength;
      if (total > this.#maxBufferedBytes) {
        // Ver la nota 1: sin `@aws-sdk/lib-storage` no hay multipart, y
        // tragarse un stream sin tope tumba el worker con un OOM que no dice
        // de dónde vino.
        throw new PortError(
          "bad_request",
          `The upload exceeds the maximum size this adapter can buffer (${String(this.#maxBufferedBytes)} bytes)`,
          { source: SOURCE },
        );
      }
      parts.push(chunk);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }
}

function clientConfig(config: S3StorageConfig): S3ClientConfig {
  return {
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.forcePathStyle === undefined
      ? {}
      : { forcePathStyle: config.forcePathStyle }),
  };
}

/* ------------------------------------------------------------------------ *
 * Conversión
 * ------------------------------------------------------------------------ */

/**
 * El `Body` del SDK es un `SdkStream`. En Node es un `Readable`, que ya es
 * `AsyncIterable<Buffer>`; en otros runtimes es un `ReadableStream` web. Se
 * cubren los dos para no atar el adaptador a Node más de lo necesario.
 */
function toAsyncIterable(body: unknown): AsyncIterable<Uint8Array> {
  if (typeof body === "object" && body !== null && Symbol.asyncIterator in body) {
    return body as AsyncIterable<Uint8Array>;
  }
  if (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { getReader?: unknown }).getReader === "function"
  ) {
    const stream = body as ReadableStream<Uint8Array>;
    return (async function* () {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value !== undefined) yield value;
        }
      } finally {
        reader.releaseLock();
      }
    })();
  }
  throw new PortError(
    "provider_contract_violation",
    "The object storage returned a body this adapter cannot read",
    { source: SOURCE },
  );
}

/* ------------------------------------------------------------------------ *
 * Validación
 * ------------------------------------------------------------------------ */

function assertTtl(ttlSeconds: number): void {
  if (
    !Number.isFinite(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > MAX_SIGNED_URL_TTL_SECONDS
  ) {
    // `NFR-008` fija 1 hora para las URLs de playback. No es una preferencia:
    // son capacidades bearer y su vida es su única defensa.
    throw new PortError(
      "bad_request",
      `ttlSeconds must be between 1 and ${String(MAX_SIGNED_URL_TTL_SECONDS)}`,
      { source: SOURCE },
    );
  }
}

function assertKey(key: StorageKey): void {
  if (key.length === 0) {
    throw new PortError("bad_request", "Storage key must not be empty", {
      source: SOURCE,
    });
  }
}

function sanitizeFilename(filename: string): string {
  // `Content-Disposition` es una cabecera: comillas y saltos de línea permiten
  // inyectar cabeceras. El nombre lo elige el usuario (`FR-`), así que se acota.
  return filename.replaceAll(/["\\\r\n]/g, "_").slice(0, 200);
}

/* ------------------------------------------------------------------------ *
 * Traducción de errores — PRD §10, `NFR-022`
 * ------------------------------------------------------------------------ */

interface S3Error {
  readonly name?: string;
  readonly $metadata?: { readonly httpStatusCode?: number };
  readonly Code?: string;
}

const NOT_FOUND_NAMES = new Set(["NotFound", "NoSuchKey", "NoSuchBucket"]);

function isNotFound(error: unknown): boolean {
  const e = error as S3Error | null;
  if (e === null || typeof e !== "object") return false;
  if (e.name !== undefined && NOT_FOUND_NAMES.has(e.name)) return true;
  if (e.Code !== undefined && NOT_FOUND_NAMES.has(e.Code)) return true;
  return e.$metadata?.httpStatusCode === 404;
}

async function wrap<T>(body: () => Promise<T>, what: string): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof PortError) throw error;
    throw translate(error, what);
  }
}

/**
 * Los mensajes son neutrales porque cruzan hacia el cliente por
 * `PortError.toPublic()`. Ni el bucket, ni el endpoint, ni el código del
 * proveedor: `apps/api/src/http/errors.test.ts` verifica exactamente eso.
 */
function translate(error: unknown, what: string): PortError {
  const e = (error ?? {}) as S3Error;
  const name = e.name ?? e.Code ?? "";
  const status = e.$metadata?.httpStatusCode;

  if (isNotFound(error)) {
    return new PortError("not_found", "Object not found", {
      source: SOURCE,
      cause: error,
    });
  }
  if (
    name === "AccessDenied" ||
    name === "InvalidAccessKeyId" ||
    name === "SignatureDoesNotMatch" ||
    status === 401 ||
    status === 403
  ) {
    // Nunca sale hacia el cliente tal cual: es un problema de configuración
    // nuestra, no de su petición.
    return new PortError("unauthorized", "Object storage rejected the credentials", {
      source: SOURCE,
      cause: error,
    });
  }
  if (name === "SlowDown" || status === 429 || status === 503) {
    return new PortError("rate_limited", "Object storage is throttling requests", {
      source: SOURCE,
      cause: error,
    });
  }
  if (name === "EntityTooLarge" || status === 413) {
    return new PortError(
      "bad_request",
      "The object exceeds the size the storage accepts",
      {
        source: SOURCE,
        cause: error,
      },
    );
  }
  if (name === "QuotaExceeded" || status === 507) {
    // Ojo: esto es capacidad del **proveedor**. La cuota de storage por
    // workspace (§9.11, `402 payment_required`) la comprueba `core` antes.
    return new PortError("quota_exceeded", "Object storage is out of capacity", {
      source: SOURCE,
      cause: error,
    });
  }
  if (name === "TimeoutError" || name === "RequestTimeout" || status === 408) {
    return new PortError("timeout", `Object storage timed out while ${what}`, {
      source: SOURCE,
      cause: error,
    });
  }
  if (status !== undefined && status >= 500) {
    return new PortError("provider_unavailable", "Object storage is unavailable", {
      source: SOURCE,
      cause: error,
    });
  }
  if (status !== undefined && status >= 400) {
    return new PortError(
      "bad_request",
      `Object storage rejected the request while ${what}`,
      {
        source: SOURCE,
        cause: error,
      },
    );
  }
  // Sin status: fallo de red, DNS o TLS.
  return new PortError("provider_unavailable", "Object storage is unreachable", {
    source: SOURCE,
    cause: error,
  });
}
