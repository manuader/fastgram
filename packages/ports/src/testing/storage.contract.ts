/**
 * Contrato del puerto `Storage` — PRD §9.8, §9.11, `NFR-008`.
 *
 * Esta es la suite que hace honesta la frase de ADR-006: «es S3-compatible,
 * así que el puerto `Storage` permite MinIO en local y desarrollo». Si MinIO y
 * R2 no pasan exactamente estos casos, los tests locales estarían validando un
 * comportamiento que producción no tiene.
 *
 * El caso que más importa es el más aburrido: `head` de una clave inexistente
 * devuelve `null` y no lanza. §9.8 traduce «el objeto todavía no está» a
 * `409 conflict` y «la reserva es de otro workspace» a `404`; si el adaptador
 * lanzara en el primer caso, esa distinción se perdería y el usuario vería un
 * error de sistema donde el contrato promete un conflicto recuperable.
 */

import type { Storage, StorageKey } from "../storage.js";
import { MAX_SIGNED_URL_TTL_SECONDS } from "../storage.js";
import {
  check,
  checkEqual,
  checkFuture,
  checkNonEmpty,
  checkRejectsWithCode,
  checkResolves,
  type AdapterFactory,
  type ContractHarness,
} from "./harness.js";

export interface StorageContractSetup {
  readonly makeAdapter: AdapterFactory<Storage>;
  /**
   * Prefijo único por corrida, para que dos adaptadores (o dos CI en paralelo)
   * no se pisen las claves. Ej. `contract/2026-09-21T10-00-00Z`.
   */
  readonly keyPrefix: string;
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function describeStorageContract(
  harness: ContractHarness,
  name: string,
  setup: StorageContractSetup,
): void {
  const { describe, it } = harness;
  let counter = 0;
  const nextKey = (suffix: string): StorageKey => {
    counter += 1;
    return `${setup.keyPrefix}/${String(counter)}-${suffix}`;
  };
  const payload = new TextEncoder().encode("fastgram port contract");

  describe(`Storage contract · ${name}`, () => {
    it("head de una clave inexistente devuelve null, no lanza", async () => {
      const storage = await setup.makeAdapter();
      const found = await checkResolves(
        () => storage.head(nextKey("missing")),
        "head de clave inexistente",
      );
      checkEqual(found, null, "head de clave inexistente");
    });

    it("put expone tamaño y content type reales en head", async () => {
      const storage = await setup.makeAdapter();
      const key = nextKey("put");
      await storage.put({ key, body: payload, contentType: "text/plain" });

      const found = await storage.head(key);
      check(found !== null, "head después de put devolvió null");
      if (found === null) return;
      checkEqual(found.sizeBytes, payload.byteLength, "sizeBytes");
      check(
        found.contentType.startsWith("text/plain"),
        `contentType "${found.contentType}" no conserva el declarado`,
      );
    });

    it("get devuelve exactamente los bytes que se subieron", async () => {
      const storage = await setup.makeAdapter();
      const key = nextKey("roundtrip");
      await storage.put({ key, body: payload, contentType: "text/plain" });

      const bytes = await collect(await storage.get(key));
      checkEqual(bytes.byteLength, payload.byteLength, "longitud del round-trip");
      for (let i = 0; i < payload.length; i += 1) {
        checkEqual(bytes[i], payload[i], `byte ${String(i)} del round-trip`);
      }
    });

    it("get de una clave inexistente lanza not_found", async () => {
      const storage = await setup.makeAdapter();
      await checkRejectsWithCode(
        () => storage.get(nextKey("nope")),
        ["not_found"],
        "get de clave inexistente",
      );
    });

    it("delete es idempotente: borrar lo que no existe no es error (§9.11)", async () => {
      const storage = await setup.makeAdapter();
      const key = nextKey("delete");
      await storage.put({ key, body: payload, contentType: "text/plain" });

      await storage.delete(key);
      checkEqual(await storage.head(key), null, "head después de delete");
      await checkResolves(() => storage.delete(key), "segundo delete de la misma clave");
    });

    it("createUploadUrl devuelve PUT, cabeceras y un vencimiento futuro (§9.8)", async () => {
      const storage = await setup.makeAdapter();
      const upload = await storage.createUploadUrl({
        key: nextKey("upload"),
        contentType: "image/png",
        sizeBytes: 1024,
        ttlSeconds: 600,
      });

      checkNonEmpty(upload.url, "uploadUrl");
      checkEqual(upload.method, "PUT", "method: §9.8 lo fija como contrato público");
      checkFuture(upload.expiresAt, "expiresAt de la reserva");
      check(
        typeof upload.headers === "object",
        "headers ausente: el cliente no podría reproducir la petición firmada",
      );
    });

    it("createDownloadUrl respeta el techo de 1 hora de NFR-008", async () => {
      const storage = await setup.makeAdapter();
      const key = nextKey("download");
      await storage.put({ key, body: payload, contentType: "text/plain" });

      const signed = await storage.createDownloadUrl({ key, ttlSeconds: 60 });
      checkNonEmpty(signed.url, "downloadUrl");
      checkFuture(signed.expiresAt, "expiresAt de la URL firmada");

      await checkRejectsWithCode(
        () =>
          storage.createDownloadUrl({
            key,
            ttlSeconds: MAX_SIGNED_URL_TTL_SECONDS + 1,
          }),
        ["bad_request"],
        `ttl mayor a ${String(MAX_SIGNED_URL_TTL_SECONDS)} s`,
      );
    });
  });
}
