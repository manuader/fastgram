/**
 * Link a un post → perfil del autor — `P1-BRAND-005`, `FR-011.1`, `ERR-B12`.
 *
 * `detectBrandSource` devuelve `needs_lookup` para los posts cuya URL no trae
 * el autor (Instagram `/p/…`, YouTube `watch`/`shorts`/`youtu.be`, LinkedIn
 * `/posts/…` y `/feed/update/…`), y la API respondía 503. Esto resuelve lo que
 * se puede sin inventar:
 *
 * 1. **Parseo** (acá, puro): LinkedIn `/posts/<autor>_<título>-activity-<id>`
 *    trae el slug del autor antes del primer `_`.
 * 2. **oEmbed de YouTube** (lo hace la API): `https://www.youtube.com/oembed`
 *    es público, sin key, y devuelve `author_url` del canal. Acá sólo se arma
 *    la URL y se lee la respuesta.
 * 3. Lo demás (Instagram `/p/…`: su oEmbed exige token) **no se resuelve**: la
 *    API responde que no se pudo leer y la pantalla ofrece pegar el perfil o
 *    la bio (tier D).
 */
import type { NeedsLookupInput } from "./source-input.js";

/** Endpoint oEmbed de YouTube (oembed.com, proveedor YouTube). */
export const YOUTUBE_OEMBED_ENDPOINT = "https://www.youtube.com/oembed";

/**
 * El slug del autor de un post de LinkedIn, o `null`.
 *
 * `linkedin.com/posts/acme-inc_lanzamos-algo-activity-7123-AbCd` → `acme-inc`.
 * Es el slug de la página o del perfil; cuál de los dos no se sabe desde la
 * URL, así que quien llama arma `company/<slug>` (el default de `FR-011.1`
 * para un slug suelto) y lo avisa como `resolvedFromPost` (`ERR-B12`).
 */
export function linkedInPostAuthor(postRef: string): string | null {
  const ref = postRef.trim();
  const underscore = ref.indexOf("_");
  if (underscore <= 0) return null;
  const slug = ref.slice(0, underscore).toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,99}$/.test(slug) ? slug : null;
}

/** La URL oEmbed para un post de YouTube, o `null` si no es de YouTube. */
export function youtubeOEmbedUrl(detection: NeedsLookupInput): string | null {
  if (detection.sourceType !== "youtube") return null;
  const u = new URL(YOUTUBE_OEMBED_ENDPOINT);
  u.searchParams.set("url", detection.canonicalUrl);
  u.searchParams.set("format", "json");
  return u.toString();
}

/**
 * `author_url` de una respuesta oEmbed, sólo si es un canal de YouTube
 * (`https://www.youtube.com/@…` o `/channel/…`). Cualquier otra cosa es `null`:
 * la respuesta es de un tercero y no decide a qué host se apunta.
 */
export function youtubeAuthorUrlFromOEmbed(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const raw = (json as Record<string, unknown>)["author_url"];
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname !== "youtube.com" && url.hostname !== "www.youtube.com") return null;
  if (!/^\/(@[^/]+|channel\/[^/]+)\/?$/.test(url.pathname)) return null;
  return `https://www.youtube.com${url.pathname.replace(/\/$/, "")}`;
}
