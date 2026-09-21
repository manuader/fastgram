/**
 * URL estable de un objeto del bucket — PRD §9.8, §9.10, `DATA-010`.
 *
 * **No es una URL firmada.** §9.10 prohíbe persistir y loguear las firmadas
 * porque son capacidades bearer de una hora; `Media.r2Url` y `Content.files`
 * son campos persistidos del modelo, así que tienen que ser la dirección del
 * objeto y nada más. Se obtiene firmando una y quitándole la query, que es
 * donde vive la firma: lo que queda es la ruta del objeto en el bucket.
 *
 * Es un rodeo, y conviene saber por qué está: el puerto `Storage` **no expone**
 * "dame la URL pública de esta clave", y ninguna de las dos apps lleva la base
 * pública del bucket hasta el punto donde hace falta (`S3_PUBLIC_URL` existe en
 * `env.ts` y no llega). Con el adaptador S3 montado, el resultado apunta al
 * endpoint de firma y no a un CDN.
 *
 * ## Por qué vive en `adapters` y no en una de las dos apps
 *
 * Porque las dos la necesitan: `apps/api` al finalizar una subida (§9.8 paso 3)
 * y `apps/worker` al guardar el resultado de un build. Estaba sólo en la API, y
 * la copia del worker habría sido la segunda definición de **qué es la
 * dirección de un objeto** — que es justo la clase de cosa que se desincroniza
 * sin que nadie lo note, porque las dos copias siguen devolviendo una URL
 * plausible. Es una función pura sobre el puerto, así que no arrastra nada.
 */

import {
  MAX_SIGNED_URL_TTL_SECONDS,
  type Storage,
  type StorageKey,
} from "@fastgram/ports";

export async function canonicalObjectUrl(
  storage: Storage,
  key: StorageKey,
): Promise<string> {
  const signed = await storage.createDownloadUrl({
    key,
    ttlSeconds: MAX_SIGNED_URL_TTL_SECONDS,
  });
  const url = new URL(signed.url);
  url.search = "";
  url.hash = "";
  return url.toString();
}
