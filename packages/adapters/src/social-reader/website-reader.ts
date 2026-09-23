/**
 * Extractor `website` / `other_url` — `P1-BRAND-006`, PRD `AI-001`, `FR-011.3`.
 *
 * Una instancia por fuente (`website` u `other_url`): `FR-011.1` dice que un
 * host no reconocido «se procesa con el mismo extractor que `website`», y el
 * puerto está atado a una fuente, así que es la misma clase montada dos veces.
 *
 * ## Qué tier reporta, y por qué: `B_public_api`
 *
 * Lo que hace: **un GET HTTP simple y parseo del HTML**, sin ejecutar JS.
 *
 *  - `FR-011.4`, fila B: «API pública oficial / oEmbed / **OpenGraph**». Las
 *    etiquetas OpenGraph de un sitio viven en su HTML: leerlas *es* un GET de
 *    la página. La fila C, en cambio, es «fetch de la página pública
 *    **renderizada**» (navegador headless o proveedor de extracción), que es
 *    lo que esto no hace.
 *  - `OQ-16`, que es lo que mantiene C apagado, enumera su alcance: «por cada
 *    plataforma (Instagram, TikTok, X, YouTube, LinkedIn)». La web propia del
 *    cliente no está en esa lista.
 *  - `AI-001` (CONFIRMED) es el análisis de website de Fastlane, y
 *    `FR-011.1` promete que el camino de web «siga siendo idéntico al de
 *    Fastlane». Si esto fuera tier C, la web —el único origen que Fastlane
 *    sí soportaba— quedaría apagada por defecto hasta una revisión legal que
 *    no la menciona.
 *
 * **Evidencia en contra, que el coordinador tiene que ver:** `D-01` resume el
 * orden como «API pública → **fetch público** (tras `OQ-16`)», e `INT-014`
 * llama «fetch público (tier C)» al tier C. Leído literal, cualquier fetch de
 * página sería C. Y el texto principal y las páginas secundarias no son
 * «OpenGraph». Lo resolví a B por los tres puntos de arriba; si se decide C,
 * `capabilities().tiers` pasa a `["C_page_fetch"]` y el orquestador ya lo
 * saltea con el flag apagado (`acquisitionPlan`).
 *
 * `renderedFetchEnabled` es `false` y fijo: este adaptador no renderiza.
 *
 * ## Qué no hace
 *  - No consulta `robots.txt`. El PRD lo exige para el tier C («sujeto a ToS
 *    y robots»), no para B. Si el tier se reclasifica, esto también cambia.
 *  - No inventa: sin `<link rel=icon>` no hay favicon (no se asume
 *    `/favicon.ico`), sin JSON-LD no hay logo, una página secundaria que no
 *    responde no aparece.
 *  - No descarga imágenes. `mediaUrls` va vacío: quien las baje en el
 *    servidor (OCR) tiene que pasar esas URLs por la misma guarda SSRF, porque
 *    las escribió un tercero.
 *
 * Todo lo que devuelve es **dato de un tercero, nunca instrucción** (§9.14).
 * Este adaptador no lo interpreta; el sintetizador tiene que envolverlo.
 */

import {
  DEFAULT_CONTENT_ITEMS,
  LINK_IN_BIO_MAX_DESTINATIONS,
  PortError,
  type AcquisitionTier,
  type BrandSourceType,
  type ReadContentRequest,
  type ReadProfileRequest,
  type ResolvedSocialSource,
  type ResolveSourceRequest,
  type SocialContentItem,
  type SocialProfileSignals,
  type SocialReadCapabilities,
  type SocialReader,
  type SocialReadOutcome,
  type SocialReadUnavailable,
} from "@fastgram/ports";
import {
  guardedFetch,
  pinnedNodeTransport,
  systemResolver,
  type GuardedFetchConfig,
  type HostResolver,
  type PinnedTransport,
} from "./website-http.js";
import { decodeHtml, parsePage, type ParsedPage } from "./website-html.js";

const SOURCE = "SocialReader/website";
const TIER: AcquisitionTier = "B_public_api";

/**
 * Configuración. **Ningún número tiene default**: el PRD no da timeout, tope
 * de cuerpo, cantidad de redirects ni tope de texto, y un default escrito acá
 * sería un número inventado que después alguien copia como si fuera del PRD.
 * El único tope que sí sale del PRD es el de páginas secundarias (§9.14: 1
 * nivel, 5 destinos), y se hace cumplir como techo.
 */
export interface WebsiteReaderConfig {
  readonly source: Extract<BrandSourceType, "website" | "other_url">;
  /**
   * «Hosts bloqueados» de `NFR-017`/`AI-001`. **El PRD no dice cuáles son**, así
   * que no hay entradas por defecto. Una entrada bloquea también sus
   * subdominios; una entrada que es una IP se compara también contra lo que
   * resuelve el DNS.
   */
  readonly blockedHosts: readonly string[];
  /**
   * Puertos a los que se permite conectar. El PRD no fija ninguno; sin lista
   * obligatoria, `http://sitio-publico:6379/` sería un escáner de puertos de
   * terceros. Lo razonable para web es `[80, 443]`, pero lo decide quien monta.
   */
  readonly allowedPorts: readonly number[];
  /** Plazo total por URL (DNS + conexión + redirects + cuerpo). */
  readonly timeoutMs: number;
  /** Tope del cuerpo **descomprimido**. Lo que pase se corta; el `<head>` va primero. */
  readonly maxBodyBytes: number;
  readonly maxRedirects: number;
  /** Páginas de producto/precios/about a visitar. Techo: {@link LINK_IN_BIO_MAX_DESTINATIONS}. */
  readonly maxSecondaryPages: number;
  /** `DATA-032`: extractos citables, no copia. Tope de texto por página. */
  readonly maxTextChars: number;
  /** Identificación del bot. No se inventa una: la pone quien opera. */
  readonly userAgent: string;
  /** Sólo tests. Default: resolvedor del sistema. */
  readonly resolver?: HostResolver;
  /**
   * Sólo tests. Default: `node:http(s)` con la IP fijada. Un transporte que no
   * conecte a `request.address` anula la protección contra DNS rebinding —
   * la guarda de IP sigue corriendo, pero sobre una IP que no es la usada.
   */
  readonly transport?: PinnedTransport;
}

type PageFetch =
  | { readonly status: "ok"; readonly page: ParsedPage; readonly finalUrl: URL }
  | SocialReadUnavailable;

type Category = "product" | "pricing" | "about";

/**
 * Decisión mía: el PRD nombra «producto/precios/about» y nada más. Estas
 * palabras cubren esos tres en inglés, español y portugués; se comparan contra
 * tokens enteros del path y del texto del enlace, no como subcadenas.
 */
const KEYWORDS: Readonly<Record<Category, ReadonlySet<string>>> = {
  product: new Set([
    "product",
    "products",
    "producto",
    "productos",
    "produto",
    "produtos",
    "shop",
    "store",
    "tienda",
    "loja",
    "catalog",
    "catalogo",
    "catálogo",
    "service",
    "services",
    "servicio",
    "servicios",
    "serviço",
    "serviços",
    "features",
  ]),
  pricing: new Set([
    "pricing",
    "price",
    "prices",
    "plans",
    "precio",
    "precios",
    "planes",
    "preço",
    "preços",
    "precos",
    "planos",
    "tarifas",
  ]),
  about: new Set([
    "about",
    "nosotros",
    "somos",
    "company",
    "empresa",
    "story",
    "historia",
    "história",
  ]),
};
const CATEGORY_ORDER: readonly Category[] = ["product", "pricing", "about"];

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

function categorize(url: URL, text: string): Category | null {
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // path mal codificado: se usa tal cual.
  }
  const all = [...tokens(path), ...tokens(text)];
  for (const c of CATEGORY_ORDER) {
    if (all.some((t) => KEYWORDS[c].has(t))) return c;
  }
  return null;
}

function bareHost(url: URL): string {
  return url.hostname
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/^www\./, "");
}

function excerpt(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

function httpUrl(href: string | undefined, base: URL): string | undefined {
  if (href === undefined || href === "") return undefined;
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function assertPositiveInt(name: string, v: number, min = 1): void {
  if (!Number.isInteger(v) || v < min) {
    throw new Error(
      `WebsiteReader: ${name} tiene que ser un entero >= ${String(min)} (vino ${String(v)})`,
    );
  }
}

export class WebsiteReader implements SocialReader {
  readonly source: BrandSourceType;
  private readonly fetchConfig: GuardedFetchConfig;
  private readonly maxSecondaryPages: number;
  private readonly maxTextChars: number;

  constructor(config: WebsiteReaderConfig) {
    assertPositiveInt("timeoutMs", config.timeoutMs);
    assertPositiveInt("maxBodyBytes", config.maxBodyBytes);
    assertPositiveInt("maxRedirects", config.maxRedirects, 0);
    assertPositiveInt("maxSecondaryPages", config.maxSecondaryPages, 0);
    assertPositiveInt("maxTextChars", config.maxTextChars);
    if (config.maxSecondaryPages > LINK_IN_BIO_MAX_DESTINATIONS) {
      throw new Error(
        `WebsiteReader: maxSecondaryPages ${String(config.maxSecondaryPages)} supera el techo de §9.14 (${String(LINK_IN_BIO_MAX_DESTINATIONS)} destinos)`,
      );
    }
    if (config.allowedPorts.length === 0) {
      throw new Error("WebsiteReader: allowedPorts vacío — no podría conectar a nada");
    }
    for (const p of config.allowedPorts) {
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        throw new Error(`WebsiteReader: puerto inválido ${String(p)}`);
      }
    }
    if (config.userAgent.trim() === "") throw new Error("WebsiteReader: userAgent vacío");

    this.source = config.source;
    this.maxSecondaryPages = config.maxSecondaryPages;
    this.maxTextChars = config.maxTextChars;
    this.fetchConfig = {
      blockedHosts: [...config.blockedHosts],
      allowedPorts: [...config.allowedPorts],
      timeoutMs: config.timeoutMs,
      maxBodyBytes: config.maxBodyBytes,
      maxRedirects: config.maxRedirects,
      userAgent: config.userAgent,
      resolver: config.resolver ?? systemResolver,
      transport: config.transport ?? pinnedNodeTransport,
    };
  }

  capabilities(): SocialReadCapabilities {
    return {
      source: this.source,
      tiers: [TIER],
      profileSignals: [
        "displayName",
        "handle",
        "tagline",
        "bio",
        "about",
        "avatarUrl",
        "links",
      ],
      contentSignals: ["externalId", "kind", "permalink", "title", "caption"],
      maxContentItems: 1 + this.maxSecondaryPages,
      requiresConnection: false,
      renderedFetchEnabled: false,
    };
  }

  async resolve(
    request: ResolveSourceRequest,
  ): Promise<SocialReadOutcome<ResolvedSocialSource>> {
    const url = this.startUrl(request.input);
    const fetched = await this.fetchPage(url);
    if (fetched.status !== "ok") return fetched;
    const profile = this.profileFrom(fetched.page, fetched.finalUrl, url);
    const data: ResolvedSocialSource = {
      sourceType: this.source,
      handle: bareHost(url),
      canonicalUrl: `${url.protocol}//${bareHost(url)}${url.pathname.replace(/\/$/, "")}${url.search}`,
      available: true,
      ...(profile.displayName === undefined ? {} : { displayName: profile.displayName }),
      ...(profile.avatarUrl === undefined ? {} : { avatarUrl: profile.avatarUrl }),
    };
    return { status: "ok", tier: TIER, data };
  }

  /**
   * `handle` puede ser el host (lo que guarda `detectBrandSource` de `core`) o
   * la URL completa. **Hueco del puerto:** `ReadProfileRequest` no trae
   * `canonicalUrl`, así que con sólo el host se lee la raíz y se pierde el
   * path de `sitio.com/marca`. Quien orqueste debería pasar la URL canónica.
   */
  async readProfile(
    request: ReadProfileRequest,
  ): Promise<SocialReadOutcome<SocialProfileSignals>> {
    const url = this.startUrl(request.handle);
    const fetched = await this.fetchPage(url);
    if (fetched.status !== "ok") return fetched;
    const signals = this.profileFrom(fetched.page, fetched.finalUrl, url);
    const informative =
      signals.displayName !== undefined ||
      signals.bio !== undefined ||
      signals.tagline !== undefined ||
      fetched.page.mainText !== "";
    if (!informative) return { status: "insufficient_content", attemptedTiers: [TIER] };
    return { status: "ok", tier: TIER, data: signals };
  }

  /**
   * Texto principal de la home + hasta `maxSecondaryPages` páginas de
   * producto/precios/about del mismo sitio, a **un** nivel (§9.14): los
   * enlaces de las páginas secundarias no se siguen.
   *
   * El orden «del más reciente al más viejo» no aplica — una página no tiene
   * fecha — y por eso ningún ítem trae `postedAt`. El orden es fijo: la home
   * primero, después producto, precios, about.
   */
  async readRecentContent(
    request: ReadContentRequest,
  ): Promise<SocialReadOutcome<readonly SocialContentItem[]>> {
    const cap = this.capabilities().maxContentItems;
    const limit = Math.max(0, Math.min(request.limit ?? DEFAULT_CONTENT_ITEMS, cap));
    const url = this.startUrl(request.handle);
    const fetched = await this.fetchPage(url);
    if (fetched.status !== "ok") return fetched;

    const items: SocialContentItem[] = [];
    const home = this.itemFrom(fetched.page, fetched.finalUrl);
    if (home !== null) items.push(home);

    // Un solo nivel (`LINK_IN_BIO_MAX_DEPTH` = 1): sólo enlaces de la home, y
    // `trySecondary` no mira los enlaces de lo que baja.
    const budget = Math.max(0, limit - items.length);
    for (const target of this.secondaryTargets(fetched.page, fetched.finalUrl).slice(
      0,
      budget,
    )) {
      const item = await this.trySecondary(target);
      if (item !== null) items.push(item);
    }

    if (items.length === 0)
      return { status: "insufficient_content", attemptedTiers: [TIER] };
    return { status: "ok", tier: TIER, data: items.slice(0, limit) };
  }

  // ─────────────────────────────────────────────────────────────────────────

  private startUrl(raw: string): URL {
    const trimmed = raw.trim();
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch (e) {
      throw this.badInput(e);
    }
    if (trimmed === "" || (url.protocol !== "http:" && url.protocol !== "https:")) {
      throw this.badInput({ protocol: url.protocol });
    }
    return url;
  }

  private badInput(cause: unknown): PortError {
    // Copy de `ERR-B02` (`FR-011.9`).
    return new PortError(
      "bad_request",
      "We couldn't tell what this is. Paste a website URL or a social profile link.",
      { source: SOURCE, cause },
    );
  }

  /** La página principal: sus fallas son el resultado del extractor. */
  private async fetchPage(url: URL): Promise<PageFetch> {
    const r = await guardedFetch(url, this.fetchConfig);
    const unavailable = (
      status: SocialReadUnavailable["status"],
    ): SocialReadUnavailable => ({
      status,
      attemptedTiers: [TIER],
    });
    if (r.kind === "host_not_found") return unavailable("not_found");
    if (r.status === 404 || r.status === 410) return unavailable("not_found");
    // Decisión: 401/403 → `private` (`ERR-B05`: «can't read it … paste your
    // bio instead»). En una web, un 403 suele ser un WAF anti-bot y no una
    // cuenta privada, pero el consejo que da `ERR-B05` sigue siendo el útil.
    if (r.status === 401 || r.status === 403) return unavailable("private");
    if (r.status === 429) {
      const secs =
        r.retryAfter !== undefined && /^\d+$/.test(r.retryAfter.trim())
          ? Number(r.retryAfter)
          : undefined;
      throw new PortError("rate_limited", "The website is limiting our requests", {
        source: SOURCE,
        cause: { status: 429 },
        ...(secs === undefined ? {} : { retryAfterSeconds: secs }),
      });
    }
    if (r.status >= 500) {
      throw new PortError(
        "provider_unavailable",
        "The website isn't responding right now",
        {
          source: SOURCE,
          cause: { status: r.status },
        },
      );
    }
    if (r.status < 200 || r.status >= 300) {
      throw new PortError(
        "provider_contract_violation",
        "The website sent a response we can't read",
        {
          source: SOURCE,
          cause: { status: r.status },
        },
      );
    }
    // 2xx que no es HTML (un PDF, una imagen): no hay señales que leer.
    if (r.body.length === 0) return unavailable("insufficient_content");
    const page = parsePage(decodeHtml(r.body, r.contentType));
    return { status: "ok", page, finalUrl: r.finalUrl };
  }

  private baseFor(page: ParsedPage, finalUrl: URL): URL {
    const base = httpUrl(page.baseHref, finalUrl);
    return base === undefined ? finalUrl : new URL(base);
  }

  /**
   * Mapeo de la fila `website / other_url` de `FR-011.3` a los campos del
   * puerto. El puerto no tiene campo para `title`, `favicon` ni `og:image`
   * por separado — hueco reportado —, así que:
   *  - `displayName` ← `og:site_name`, si no `<title>`.
   *  - `tagline` ← `og:title`, si no `<title>`, sólo si difiere de `displayName`.
   *  - `bio` ← `<meta name=description>`, si no `og:description`.
   *  - `about` ← `og:description` cuando `bio` salió de la meta y difieren.
   *  - `avatarUrl` ← logo de JSON-LD, si no el favicon declarado.
   *  - `links` ← las páginas de producto/precios/about encontradas.
   */
  private profileFrom(
    page: ParsedPage,
    finalUrl: URL,
    requested: URL,
  ): SocialProfileSignals {
    const og = page.openGraph;
    const cap = (s: string | undefined): string | undefined =>
      s === undefined || s === "" ? undefined : excerpt(s, this.maxTextChars);
    const displayName = cap(og.get("site_name") ?? page.title);
    const rawTagline = cap(og.get("title") ?? page.title);
    const tagline = rawTagline !== displayName ? rawTagline : undefined;
    const bio = cap(page.metaDescription ?? og.get("description"));
    const ogDesc = cap(og.get("description"));
    const about =
      page.metaDescription !== undefined && ogDesc !== undefined && ogDesc !== bio
        ? ogDesc
        : undefined;
    const base = this.baseFor(page, finalUrl);
    const avatarUrl = httpUrl(page.logoHref, base) ?? httpUrl(page.faviconHref, base);
    const links = this.secondaryTargets(page, finalUrl).map((u) => u.toString());

    return {
      handle: bareHost(requested),
      ...(displayName === undefined ? {} : { displayName }),
      ...(tagline === undefined ? {} : { tagline }),
      ...(bio === undefined ? {} : { bio }),
      ...(about === undefined ? {} : { about }),
      ...(avatarUrl === undefined ? {} : { avatarUrl }),
      ...(links.length === 0 ? {} : { links }),
    };
  }

  private itemFrom(page: ParsedPage, finalUrl: URL): SocialContentItem | null {
    const caption = excerpt(page.mainText, this.maxTextChars);
    const rawTitle = page.openGraph.get("title") ?? page.title;
    if (caption === "" && rawTitle === undefined) return null;
    return {
      externalId: finalUrl.toString(),
      kind: "text",
      permalink: finalUrl.toString(),
      ...(rawTitle === undefined ? {} : { title: excerpt(rawTitle, this.maxTextChars) }),
      ...(caption === "" ? {} : { caption }),
      hashtags: [],
      mentions: [],
      engagement: {},
      mediaUrls: [],
    };
  }

  /**
   * Candidatas del mismo sitio (host sin `www.`), una por categoría primero y
   * después en orden de documento, hasta `maxSecondaryPages`. Sólo se miran
   * los enlaces de la home: no hay recursión.
   */
  private secondaryTargets(page: ParsedPage, finalUrl: URL): URL[] {
    const base = this.baseFor(page, finalUrl);
    const site = bareHost(finalUrl);
    const self = `${finalUrl.origin}${finalUrl.pathname}`;
    const seen = new Set<string>([self]);
    const found: { url: URL; category: Category }[] = [];
    for (const link of page.links) {
      const abs = httpUrl(link.href, base);
      if (abs === undefined) continue;
      const u = new URL(abs);
      u.hash = "";
      if (bareHost(u) !== site) continue;
      const key = `${u.origin}${u.pathname}${u.search}`;
      if (seen.has(key)) continue;
      const category = categorize(u, link.text);
      if (category === null) continue;
      seen.add(key);
      found.push({ url: u, category });
    }
    const picked: URL[] = [];
    for (const c of CATEGORY_ORDER) {
      const first = found.find((f) => f.category === c);
      if (first !== undefined) picked.push(first.url);
    }
    for (const f of found) {
      if (!picked.includes(f.url)) picked.push(f.url);
    }
    return picked.slice(0, this.maxSecondaryPages);
  }

  /**
   * Una página secundaria es «si es alcanzable» (`FR-011.3`): cualquier falla
   * —incluida la guarda SSRF— la deja afuera en silencio. Nunca se pide sin
   * pasar por `guardedFetch`, y nunca se reemplaza con nada.
   */
  private async trySecondary(url: URL): Promise<SocialContentItem | null> {
    try {
      const r = await this.fetchPage(url);
      return r.status === "ok" ? this.itemFrom(r.page, r.finalUrl) : null;
    } catch (e) {
      if (e instanceof PortError) return null;
      throw e;
    }
  }
}
