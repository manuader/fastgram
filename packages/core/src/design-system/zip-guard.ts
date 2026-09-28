/**
 * Guardas del zip de un design system — `PU-S9-001`.
 *
 * El zip lo sube el dueño, pero el archivo viene de afuera (un export de
 * Claude Design, o lo que alguien le haya mandado): se trata como hostil. Esta
 * parte es **pura** y decide, sólo con el directorio central (nombres y
 * tamaños declarados), qué se descomprime y qué no. El worker la corre
 * **antes** de inflar un byte (`apps/worker/src/design-system/unzip.ts`).
 *
 * ## Qué se rechaza entero y qué se saltea
 *
 *  - **Se rechaza el zip** (código estable, nada se importa) si: pesa más que
 *    {@link DESIGN_SYSTEM_ZIP_LIMITS.maxCompressedBytes}; trae más entradas que
 *    `maxEntries`; **alguna** ruta es insegura (`..`, absoluta, unidad de
 *    Windows, `\`, NUL o controles) — un zip con una sola ruta así no es un
 *    export honesto; o lo que habría que inflar declara más de
 *    `maxUncompressedBytes` en total, más de `maxEntryBytes` en una entrada, o
 *    una tasa de compresión de bomba (`maxCompressionRatio`).
 *  - **Se saltea** (queda en `skipped`, con motivo) lo que no se usa:
 *    extensiones fuera de la lista, `__MACOSX/`, archivos ocultos, `scraps/`
 *    (páginas del manual, no son assets de marca) y `templates/` (HTML de
 *    Claude Design, no se importan como media). Lo salteado **no se infla**,
 *    así que no cuenta para los topes de descompresión.
 *
 * ## Por qué alcanza con los tamaños declarados
 *
 * Un zip puede mentir en el directorio central. `unzipSync` de fflate reserva
 * la salida con el tamaño **declarado** y no la agranda: una entrada que
 * declara 1 KB e infla 1 GB se corta en 1 KB (medido en el test del worker).
 * Así que el tope sobre lo declarado es un tope sobre lo que se escribe en
 * memoria.
 */

/** Topes. Números nuestros (el PRD no los da): ver cada uno. */
export const DESIGN_SYSTEM_ZIP_LIMITS = {
  /**
   * 100 MB comprimido. El export de referencia (FOCUS) pesa 43 MB con fuentes
   * e imágenes a resolución de imprenta; el doble largo más un margen.
   */
  maxCompressedBytes: 100 * 1024 * 1024,
  /**
   * 300 MB inflados en total, sumando **sólo** lo que se extrae. FOCUS infla
   * ~43 MB (las JPG no comprimen); 300 MB entran en la memoria del worker.
   */
  maxUncompressedBytes: 300 * 1024 * 1024,
  /** 60 MB por archivo: una imagen de imprenta enorme sí, un video no. */
  maxEntryBytes: 60 * 1024 * 1024,
  /** FOCUS trae 90. Un export con 2 000 archivos ya no es un design system. */
  maxEntries: 2_000,
  /**
   * Tasa inflado/comprimido a partir de la cual una entrada es una bomba. Un
   * CSS o un SVG comprimen ~5–10×; 200× sólo lo logra relleno repetido. Se
   * mira en entradas de más de 1 MB inflado: un archivo chico que comprime
   * mucho no es un riesgo de memoria.
   */
  maxCompressionRatio: 200,
  ratioCheckMinBytes: 1024 * 1024,
} as const;

export type DesignSystemZipLimits = {
  readonly [K in keyof typeof DESIGN_SYSTEM_ZIP_LIMITS]: number;
};

/** Lo que el directorio central dice de una entrada. */
export interface ZipEntryInfo {
  readonly path: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

/** Códigos estables de rechazo. La API y la web los traducen. */
export const DESIGN_SYSTEM_IMPORT_FAILURES = [
  "zip_too_large",
  "too_many_entries",
  "unsafe_path",
  "zip_bomb",
  "not_a_zip",
  "empty_design_system",
  "storage_failed",
  "internal_error",
] as const;
export type DesignSystemImportFailure = (typeof DESIGN_SYSTEM_IMPORT_FAILURES)[number];

/** Extensiones que se extraen, y a qué clase de archivo pertenecen. */
export const DESIGN_SYSTEM_FILE_KINDS: Readonly<Record<string, DesignSystemFileKind>> = {
  ".css": "text",
  ".md": "text",
  ".json": "text",
  ".svg": "svg",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".otf": "font",
  ".ttf": "font",
  ".woff": "font",
  ".woff2": "font",
};
export type DesignSystemFileKind = "text" | "svg" | "image" | "font";

/** Carpetas que no se importan: ver la cabecera. */
const IGNORED_TOP_DIRS = new Set(["scraps", "templates", "guidelines", "__macosx"]);

export type SafePath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Normaliza una ruta del zip o dice por qué es insegura. Acepta `./` al
 * principio y barras repetidas; rechaza todo lo que pueda salir del árbol.
 */
export function safeZipPath(raw: string): SafePath {
  if (raw.length === 0) return { ok: false, reason: "empty path" };
  // eslint-disable-next-line no-control-regex -- los controles son justo lo que se busca
  if (/[\u0000-\u001f\u007f]/u.test(raw)) {
    return { ok: false, reason: "control character in path" };
  }
  if (raw.includes("\\")) return { ok: false, reason: "backslash in path" };
  if (raw.startsWith("/")) return { ok: false, reason: "absolute path" };
  if (/^[a-z]:/iu.test(raw)) return { ok: false, reason: "drive letter in path" };
  const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    return { ok: false, reason: "parent directory segment" };
  }
  return { ok: true, path: segments.join("/") };
}

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** La clase de un archivo por su extensión, o `null` si no se extrae. */
export function fileKindOf(path: string): DesignSystemFileKind | null {
  return DESIGN_SYSTEM_FILE_KINDS[extensionOf(path)] ?? null;
}

export interface PlannedZipEntry {
  /** La ruta tal como está en el zip (la que usa el lector). */
  readonly zipPath: string;
  /** La ruta normalizada y sin la carpeta raíz común. Es la que ve el parser. */
  readonly path: string;
  readonly kind: DesignSystemFileKind;
  readonly uncompressedSize: number;
}

export type ZipPlan =
  | {
      readonly ok: true;
      /** Carpeta raíz común que se sacó (`""` si no había). */
      readonly root: string;
      readonly extract: readonly PlannedZipEntry[];
      readonly skipped: readonly { readonly path: string; readonly reason: string }[];
      readonly uncompressedBytes: number;
    }
  | {
      readonly ok: false;
      readonly code: DesignSystemImportFailure;
      readonly detail: string;
    };

/**
 * Si **todas** las entradas cuelgan de una misma carpeta (`FOCUS/readme.md`,
 * `FOCUS/tokens/…`), esa carpeta se saca: un export comprimido desde el Finder
 * la agrega y el parser espera `tokens/` en la raíz.
 */
function commonRoot(paths: readonly string[]): string {
  // La basura del Finder (`__MACOSX/`, `._x`) no cuenta: vive fuera de la
  // carpeta del export y se saltea igual.
  const files = paths.filter((p) => {
    if (p.endsWith("/")) return false;
    const top = p.split("/")[0] ?? "";
    return top.toLowerCase() !== "__macosx" && !top.startsWith(".");
  });
  if (files.length === 0) return "";
  const first = files[0]?.split("/")[0] ?? "";
  if (first === "" || !files.every((p) => p.includes("/") && p.split("/")[0] === first)) {
    return "";
  }
  // Un zip que sólo trae `assets/` (o `tokens/`) no tiene carpeta del export:
  // esa carpeta **es** parte del design system y no se saca.
  return KNOWN_DS_DIRS.has(first.toLowerCase()) ? "" : first;
}

const KNOWN_DS_DIRS = new Set([
  "assets",
  "tokens",
  "uploads",
  "fonts",
  "guidelines",
  "templates",
  "scraps",
]);

function hiddenOrSystem(path: string): string | null {
  const segments = path.split("/");
  if (segments.some((s) => s.startsWith("."))) return "hidden file";
  const top = segments[0]?.toLowerCase() ?? "";
  if (segments.length > 1 && IGNORED_TOP_DIRS.has(top)) return `ignored folder ${top}/`;
  return null;
}

/**
 * Decide qué se infla. Puro: sólo mira el directorio central.
 *
 * `compressedBytes` es el tamaño del archivo zip entero (el objeto subido).
 */
export function planZipExtraction(
  entries: readonly ZipEntryInfo[],
  compressedBytes: number,
  limits: DesignSystemZipLimits = DESIGN_SYSTEM_ZIP_LIMITS,
): ZipPlan {
  if (compressedBytes > limits.maxCompressedBytes) {
    return {
      ok: false,
      code: "zip_too_large",
      detail: `${String(compressedBytes)} bytes > ${String(limits.maxCompressedBytes)}`,
    };
  }
  if (entries.length > limits.maxEntries) {
    return {
      ok: false,
      code: "too_many_entries",
      detail: `${String(entries.length)} entries > ${String(limits.maxEntries)}`,
    };
  }

  const normalized: { entry: ZipEntryInfo; path: string; isDir: boolean }[] = [];
  for (const entry of entries) {
    const isDir = entry.path.endsWith("/");
    const safe = safeZipPath(entry.path);
    if (!safe.ok) {
      return {
        ok: false,
        code: "unsafe_path",
        detail: `${safe.reason}: ${entry.path.slice(0, 200)}`,
      };
    }
    normalized.push({ entry, path: safe.path + (isDir ? "/" : ""), isDir });
  }

  const root = commonRoot(normalized.map((n) => n.path));
  const extract: PlannedZipEntry[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let total = 0;

  for (const { entry, path, isDir } of normalized) {
    if (isDir) continue;
    const relative =
      root === ""
        ? path
        : path.startsWith(`${root}/`)
          ? path.slice(root.length + 1)
          : null;
    if (relative === null) {
      skipped.push({ path, reason: "outside the export folder" });
      continue;
    }
    const hidden = hiddenOrSystem(relative);
    if (hidden !== null) {
      skipped.push({ path: relative, reason: hidden });
      continue;
    }
    const kind = fileKindOf(relative);
    if (kind === null) {
      skipped.push({
        path: relative,
        reason: `extension ${extensionOf(relative) || "none"}`,
      });
      continue;
    }
    if (entry.uncompressedSize > limits.maxEntryBytes) {
      return {
        ok: false,
        code: "zip_bomb",
        detail: `${relative}: ${String(entry.uncompressedSize)} bytes > ${String(limits.maxEntryBytes)}`,
      };
    }
    if (
      entry.uncompressedSize >= limits.ratioCheckMinBytes &&
      entry.uncompressedSize / Math.max(1, entry.compressedSize) >
        limits.maxCompressionRatio
    ) {
      return {
        ok: false,
        code: "zip_bomb",
        detail: `${relative}: compression ratio ${String(
          Math.round(entry.uncompressedSize / Math.max(1, entry.compressedSize)),
        )}x`,
      };
    }
    total += entry.uncompressedSize;
    if (total > limits.maxUncompressedBytes) {
      return {
        ok: false,
        code: "zip_bomb",
        detail: `more than ${String(limits.maxUncompressedBytes)} bytes to inflate`,
      };
    }
    extract.push({
      zipPath: entry.path,
      path: relative,
      kind,
      uncompressedSize: entry.uncompressedSize,
    });
  }

  return { ok: true, root, extract, skipped, uncompressedBytes: total };
}

/* ------------------------------------------------------------------------ *
 * SVG
 * ------------------------------------------------------------------------ */

/**
 * ¿Un SVG se puede rasterizar y servir? `false` si trae algo ejecutable o que
 * sale a la red: `<script>`, manejadores `on*=`, `javascript:`,
 * `<foreignObject>` (HTML embebido), `<!ENTITY` (XXE / billion laughs) o una
 * referencia externa (`href` a `http(s):` o `//`). No se «limpia»: un motivo
 * de marca no necesita nada de eso, así que el que lo trae se saltea entero.
 */
export function svgIsSafe(svg: string): {
  readonly ok: boolean;
  readonly reason?: string;
} {
  const checks: readonly [RegExp, string][] = [
    [/<\s*script/iu, "script element"],
    [/\son[a-z]+\s*=/iu, "event handler attribute"],
    [/javascript\s*:/iu, "javascript: URL"],
    [/<\s*foreignObject/iu, "foreignObject"],
    [/<!\s*ENTITY/iu, "XML entity declaration"],
    [
      /(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/|data:text\/html)/iu,
      "external reference",
    ],
    [/url\(\s*["']?\s*(?:https?:|\/\/)/iu, "external url()"],
  ];
  for (const [re, reason] of checks) {
    if (re.test(svg)) return { ok: false, reason };
  }
  if (!/<\s*svg[\s>]/iu.test(svg)) return { ok: false, reason: "not an svg document" };
  return { ok: true };
}
