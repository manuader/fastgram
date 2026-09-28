/**
 * Lo que vuelve de la base (`jsonb`) validado — `brand_design_systems`.
 *
 * `packages/db` no conoce los tipos de `core` (no depende de él), así que las
 * columnas `tokens`, `style`, `fonts` y `pending_assets` vuelven como
 * `unknown`. Acá se validan a mano (regla `core-no-npm`: sin Zod) y se
 * **descarta** lo que no tiene forma, en vez de lanzar: una fila vieja o
 * editada a mano no puede tirar el refill de Blitz.
 */
import type {
  DesignSystemStyle,
  DesignSystemTokens,
  DsColor,
  DsFontFace,
  DsFontFamily,
  DsLogoLayer,
  DsSpacing,
  DsTypeRole,
} from "./types.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const HEX = /^#[0-9A-F]{6}$/u;
const hex = (v: unknown): string | null =>
  typeof v === "string" && HEX.test(v.toUpperCase()) ? v.toUpperCase() : null;
const strList = (v: unknown, max = 50): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string").slice(0, max)
    : [];

function readColor(v: unknown): DsColor | null {
  if (!isObj(v)) return null;
  const name = str(v["name"]);
  const h = hex(v["hex"]);
  if (name === null || h === null) return null;
  return { name, hex: h, aliasOf: str(v["aliasOf"]) };
}

function readFace(v: unknown): DsFontFace | null {
  if (!isObj(v)) return null;
  const weight = v["weight"];
  const file = str(v["file"]);
  if (typeof weight !== "number" || file === null) return null;
  return { weight, style: v["style"] === "italic" ? "italic" : "normal", file };
}

const CATEGORIES = ["serif", "sans", "display", "mono", "script"] as const;
const LICENSES = ["open", "needs_confirmation", "system"] as const;
const ORIGINS = ["file", "google", "stack"] as const;

function oneOf<T extends string>(v: unknown, xs: readonly T[], fallback: T): T {
  return typeof v === "string" && (xs as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}

function readFamily(v: unknown): DsFontFamily | null {
  if (!isObj(v)) return null;
  const name = str(v["name"]);
  const id = str(v["id"]);
  if (name === null || id === null) return null;
  return {
    name,
    id,
    origin: oneOf(v["origin"], ORIGINS, "stack"),
    category: oneOf(v["category"], CATEGORIES, "sans"),
    license: oneOf(v["license"], LICENSES, "system"),
    licenseConfirmed: v["licenseConfirmed"] === true,
    faces: Array.isArray(v["faces"])
      ? v["faces"].map(readFace).filter((f): f is DsFontFace => f !== null)
      : [],
    weights: Array.isArray(v["weights"])
      ? v["weights"].filter((w): w is number => typeof w === "number")
      : [],
    fallback: str(v["fallback"]) ?? "inter",
  };
}

function readRole(v: unknown): DsTypeRole | null {
  if (!isObj(v)) return null;
  const role = str(v["role"]);
  if (role === null) return null;
  return { role, stack: strList(v["stack"], 12), familyId: str(v["familyId"]) };
}

function readSpacing(v: unknown): DsSpacing | null {
  if (!isObj(v)) return null;
  const name = str(v["name"]);
  const px = v["px"];
  return name === null || typeof px !== "number" ? null : { name, px };
}

const nonNull = <T>(x: T | null): x is T => x !== null;

/** `tokens` de la base. `null` si no es un objeto. */
export function readDesignSystemTokens(raw: unknown): DesignSystemTokens | null {
  if (!isObj(raw)) return null;
  const sem = isObj(raw["semantic"]) ? raw["semantic"] : {};
  return {
    colors: Array.isArray(raw["colors"])
      ? raw["colors"].map(readColor).filter(nonNull)
      : [],
    semantic: {
      surfaceDark: hex(sem["surfaceDark"]),
      surfaceLight: hex(sem["surfaceLight"]),
      textOnDark: hex(sem["textOnDark"]),
      textOnLight: hex(sem["textOnLight"]),
      accents: strList(sem["accents"], 6)
        .map((a) => hex(a))
        .filter(nonNull),
    },
    families: Array.isArray(raw["families"])
      ? raw["families"].map(readFamily).filter(nonNull)
      : [],
    roles: Array.isArray(raw["roles"]) ? raw["roles"].map(readRole).filter(nonNull) : [],
    spacing: Array.isArray(raw["spacing"])
      ? raw["spacing"].map(readSpacing).filter(nonNull)
      : [],
    // Sprint 9 (S): se conserva al releer, así una edición de la paleta (que
    // relee y reescribe `tokens`) no apaga el logo.
    ...optionalLogoLayer(raw["logoLayer"]),
  };
}

const LOGO_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
const LOGO_SIZES = ["small", "medium", "large"] as const;

/** `tokens.logoLayer`. `null` si no está o no tiene forma. */
export function readLogoLayer(raw: unknown): DsLogoLayer | null {
  if (!isObj(raw)) return null;
  const opacity = raw["opacity"];
  if (
    typeof raw["enabled"] !== "boolean" ||
    typeof opacity !== "number" ||
    !Number.isFinite(opacity)
  ) {
    return null;
  }
  return {
    enabled: raw["enabled"],
    corner: oneOf(raw["corner"], LOGO_CORNERS, "top-right"),
    size: oneOf(raw["size"], LOGO_SIZES, "small"),
    opacity: Math.min(1, Math.max(0.1, opacity)),
  };
}

function optionalLogoLayer(raw: unknown): { logoLayer?: DsLogoLayer } {
  const layer = readLogoLayer(raw);
  return layer === null ? {} : { logoLayer: layer };
}

/** `style` de la base. `null` si no hay o no es un objeto. */
export function readDesignSystemStyle(raw: unknown): DesignSystemStyle | null {
  if (!isObj(raw)) return null;
  return {
    voice: str(raw["voice"]) ?? "",
    values: strList(raw["values"], 8),
    tagline: str(raw["tagline"]),
    compositionRules: strList(raw["compositionRules"], 10),
    dos: strList(raw["dos"], 8),
    donts: strList(raw["donts"], 8),
    language: str(raw["language"]),
    origin: oneOf(raw["origin"], ["model", "heuristic", "owner"] as const, "owner"),
  };
}

/** Un generado pendiente de aprobación (`pending_assets`). */
export interface PendingDesignAsset {
  readonly id: string;
  readonly requestId: string;
  readonly storageKey: string;
  readonly url: string;
  readonly generator: "local" | "model";
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: number;
}

export function readPendingAssets(raw: unknown): PendingDesignAsset[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingDesignAsset[] = [];
  for (const v of raw) {
    if (!isObj(v)) continue;
    const id = str(v["id"]);
    const requestId = str(v["requestId"]);
    const storageKey = str(v["storageKey"]);
    const url = str(v["url"]);
    const contentType = str(v["contentType"]);
    const sizeBytes = v["sizeBytes"];
    const createdAt = v["createdAt"];
    if (
      id === null ||
      requestId === null ||
      storageKey === null ||
      url === null ||
      contentType === null ||
      typeof sizeBytes !== "number" ||
      typeof createdAt !== "number"
    ) {
      continue;
    }
    out.push({
      id,
      requestId,
      storageKey,
      url,
      generator: v["generator"] === "model" ? "model" : "local",
      contentType,
      sizeBytes,
      createdAt,
    });
  }
  return out;
}

/** Un asset importado (`brand_design_systems.assets`). El archivo vive en `media`. */
export interface StoredDesignAsset {
  readonly mediaId: string;
  readonly kind: "logo" | "imagery" | "motif" | "generated";
  readonly path: string;
  readonly filename: string;
}

const ASSET_KINDS = ["logo", "imagery", "motif", "generated"] as const;

export function readStoredAssets(raw: unknown): StoredDesignAsset[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredDesignAsset[] = [];
  for (const v of raw) {
    if (!isObj(v)) continue;
    const mediaId = str(v["mediaId"]);
    if (mediaId === null) continue;
    out.push({
      mediaId,
      kind: oneOf(v["kind"], ASSET_KINDS, "imagery"),
      path: str(v["path"]) ?? "",
      filename: str(v["filename"]) ?? "",
    });
  }
  return out;
}

/** Un archivo de fuente subido (`brand_design_systems.fonts`). */
export interface StoredDesignFontFile {
  readonly fileRef: string;
  readonly familyId: string;
  readonly weight: number;
  readonly style: "normal" | "italic";
  readonly storageKey: string;
  readonly url: string;
  readonly contentType: string;
  readonly bytes: number;
}

export function readStoredFontFiles(raw: unknown): StoredDesignFontFile[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredDesignFontFile[] = [];
  for (const v of raw) {
    if (!isObj(v)) continue;
    const fileRef = str(v["fileRef"]);
    const familyId = str(v["familyId"]);
    const storageKey = str(v["storageKey"]);
    const url = str(v["url"]);
    const contentType = str(v["contentType"]);
    const weight = v["weight"];
    const bytes = v["bytes"];
    if (
      fileRef === null ||
      familyId === null ||
      storageKey === null ||
      url === null ||
      contentType === null ||
      typeof weight !== "number" ||
      typeof bytes !== "number"
    ) {
      continue;
    }
    out.push({
      fileRef,
      familyId,
      weight,
      style: v["style"] === "italic" ? "italic" : "normal",
      storageKey,
      url,
      contentType,
      bytes,
    });
  }
  return out;
}
