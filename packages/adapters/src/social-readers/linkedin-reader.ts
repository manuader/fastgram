/**
 * LinkedIn **sin login** — sprint 7 (agente G), `P1-BRAND-011`, PRD
 * `FR-011.3`, `D-02`, `D-13`.
 *
 * Tier **C** (página pública): un `GET` de
 * `https://www.linkedin.com/company/<slug>/` sin cookies, y de ahí lo que la
 * página pública expone para buscadores y previews:
 *
 * - las etiquetas Open Graph (`og:title`, `og:description`, `og:image`), y
 * - el JSON-LD `Organization` si viene (`name`, `description`, `url`,
 *   `address`, `numberOfEmployees`, `sameAs`).
 *
 * **Lo que no hay**: LinkedIn no tiene API pública para leer páginas de
 * empresa sin OAuth de la propia página (Community Management API, con
 * revisión), y los posts **no** están en la página pública sin sesión. Así que
 * este extractor trae **perfil y nada de posts**: `readRecentContent` devuelve
 * `insufficient_content` y el análisis queda `partial` con el perfil.
 *
 * **LinkedIn suele cerrar la puerta**: a un cliente que no es navegador le
 * contesta `999`, o lo redirige al *authwall* (`/authwall`, `/login`,
 * `/signup`). Eso es «hace falta sesión» y `D-13` prohíbe usar una: se
 * devuelve `private`, que el worker degrada a **tier D** (pegar el «About» a
 * mano) con el aviso de la pantalla de fuentes. No se reintenta con otro
 * User-Agent ni se «disfraza» de navegador: sería evadir un bloqueo.
 *
 * Personas (`/in/…`) no se leen: el PRD habla de la marca (`FR-011.1`:
 * `linkedin.com/company/mimarca`), y el perfil de una persona no es la voz de
 * la marca. Una escuela (`/school/…`) se lee igual que una empresa.
 */
import {
  PortError,
  type ReadContentRequest,
  type ReadProfileRequest,
  type ResolvedSocialSource,
  type ResolveSourceRequest,
  type SocialContentItem,
  type SocialProfileSignals,
  type SocialReadCapabilities,
  type SocialReader,
  type SocialReadOutcome,
} from "@fastgram/ports";

import {
  count,
  isRecord,
  opt,
  retryAfterSeconds,
  text,
  type SocialFetch,
} from "./http.js";

const SOURCE = "SocialReader/linkedin";
const TIER = "C_page_fetch" as const;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;
/** Una página de empresa pesa ~300 KB; esto es para no leer algo absurdo. */
const MAX_HTML_BYTES = 3 * 1024 * 1024;

export interface LinkedInPageRef {
  readonly kind: "company" | "school";
  readonly slug: string;
}

/**
 * `https://linkedin.com/company/acme`, `company/acme` (lo que guarda la fila)
 * o el slug pelado → la página. `null` si no es una página de empresa o
 * escuela.
 */
export function linkedinPageFrom(input: string): LinkedInPageRef | null {
  let raw = input.trim();
  if (raw === "") return null;
  if (/^https?:\/\//i.test(raw) || /^([a-z]{2,3}\.|www\.)?linkedin\.com\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
    raw = url.pathname;
  }
  const parts = raw.split("/").filter((p) => p !== "");
  const [first, second] = parts;
  if (first === undefined) return null;
  if (first === "company" || first === "school") {
    const slug = second?.toLowerCase();
    return slug !== undefined && SLUG.test(slug) ? { kind: first, slug } : null;
  }
  if (parts.length === 1 && first !== "in") {
    const slug = first.toLowerCase();
    return SLUG.test(slug) ? { kind: "company", slug } : null;
  }
  return null;
}

export function linkedinPageUrl(ref: LinkedInPageRef): string {
  return `https://www.linkedin.com/${ref.kind}/${ref.slug}/`;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
};

function decode(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (ENTITIES[k] !== undefined) return ENTITIES[k];
      if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10));
      return m;
    })
    .trim();
}

function meta(html: string, property: string): string | undefined {
  const esc = property.replace(/[.:]/g, (c) => `\\${c}`);
  const a = new RegExp(
    `<meta[^>]+(?:property|name)=["']${esc}["'][^>]*content=["']([^"']*)["']`,
    "i",
  ).exec(html);
  const b = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${esc}["']`,
    "i",
  ).exec(html);
  const v = a?.[1] ?? b?.[1];
  return v === undefined ? undefined : text(decode(v));
}

function organizationFrom(html: string): Record<string, unknown> | null {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    let json: unknown;
    try {
      json = JSON.parse(m[1] ?? "");
    } catch {
      continue;
    }
    const nodes: unknown[] = Array.isArray(json)
      ? json
      : isRecord(json) && Array.isArray(json["@graph"])
        ? json["@graph"]
        : [json];
    for (const n of nodes) {
      if (!isRecord(n)) continue;
      const type = n["@type"];
      const types = Array.isArray(type) ? type : [type];
      if (
        types.some(
          (t) =>
            t === "Organization" ||
            t === "Corporation" ||
            t === "EducationalOrganization",
        )
      ) {
        return n;
      }
    }
  }
  return null;
}

/** El HTML público de la página → las señales. Exportada para los tests. */
export function parseLinkedInCompanyPage(html: string): SocialProfileSignals | null {
  const org = organizationFrom(html);
  const ogTitle = meta(html, "og:title");
  // `og:title` viene como «Acme | LinkedIn»: la marca es lo de antes.
  const name =
    (org === null ? undefined : text(org["name"])) ??
    ogTitle?.replace(/\s*\|\s*LinkedIn\s*$/i, "");
  if (name === undefined) return null;
  const about =
    (org === null ? undefined : text(org["description"])) ??
    meta(html, "og:description") ??
    meta(html, "description");
  const address = org !== null && isRecord(org["address"]) ? org["address"] : null;
  const hq =
    address === null
      ? undefined
      : [address["addressLocality"], address["addressRegion"]]
          .map((x) => text(x))
          .filter((x): x is string => x !== undefined)
          .join(", ") || undefined;
  const employees =
    org !== null && isRecord(org["numberOfEmployees"])
      ? count(org["numberOfEmployees"]["value"])
      : undefined;
  const sameAs =
    org !== null && Array.isArray(org["sameAs"])
      ? org["sameAs"].map((x) => text(x)).filter((x): x is string => x !== undefined)
      : [];
  const website = org === null ? undefined : text(org["url"]);
  const links = [
    ...new Set([website, ...sameAs].filter((x): x is string => x !== undefined)),
  ]
    .filter((u) => !/linkedin\.com/i.test(u))
    .slice(0, 5);
  const logo =
    org !== null && isRecord(org["logo"])
      ? (text(org["logo"]["contentUrl"]) ?? text(org["logo"]["url"]))
      : org === null
        ? undefined
        : text(org["logo"]);
  return {
    displayName: decode(name),
    ...opt("about", about),
    ...opt("headquarters", hq),
    ...opt("companySize", employees === undefined ? undefined : String(employees)),
    ...(links.length === 0 ? {} : { links }),
    ...opt("avatarUrl", logo ?? meta(html, "og:image")),
  };
}

export interface LinkedInReaderConfig {
  readonly fetch?: SocialFetch;
  readonly timeoutMs?: number;
  /** Se identifica quién pregunta. No se disfraza de navegador. */
  readonly userAgent?: string;
  readonly memoTtlMs?: number;
  readonly now?: () => number;
}

type PageOutcome =
  | { readonly status: "ok"; readonly profile: SocialProfileSignals }
  | { readonly status: "not_found" | "private" | "insufficient_content" };

export class LinkedInCompanyReader implements SocialReader {
  readonly source = "linkedin" as const;
  readonly #config: LinkedInReaderConfig;
  readonly #fetch: SocialFetch;
  readonly #memo = new Map<string, { at: number; promise: Promise<PageOutcome> }>();

  constructor(config: LinkedInReaderConfig = {}) {
    this.#config = config;
    this.#fetch =
      config.fetch ?? ((url, init) => fetch(url, { ...init, redirect: "manual" }));
  }

  capabilities(): SocialReadCapabilities {
    return {
      source: "linkedin",
      tiers: [TIER],
      profileSignals: [
        "displayName",
        "about",
        "headquarters",
        "companySize",
        "links",
        "avatarUrl",
      ],
      contentSignals: [],
      maxContentItems: 0,
      requiresConnection: false,
      renderedFetchEnabled: true,
    };
  }

  #ref(input: string): LinkedInPageRef {
    const ref = linkedinPageFrom(input);
    if (ref === null) {
      throw new PortError("bad_request", "Not a LinkedIn company page.", {
        source: SOURCE,
      });
    }
    return ref;
  }

  #page(ref: LinkedInPageRef): Promise<PageOutcome> {
    const key = `${ref.kind}/${ref.slug}`;
    const now = (this.#config.now ?? Date.now)();
    const hit = this.#memo.get(key);
    if (hit !== undefined && now - hit.at < (this.#config.memoTtlMs ?? 60_000)) {
      return hit.promise;
    }
    const promise = this.#read(ref);
    this.#memo.set(key, { at: now, promise });
    promise.catch(() => {
      if (this.#memo.get(key)?.promise === promise) this.#memo.delete(key);
    });
    return promise;
  }

  async #read(ref: LinkedInPageRef): Promise<PageOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#config.timeoutMs ?? 15_000);
    let res: Response;
    let html: string;
    try {
      res = await this.#fetch(linkedinPageUrl(ref), {
        method: "GET",
        headers: {
          accept: "text/html",
          "accept-language": "en",
          "user-agent": this.#config.userAgent ?? "FastGram/0 (personal brand analysis)",
        },
        signal: controller.signal,
      });
      const body = new Uint8Array(await res.arrayBuffer());
      html = new TextDecoder().decode(body.slice(0, MAX_HTML_BYTES));
    } catch (error) {
      throw new PortError(
        controller.signal.aborted ? "timeout" : "provider_unavailable",
        controller.signal.aborted
          ? "LinkedIn did not answer in time."
          : "LinkedIn is unreachable.",
        { source: SOURCE, cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    // 999 = el «request denied» de LinkedIn a clientes que no son navegador.
    // Una redirección al authwall/login es lo mismo: hace falta sesión.
    const location = res.headers.get("location") ?? "";
    if (
      res.status === 999 ||
      (res.status >= 300 &&
        res.status < 400 &&
        /authwall|\/login|\/signup|\/uas\//i.test(location))
    ) {
      return { status: "private" };
    }
    if (res.status === 404 || res.status === 410) return { status: "not_found" };
    if (res.status >= 300 && res.status < 400) return { status: "not_found" };
    if (res.status === 429) {
      throw new PortError("rate_limited", "LinkedIn is limiting reads right now.", {
        source: SOURCE,
        ...opt("retryAfterSeconds", retryAfterSeconds(res.headers)),
      });
    }
    if (res.status >= 500) {
      throw new PortError(
        "provider_unavailable",
        "LinkedIn isn't responding right now.",
        {
          source: SOURCE,
          cause: { status: res.status },
        },
      );
    }
    if (res.status !== 200) return { status: "private" };
    // Un 200 con el formulario de login en vez de la página también es el muro.
    if (
      /authwall|join linkedin|sign in to linkedin/i.test(html) &&
      !/og:title/i.test(html)
    ) {
      return { status: "private" };
    }
    const profile = parseLinkedInCompanyPage(html);
    if (profile === null) return { status: "insufficient_content" };
    return { status: "ok", profile };
  }

  async resolve(
    request: ResolveSourceRequest,
  ): Promise<SocialReadOutcome<ResolvedSocialSource>> {
    const ref = this.#ref(request.input);
    const page = await this.#page(ref);
    if (page.status !== "ok") return { status: page.status, attemptedTiers: [TIER] };
    return {
      status: "ok",
      tier: TIER,
      data: {
        sourceType: "linkedin",
        handle: `${ref.kind}/${ref.slug}`,
        canonicalUrl: linkedinPageUrl(ref),
        available: true,
        ...opt("displayName", page.profile.displayName),
        ...opt("avatarUrl", page.profile.avatarUrl),
      },
    };
  }

  async readProfile(
    request: ReadProfileRequest,
  ): Promise<SocialReadOutcome<SocialProfileSignals>> {
    const page = await this.#page(this.#ref(request.handle));
    if (page.status !== "ok") return { status: page.status, attemptedTiers: [TIER] };
    return { status: "ok", tier: TIER, data: page.profile };
  }

  /** Sin sesión no hay posts en la página pública: ver la cabecera. */
  async readRecentContent(
    request: ReadContentRequest,
  ): Promise<SocialReadOutcome<readonly SocialContentItem[]>> {
    const page = await this.#page(this.#ref(request.handle));
    if (page.status !== "ok") return { status: page.status, attemptedTiers: [TIER] };
    return { status: "insufficient_content", attemptedTiers: [TIER] };
  }
}
