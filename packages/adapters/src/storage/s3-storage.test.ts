import { describe, expect, it } from "vitest";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { describeStorageContract, isPortError } from "@fastgram/ports";
import { S3Storage } from "./s3-storage.js";

/**
 * Suite de contrato de `Storage` contra **MinIO de verdad**.
 *
 * Es la suite que hace honesta la frase de ADR-006 —«R2 es S3-compatible, así
 * que el puerto `Storage` permite MinIO en local»—. `MemoryStorage` ya pasa el
 * mismo contrato; que las dos pasen lo mismo es lo que hace que un test que
 * usa la de memoria diga algo sobre producción.
 *
 * Lo que **no** cubre, y hay que dejarlo escrito: R2. Las diferencias
 * conocidas entre MinIO y R2 (formato del `etag` con multipart, `region`,
 * cabeceras de `Content-Disposition`) sólo se ven contra R2. Cuando se cierre
 * ADR-006 —está bloqueado por una pregunta legal, ver `COST-MODEL.md` §4.4—
 * esta misma suite hay que correrla contra el bucket real con otro `.env`.
 *
 * Se saltea explícitamente si MinIO no responde, con el motivo en el nombre de
 * cada caso: `packages/adapters` no tiene script `test:int`, así que esto vive
 * en `pnpm test` y en CI no hay MinIO.
 */
const CONFIG = {
  bucket: process.env["S3_BUCKET"] ?? "fastgram-dev",
  endpoint: process.env["S3_ENDPOINT"] ?? "http://localhost:9000",
  region: process.env["S3_REGION"] ?? "auto",
  accessKeyId: process.env["S3_ACCESS_KEY_ID"] ?? "fastgram",
  secretAccessKey: process.env["S3_SECRET_ACCESS_KEY"] ?? "fastgram-dev-secret",
  // MinIO necesita path-style; sin esto devuelve `NoSuchBucket`, que parece un
  // problema de permisos y no lo es.
  forcePathStyle: true,
} as const;

async function probe(): Promise<string | null> {
  const client = new S3Client({
    region: CONFIG.region,
    endpoint: CONFIG.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: CONFIG.accessKeyId,
      secretAccessKey: CONFIG.secretAccessKey,
    },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: CONFIG.bucket }));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    client.destroy();
  }
}

const unavailable = await probe();
const reason =
  unavailable === null
    ? null
    : `SALTEADA — no hay bucket ${CONFIG.bucket} en ${CONFIG.endpoint}: ${unavailable}`;

const harness = {
  describe,
  it:
    reason === null
      ? it
      : (name: string, body: () => void | Promise<void>) => it.skip(name, body),
};
const itS3 = reason === null ? it : it.skip;

// Prefijo único por corrida: dos CI en paralelo sobre el mismo bucket no se
// pueden pisar las claves.
const PREFIX = `contract/${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${String(process.pid)}`;

describeStorageContract(harness, reason === null ? "minio" : `minio · ${reason}`, {
  makeAdapter: () => new S3Storage(CONFIG),
  keyPrefix: PREFIX,
});

describe(`S3Storage — comportamiento propio${reason === null ? "" : ` · ${reason}`}`, () => {
  itS3("la URL de subida firmada acepta el PUT que declara, y sólo ese", async () => {
    // Éste es el caso que el contrato no puede verificar y que §9.8 promete:
    // que el cliente pueda reproducir la petición firmada. `MemoryStorage`
    // devuelve URLs sintéticas; sólo contra MinIO se sabe si la firma vale.
    const storage = new S3Storage(CONFIG);
    const key = `${PREFIX}/presigned-put`;
    const bytes = new TextEncoder().encode("subido por el cliente");

    const upload = await storage.createUploadUrl({
      key,
      contentType: "text/plain",
      sizeBytes: bytes.byteLength,
      ttlSeconds: 600,
    });

    const response = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body: bytes,
    });
    expect(response.status).toBe(200);

    const found = await storage.head(key);
    expect(found?.sizeBytes).toBe(bytes.byteLength);
    await storage.delete(key);
  });

  itS3("la URL de subida no sirve si el cliente cambia el Content-Type", async () => {
    // Con SigV4 el `Content-Type` está firmado. Si no lo estuviera, un cliente
    // podría reservar una imagen y subir un ejecutable con el mismo permiso.
    const storage = new S3Storage(CONFIG);
    const key = `${PREFIX}/presigned-wrong-type`;
    const bytes = new TextEncoder().encode("x");

    const upload = await storage.createUploadUrl({
      key,
      contentType: "image/png",
      sizeBytes: bytes.byteLength,
      ttlSeconds: 600,
    });

    const response = await fetch(upload.url, {
      method: "PUT",
      headers: { ...upload.headers, "Content-Type": "application/zip" },
      body: bytes,
    });
    expect(response.ok).toBe(false);
  });

  itS3("la URL de descarga firmada devuelve los bytes", async () => {
    const storage = new S3Storage(CONFIG);
    const key = `${PREFIX}/presigned-get`;
    await storage.put({
      key,
      body: new TextEncoder().encode("playback"),
      contentType: "text/plain",
    });

    const signed = await storage.createDownloadUrl({ key, ttlSeconds: 300 });
    const response = await fetch(signed.url);
    expect(await response.text()).toBe("playback");
    await storage.delete(key);
  });

  itS3("downloadFilename fuerza la descarga con ese nombre", async () => {
    const storage = new S3Storage(CONFIG);
    const key = `${PREFIX}/presigned-download-name`;
    await storage.put({ key, body: new Uint8Array([1, 2]), contentType: "video/mp4" });

    const signed = await storage.createDownloadUrl({
      key,
      ttlSeconds: 300,
      downloadFilename: "mi video.mp4",
    });
    const response = await fetch(signed.url);
    expect(response.headers.get("content-disposition")).toContain("mi video.mp4");
    await storage.delete(key);
  });

  itS3("un nombre de descarga con comillas o saltos no inyecta cabeceras", async () => {
    const storage = new S3Storage(CONFIG);
    const key = `${PREFIX}/presigned-injection`;
    await storage.put({ key, body: new Uint8Array([1]), contentType: "text/plain" });

    const signed = await storage.createDownloadUrl({
      key,
      ttlSeconds: 300,
      downloadFilename: 'x";\r\nX-Inyectada: si\r\n',
    });
    const response = await fetch(signed.url);
    expect(response.headers.get("x-inyectada")).toBeNull();
    await storage.delete(key);
  });

  itS3("put acepta un AsyncIterable y el round-trip conserva los bytes", async () => {
    const storage = new S3Storage(CONFIG);
    const key = `${PREFIX}/stream`;
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4, 5]);
    }
    const written = await storage.put({
      key,
      body: chunks(),
      contentType: "application/octet-stream",
    });
    expect(written.sizeBytes).toBe(5);

    const parts: Uint8Array[] = [];
    for await (const chunk of await storage.get(key)) parts.push(chunk);
    expect(Buffer.concat(parts)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    await storage.delete(key);
  });

  itS3("un stream por encima del tope falla claro, no con un OOM", async () => {
    // Ver la nota 1 de la cabecera del adaptador: sin `@aws-sdk/lib-storage`
    // no hay multipart y el stream se acumula. El tope es deuda declarada.
    const storage = new S3Storage({ ...CONFIG, maxBufferedBytes: 8 });
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield new Uint8Array(16);
    }
    const error = await storage
      .put({
        key: `${PREFIX}/too-big`,
        body: chunks(),
        contentType: "application/octet-stream",
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isPortError(error) && error.code).toBe("bad_request");
  });

  itS3(
    "credenciales inválidas salen como unauthorized y no nombran al bucket",
    async () => {
      const storage = new S3Storage({ ...CONFIG, secretAccessKey: "no-es-la-clave" });
      const error = await storage.get(`${PREFIX}/lo-que-sea`).then(
        () => null,
        (e: unknown) => e,
      );

      expect(isPortError(error)).toBe(true);
      if (!isPortError(error)) return;
      expect(error.code).toBe("unauthorized");
      const publicBody = JSON.stringify(error.toPublic());
      expect(publicBody).not.toContain(CONFIG.bucket);
      expect(publicBody).not.toContain("localhost");
    },
  );

  itS3("un endpoint muerto sale como provider_unavailable", async () => {
    const storage = new S3Storage({ ...CONFIG, endpoint: "http://127.0.0.1:9" });
    const error = await storage.head("cualquiera").then(
      () => null,
      (e: unknown) => e,
    );
    expect(isPortError(error) && error.code).toBe("provider_unavailable");
  });

  it("ttl por encima de NFR-008 es bad_request antes de tocar la red", async () => {
    // No necesita MinIO: la validación es local y por eso este caso no se
    // saltea. Es la única defensa de una capacidad bearer.
    const storage = new S3Storage({ ...CONFIG, endpoint: "http://127.0.0.1:9" });
    const error = await storage.createDownloadUrl({ key: "k", ttlSeconds: 3601 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isPortError(error) && error.code).toBe("bad_request");
  });
});
