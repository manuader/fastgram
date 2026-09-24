/**
 * Leer y escribir los objetos JSON de estado y metadata de un import —
 * `PU-MEME-001`. Por qué viven en el storage y no en la base está en
 * `packages/core/src/media-import/media-import.ts`.
 */
import {
  importStatusKey,
  mediaMetaKey,
  parseMediaImportStatus,
  type MediaImportStatus,
  type MediaMeta,
} from "@fastgram/core";
import { PortError, type Storage } from "@fastgram/ports";

/** Un JSON de estado no pasa de unos KB; más es un objeto que no es nuestro. */
const MAX_JSON_BYTES = 256 * 1024;

export async function readJsonObject(storage: Storage, key: string): Promise<unknown> {
  let stream: AsyncIterable<Uint8Array>;
  try {
    stream = await storage.get(key);
  } catch (error) {
    if (error instanceof PortError && error.code === "not_found") return null;
    throw error;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > MAX_JSON_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

async function putJson(storage: Storage, key: string, value: unknown): Promise<void> {
  await storage.put({
    key,
    body: new TextEncoder().encode(JSON.stringify(value)),
    contentType: "application/json",
    cacheControl: "no-store",
  });
}

export async function readImportStatus(
  storage: Storage,
  companyId: string,
  importId: string,
): Promise<MediaImportStatus | null> {
  return parseMediaImportStatus(
    await readJsonObject(storage, importStatusKey(companyId, importId)),
  );
}

export async function writeImportStatus(
  storage: Storage,
  companyId: string,
  status: MediaImportStatus,
): Promise<void> {
  await putJson(storage, importStatusKey(companyId, status.importId), status);
}

export async function writeMediaMeta(
  storage: Storage,
  companyId: string,
  meta: MediaMeta,
): Promise<void> {
  await putJson(storage, mediaMetaKey(companyId, meta.mediaId), meta);
}
