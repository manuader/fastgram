import {
  MAX_SIGNED_URL_TTL_SECONDS,
  PortError,
  type Clock,
  type CreateDownloadUrlRequest,
  type CreateUploadUrlRequest,
  type PresignedUpload,
  type PutObjectRequest,
  type SignedUrl,
  type Storage,
  type StorageKey,
  type StorageObject,
} from "@fastgram/ports";

/**
 * Storage en memoria.
 *
 * No es un mock de relleno: es la tercera implementación real del puerto,
 * junto a R2 (producción) y MinIO (desarrollo). Existe por dos razones
 * concretas:
 *
 * 1. **Correr la suite de contrato sin red ni Docker.** La suite de `Storage`
 *    es la que hace honesta la frase de ADR-006 —«R2 y MinIO hacen lo mismo»—
 *    y una suite que sólo corre cuando hay Docker arriba se termina salteando.
 *
 * 2. **Tests de casos de uso** que necesitan un storage que funcione pero no
 *    les importa cuál. Que `put` y `head` se comporten igual que en R2 es lo
 *    que hace que esos tests digan algo.
 *
 * Lo que NO hace: firmar de verdad. Las URLs son sintéticas y el "upload"
 * nunca ocurre. Un test que dependa de que el PUT a `uploadUrl` funcione tiene
 * que correr contra MinIO.
 */
export class MemoryStorage implements Storage {
  readonly #objects = new Map<
    StorageKey,
    { body: Uint8Array; contentType: string; lastModified: Date; etag: string }
  >();
  #etagCounter = 0;

  constructor(
    private readonly clock: Clock,
    private readonly baseUrl = "memory://bucket",
  ) {}

  async createUploadUrl(request: CreateUploadUrlRequest): Promise<PresignedUpload> {
    this.#assertTtl(request.ttlSeconds);
    if (request.sizeBytes < 0) {
      throw new PortError("bad_request", "sizeBytes must be positive", {
        source: "Storage/memory",
      });
    }
    return {
      url: `${this.baseUrl}/${encodeURIComponent(request.key)}?upload=1`,
      method: "PUT",
      headers: {
        "Content-Type": request.contentType,
        "Content-Length": String(request.sizeBytes),
      },
      expiresAt: new Date(this.clock.nowMs() + request.ttlSeconds * 1000),
    };
  }

  async head(key: StorageKey): Promise<StorageObject | null> {
    const o = this.#objects.get(key);
    // `null`, no excepción. Que el objeto todavía no esté es el caso esperado
    // cuando el cliente aún no hizo el PUT, y §9.8 lo traduce a 409, no a un
    // fallo de infraestructura.
    if (o === undefined) return null;
    return {
      key,
      sizeBytes: o.body.byteLength,
      contentType: o.contentType,
      lastModified: o.lastModified,
      etag: o.etag,
    };
  }

  async put(request: PutObjectRequest): Promise<StorageObject> {
    const body =
      request.body instanceof Uint8Array ? request.body : await collect(request.body);

    const etag = `"mem-${++this.#etagCounter}"`;
    const lastModified = this.clock.now();
    this.#objects.set(request.key, {
      body,
      contentType: request.contentType,
      lastModified,
      etag,
    });
    return {
      key: request.key,
      sizeBytes: body.byteLength,
      contentType: request.contentType,
      lastModified,
      etag,
    };
  }

  async get(key: StorageKey): Promise<AsyncIterable<Uint8Array>> {
    const o = this.#objects.get(key);
    if (o === undefined) {
      throw new PortError("not_found", "Object not found", { source: "Storage/memory" });
    }
    const body = o.body;
    return (async function* () {
      yield body;
    })();
  }

  async createDownloadUrl(request: CreateDownloadUrlRequest): Promise<SignedUrl> {
    this.#assertTtl(request.ttlSeconds);
    const filename = request.downloadFilename;
    const suffix =
      filename === undefined ? "" : `&download=${encodeURIComponent(filename)}`;
    return {
      url: `${this.baseUrl}/${encodeURIComponent(request.key)}?sig=mem${suffix}`,
      expiresAt: new Date(this.clock.nowMs() + request.ttlSeconds * 1000),
    };
  }

  async delete(key: StorageKey): Promise<void> {
    // Idempotente: borrar algo que no está no es un error.
    this.#objects.delete(key);
  }

  /** Sólo para tests: cuántos objetos quedan. */
  get size(): number {
    return this.#objects.size;
  }

  #assertTtl(ttlSeconds: number): void {
    if (ttlSeconds <= 0 || ttlSeconds > MAX_SIGNED_URL_TTL_SECONDS) {
      throw new PortError(
        "bad_request",
        `ttlSeconds must be between 1 and ${MAX_SIGNED_URL_TTL_SECONDS}`,
        { source: "Storage/memory" },
      );
    }
  }
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const c of chunks) {
    parts.push(c);
    total += c.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}
