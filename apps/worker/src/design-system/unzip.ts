/**
 * Abrir el zip de un design system — `PU-S9-001`.
 *
 * Dos pasadas de `unzipSync` (fflate) sobre el mismo buffer:
 *
 *  1. **Sólo el directorio central**: el `filter` anota nombre y tamaños y
 *     devuelve `false`, así que no se infla nada. Con eso decide
 *     `planZipExtraction` de `core` (traversal, bomba, extensiones).
 *  2. **Lo planificado**: el `filter` deja pasar sólo esas rutas.
 *
 * `unzipSync` reserva la salida de cada entrada con el tamaño **declarado** y
 * no la agranda (`inflateSync(…, { out: new u8(originalSize) })`, verificado
 * en el test con una entrada que miente): lo que se escribe en memoria está
 * acotado por lo que `planZipExtraction` ya aceptó.
 */
import { createHash } from "node:crypto";

import {
  planZipExtraction,
  type DesignSystemEntry,
  type DesignSystemImportFailure,
  type PlannedZipEntry,
  type ZipEntryInfo,
} from "@fastgram/core";
import { unzipSync } from "fflate";

export type OpenedZip =
  | {
      readonly ok: true;
      readonly entries: readonly DesignSystemEntry[];
      /** Los bytes de cada archivo extraído, por su ruta normalizada. */
      readonly files: ReadonlyMap<string, Uint8Array>;
      readonly skipped: number;
    }
  | {
      readonly ok: false;
      readonly code: DesignSystemImportFailure;
      readonly detail: string;
    };

/** Lista el directorio central sin inflar. `null` si no es un zip. */
export function listZipEntries(bytes: Uint8Array): ZipEntryInfo[] | null {
  const out: ZipEntryInfo[] = [];
  try {
    unzipSync(bytes, {
      filter: (file) => {
        out.push({
          path: file.name,
          compressedSize: file.size,
          uncompressedSize: file.originalSize,
        });
        return false;
      },
    });
  } catch {
    return null;
  }
  return out;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

export function openDesignSystemZip(bytes: Uint8Array): OpenedZip {
  const listed = listZipEntries(bytes);
  if (listed === null) {
    return { ok: false, code: "not_a_zip", detail: "no zip central directory" };
  }
  const plan = planZipExtraction(listed, bytes.byteLength);
  if (!plan.ok) return plan;

  const byZipPath = new Map<string, PlannedZipEntry>(
    plan.extract.map((e) => [e.zipPath, e]),
  );
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes, { filter: (file) => byZipPath.has(file.name) });
  } catch (error: unknown) {
    return {
      ok: false,
      code: "not_a_zip",
      detail: error instanceof Error ? error.message.slice(0, 200) : "inflate failed",
    };
  }

  const entries: DesignSystemEntry[] = [];
  const files = new Map<string, Uint8Array>();
  for (const [zipPath, data] of Object.entries(raw)) {
    const planned = byZipPath.get(zipPath);
    if (planned === undefined) continue;
    files.set(planned.path, data);
    const sha256 = createHash("sha256").update(data).digest("hex");
    entries.push({
      path: planned.path,
      kind: planned.kind,
      bytes: data.byteLength,
      sha256,
      ...(planned.kind === "text" || planned.kind === "svg"
        ? { text: decoder.decode(data) }
        : {}),
    });
  }
  return { ok: true, entries, files, skipped: plan.skipped.length };
}
