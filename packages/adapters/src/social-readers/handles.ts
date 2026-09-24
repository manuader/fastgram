/**
 * De lo que guarda la fila a un handle que se puede mandar a un extractor.
 *
 * El handler del worker pasa `canonicalUrl ?? handle` (lo pide así el
 * extractor web, que necesita el path). Para las redes, `canonicalSocialUrl`
 * de `@fastgram/core` guarda `https://instagram.com/<h>`,
 * `https://tiktok.com/@<h>` y `https://x.com/<h>`; acá se acepta eso, la
 * variante con `www.`, el `@handle` y el handle pelado.
 *
 * `null` si no es un handle válido de esa plataforma: el adaptador lo trata
 * como `bad_request` sin gastar una llamada. El patrón es deliberadamente
 * estrecho (letras, números, `.`, `_`, `-`) porque el resultado viaja dentro
 * de una URL de un tercero.
 */
export type ScrapedPlatform = "instagram" | "tiktok" | "x";

const HOSTS: Readonly<Record<ScrapedPlatform, readonly string[]>> = {
  instagram: ["instagram.com"],
  tiktok: ["tiktok.com"],
  x: ["x.com", "twitter.com"],
};

const PATTERN: Readonly<Record<ScrapedPlatform, RegExp>> = {
  instagram: /^[A-Za-z0-9._]{1,30}$/,
  tiktok: /^[A-Za-z0-9._-]{1,64}$/,
  x: /^[A-Za-z0-9_]{1,50}$/,
};

export function handleFrom(platform: ScrapedPlatform, input: string): string | null {
  const raw = input.trim();
  if (raw === "") return null;

  let candidate: string;
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ||
    /^(www\.)?[a-z0-9-]+\.[a-z]+\//i.test(raw)
  ) {
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, "");
    if (!HOSTS[platform].includes(host)) return null;
    const first = url.pathname.split("/").find((s) => s !== "");
    if (first === undefined) return null;
    candidate = first;
  } else {
    candidate = raw;
  }
  candidate = candidate.replace(/^@/, "");
  return PATTERN[platform].test(candidate) ? candidate.toLowerCase() : null;
}
