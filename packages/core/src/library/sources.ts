/**
 * Fuentes externas de la biblioteca global — sprint 9 (agente N), `PU-S9-006`.
 *
 * Funciones **puras**: arman la URL del pedido y convierten la respuesta del
 * proveedor en candidatos con la licencia ya verificada. El `fetch` lo hace
 * quien llama (la API para buscar, el worker para bajar): `core` no hace IO.
 *
 * Cada fuente, con la doc oficial que se leyó (2026-09-28):
 *
 * - **Wikimedia Commons** — MediaWiki Action API, sin key:
 *   https://www.mediawiki.org/wiki/API:Search (generator=search sobre el
 *   namespace 6, `File:`), https://www.mediawiki.org/wiki/API:Imageinfo y la
 *   licencia por archivo en `extmetadata`
 *   (https://www.mediawiki.org/wiki/Extension:CommonsMetadata: `License`,
 *   `LicenseShortName`, `LicenseUrl`, `Artist`, `Restrictions`). Pide un
 *   User-Agent descriptivo (https://meta.wikimedia.org/wiki/User-Agent_policy).
 * - **Pexels** — https://www.pexels.com/api/documentation/ : `GET
 *   https://api.pexels.com/v1/videos/search` y `/v1/videos/videos/:id`, header
 *   `Authorization: <key>`, 200 pedidos/hora y 20.000/mes, `per_page` ≤ 80.
 *   Licencia: https://www.pexels.com/license/ .
 * - **Pixabay** — https://pixabay.com/api/docs/ : `GET
 *   https://pixabay.com/api/videos/?key=…&q=…` (`id` para uno), 100 pedidos
 *   cada 60 s, **resultados cacheados 24 h**, `per_page` 3–200. Licencia:
 *   https://pixabay.com/service/license-summary/ .
 *
 * ## La licencia de Commons se verifica, no se cree
 *
 * `License` es «una mejor suposición» según la doc de CommonsMetadata, y no
 * es confiable en archivos con varias licencias. Por eso se exige que
 * `License` y `LicenseShortName` **digan lo mismo** (un `cc-by-3.0` con
 * nombre corto `CC BY 3.0`), que haya autor para CC BY, y que `Restrictions`
 * venga vacío (marcas, derechos de imagen…). Cualquier duda → no importable,
 * con el motivo.
 */

export type LibrarySource = "wikimedia" | "pexels" | "pixabay";
export type LibrarySourceMediaType = "video" | "image" | "audio";

export type SourceRejection =
  | "license_not_accepted"
  | "license_unverifiable"
  | "restricted"
  | "too_long"
  | "too_large"
  | "unsupported_media";

export interface SourceLicense {
  readonly type: "cc0" | "cc-by" | "pexels" | "pixabay";
  readonly version?: string;
  readonly attribution?: string;
  readonly sourceUrl: string;
  readonly author?: string;
  readonly licenseUrl: string;
  readonly verifiedAt: string;
}

export interface SourceCandidate {
  readonly source: LibrarySource;
  readonly externalId: string;
  readonly title: string;
  readonly pageUrl: string;
  /** El archivo a bajar (https, en un host de {@link LIBRARY_SOURCE_DOWNLOAD_HOSTS}). */
  readonly downloadUrl: string;
  readonly previewUrl: string | null;
  readonly mediaType: LibrarySourceMediaType;
  readonly mime: string | null;
  readonly durationSec: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly sizeBytes: number | null;
  /** Lo que declara la fuente, tal cual, para mostrar. */
  readonly licenseLabel: string;
  readonly license: SourceLicense | null;
  readonly rejection: SourceRejection | null;
}

export interface SourcePage {
  readonly candidates: readonly SourceCandidate[];
  readonly nextPage: number | null;
}

/** Topes de lo que entra. Un meme dura segundos; un fondo en loop, un minuto. */
export const LIBRARY_MAX_DURATION_SEC = 180;
export const LIBRARY_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;
export const LIBRARY_SEARCH_PAGE_SIZE = 24;

/**
 * Los únicos hosts de los que el worker baja, por fuente. Los links vienen de
 * la respuesta de la API del proveedor (no del cliente), y aun así se
 * chequean: el payload vive en la cola.
 *
 * `player.vimeo.com` está porque Pexels sirvió históricamente sus archivos de
 * video desde ahí; no se pudo confirmar en la doc actual (sin key), queda
 * como tolerancia documentada.
 */
export const LIBRARY_SOURCE_DOWNLOAD_HOSTS: Readonly<
  Record<LibrarySource, readonly string[]>
> = {
  wikimedia: ["upload.wikimedia.org"],
  pexels: ["videos.pexels.com", "images.pexels.com", "player.vimeo.com"],
  pixabay: ["cdn.pixabay.com"],
};

export function isAllowedDownloadUrl(source: LibrarySource, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "")
    return false;
  return LIBRARY_SOURCE_DOWNLOAD_HOSTS[source].includes(parsed.hostname.toLowerCase());
}

export const LIBRARY_SOURCE_INFO: Readonly<
  Record<
    LibrarySource,
    {
      readonly label: string;
      readonly licenseUrl: string;
      readonly needsKey: boolean;
      readonly credit: { readonly text: string; readonly url: string };
    }
  >
> = {
  wikimedia: {
    label: "Wikimedia Commons",
    licenseUrl:
      "https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia",
    needsKey: false,
    credit: {
      text: "Files from Wikimedia Commons",
      url: "https://commons.wikimedia.org",
    },
  },
  pexels: {
    label: "Pexels",
    licenseUrl: "https://www.pexels.com/license/",
    needsKey: true,
    // La guía de la API pide un link visible a Pexels.
    credit: { text: "Videos provided by Pexels", url: "https://www.pexels.com" },
  },
  pixabay: {
    label: "Pixabay",
    licenseUrl: "https://pixabay.com/service/license-summary/",
    needsKey: true,
    // La doc pide mostrar de dónde vienen los resultados.
    credit: { text: "Videos from Pixabay", url: "https://pixabay.com" },
  },
};

// --- utilidades --------------------------------------------------------------

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

/** HTML de terceros → texto de una línea (el `Artist` de Commons trae links). */
export function htmlToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&([a-z#0-9]+);/gi, (m, e: string) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/** `File:Court Scale Green Screen.webm` → `Court Scale Green Screen`. */
export function titleFromFileName(fileTitle: string): string {
  const noNs = fileTitle.replace(/^File:/i, "");
  const dot = noNs.lastIndexOf(".");
  return (dot > 0 ? noNs.slice(0, dot) : noNs).replace(/_/g, " ").trim().slice(0, 200);
}

function rejectBySize(
  durationSec: number | null,
  sizeBytes: number | null,
): SourceRejection | null {
  if (durationSec !== null && durationSec > LIBRARY_MAX_DURATION_SEC) return "too_long";
  if (sizeBytes !== null && sizeBytes > LIBRARY_DOWNLOAD_MAX_BYTES) return "too_large";
  return null;
}

// --- Wikimedia Commons -------------------------------------------------------

export const WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php";

const EXTMETADATA_FIELDS =
  "License|LicenseShortName|LicenseUrl|Artist|Credit|AttributionRequired|Restrictions|UsageTerms";

const FILETYPE: Readonly<Record<LibrarySourceMediaType, string>> = {
  video: "video",
  image: "bitmap",
  audio: "audio",
};

function wikimediaParams(extra: Record<string, string>): string {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "imageinfo",
    iiprop: "url|size|mime|mediatype|extmetadata",
    iiextmetadatafilter: EXTMETADATA_FIELDS,
    // La miniatura para la grilla: 640 px de ancho (un poster del video).
    iiurlwidth: "640",
    ...extra,
  });
  return `${WIKIMEDIA_API}?${params.toString()}`;
}

/** Búsqueda en el namespace `File:` filtrada por tipo (`filetype:` de CirrusSearch). */
export function wikimediaSearchUrl(
  query: string,
  page: number,
  mediaType: LibrarySourceMediaType = "video",
  perPage: number = LIBRARY_SEARCH_PAGE_SIZE,
): string {
  return wikimediaParams({
    generator: "search",
    gsrnamespace: "6",
    gsrsearch: `${query} filetype:${FILETYPE[mediaType]}`,
    gsrlimit: String(perPage),
    gsroffset: String((Math.max(1, page) - 1) * perPage),
  });
}

/** Un archivo por su título (`File:…`): lo que el import vuelve a pedir del lado del servidor. */
export function wikimediaFileUrl(title: string): string {
  return wikimediaParams({ titles: title });
}

const CC_BY = /^cc-by-(\d(?:\.\d)?)$/;

function metaValue(ext: Json | null, key: string): string | null {
  const field = obj(ext?.[key]);
  const v = field?.["value"];
  return typeof v === "string" ? v.trim() : null;
}

interface CommonsLicenseVerdict {
  readonly license: SourceLicense | null;
  readonly rejection:
    "license_not_accepted" | "license_unverifiable" | "restricted" | null;
  readonly label: string;
}

export function verifyCommonsLicense(
  ext: Json | null,
  pageUrl: string,
  title: string,
  verifiedAt: string,
): CommonsLicenseVerdict {
  const code = (metaValue(ext, "License") ?? "").toLowerCase();
  const shortName = metaValue(ext, "LicenseShortName") ?? "";
  const label = shortName.length > 0 ? shortName : code.length > 0 ? code : "unknown";
  const restrictions = metaValue(ext, "Restrictions") ?? "";
  if (code.length === 0 || shortName.length === 0) {
    return { license: null, rejection: "license_unverifiable", label };
  }
  const normalizedShort = shortName.toLowerCase().replace(/\s+/g, " ");
  const author = htmlToText(metaValue(ext, "Artist") ?? "").slice(0, 200);
  const licenseUrl = metaValue(ext, "LicenseUrl");

  let license: SourceLicense | null = null;
  if (code === "cc0") {
    if (normalizedShort !== "cc0") {
      return { license: null, rejection: "license_unverifiable", label };
    }
    license = {
      type: "cc0",
      sourceUrl: pageUrl,
      licenseUrl: licenseUrl ?? "https://creativecommons.org/publicdomain/zero/1.0/",
      ...(author.length > 0 ? { author } : {}),
      verifiedAt,
    };
  } else {
    const byMatch = CC_BY.exec(code);
    if (byMatch === null) {
      return { license: null, rejection: "license_not_accepted", label };
    }
    const version = byMatch[1] ?? "";
    // Que el nombre corto diga lo mismo: «CC BY 3.0», no «CC BY-SA 3.0».
    if (normalizedShort !== `cc by ${version}`) {
      return { license: null, rejection: "license_unverifiable", label };
    }
    if (author.length === 0 || licenseUrl === null) {
      return { license: null, rejection: "license_unverifiable", label };
    }
    license = {
      type: "cc-by",
      version,
      author,
      sourceUrl: pageUrl,
      licenseUrl,
      // TASL: título, autor, fuente, licencia.
      attribution: `"${title}" by ${author}, ${shortName}, via Wikimedia Commons`.slice(
        0,
        500,
      ),
      verifiedAt,
    };
  }
  if (restrictions.length > 0) return { license: null, rejection: "restricted", label };
  return { license, rejection: null, label };
}

function commonsMediaType(
  mediatype: string | null,
  mime: string | null,
): LibrarySourceMediaType | null {
  const m = (mediatype ?? "").toUpperCase();
  if (m === "VIDEO") return "video";
  if (m === "BITMAP" || m === "DRAWING") return "image";
  if (m === "AUDIO") return "audio";
  if (mime?.startsWith("video/") === true) return "video";
  if (mime?.startsWith("image/") === true) return "image";
  if (mime?.startsWith("audio/") === true) return "audio";
  return null;
}

/** Las páginas de una respuesta de Commons (búsqueda o archivo puntual). */
export function parseWikimediaResponse(
  body: unknown,
  verifiedAt: string,
  page = 1,
): SourcePage {
  const root = obj(body);
  const pages = arr(obj(root?.["query"])?.["pages"]);
  const candidates: SourceCandidate[] = [];
  for (const raw of pages) {
    const p = obj(raw);
    const fileTitle = str(p?.["title"]);
    if (p === null || fileTitle === null || p["missing"] === true) continue;
    const info = obj(arr(p["imageinfo"])[0]);
    const url = str(info?.["url"]);
    const pageUrl = str(info?.["descriptionurl"]);
    if (info === null || url === null || pageUrl === null) continue;
    const mime = str(info["mime"]);
    const mediaType = commonsMediaType(str(info["mediatype"]), mime);
    const title = titleFromFileName(fileTitle);
    const durationSec = num(info["duration"]);
    const sizeBytes = num(info["size"]);
    const verdict = verifyCommonsLicense(
      obj(info["extmetadata"]),
      pageUrl,
      title,
      verifiedAt,
    );
    const rejection =
      mediaType === null
        ? "unsupported_media"
        : (verdict.rejection ?? rejectBySize(durationSec, sizeBytes));
    candidates.push({
      source: "wikimedia",
      externalId: fileTitle,
      title,
      pageUrl,
      downloadUrl: url,
      previewUrl: str(info["thumburl"]),
      mediaType: mediaType ?? "video",
      mime,
      durationSec,
      width: num(info["width"]),
      height: num(info["height"]),
      sizeBytes,
      licenseLabel: verdict.label,
      license: rejection === null ? verdict.license : null,
      rejection,
    });
  }
  const offset = num(obj(root?.["continue"])?.["gsroffset"]);
  return { candidates, nextPage: offset === null ? null : page + 1 };
}

// --- Pexels ------------------------------------------------------------------

export const PEXELS_API = "https://api.pexels.com/v1";

export function pexelsSearchUrl(
  query: string,
  page: number,
  perPage = LIBRARY_SEARCH_PAGE_SIZE,
): string {
  const params = new URLSearchParams({
    query,
    page: String(Math.max(1, page)),
    per_page: String(Math.min(80, perPage)),
  });
  return `${PEXELS_API}/videos/search?${params.toString()}`;
}

export function pexelsVideoUrl(id: string): string {
  return `${PEXELS_API}/videos/videos/${encodeURIComponent(id)}`;
}

/** El archivo mp4 más grande que no pase de 1920 px de lado (o el más chico). */
function pickPexelsFile(
  files: unknown[],
): { link: string; width: number | null; height: number | null } | null {
  const mp4 = files
    .map(obj)
    .filter((f): f is Json => f !== null && str(f["link"]) !== null)
    .filter((f) => (str(f["file_type"]) ?? "video/mp4") === "video/mp4")
    .map((f) => ({
      link: str(f["link"]) as string,
      width: num(f["width"]),
      height: num(f["height"]),
    }));
  if (mp4.length === 0) return null;
  const side = (f: { width: number | null; height: number | null }) =>
    Math.max(f.width ?? 0, f.height ?? 0);
  const fitting = mp4.filter((f) => side(f) <= 1920).sort((a, b) => side(b) - side(a));
  return fitting[0] ?? [...mp4].sort((a, b) => side(a) - side(b))[0] ?? null;
}

function pexelsCandidate(raw: unknown, verifiedAt: string): SourceCandidate | null {
  const v = obj(raw);
  const id = num(v?.["id"]);
  const pageUrl = str(v?.["url"]);
  if (v === null || id === null || pageUrl === null) return null;
  const file = pickPexelsFile(arr(v["video_files"]));
  const user = obj(v["user"]);
  const author = str(user?.["name"]);
  const durationSec = num(v["duration"]);
  // El slug de la página es lo más parecido a un título que da la API.
  const slug = /\/video\/([^/]+?)-?\d*\/?$/.exec(pageUrl)?.[1]?.replace(/-/g, " ").trim();
  const title = (
    slug !== undefined && slug.length > 0 ? slug : `Pexels video ${String(id)}`
  ).slice(0, 200);
  const license: SourceLicense = {
    type: "pexels",
    sourceUrl: pageUrl,
    licenseUrl: LIBRARY_SOURCE_INFO.pexels.licenseUrl,
    ...(author === null ? {} : { author, attribution: `Video by ${author} on Pexels` }),
    verifiedAt,
  };
  const rejection: SourceRejection | null =
    file === null ? "unsupported_media" : rejectBySize(durationSec, null);
  return {
    source: "pexels",
    externalId: String(id),
    title,
    pageUrl,
    downloadUrl: file?.link ?? pageUrl,
    previewUrl: str(v["image"]),
    mediaType: "video",
    mime: "video/mp4",
    durationSec,
    width: file?.width ?? num(v["width"]),
    height: file?.height ?? num(v["height"]),
    sizeBytes: null,
    licenseLabel: "Pexels License",
    license: rejection === null ? license : null,
    rejection,
  };
}

/** Respuesta de `/videos/search` (`videos[]`, `next_page`) o de `/videos/videos/:id` (un video). */
export function parsePexelsResponse(
  body: unknown,
  verifiedAt: string,
  page = 1,
): SourcePage {
  const root = obj(body);
  if (root !== null && Array.isArray(root["videos"])) {
    const candidates = root["videos"]
      .map((v) => pexelsCandidate(v, verifiedAt))
      .filter((c): c is SourceCandidate => c !== null);
    return { candidates, nextPage: str(root["next_page"]) === null ? null : page + 1 };
  }
  const one = pexelsCandidate(body, verifiedAt);
  return { candidates: one === null ? [] : [one], nextPage: null };
}

// --- Pixabay -----------------------------------------------------------------

export const PIXABAY_API = "https://pixabay.com/api/videos/";

/** La key va en la query (así lo pide Pixabay): esta URL **nunca** se loguea. */
export function pixabaySearchUrl(
  apiKey: string,
  query: string,
  page: number,
  perPage = LIBRARY_SEARCH_PAGE_SIZE,
): string {
  const params = new URLSearchParams({
    key: apiKey,
    q: query.slice(0, 100),
    page: String(Math.max(1, page)),
    per_page: String(Math.min(200, Math.max(3, perPage))),
    safesearch: "true",
  });
  return `${PIXABAY_API}?${params.toString()}`;
}

export function pixabayVideoUrl(apiKey: string, id: string): string {
  const params = new URLSearchParams({ key: apiKey, id });
  return `${PIXABAY_API}?${params.toString()}`;
}

function pixabayCandidate(raw: unknown, verifiedAt: string): SourceCandidate | null {
  const h = obj(raw);
  const id = num(h?.["id"]);
  const pageUrl = str(h?.["pageURL"]);
  if (h === null || id === null || pageUrl === null) return null;
  const videos = obj(h["videos"]);
  const rendition = (name: string) => {
    const r = obj(videos?.[name]);
    const url = str(r?.["url"]);
    return url === null
      ? null
      : {
          url,
          width: num(r?.["width"]),
          height: num(r?.["height"]),
          size: num(r?.["size"]),
          thumbnail: str(r?.["thumbnail"]),
        };
  };
  const large = rendition("large");
  const medium = rendition("medium");
  const chosen =
    large !== null && Math.max(large.width ?? 0, large.height ?? 0) <= 1920
      ? large
      : (medium ?? large);
  const author = str(h["user"]);
  const tags = str(h["tags"]) ?? "";
  const durationSec = num(h["duration"]);
  const license: SourceLicense = {
    type: "pixabay",
    sourceUrl: pageUrl,
    licenseUrl: LIBRARY_SOURCE_INFO.pixabay.licenseUrl,
    ...(author === null
      ? {}
      : { author, attribution: `Video by ${author} from Pixabay` }),
    verifiedAt,
  };
  const rejection: SourceRejection | null =
    chosen === null ? "unsupported_media" : rejectBySize(durationSec, chosen.size);
  return {
    source: "pixabay",
    externalId: String(id),
    title: (tags.length > 0 ? tags : `Pixabay video ${String(id)}`).slice(0, 200),
    pageUrl,
    downloadUrl: chosen?.url ?? pageUrl,
    previewUrl: chosen?.thumbnail ?? rendition("tiny")?.thumbnail ?? null,
    mediaType: "video",
    mime: "video/mp4",
    durationSec,
    width: chosen?.width ?? null,
    height: chosen?.height ?? null,
    sizeBytes: chosen?.size ?? null,
    licenseLabel: "Pixabay Content License",
    license: rejection === null ? license : null,
    rejection,
  };
}

export function parsePixabayResponse(
  body: unknown,
  verifiedAt: string,
  page = 1,
  perPage = LIBRARY_SEARCH_PAGE_SIZE,
): SourcePage {
  const root = obj(body);
  const hits = arr(root?.["hits"]);
  const candidates = hits
    .map((h) => pixabayCandidate(h, verifiedAt))
    .filter((c): c is SourceCandidate => c !== null);
  const totalHits = num(root?.["totalHits"]) ?? 0;
  return { candidates, nextPage: page * perPage < totalHits ? page + 1 : null };
}
