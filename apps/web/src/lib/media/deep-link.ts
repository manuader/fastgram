/**
 * Deep-linking del Media Bank · `FR-100.1` (`P2-MEDIA-008`, sprint 7).
 *
 * `/library?from=%2Fblitz%2Fsettings%3Ffocus%3D<id>&focus=<mediaId>`:
 * `from` es a dónde vuelve el botón «Back»; `focus`, el asset a resaltar.
 *
 * `from` es input de la URL: sólo se acepta un **path interno** (empieza con
 * una sola `/`, sin esquema ni `//host`). Cualquier otra cosa se descarta: un
 * «Back» que lleva a `https://otro-sitio` es un open redirect.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\"))
    return null;
  // Caracteres de control (código < 32): no tienen nada que hacer en un path.
  if ([...value].some((c) => c.charCodeAt(0) < 32)) return null;
  if (value.length > 2048) return null;
  return value;
}

export interface LibraryDeepLink {
  readonly from: string | null;
  readonly focus: string | null;
  /** Con contexto (`from`/`focus`) se abre directo en el Media Bank. */
  readonly tab: "posts" | "content" | "media" | "audio" | null;
}

export function readLibraryDeepLink(params: {
  get(name: string): string | null;
}): LibraryDeepLink {
  const from = safeReturnPath(params.get("from"));
  const focusRaw = params.get("focus");
  const focus = focusRaw !== null && /^[\w-]{1,64}$/.test(focusRaw) ? focusRaw : null;
  const tabRaw = params.get("tab");
  const tab =
    tabRaw === "posts" || tabRaw === "content" || tabRaw === "media" || tabRaw === "audio"
      ? tabRaw
      : from !== null || focus !== null
        ? "media"
        : null;
  return { from, focus, tab };
}
