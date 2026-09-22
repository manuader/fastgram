/**
 * El cableado del storage — `P1-STORAGE-007`.
 *
 * Corre en `pnpm test`, sin Docker y sin red: construir un `S3Storage` no abre
 * ninguna conexión y firmar es CPU local. Lo que necesita MinIO de verdad —que
 * el PUT firmado entre y que la finalización encuentre el objeto— vive en
 * `test/media-upload.int.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { FixedClock, MemoryStorage, S3Storage } from "@fastgram/adapters";

import {
  CANONICAL_URL_PROBE_KEY,
  checkCanonicalUrlBase,
  createStorage,
  s3ConfigFrom,
  type StorageEnv,
} from "./storage.js";

const ENV: StorageEnv = {
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "auto",
  S3_BUCKET: "fastgram-dev",
  S3_ACCESS_KEY_ID: "clave-de-prueba",
  S3_SECRET_ACCESS_KEY: "secreto-de-prueba",
  S3_PUBLIC_URL: "http://localhost:9000/fastgram-dev",
  S3_FORCE_PATH_STYLE: true,
};

describe("s3ConfigFrom", () => {
  it("lleva `forcePathStyle` desde el entorno y no lo adivina", () => {
    // MinIO devuelve `NoSuchBucket` —que parece un problema de permisos— si el
    // cliente usa virtual-host. El adaptador expone la opción y no la infiere,
    // así que el único lugar donde se decide es éste.
    expect(s3ConfigFrom(ENV).forcePathStyle).toBe(true);
    expect(s3ConfigFrom({ ...ENV, S3_FORCE_PATH_STYLE: false }).forcePathStyle).toBe(
      false,
    );
  });

  it("no inventa campos que `S3StorageConfig` no tiene", () => {
    // `maxBufferedBytes` se deja en el default del adaptador: la API no hace
    // `put` —los bytes del usuario van directo al bucket— así que fijarlo acá
    // sería un número sin uso que el día de mañana alguien copia al worker,
    // donde sí importa.
    expect(Object.keys(s3ConfigFrom(ENV)).sort()).toEqual([
      "accessKeyId",
      "bucket",
      "endpoint",
      "forcePathStyle",
      "region",
      "secretAccessKey",
    ]);
  });

  it("construye un `S3Storage`, y construirlo no abre ninguna conexión", () => {
    // Importa saberlo: si el constructor hablara con el bucket, `main.ts` no
    // podría montarlo antes de escuchar, y un MinIO caído impediría arrancar.
    // Que no lo haga es también la razón por la que el job `binario` de CI no
    // necesita un MinIO, sólo las variables.
    expect(createStorage(ENV)).toBeInstanceOf(S3Storage);
  });
});

describe("checkCanonicalUrlBase", () => {
  const clock = new FixedClock("2026-09-21T12:00:00.000Z");

  it("dice `aligned` cuando la URL persistida cae bajo `S3_PUBLIC_URL`", async () => {
    const storage = new MemoryStorage(clock, "https://cdn.example.test");
    const check = await checkCanonicalUrlBase(storage, "https://cdn.example.test");
    expect(check).toEqual({ kind: "aligned", base: "https://cdn.example.test" });
  });

  it("tolera la barra final de `S3_PUBLIC_URL`", async () => {
    // Un `.env` con barra al final es lo más común del mundo y no puede
    // producir un aviso falso: el aviso perdería valor el primer día.
    const storage = new MemoryStorage(clock, "https://cdn.example.test");
    const check = await checkCanonicalUrlBase(storage, "https://cdn.example.test/");
    expect(check.kind).toBe("aligned");
  });

  it("dice `diverged` cuando el endpoint de firma no es el del CDN", async () => {
    // El caso de producción con R2: lo que se persiste apunta a
    // `<account>.r2.cloudflarestorage.com`, que no sirve nada públicamente, y
    // hoy no tiene ningún síntoma hasta que alguien abre un video.
    const storage = new MemoryStorage(clock, "https://acct.r2.cloudflarestorage.com/b");
    const check = await checkCanonicalUrlBase(storage, "https://cdn.example.test");
    expect(check).toEqual({
      kind: "diverged",
      canonicalBase: "https://acct.r2.cloudflarestorage.com/b",
      publicBase: "https://cdn.example.test",
    });
  });

  it("no lanza si el storage falla: es diagnóstico, no una precondición", async () => {
    const roto = {
      async createDownloadUrl(): Promise<never> {
        throw new Error("sin credenciales");
      },
    } as unknown as MemoryStorage;

    const check = await checkCanonicalUrlBase(roto, "https://cdn.example.test");
    // Si esto lanzara, un storage mal configurado impediría **arrancar** por un
    // chequeo que sólo existe para escribir una línea de log.
    expect(check).toEqual({ kind: "unknown", reason: "sin credenciales" });
  });

  it("la clave de sonda se anuncia como tal", () => {
    // Va a aparecer en una URL firmada en el log de alguien alguna vez.
    expect(CANONICAL_URL_PROBE_KEY.startsWith("__probe__/")).toBe(true);
  });
});
