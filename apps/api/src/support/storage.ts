/**
 * Construcción del puerto `Storage` desde el entorno — `P1-STORAGE-007`.
 *
 * Vive acá y no dentro de `main.ts` por una sola razón: `main.ts` no se puede
 * importar desde un test —abre el puerto y arranca pg-boss en el import— y lo
 * que hay que poder ejercitar sin levantar nada es el mapeo de variables a
 * `S3StorageConfig` y el aviso del hueco del CDN.
 *
 * ## Qué cambia respecto de `MemoryStorage`
 *
 * `MemoryStorage` era *"un puesto de guardia, no la solución"*, y el efecto
 * medido era concreto: la `uploadUrl` de la reserva es sintética
 * (`memory://bucket/...`), el PUT del cliente no llega a ningún lado, y el
 * `head()` de la finalización devuelve `null`, así que **`POST /media`
 * respondía `409` siempre**. §9.8 es reserva → PUT directo → finalización, y
 * de los tres pasos sólo el primero devolvía algo.
 */

import { S3Storage, canonicalObjectUrl, type S3StorageConfig } from "@fastgram/adapters";
import type { Storage } from "@fastgram/ports";

/** Lo que de `ApiEnv` necesita el storage. Un subconjunto, para poder testearlo. */
export interface StorageEnv {
  readonly S3_ENDPOINT: string;
  readonly S3_REGION: string;
  readonly S3_BUCKET: string;
  readonly S3_ACCESS_KEY_ID: string;
  readonly S3_SECRET_ACCESS_KEY: string;
  readonly S3_PUBLIC_URL: string;
  readonly S3_FORCE_PATH_STYLE: boolean;
}

/**
 * `S3StorageConfig` desde el entorno.
 *
 * `maxBufferedBytes` se deja en el default del adaptador (64 MiB): la API no
 * hace `put` —los bytes del usuario van directo al bucket por la URL firmada,
 * que es el punto entero de §9.8— así que el tope no se toca por este camino.
 * Quien sí sube es el worker.
 */
export function s3ConfigFrom(env: StorageEnv): S3StorageConfig {
  return {
    bucket: env.S3_BUCKET,
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  };
}

export function createStorage(env: StorageEnv): Storage {
  return new S3Storage(s3ConfigFrom(env));
}

/**
 * Clave de sonda para el chequeo de abajo.
 *
 * No se escribe ni se lee: `createDownloadUrl` firma en local, sin red. El
 * prefijo dice a las claras que es una sonda para quien la vea en un log.
 */
export const CANONICAL_URL_PROBE_KEY = "__probe__/canonical-url-check";

export type CanonicalUrlCheck =
  | { readonly kind: "aligned"; readonly base: string }
  | {
      readonly kind: "diverged";
      readonly canonicalBase: string;
      readonly publicBase: string;
    }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * ¿La URL que se **persiste** apunta a `S3_PUBLIC_URL`?
 *
 * `canonicalObjectUrl` (en `@fastgram/adapters`) arma la dirección estable de
 * un objeto firmando una descarga y tirándole la query. Eso da la ruta del
 * objeto **en el endpoint de firma**, que con MinIO en desarrollo resulta ser
 * la misma URL pública —el compose deja el bucket con lectura anónima— y con
 * R2 detrás de un CDN **no lo es**: `Media.r2Url` y `Content.files` quedarían
 * guardados apuntando a `<account>.r2.cloudflarestorage.com`, que no sirve
 * nada públicamente.
 *
 * Está reportado como hueco desde hace dos tandas y **no se puede cerrar desde
 * `apps/api`**: el puerto `Storage` no expone "dame la URL pública de esta
 * clave", y escribir acá una segunda definición de *cuál es la dirección de un
 * objeto* es justo lo que el docstring de `canonical-url.ts` pide no hacer —
 * `apps/worker` tiene la otra mitad y las dos copias se separarían devolviendo
 * URLs igual de plausibles.
 *
 * Lo que sí se puede hacer, y es lo que hace esta función, es **que deje de ser
 * silencioso**: se compara al arrancar y, si divergen, se loguea con los dos
 * valores. Cuesta una firma local y convierte un dato mal persistido —que no
 * tiene síntoma hasta que alguien abre un video y ve un 403— en una línea de
 * log del arranque.
 */
export async function checkCanonicalUrlBase(
  storage: Storage,
  publicUrl: string,
): Promise<CanonicalUrlCheck> {
  let canonical: string;
  try {
    canonical = await canonicalObjectUrl(storage, CANONICAL_URL_PROBE_KEY);
  } catch (error: unknown) {
    // Un fallo acá no puede tumbar el arranque: es un chequeo de diagnóstico.
    return { kind: "unknown", reason: describe(error) };
  }

  const canonicalBase = stripSuffix(canonical, CANONICAL_URL_PROBE_KEY);
  const publicBase = trimSlash(publicUrl);

  if (canonicalBase === publicBase) return { kind: "aligned", base: publicBase };
  return { kind: "diverged", canonicalBase, publicBase };
}

function stripSuffix(url: string, key: string): string {
  // La clave puede venir percent-encoded según el proveedor; se prueban las dos.
  for (const candidate of [key, encodeURI(key), encodeURIComponent(key)]) {
    if (url.endsWith(candidate)) return trimSlash(url.slice(0, -candidate.length));
  }
  return trimSlash(url);
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
