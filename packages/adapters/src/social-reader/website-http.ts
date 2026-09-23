/**
 * GET guardado contra SSRF para el extractor `website` — `NFR-017`, §9.14.
 *
 * Tres propiedades que este archivo existe para sostener, y cómo:
 *
 * 1. **Se valida la IP a la que se conecta, no el nombre.** Se resuelve el
 *    host, se clasifican **todas** las direcciones (si una sola es privada se
 *    rechaza: un registro mixto público+privado es un truco conocido) y se
 *    conecta a la primera.
 * 2. **Cada redirect se revalida.** `fetch` con `redirect: "follow"` salta a
 *    `http://169.254.169.254/` sin preguntar; acá el salto lo hace este bucle,
 *    y cada `Location` pasa por `checkUrl` + DNS + clasificación como si fuera
 *    la URL inicial.
 * 3. **DNS rebinding: se conecta a la IP ya validada.** El transporte por
 *    defecto usa `node:http(s)` con un `lookup` fijo que devuelve la dirección
 *    validada, así que entre «validar» y «conectar» no hay una segunda
 *    resolución que el atacante pueda contestar distinto. TLS sigue
 *    verificando el certificado contra el **nombre** (SNI y `checkServerIdentity`
 *    usan `hostname`), así que fijar la IP no debilita HTTPS. `agent: false`
 *    evita que un socket de pool conectado antes se reutilice.
 *
 * Por qué `node:http` y no `fetch`: el `fetch` global no acepta `lookup`, y
 *    fijar la IP exige un `dispatcher` de `undici`, que no es dependencia de
 *    este paquete (y no se instalan dependencias en esta tarea).
 *
 * Ningún error crudo sale de acá: todo termina en `PortError` con código
 * estable y el original en `cause` (`NFR-022`).
 */

import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { promises as dns } from "node:dns";
import {
  constants as zc,
  createBrotliDecompress,
  createGunzip,
  createInflate,
} from "node:zlib";
import type { Transform } from "node:stream";
import { PortError } from "@fastgram/ports";
import {
  checkUrl,
  classifyAddress,
  normalizeHostname,
  type BlockReason,
  type UrlPolicy,
} from "./website-ssrf.js";

const SOURCE = "SocialReader/website";

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * Resolución de nombres. Inyectable para testear «un nombre público que
 * resuelve a 10.0.0.1» sin tocar el DNS real. En producción es
 * `dns.lookup` con `all: true` — el mismo resolvedor del sistema que usaría
 * `http.request`, así que no hay divergencia entre lo validado y lo que el
 * sistema habría elegido.
 */
export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface TransportRequest {
  readonly url: URL;
  /** IP ya validada. El transporte **debe** conectar a esta, no re-resolver. */
  readonly address: string;
  readonly family: 4 | 6;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface TransportResponse {
  readonly status: number;
  /** Nombres en minúsculas. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
  /** Libera el socket. Idempotente. */
  destroy(): void;
}

/**
 * Transporte que conecta a una IP fijada. Inyectable **sólo** para que los
 * tests puedan llevar la conexión a `127.0.0.1` después de que la guarda
 * aprobó una IP pública ficticia: la guarda corre igual, entera, delante.
 */
export type PinnedTransport = (request: TransportRequest) => Promise<TransportResponse>;

export const systemResolver: HostResolver = async (hostname) => {
  const rows = await dns.lookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

export const pinnedNodeTransport: PinnedTransport = (req) =>
  new Promise((resolve, reject) => {
    const isHttps = req.url.protocol === "https:";
    const lookup = ((
      _hostname: string,
      options: { all?: boolean },
      callback: (...args: unknown[]) => void,
    ) => {
      if (options.all === true) {
        callback(null, [{ address: req.address, family: req.family }]);
      } else {
        callback(null, req.address, req.family);
      }
      // `LookupFunction` tipa el callback con sobrecargas que un literal de
      // función no puede satisfacer a la vez; la forma de arriba cubre las dos.
    }) as unknown as LookupFunction;

    const options: https.RequestOptions = {
      protocol: req.url.protocol,
      hostname: req.url.hostname.replace(/^\[|\]$/g, ""),
      method: "GET",
      path: `${req.url.pathname}${req.url.search}`,
      headers: { ...req.headers },
      lookup,
      agent: false,
      signal: req.signal,
    };
    if (req.url.port !== "") options.port = Number(req.url.port);

    const onResponse = (res: http.IncomingMessage): void => {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
      }
      resolve({
        status: res.statusCode ?? 0,
        headers,
        body: res,
        destroy: () => {
          res.destroy();
          request.destroy();
        },
      });
    };
    const request = isHttps
      ? https.request(options, onResponse)
      : http.request(options, onResponse);
    request.on("error", reject);
    request.end();
  });

export interface GuardedFetchConfig extends UrlPolicy {
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
  readonly maxRedirects: number;
  readonly userAgent: string;
  readonly resolver: HostResolver;
  readonly transport: PinnedTransport;
}

export type GuardedFetchResult =
  | {
      /** NXDOMAIN o sin registros: el host no existe. `ERR-B04`, no un error. */
      readonly kind: "host_not_found";
      readonly url: URL;
    }
  | {
      readonly kind: "response";
      /** URL después de los redirects. Es la que manda para resolver relativos. */
      readonly finalUrl: URL;
      readonly status: number;
      readonly contentType: string | undefined;
      readonly retryAfter: string | undefined;
      /** Vacío salvo en 2xx con tipo HTML. */
      readonly body: Uint8Array;
      /** Se cortó en `maxBodyBytes`. */
      readonly truncated: boolean;
    };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Copy literal de `FR-010` (PRD:767), la misma que usa `core`. */
function forbidden(reason: BlockReason, detail: string): PortError {
  const message =
    reason === "loopback" || reason === "localhost_name"
      ? "Localhost URLs are not allowed"
      : reason === "blocked_host" ||
          reason === "scheme" ||
          reason === "port" ||
          reason === "not_an_ip"
        ? "Blocked URL for security reasons"
        : "Private IP addresses are not allowed";
  return new PortError("forbidden", message, {
    source: SOURCE,
    cause: { reason, detail },
  });
}

/** HTML o sin `Content-Type` (hay servidores que lo omiten). Nada más se lee. */
export function isHtmlContentType(ct: string | undefined): boolean {
  if (ct === undefined || ct.trim() === "") return true;
  const mime = ct.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime === "text/html" || mime === "application/xhtml+xml";
}

function errorCode(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && "code" in e) {
    const c = (e as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

const DNS_NOT_FOUND = new Set(["ENOTFOUND", "ENODATA", "ENONAME"]);

function translate(e: unknown, signal: AbortSignal): PortError {
  if (e instanceof PortError) return e;
  if (signal.aborted) {
    return new PortError("timeout", "The website took too long to respond", {
      source: SOURCE,
      cause: e,
    });
  }
  const code = errorCode(e) ?? "";
  if (
    code.startsWith("ERR_TLS") ||
    code.startsWith("ERR_SSL") ||
    code.startsWith("CERT_") ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "ERR_INVALID_URL" ||
    code.startsWith("Z_") ||
    code === "HPE_INVALID_CONSTANT" ||
    code.startsWith("HPE_")
  ) {
    return new PortError(
      "provider_contract_violation",
      "The website sent a response we can't read",
      {
        source: SOURCE,
        cause: e,
      },
    );
  }
  return new PortError("provider_unavailable", "The website isn't responding right now", {
    source: SOURCE,
    cause: e,
  });
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function makeDecompressor(encoding: string | undefined): Transform | null {
  const enc = (encoding ?? "").trim().toLowerCase();
  // `finishFlush: SYNC` para que un cuerpo comprimido cortado por el servidor
  // no reviente con «unexpected end of file» y se pueda usar lo recibido.
  const opts = { finishFlush: zc.Z_SYNC_FLUSH };
  if (enc === "" || enc === "identity") return null;
  if (enc === "gzip" || enc === "x-gzip") return createGunzip(opts);
  if (enc === "deflate") return createInflate(opts);
  if (enc === "br") {
    return createBrotliDecompress({ finishFlush: zc.BROTLI_OPERATION_FLUSH });
  }
  throw new PortError(
    "provider_contract_violation",
    "The website sent a response we can't read",
    {
      source: SOURCE,
      cause: { contentEncoding: enc },
    },
  );
}

/**
 * Lee el cuerpo **ya descomprimido** hasta `max` bytes. El tope se cuenta
 * después de descomprimir a propósito: contarlo antes deja pasar una bomba de
 * compresión de 10 KB que se expande a 1 GB.
 */
export async function collectBody(
  body: AsyncIterable<Uint8Array>,
  encoding: string | undefined,
  max: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const out: Buffer[] = [];
  let total = 0;
  let truncated = false;
  const take = (chunk: Uint8Array): boolean => {
    const c = Buffer.from(chunk);
    const room = max - total;
    if (c.length > room) {
      if (room > 0) out.push(c.subarray(0, room));
      total = max;
      truncated = true;
      return false;
    }
    out.push(c);
    total += c.length;
    return true;
  };

  const z = makeDecompressor(encoding);
  if (z === null) {
    for await (const chunk of body) {
      if (!take(chunk)) break;
    }
    return { bytes: Buffer.concat(out), truncated };
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: unknown): void => {
      if (settled) return;
      settled = true;
      if (err === undefined) resolve();
      else reject(err instanceof Error ? err : new Error(String(err)));
    };
    z.on("data", (c: Buffer) => {
      if (settled) return;
      if (!take(c)) finish();
    });
    z.on("end", () => finish());
    z.on("error", (e: Error) => finish(e));
    void (async () => {
      for await (const chunk of body) {
        if (settled) break;
        if (!z.write(chunk)) {
          await new Promise<void>((r) => {
            z.once("drain", () => r());
            z.once("close", () => r());
          });
        }
      }
      if (!settled) z.end();
    })().catch((e: unknown) => finish(e));
  });
  z.destroy();
  return { bytes: Buffer.concat(out), truncated };
}

/**
 * Un GET con la guarda SSRF en cada salto. El `timeoutMs` es un plazo **total**
 * para esta URL —DNS, conexión, redirects y cuerpo—, no por salto: un servidor
 * que gotea un byte por segundo (slowloris) no lo estira.
 */
export async function guardedFetch(
  start: URL,
  cfg: GuardedFetchConfig,
): Promise<GuardedFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("deadline")), cfg.timeoutMs);
  const blockedIps = new Set(
    cfg.blockedHosts.map(normalizeHostname).filter((h) => isIP(h) !== 0),
  );
  const headers = {
    "user-agent": cfg.userAgent,
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    "accept-encoding": "gzip, deflate, br",
  };

  try {
    let url = start;
    let hops = 0;
    for (;;) {
      const check = checkUrl(url, cfg);
      if (!check.ok) throw forbidden(check.reason, check.detail);

      let target: ResolvedAddress;
      if (check.literalAddress !== null) {
        target = {
          address: check.literalAddress,
          family: isIP(check.literalAddress) === 6 ? 6 : 4,
        };
      } else {
        let addresses: readonly ResolvedAddress[];
        try {
          addresses = await abortable(cfg.resolver(check.host), controller.signal);
        } catch (e) {
          if (DNS_NOT_FOUND.has(errorCode(e) ?? ""))
            return { kind: "host_not_found", url };
          throw e;
        }
        if (addresses.length === 0) return { kind: "host_not_found", url };
        // Todas, no sólo la primera: si el transporte (o el SO) cayera en otra
        // de la lista, también tiene que ser pública.
        for (const a of addresses) {
          const reason = classifyAddress(a.address);
          if (reason !== null) throw forbidden(reason, `${check.host} -> ${a.address}`);
          if (blockedIps.has(normalizeHostname(a.address))) {
            throw forbidden("blocked_host", `${check.host} -> ${a.address}`);
          }
        }
        const first = addresses[0];
        if (first === undefined) return { kind: "host_not_found", url };
        target = first;
      }

      const res = await cfg.transport({
        url,
        address: target.address,
        family: target.family,
        headers,
        signal: controller.signal,
      });

      const location = res.headers["location"];
      if (REDIRECTS.has(res.status) && location !== undefined && location !== "") {
        res.destroy();
        if (hops >= cfg.maxRedirects) {
          throw new PortError(
            "provider_contract_violation",
            "The website redirects too many times",
            {
              source: SOURCE,
              cause: { maxRedirects: cfg.maxRedirects, last: url.toString() },
            },
          );
        }
        hops += 1;
        try {
          url = new URL(location, url);
        } catch (e) {
          throw new PortError(
            "provider_contract_violation",
            "The website sent a response we can't read",
            {
              source: SOURCE,
              cause: e,
            },
          );
        }
        continue;
      }

      const contentType = res.headers["content-type"];
      const base = {
        kind: "response" as const,
        finalUrl: url,
        status: res.status,
        contentType,
        retryAfter: res.headers["retry-after"],
      };
      if (res.status < 200 || res.status >= 300 || !isHtmlContentType(contentType)) {
        res.destroy();
        return { ...base, body: new Uint8Array(0), truncated: false };
      }
      try {
        const { bytes, truncated } = await collectBody(
          res.body,
          res.headers["content-encoding"],
          cfg.maxBodyBytes,
        );
        return { ...base, body: bytes, truncated };
      } finally {
        res.destroy();
      }
    }
  } catch (e) {
    throw translate(e, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
