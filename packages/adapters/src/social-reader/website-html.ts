/**
 * Parser HTML acotado para el extractor `website` — señales de `FR-011.3`.
 *
 * `@fastgram/adapters` no tiene ninguna librería de HTML entre sus
 * dependencias, y en esta tarea no se instalan. Esto **no** es un parser
 * HTML5: es un tokenizador lineal (sin regex con backtracking sobre la entrada,
 * así que una página hostil no puede colgarlo) que saca exactamente lo que la
 * fila `website / other_url` pide: `<title>`, `<meta>` (description y
 * OpenGraph), `<link rel=icon>`, el `logo` de JSON-LD, `<base href>`, los
 * `<a href>` y el texto visible.
 *
 * Límites conocidos, escritos para que nadie los descubra en producción:
 *  - No ejecuta JS. Un sitio que pinta todo en el cliente (SPA) devuelve un
 *    cascarón casi vacío, y eso termina en `insufficient_content`, no en un
 *    perfil inventado.
 *  - No aplica CSS. Oculta sólo lo que el HTML marca como oculto (`hidden`,
 *    `aria-hidden="true"`, `style` con `display:none`/`visibility:hidden`). El
 *    texto escondido por una hoja de estilos externa **sí** se extrae — y es
 *    un vector de prompt injection que el sintetizador tiene que tratar como
 *    dato (§9.14), no algo que este parser pueda garantizar.
 *  - Entidades: numéricas completas y un subconjunto de las nombradas.
 *  - No mira `<meta charset>`: el charset sale del `Content-Type`, y si no
 *    viene se asume UTF-8.
 */

// ───────────────────────────────────────────────────────────────────────────
// Entidades
// ───────────────────────────────────────────────────────────────────────────

const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  euro: "€",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  Ntilde: "Ñ",
  uuml: "ü",
  ccedil: "ç",
  atilde: "ã",
  otilde: "õ",
};

export function decodeEntities(s: string): string {
  return s.replace(
    /&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g,
    (m, body: string) => {
      if (body.startsWith("#")) {
        const cp =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        if (
          !Number.isFinite(cp) ||
          cp <= 0 ||
          cp > 0x10ffff ||
          (cp >= 0xd800 && cp <= 0xdfff)
        )
          return "�";
        return String.fromCodePoint(cp);
      }
      return NAMED[body] ?? m;
    },
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Tokenizador
// ───────────────────────────────────────────────────────────────────────────

type Token =
  | {
      readonly type: "open";
      readonly name: string;
      readonly attrs: ReadonlyMap<string, string>;
      readonly selfClosing: boolean;
    }
  | { readonly type: "close"; readonly name: string }
  | { readonly type: "text"; readonly text: string }
  /** Contenido de un elemento de texto crudo (`script`, `style`, `title`…). */
  | {
      readonly type: "raw";
      readonly name: string;
      readonly attrs: ReadonlyMap<string, string>;
      readonly text: string;
    };

const RAW_TEXT = new Set([
  "script",
  "style",
  "title",
  "textarea",
  "noscript",
  "template",
  "xmp",
  "plaintext",
]);

function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f";
}

function isNameChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9:_-]/.test(c);
}

/** Tokeniza en una sola pasada. Todo avance de `i` es hacia adelante. */
export function tokenize(html: string): Token[] {
  const out: Token[] = [];
  const n = html.length;
  // Sólo ASCII: `toLowerCase()` cambia la longitud de algunos caracteres
  // (`İ` → `i̇`) y desalinearía los índices contra `html`.
  const lower = html.replace(/[A-Z]/g, (c) => c.toLowerCase());
  let i = 0;
  let textStart = 0;

  const flushText = (end: number): void => {
    if (end > textStart) out.push({ type: "text", text: html.slice(textStart, end) });
  };

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const next = html[lt + 1];

    // Comentario: se descarta entero (también es un escondite de instrucciones).
    if (html.startsWith("<!--", lt)) {
      flushText(lt);
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      textStart = i;
      continue;
    }
    // `<!DOCTYPE`, `<![CDATA[`, `<?xml`: se saltean hasta el `>`.
    if (next === "!" || next === "?") {
      flushText(lt);
      const end = html.indexOf(">", lt + 2);
      i = end < 0 ? n : end + 1;
      textStart = i;
      continue;
    }
    // Cierre.
    if (next === "/") {
      let j = lt + 2;
      while (j < n && isNameChar(html[j])) j++;
      if (j === lt + 2) {
        i = lt + 1;
        continue;
      }
      flushText(lt);
      const name = html.slice(lt + 2, j).toLowerCase();
      const end = html.indexOf(">", j);
      i = end < 0 ? n : end + 1;
      textStart = i;
      out.push({ type: "close", name });
      continue;
    }
    // Apertura.
    if (next === undefined || !/[A-Za-z]/.test(next)) {
      i = lt + 1;
      continue;
    }
    flushText(lt);
    let j = lt + 1;
    while (j < n && isNameChar(html[j])) j++;
    const name = html.slice(lt + 1, j).toLowerCase();
    const attrs = new Map<string, string>();
    let selfClosing = false;
    // Atributos.
    for (;;) {
      while (j < n && isSpace(html[j])) j++;
      if (j >= n) break;
      const c = html[j];
      if (c === ">") {
        j++;
        break;
      }
      if (c === "/") {
        selfClosing = html[j + 1] === ">";
        j++;
        continue;
      }
      const ks = j;
      while (
        j < n &&
        !isSpace(html[j]) &&
        html[j] !== "=" &&
        html[j] !== ">" &&
        html[j] !== "/"
      )
        j++;
      const key = html.slice(ks, j).toLowerCase();
      if (j === ks) {
        j++; // carácter raro: avanzar siempre
        continue;
      }
      while (j < n && isSpace(html[j])) j++;
      let value = "";
      if (html[j] === "=") {
        j++;
        while (j < n && isSpace(html[j])) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, j + 1);
          value = html.slice(j + 1, end < 0 ? n : end);
          j = end < 0 ? n : end + 1;
        } else {
          const vs = j;
          while (j < n && !isSpace(html[j]) && html[j] !== ">") j++;
          value = html.slice(vs, j);
        }
      }
      if (!attrs.has(key)) attrs.set(key, decodeEntities(value));
    }
    i = j;
    textStart = i;

    if (RAW_TEXT.has(name) && !selfClosing) {
      // `indexOf` sobre una copia en minúsculas hecha una sola vez: un
      // `slice` + regex por elemento sería cuadrático con miles de `<script>`.
      const needle = `</${name}`;
      let end = lower.indexOf(needle, i);
      while (end >= 0) {
        const after = lower[end + needle.length];
        if (after === undefined || after === ">" || after === "/" || isSpace(after))
          break;
        end = lower.indexOf(needle, end + needle.length);
      }
      const stop = end < 0 ? n : end;
      out.push({ type: "raw", name, attrs, text: html.slice(i, stop) });
      if (end < 0) {
        i = n;
      } else {
        const gt = html.indexOf(">", end);
        i = gt < 0 ? n : gt + 1;
      }
      textStart = i;
      continue;
    }
    out.push({ type: "open", name, attrs, selfClosing });
  }
  flushText(n);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Extracción
// ───────────────────────────────────────────────────────────────────────────

export interface PageLink {
  readonly href: string;
  readonly text: string;
}

export interface ParsedPage {
  readonly title?: string;
  readonly metaDescription?: string;
  /** `og:*` tal cual, clave sin el prefijo `og:`. Primera aparición gana. */
  readonly openGraph: ReadonlyMap<string, string>;
  /** `href` crudo del primer `<link rel~=icon>`. Sin resolver. */
  readonly faviconHref?: string;
  /** `logo` de un bloque JSON-LD. Sin resolver. */
  readonly logoHref?: string;
  readonly baseHref?: string;
  readonly links: readonly PageLink[];
  /** Texto visible del `<main>` si existe, si no del `<body>`, sin nav/footer. */
  readonly mainText: string;
}

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
/** Contenedores cuyo texto no es «texto principal» (`FR-011.3`). */
const NON_CONTENT = new Set([
  "nav",
  "footer",
  "svg",
  "iframe",
  "object",
  "select",
  "head",
]);
/** De éstos se descarta el texto pero se conservan los enlaces. */
const LINKS_ONLY = new Set(["nav", "footer"]);
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "li",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "br",
  "tr",
  "td",
  "th",
  "header",
  "main",
  "blockquote",
  "pre",
  "table",
  "dd",
  "dt",
  "figcaption",
]);

function isHidden(attrs: ReadonlyMap<string, string>): boolean {
  if (attrs.has("hidden")) return true;
  if ((attrs.get("aria-hidden") ?? "").trim().toLowerCase() === "true") return true;
  const style = (attrs.get("style") ?? "").toLowerCase().replace(/\s+/g, "");
  return style.includes("display:none") || style.includes("visibility:hidden");
}

/**
 * Caracteres invisibles que se quitan: controles C0 (menos `\t` y `\n`), DEL,
 * los de ancho cero (U+200B..U+200F), separadores de línea/párrafo, los
 * overrides bidi (U+202A..U+202E), U+2060..U+2064 y el BOM. No aportan nada y
 * son una forma de esconder texto en lo que después se le pasa a un LLM.
 * Se describen por código y no con un literal de regex para que el archivo
 * no dependa de caracteres invisibles en el fuente.
 */
function isInvisible(cp: number): boolean {
  return (
    (cp <= 0x1f && cp !== 0x09 && cp !== 0x0a) ||
    cp === 0x7f ||
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    cp === 0xfeff
  );
}

export function collapseWhitespace(s: string): string {
  let clean = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isInvisible(cp)) continue;
    clean += cp === 0xa0 ? " " : ch;
  }
  return clean
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n\s*/g, "\n")
    .trim();
}

function findLogo(node: unknown, depth = 0): string | undefined {
  if (depth > 8 || node === null || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const x of node) {
      const r = findLogo(x, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  const obj = node as Record<string, unknown>;
  const logo = obj["logo"];
  if (typeof logo === "string" && logo.trim() !== "") return logo.trim();
  if (logo !== null && typeof logo === "object") {
    const url = (logo as Record<string, unknown>)["url"];
    if (typeof url === "string" && url.trim() !== "") return url.trim();
  }
  for (const v of Object.values(obj)) {
    const r = findLogo(v, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

export function parsePage(html: string): ParsedPage {
  const tokens = tokenize(html);
  const og = new Map<string, string>();
  const links: PageLink[] = [];
  let title: string | undefined;
  let metaDescription: string | undefined;
  let faviconHref: string | undefined;
  let logoHref: string | undefined;
  let baseHref: string | undefined;

  // Texto: se acumula aparte para `<main>` y para el resto del `<body>`.
  const bodyText: string[] = [];
  const mainText: string[] = [];
  let hasMain = false;
  let inMain = 0;
  /** Pila de elementos que suprimen texto: nombre + profundidad propia. */
  const skip: { name: string; depth: number; keepLinks: boolean }[] = [];
  let anchor: { href: string; text: string[] } | null = null;

  for (const t of tokens) {
    if (t.type === "raw") {
      if (t.name === "title" && title === undefined) {
        const v = collapseWhitespace(decodeEntities(t.text));
        if (v !== "") title = v;
      } else if (
        t.name === "script" &&
        (t.attrs.get("type") ?? "").trim().toLowerCase() === "application/ld+json" &&
        logoHref === undefined
      ) {
        try {
          logoHref = findLogo(JSON.parse(t.text) as unknown);
        } catch {
          // JSON-LD roto: es dato de un tercero, se ignora.
        }
      }
      continue;
    }

    if (t.type === "open") {
      const a = t.attrs;
      if (t.name === "meta") {
        const content = a.get("content");
        const key = (a.get("property") ?? a.get("name") ?? "").trim().toLowerCase();
        if (content !== undefined && content.trim() !== "") {
          const v = collapseWhitespace(content);
          if (key === "description" && metaDescription === undefined) metaDescription = v;
          if (key.startsWith("og:")) {
            const k = key.slice(3);
            if (!og.has(k)) og.set(k, v);
          }
        }
        continue;
      }
      if (t.name === "link") {
        const rel = (a.get("rel") ?? "").toLowerCase().split(/\s+/);
        const href = a.get("href");
        if (
          href !== undefined &&
          href.trim() !== "" &&
          rel.includes("icon") &&
          faviconHref === undefined
        ) {
          faviconHref = href.trim();
        }
        continue;
      }
      if (t.name === "base") {
        const href = a.get("href");
        if (href !== undefined && baseHref === undefined) baseHref = href.trim();
        continue;
      }
      if (skip.length > 0) {
        const top = skip[skip.length - 1];
        if (top !== undefined && top.name === t.name && !t.selfClosing) top.depth++;
        // Dentro de `nav`/`footer` el texto no es «principal», pero los
        // enlaces sí cuentan: ahí es justamente donde viven «Productos»,
        // «Precios» y «Nosotros». Dentro de algo oculto, ni eso.
        if (t.name === "a" && skip.every((f) => f.keepLinks)) {
          const href = a.get("href");
          anchor = href !== undefined ? { href: href.trim(), text: [] } : null;
        }
        continue;
      }
      if (
        !VOID.has(t.name) &&
        !t.selfClosing &&
        (NON_CONTENT.has(t.name) || isHidden(a))
      ) {
        skip.push({
          name: t.name,
          depth: 1,
          keepLinks: LINKS_ONLY.has(t.name) && !isHidden(a),
        });
        continue;
      }
      if (t.name === "main") {
        hasMain = true;
        inMain++;
      }
      if (t.name === "a") {
        const href = a.get("href");
        anchor = href !== undefined ? { href: href.trim(), text: [] } : null;
      }
      if (BLOCK.has(t.name)) {
        bodyText.push("\n");
        if (inMain > 0) mainText.push("\n");
      }
      continue;
    }

    if (t.type === "close") {
      if (skip.length > 0) {
        if (t.name === "a" && anchor !== null) {
          links.push({
            href: anchor.href,
            text: collapseWhitespace(anchor.text.join(" ")),
          });
          anchor = null;
        }
        const top = skip[skip.length - 1];
        if (top !== undefined && top.name === t.name) {
          top.depth--;
          if (top.depth === 0) skip.pop();
        }
        continue;
      }
      if (t.name === "main" && inMain > 0) inMain--;
      if (t.name === "a" && anchor !== null) {
        links.push({
          href: anchor.href,
          text: collapseWhitespace(anchor.text.join(" ")),
        });
        anchor = null;
      }
      if (BLOCK.has(t.name)) {
        bodyText.push("\n");
        if (inMain > 0) mainText.push("\n");
      }
      continue;
    }

    // Texto.
    if (skip.length > 0) {
      if (anchor !== null) anchor.text.push(decodeEntities(t.text));
      continue;
    }
    const text = decodeEntities(t.text);
    bodyText.push(text);
    if (inMain > 0) mainText.push(text);
    if (anchor !== null) anchor.text.push(text);
  }
  if (anchor !== null)
    links.push({ href: anchor.href, text: collapseWhitespace(anchor.text.join(" ")) });

  const main = collapseWhitespace((hasMain ? mainText : bodyText).join(""));
  const page: ParsedPage = {
    openGraph: og,
    links,
    mainText: main,
    ...(title === undefined ? {} : { title }),
    ...(metaDescription === undefined ? {} : { metaDescription }),
    ...(faviconHref === undefined ? {} : { faviconHref }),
    ...(logoHref === undefined ? {} : { logoHref }),
    ...(baseHref === undefined ? {} : { baseHref }),
  };
  return page;
}

/** Decodifica bytes según el `charset` del `Content-Type`; UTF-8 si no hay o no se conoce. */
export function decodeHtml(bytes: Uint8Array, contentType: string | undefined): string {
  const m = /charset\s*=\s*"?([A-Za-z0-9._:-]+)"?/i.exec(contentType ?? "");
  const label = m?.[1] ?? "utf-8";
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}
