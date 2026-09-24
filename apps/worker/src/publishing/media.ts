/**
 * La media de un post, tal como la necesita cada plataforma — `PU-PUB-003…006`,
 * `PU-RUN-005`, `NFR-008`.
 *
 * `contents.files` guarda la URL **canónica** de cada objeto (la firmada sin la
 * query, `canonicalObjectUrl`): no sirve para que una plataforma la baje, y
 * desde ella no se puede firmar sin la clave. Este archivo recupera la clave y
 * pide la URL que corresponde:
 *
 * - `public_url` → `PublicMediaUrls.forObject(key)` (el túnel): Instagram,
 *   Threads, Facebook y las fotos de TikTok **bajan** la media ellas.
 * - `private_url` → `Storage.createDownloadUrl` (firmada, 1 h): X y el video de
 *   TikTok se suben desde el worker, y alcanza con que el worker la alcance.
 *
 * ## Cómo se recupera la clave
 *
 * El puerto `Storage` no expone «la URL base del bucket», y la canónica sale
 * de firmar y quitar la query. Así que se firma **una clave sonda** y lo que
 * queda antes de ella es la base: todo lo que empieza con esa base es un
 * objeto del bucket, y el resto es su clave (percent-decodificada: el
 * adaptador de memoria codifica las `/`, el de S3 no). Un archivo que no
 * empieza con la base no es nuestro (una URL externa vieja): se pasa tal cual
 * sólo si la ruta es `private_url`; para una plataforma que baja por URL
 * pública no hay forma segura de exponerlo.
 */
import { canonicalObjectUrl } from "@fastgram/adapters";
import {
  PortError,
  type PublicMediaUrls,
  type PublishMediaKind,
  type SocialPublishCapabilities,
  type Storage,
} from "@fastgram/ports";

const PROBE_KEY = "fastgram-media-probe";

/** La URL canónica de la clave sonda, menos la sonda: la base del bucket. */
export async function bucketBaseOf(storage: Storage): Promise<string> {
  const probe = await canonicalObjectUrl(storage, PROBE_KEY);
  const at = probe.lastIndexOf(PROBE_KEY);
  if (at < 0) {
    throw new PortError(
      "provider_contract_violation",
      "Cannot derive the bucket base URL.",
      {
        source: "worker/publishing-media",
      },
    );
  }
  return probe.slice(0, at);
}

/** La clave del objeto de una URL canónica, o `null` si no es de este bucket. */
export function keyFromCanonicalUrl(url: string, base: string): string | null {
  if (!url.startsWith(base)) return null;
  const rest = url.slice(base.length);
  if (rest.length === 0) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

/** Qué tipo de URL quiere esta ruta para este tipo de media. */
export function mediaSourceFor(
  caps: SocialPublishCapabilities,
  kind: PublishMediaKind,
): "public_url" | "private_url" {
  return caps.mediaSourceByKind?.[kind] ?? caps.mediaSource ?? "public_url";
}

export interface MediaResolverDeps {
  readonly storage: Storage;
  readonly publicMedia: PublicMediaUrls;
}

/**
 * Las URLs a pasarle al adaptador. Lanza `PublicMediaUnavailableError` (sin
 * túnel) o `PortError`; quien llama decide si reintenta.
 */
export async function resolveMediaUrls(
  deps: MediaResolverDeps,
  files: readonly string[],
  source: "public_url" | "private_url",
): Promise<string[]> {
  const base = await bucketBaseOf(deps.storage);
  const out: string[] = [];
  for (const file of files) {
    const key = keyFromCanonicalUrl(file, base);
    if (key === null) {
      if (source === "private_url") {
        out.push(file);
        continue;
      }
      throw new PortError(
        "bad_request",
        "This media isn't stored in FastGram's bucket.",
        {
          source: "worker/publishing-media",
        },
      );
    }
    if (source === "public_url") {
      out.push(await deps.publicMedia.forObject(key));
    } else {
      const signed = await deps.storage.createDownloadUrl({ key, ttlSeconds: 3600 });
      out.push(signed.url);
    }
  }
  return out;
}
