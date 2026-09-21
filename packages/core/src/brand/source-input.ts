/**
 * Detección y normalización de una Brand Source — PRD `FR-011.1`, `FR-011.9`.
 *
 * El campo del alta es **uno solo**: web, enlace de perfil social o `@handle`.
 * Todo lo que sigue sale de ahí, así que este archivo es el que decide si un
 * usuario puede darse de alta o se queda mirando un error.
 *
 * Tres cosas que el PRD pide y que no son obvias:
 *
 * 1. **`@handle` a secas es ambiguo**, no inválido. Hay que preguntar en qué
 *    plataforma, **preseleccionando la que el usuario ya tenga conectada**.
 *    Tratarlo como error (`ERR-B02`) expulsa a quien escribe su handle, que es
 *    lo más natural que puede escribir alguien que vive en social.
 *
 * 2. **Un enlace a un post se resuelve al perfil de su autor**, y hay que
 *    avisarlo (`ERR-B12`). En TikTok y X el handle está en la URL y se
 *    resuelve acá; en Instagram y YouTube **no está**, y hace falta una
 *    consulta. Por eso hay un resultado `needs_lookup`: fingir que se puede
 *    resolver en local sería devolver un handle inventado.
 *
 * 3. **Las reglas SSRF de la rama web aplican a TODOS los orígenes**
 *    (`FR-011.9`). Es la parte que se olvida cuando se añade una plataforma
 *    nueva: el extractor de `other_url` sigue el link-in-bio, y un link-in-bio
 *    apuntando a `http://169.254.169.254/` es la petición al metadata del
 *    proveedor de nube. Los mensajes son los literales de `FR-010`.
 */
import type { BrandSourceType } from "@fastgram/ports";
import { DomainError } from "../errors.js";

/** `DATA-031` añade `manual` a los siete tipos del puerto. */
export type CoreBrandSourceType = BrandSourceType | "manual";

/** Las cinco de `D-02`. Son las que pueden salir del desambiguador. */
export const SOCIAL_SOURCE_TYPES = [
  "instagram",
  "tiktok",
  "x",
  "youtube",
  "linkedin",
] as const;
export type SocialSourceType = (typeof SOCIAL_SOURCE_TYPES)[number];

/**
 * Parámetros de tracking que se descartan — `FR-011.1`, literal.
 *
 * Importa para la unicidad: sin descartarlos, la misma cuenta pegada desde
 * dos sitios distintos produce dos `canonicalUrl` distintas y el chequeo de
 * `(sourceType, handle)` deja de proteger nada.
 */
export const TRACKING_PARAMS = ["igshid", "si", "fbclid"] as const;

export interface DetectOptions {
  /**
   * Plataforma fijada por el usuario: los chips de `FR-011.2` «prefijan el
   * input y **fijan** el `sourceType`», y el campo legacy `Company Website`
   * de `FR-010` es de web por definición.
   */
  readonly hint?: CoreBrandSourceType | undefined;
  /** Plataformas con OAuth ya conectado, para preseleccionar en el desambiguador. */
  readonly connectedPlatforms?: readonly SocialSourceType[] | undefined;
}

export interface ResolvedInput {
  readonly kind: "resolved";
  readonly sourceType: CoreBrandSourceType;
  /** Sin `@` ni dominio (`DATA-031`). */
  readonly handle: string;
  readonly canonicalUrl: string;
  /** `true` si la entrada era un post y se resolvió al perfil (`ERR-B12`). */
  readonly resolvedFromPost: boolean;
}

export interface AmbiguousInput {
  readonly kind: "ambiguous";
  readonly handle: string;
  readonly candidates: readonly SocialSourceType[];
  /** La que el usuario ya tiene conectada, si la hay (`FR-011.12`, criterio 3). */
  readonly preselected: SocialSourceType | null;
}

export interface NeedsLookupInput {
  readonly kind: "needs_lookup";
  readonly sourceType: SocialSourceType;
  /** Lo que hay que resolver contra la plataforma para llegar al autor. */
  readonly postRef: string;
  readonly canonicalUrl: string;
}

export interface UnrecognizedInput {
  readonly kind: "unrecognized";
}

export type BrandSourceDetection =
  | ResolvedInput
  | AmbiguousInput
  | NeedsLookupInput
  | UnrecognizedInput;

// ───────────────────────────────────────────────────────────────────────────
// SSRF — FR-010 (copy literal) y FR-011.9
// ───────────────────────────────────────────────────────────────────────────

const LOOPBACK_NAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain"];

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n > 255)) return false;
  const [a, b] = nums as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 169.254/16: el metadata de AWS, GCP y Azure vive en 169.254.169.254.
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1" || h === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // ULA fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // link-local fe80::/10
  return false;
}

/**
 * Protección SSRF. Mensajes literales de `FR-010`, aplicados a **todos** los
 * orígenes por mandato de `FR-011.9`.
 */
export function assertHostAllowed(hostname: string): void {
  const host = hostname.toLowerCase();

  if (LOOPBACK_NAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new DomainError("out_of_range", "Localhost URLs are not allowed", { host });
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    throw new DomainError("out_of_range", "Private IP addresses are not allowed", {
      host,
    });
  }
  // Un host que es un número entero sin puntos es una IP en forma decimal
  // (`http://2130706433/` es 127.0.0.1). Es la vuelta clásica al filtro de
  // dotted-quad, y no hay ninguna web legítima con esa forma.
  if (/^\d+$/.test(host)) {
    throw new DomainError("out_of_range", "Blocked URL for security reasons", {
      host,
    });
  }
  if (host.length === 0 || !host.includes(".")) {
    throw new DomainError("out_of_range", "Blocked URL for security reasons", {
      host,
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Normalización
// ───────────────────────────────────────────────────────────────────────────

function stripTracking(url: URL): URL {
  const out = new URL(url.toString());
  for (const key of [...out.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_")) out.searchParams.delete(key);
  }
  for (const key of TRACKING_PARAMS) out.searchParams.delete(key);
  return out;
}

function parseUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // `FR-011.1`: «Se aceptan URLs con o sin esquema». Sin esto, `miproducto.com`
  // —lo que cualquiera escribe— no parsea.
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return stripTracking(url);
  } catch {
    return null;
  }
}

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

function segments(url: URL): string[] {
  return url.pathname.split("/").filter((s) => s.length > 0);
}

/** `@handle` → `handle`, en minúsculas. Ver la nota de YouTube más abajo. */
function normalizeHandle(raw: string): string {
  return raw.replace(/^@/, "").toLowerCase();
}

const HANDLE_ONLY = /^@[A-Za-z0-9._-]{1,64}$/;

// ───────────────────────────────────────────────────────────────────────────
// Detección
// ───────────────────────────────────────────────────────────────────────────

/**
 * Deduce el origen de lo que el usuario pegó.
 *
 * **Ambigüedad del PRD, resuelta acá.** `FR-011.1` dice a la vez que `website`
 * es «URL http(s)» con el ejemplo `miproducto.com`, y que «si el host no se
 * reconoce, el `sourceType` es `other_url`». Las dos reglas cubren el mismo
 * caso y se contradicen. Resolución: **sin pista, un host desconocido es
 * `other_url`** —que es la frase normativa explícita—, y con `hint:
 * "website"` es `website`. El chip `Website` de `FR-011.2` y el campo legacy
 * `Company Website` de `FR-010` pasan esa pista, así que el camino de web de
 * Fastlane se conserva idéntico, que es lo que `EXT-001` promete. La
 * diferencia no es cosmética: la precedencia de fusión de `FR-011.6` pone
 * `website` primero y `other_url` penúltimo.
 */
export function detectBrandSource(
  input: string,
  options: DetectOptions = {},
): BrandSourceDetection {
  const raw = input.trim();
  if (raw.length === 0) return { kind: "unrecognized" };

  if (options.hint === "manual") {
    return {
      kind: "resolved",
      sourceType: "manual",
      handle: "",
      canonicalUrl: "",
      resolvedFromPost: false,
    };
  }

  // `@handle` sin dominio: ambiguo, no inválido (`ERR-B03`).
  if (HANDLE_ONLY.test(raw)) {
    const handle = normalizeHandle(raw);
    if (options.hint !== undefined && isSocial(options.hint)) {
      return {
        kind: "resolved",
        sourceType: options.hint,
        handle,
        canonicalUrl: canonicalSocialUrl(options.hint, handle),
        resolvedFromPost: false,
      };
    }
    const connected = options.connectedPlatforms ?? [];
    return {
      kind: "ambiguous",
      handle,
      candidates: SOCIAL_SOURCE_TYPES,
      preselected: SOCIAL_SOURCE_TYPES.find((p) => connected.includes(p)) ?? null,
    };
  }

  const url = parseUrl(raw);
  if (url === null) return { kind: "unrecognized" };

  assertHostAllowed(url.hostname);

  const host = hostOf(url);
  const path = segments(url);

  const detected =
    detectInstagram(host, path, url) ??
    detectTikTok(host, path) ??
    detectX(host, path) ??
    detectYouTube(host, path, url) ??
    detectLinkedIn(host, path);

  if (detected !== null) return detected;

  // Host no social. Ver la nota de ambigüedad de arriba.
  const sourceType: CoreBrandSourceType =
    options.hint === "website" ? "website" : "other_url";
  return {
    kind: "resolved",
    sourceType,
    handle: host,
    canonicalUrl: `${url.protocol}//${host}${url.pathname.replace(/\/$/, "")}${url.search}`,
    resolvedFromPost: false,
  };
}

function isSocial(t: CoreBrandSourceType): t is SocialSourceType {
  return (SOCIAL_SOURCE_TYPES as readonly string[]).includes(t);
}

/**
 * Forma canónica por plataforma.
 *
 * **El PRD no la especifica**, así que se fija acá y se documenta: el canonical
 * no participa de la unicidad —ésa es `(sourceType, handle)` por `DATA-031`—,
 * así que sólo tiene que ser estable y presentable.
 */
export function canonicalSocialUrl(
  sourceType: SocialSourceType,
  handle: string,
): string {
  switch (sourceType) {
    case "instagram":
      return `https://instagram.com/${handle}`;
    case "tiktok":
      return `https://tiktok.com/@${handle}`;
    case "x":
      return `https://x.com/${handle}`;
    case "youtube":
      return handle.startsWith("channel/") || handle.startsWith("c/")
        ? `https://youtube.com/${handle}`
        : `https://youtube.com/@${handle}`;
    case "linkedin":
      return `https://linkedin.com/${handle}`;
  }
}

const IG_POST_SEGMENTS = new Set(["p", "reel", "reels", "tv"]);
const IG_RESERVED = new Set([
  "explore",
  "accounts",
  "direct",
  "stories",
  "about",
  "legal",
]);

function detectInstagram(
  host: string,
  path: string[],
  url: URL,
): BrandSourceDetection | null {
  if (host !== "instagram.com" && !host.endsWith(".instagram.com")) return null;
  const first = path[0];
  if (first === undefined) return { kind: "unrecognized" };

  if (IG_POST_SEGMENTS.has(first)) {
    // `instagram.com/p/<code>` **no** contiene el handle del autor. Hay que
    // preguntárselo a la plataforma; inventarlo sería peor que no resolver.
    return {
      kind: "needs_lookup",
      sourceType: "instagram",
      postRef: path[1] ?? "",
      canonicalUrl: `https://instagram.com${url.pathname.replace(/\/$/, "")}`,
    };
  }
  if (IG_RESERVED.has(first)) return { kind: "unrecognized" };

  const handle = normalizeHandle(first);
  return {
    kind: "resolved",
    sourceType: "instagram",
    handle,
    canonicalUrl: canonicalSocialUrl("instagram", handle),
    // `/<handle>/reel/<id>` es un post con el autor en la URL.
    resolvedFromPost: path.length > 1,
  };
}

function detectTikTok(host: string, path: string[]): BrandSourceDetection | null {
  if (host !== "tiktok.com" && !host.endsWith(".tiktok.com")) return null;
  const first = path[0];
  if (first === undefined || !first.startsWith("@")) return { kind: "unrecognized" };
  const handle = normalizeHandle(first);
  return {
    kind: "resolved",
    sourceType: "tiktok",
    handle,
    canonicalUrl: canonicalSocialUrl("tiktok", handle),
    // `tiktok.com/@marca/video/123`: el handle SÍ está en la URL.
    resolvedFromPost: path.length > 1,
  };
}

const X_RESERVED = new Set(["i", "home", "explore", "search", "settings", "intent"]);

function detectX(host: string, path: string[]): BrandSourceDetection | null {
  // `FR-011.1`: «`x.com` y `twitter.com` se normalizan **ambos** a `x`».
  const isX =
    host === "x.com" ||
    host === "twitter.com" ||
    host.endsWith(".x.com") ||
    host.endsWith(".twitter.com");
  if (!isX) return null;

  const first = path[0];
  if (first === undefined || X_RESERVED.has(first)) return { kind: "unrecognized" };
  const handle = normalizeHandle(first);
  return {
    kind: "resolved",
    sourceType: "x",
    handle,
    canonicalUrl: canonicalSocialUrl("x", handle),
    resolvedFromPost: path[1] === "status",
  };
}

function detectYouTube(
  host: string,
  path: string[],
  url: URL,
): BrandSourceDetection | null {
  const isYt =
    host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
  if (!isYt) return null;

  if (host === "youtu.be" || path[0] === "watch" || path[0] === "shorts") {
    return {
      kind: "needs_lookup",
      sourceType: "youtube",
      postRef: url.searchParams.get("v") ?? path[1] ?? path[0] ?? "",
      canonicalUrl: url.toString(),
    };
  }

  const first = path[0];
  if (first === undefined) return { kind: "unrecognized" };

  if (first.startsWith("@")) {
    const handle = normalizeHandle(first);
    return {
      kind: "resolved",
      sourceType: "youtube",
      handle,
      canonicalUrl: canonicalSocialUrl("youtube", handle),
      resolvedFromPost: false,
    };
  }
  if ((first === "channel" || first === "c" || first === "user") && path[1]) {
    // Los ids de canal (`UCxxxx`) **son sensibles a mayúsculas**: pasarlos a
    // minúsculas produce un id que no existe. Sólo se normaliza el `@handle`.
    const handle = first === "channel" ? `channel/${path[1]}` : `c/${path[1].toLowerCase()}`;
    return {
      kind: "resolved",
      sourceType: "youtube",
      handle,
      canonicalUrl: canonicalSocialUrl("youtube", handle),
      resolvedFromPost: false,
    };
  }
  return { kind: "unrecognized" };
}

function detectLinkedIn(host: string, path: string[]): BrandSourceDetection | null {
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  const first = path[0];
  const second = path[1];

  if ((first === "company" || first === "school" || first === "in") && second) {
    // El handle conserva el prefijo: una página de empresa y una persona
    // pueden compartir slug, y la unicidad es `(sourceType, handle)`.
    const handle = `${first}/${second.toLowerCase()}`;
    return {
      kind: "resolved",
      sourceType: "linkedin",
      handle,
      canonicalUrl: canonicalSocialUrl("linkedin", handle),
      resolvedFromPost: path.length > 2,
    };
  }
  if (first === "posts" || first === "feed" || first === "pulse") {
    return {
      kind: "needs_lookup",
      sourceType: "linkedin",
      postRef: second ?? "",
      canonicalUrl: `https://linkedin.com/${path.join("/")}`,
    };
  }
  return { kind: "unrecognized" };
}
