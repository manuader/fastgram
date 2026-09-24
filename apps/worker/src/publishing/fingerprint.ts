/**
 * Huella del contenido renderizado — `PU-PUB-007` («nunca la misma pieza en
 * dos marcas», `docs/PLAN-USO-PERSONAL.md` §5.4).
 *
 * SHA-256 de los **bytes** de cada archivo de la pieza, en orden. Se hashean
 * los bytes y no el `etag`: el de memoria es un contador y el de MinIO y el
 * de R2 no significan lo mismo (ver la cabecera de `s3-storage.ts`).
 *
 * Una pieza no cambia de bytes sin cambiar de `revision` (un rebuild sube una
 * revisión nueva con claves nuevas), así que la huella se guarda en memoria
 * del proceso por `(contentId, revision)`: la primera publicación de la
 * mañana baja las piezas publicadas de las otras marcas y las siguientes no.
 * No hay columna donde persistirla; queda propuesta en el reporte
 * (`contents.render_fingerprint`).
 */
import { createHash } from "node:crypto";

import type { Storage } from "@fastgram/ports";

import { bucketBaseOf, keyFromCanonicalUrl } from "./media.js";

export interface FingerprintSubject {
  readonly contentId: string;
  readonly revision: number;
  readonly files: readonly string[];
}

export interface ContentFingerprinter {
  /** `null` = no se pudo calcular (un archivo fuera del bucket, o ilegible). */
  of(subject: FingerprintSubject): Promise<string | null>;
}

export function createStorageFingerprinter(
  storage: Storage,
  options: { readonly maxEntries?: number } = {},
): ContentFingerprinter {
  const cache = new Map<string, Promise<string | null>>();
  const max = options.maxEntries ?? 5_000;

  async function compute(files: readonly string[]): Promise<string | null> {
    if (files.length === 0) return null;
    const base = await bucketBaseOf(storage);
    const hash = createHash("sha256");
    for (const file of files) {
      const key = keyFromCanonicalUrl(file, base);
      if (key === null) return null;
      try {
        for await (const chunk of await storage.get(key)) hash.update(chunk);
      } catch {
        return null;
      }
      // Separador entre archivos: dos piezas con los mismos bytes repartidos
      // distinto no son la misma pieza.
      hash.update("\u0000");
    }
    return hash.digest("hex");
  }

  return {
    of(subject) {
      const cacheKey = `${subject.contentId}:${String(subject.revision)}`;
      const hit = cache.get(cacheKey);
      if (hit !== undefined) return hit;
      const promise = compute(subject.files);
      cache.set(cacheKey, promise);
      if (cache.size > max) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return promise;
    },
  };
}
