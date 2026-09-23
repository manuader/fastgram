/**
 * Guarda SSRF del extractor `website` / `other_url` — PRD `NFR-017`, `AI-001`
 * («Límites: URL pública; se rechazan localhost, IPs privadas y URLs
 * bloqueadas»), `FR-011.9` y §9.14 («mismas protecciones SSRF … aplicadas a
 * **todos** los orígenes, incluido el seguimiento de link-in-bio»).
 *
 * **Por qué no alcanza con `assertHostAllowed` de `@fastgram/core`.** Aquel
 * chequeo mira el *nombre* que tipeó el usuario, antes de cualquier red, y es
 * correcto para lo que hace: rechazar rápido en la ruta. Pero un nombre público
 * puede resolver a `127.0.0.1`, y un sitio público puede redirigir a
 * `http://169.254.169.254/`. Lo único que decide a dónde va el socket es la IP
 * **después** de resolver, y eso sólo lo ve quien conecta. Por eso esta guarda
 * clasifica direcciones, no nombres, y corre en cada salto (ver
 * `website-http.ts`). Además `adapters` no depende de `core` (sólo de
 * `ports`), así que importarla tampoco era una opción.
 *
 * Qué se bloquea, con la razón de cada rango. La lista la pidió la tarea
 * (`P1-BRAND-006`); el PRD sólo dice «localhost, IPs privadas». Los rangos
 * marcados «decisión» van más allá de lo pedido y están declarados como tal.
 */

import { isIP } from "node:net";

export type BlockReason =
  | "unspecified" // 0.0.0.0/8, ::
  | "loopback" // 127/8, ::1
  | "private" // RFC 1918
  | "cgnat" // 100.64/10 (RFC 6598)
  | "link_local" // 169.254/16 (metadata de nube), fe80::/10
  | "unique_local" // fc00::/7
  | "site_local" // fec0::/10, deprecado pero enrutable en redes viejas
  | "multicast" // 224/4, ff00::/8
  | "reserved" // 240/4 (incluye 255.255.255.255), ::/96 compat, Teredo
  | "localhost_name" // `localhost` y `*.localhost` (RFC 6761), antes de DNS
  | "blocked_host" // lista de configuración
  | "scheme" // no http/https
  | "port" // fuera de la lista de configuración
  | "not_an_ip";

// ───────────────────────────────────────────────────────────────────────────
// IPv4
// ───────────────────────────────────────────────────────────────────────────

/** Dotted-quad estricto → entero de 32 bits sin signo. `null` si no lo es. */
export function parseIpv4(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

function inV4(ip: number, base: string, bits: number): boolean {
  const b = parseIpv4(base);
  if (b === null) throw new Error(`rango mal escrito: ${base}`);
  const size = 2 ** (32 - bits);
  return Math.floor(ip / size) === Math.floor(b / size);
}

function classifyV4(ip: number): BlockReason | null {
  if (inV4(ip, "0.0.0.0", 8)) return "unspecified";
  if (inV4(ip, "127.0.0.0", 8)) return "loopback";
  if (inV4(ip, "10.0.0.0", 8)) return "private";
  if (inV4(ip, "172.16.0.0", 12)) return "private";
  if (inV4(ip, "192.168.0.0", 16)) return "private";
  if (inV4(ip, "100.64.0.0", 10)) return "cgnat";
  // 169.254.169.254 es el endpoint de metadata de AWS, GCP y Azure.
  if (inV4(ip, "169.254.0.0", 16)) return "link_local";
  if (inV4(ip, "224.0.0.0", 4)) return "multicast";
  // Decisión: 240/4 no se enruta en Internet; incluye el broadcast.
  if (inV4(ip, "240.0.0.0", 4)) return "reserved";
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// IPv6
// ───────────────────────────────────────────────────────────────────────────

/** Ocho grupos de 16 bits, o `null`. Acepta `::` y el cuarteto IPv4 final. */
export function parseIpv6(input: string): number[] | null {
  let s = input.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (isIP(s) !== 6) return null;

  // Cuarteto IPv4 embebido al final (`::ffff:127.0.0.1`).
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    const hi = Math.floor(v4 / 65536).toString(16);
    const lo = (v4 % 65536).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const groups = [...head, ...Array<string>(Math.max(missing, 0)).fill("0"), ...rest];
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some((n) => Number.isNaN(n)) || out.length !== 8 ? null : out;
}

function embeddedV4(hi: number, lo: number): number {
  return hi * 65536 + lo;
}

function classifyV6(g: readonly number[]): BlockReason | null {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  if (firstFiveZero && g5 === 0 && g6 === 0) {
    if (g7 === 0) return "unspecified";
    if (g7 === 1) return "loopback";
  }
  // IPv4-mapped `::ffff:a.b.c.d`: el kernel conecta a la IPv4 embebida. Es la
  // vuelta clásica a un filtro que sólo mira IPv4. (El `assertHostAllowed` de
  // `core` la corta como literal en la URL, pero por su regla de «host sin
  // punto», no por reconocerla; y acá la dirección llega del DNS, donde esa
  // regla no aplica.)
  if (firstFiveZero && g5 === 0xffff) return classifyV4(embeddedV4(g6, g7));
  // IPv4-compatible `::a.b.c.d` (deprecado). Nada legítimo lo usa.
  if (firstFiveZero && g5 === 0) return "reserved";
  // NAT64 bien conocido 64:ff9b::/96: embebe la IPv4 de destino.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyV4(embeddedV4(g6, g7));
  }
  // 6to4 2002::/16: embebe una IPv4 en los bits 16..47.
  if (g0 === 0x2002) return classifyV4(embeddedV4(g1, g2));
  // Decisión: Teredo 2001:0::/32 embebe una IPv4 ofuscada; se corta entero.
  if (g0 === 0x2001 && g1 === 0) return "reserved";
  if ((g0 & 0xffc0) === 0xfe80) return "link_local";
  if ((g0 & 0xffc0) === 0xfec0) return "site_local";
  if ((g0 & 0xfe00) === 0xfc00) return "unique_local";
  if ((g0 & 0xff00) === 0xff00) return "multicast";
  return null;
}

/**
 * Clasifica una dirección IP literal. `null` = pública, se puede conectar.
 * Lo que no es IP devuelve `not_an_ip`: quien llame con un nombre se equivocó
 * de función, y fallar cerrado es lo único seguro.
 */
export function classifyAddress(address: string): BlockReason | null {
  const bare = address.replace(/^\[|\]$/g, "");
  const kind = isIP(bare.split("%")[0] ?? "");
  if (kind === 4) {
    const v4 = parseIpv4(bare);
    return v4 === null ? "not_an_ip" : classifyV4(v4);
  }
  if (kind === 6) {
    const v6 = parseIpv6(bare);
    return v6 === null ? "not_an_ip" : classifyV6(v6);
  }
  return "not_an_ip";
}

// ───────────────────────────────────────────────────────────────────────────
// URL y nombre, antes de resolver
// ───────────────────────────────────────────────────────────────────────────

/**
 * Normaliza un hostname para compararlo: minúsculas, sin corchetes y **sin el
 * punto final**. `evil.example.` es el mismo host que `evil.example` para el
 * DNS, y una lista de bloqueo que no lo normaliza se esquiva con un carácter.
 */
export function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
}

/**
 * `true` si `host` es `entry` o un subdominio suyo. Decisión: una entrada de
 * la lista bloquea también sus subdominios; bloquear `example.com` y dejar
 * pasar `www.example.com` no es lo que nadie quiere decir.
 */
export function hostMatchesBlockEntry(host: string, entry: string): boolean {
  const h = normalizeHostname(host);
  const e = normalizeHostname(entry);
  if (e.length === 0) return false;
  return h === e || h.endsWith(`.${e}`);
}

export interface UrlPolicy {
  /** Sin entradas inventadas: la lista la da la configuración. */
  readonly blockedHosts: readonly string[];
  /** Puertos permitidos. El PRD no da ninguno; ver `WebsiteReaderConfig`. */
  readonly allowedPorts: readonly number[];
}

/** Resultado del chequeo estático: bloqueado, o el host listo para resolver. */
export type UrlCheck =
  | { readonly ok: false; readonly reason: BlockReason; readonly detail: string }
  | {
      readonly ok: true;
      readonly host: string;
      readonly port: number;
      /** Si el host ya es una IP literal, no hay DNS que consultar. */
      readonly literalAddress: string | null;
    };

/**
 * Todo lo que se puede decidir sin red. Corre en la URL inicial **y en cada
 * `Location`**: un redirect es una URL nueva escrita por un tercero.
 *
 * Las formas raras de IPv4 (`http://2130706433/`, `http://0177.0.0.1/`,
 * `http://0x7f.1/`) no necesitan una rama propia: el parser WHATWG de `URL`
 * las normaliza a `127.0.0.1` antes de que lleguen acá, y entran por la rama
 * de IP literal. Los tests lo verifican de punta a punta en vez de creerlo.
 */
export function checkUrl(url: URL, policy: UrlPolicy): UrlCheck {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "scheme", detail: url.protocol };
  }
  const host = normalizeHostname(url.hostname);
  if (host.length === 0) return { ok: false, reason: "not_an_ip", detail: "host vacío" };

  const port =
    url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!policy.allowedPorts.includes(port)) {
    return { ok: false, reason: "port", detail: String(port) };
  }

  for (const entry of policy.blockedHosts) {
    if (hostMatchesBlockEntry(host, entry)) {
      return { ok: false, reason: "blocked_host", detail: host };
    }
  }

  if (isIP(host) !== 0) {
    const reason = classifyAddress(host);
    if (reason !== null) return { ok: false, reason, detail: host };
    return { ok: true, host, port, literalAddress: host };
  }

  // RFC 6761: `localhost` y todo `*.localhost` resuelven a loopback por
  // definición. Se corta antes del DNS para no depender de `/etc/hosts`.
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "localhost_name", detail: host };
  }

  return { ok: true, host, port, literalAddress: null };
}
