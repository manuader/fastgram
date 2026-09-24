/**
 * Servidor de media pública — `PU-RUN-005`, PRD D-17.
 *
 * Es lo único que el túnel de Cloudflare expone. Sirve **una** ruta:
 *
 *     GET|HEAD /public-media/<token>
 *
 * y todo lo demás es 404. El token (ver `@fastgram/adapters/public-media`)
 * lleva la clave del objeto y la expiración, firmado con una subclave de
 * `~/.fastgram/secret.key`. Firma mala, vencido, clave fuera de `media/` y
 * `content/`, objeto inexistente: **404 igual para todos**, sin cuerpo que
 * explique. Quien pega desde afuera no aprende nada; el motivo va al log local,
 * sin el token.
 *
 * ## Por qué un proceso aparte y no una ruta de la API
 *
 * La API (Fastify) monta ~100 rutas, CORS, docs y health. Si el túnel apuntara
 * a ella, cualquier error de enrutamiento o un plugin que registre algo en la
 * raíz quedaría expuesto a internet, y la API en modo personal **no tiene
 * auth**. Con un proceso propio escuchando sólo en 127.0.0.1, el túnel apunta a
 * un servidor que no sabe hacer otra cosa: la superficie expuesta es este
 * archivo. Vive en `apps/api` sólo para usar sus dependencias (S3 vía
 * `@fastgram/adapters`) sin un `package.json` nuevo.
 *
 * ## Range
 *
 * Un solo rango (`bytes=a-b`, `bytes=a-`, `bytes=-n`) ⇒ 206 con
 * `Content-Range`. Varios rangos ⇒ se ignora y va el objeto entero con 200
 * (RFC 9110 §14.2 lo permite). Insatisfacible ⇒ 416 con `bytes *\/<tamaño>`.
 * `If-Range` que no coincide con el ETag ⇒ objeto entero.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  PUBLIC_MEDIA_PATH,
  verifyPublicMediaToken,
  type ByteRange,
  type PublicMediaObjectSource,
  type VerifyFailure,
} from "@fastgram/adapters/public-media";

export interface PublicMediaHandlerDeps {
  readonly source: PublicMediaObjectSource;
  /** Subclave ya derivada (`deriveSigningKey`). */
  readonly signingKey: Uint8Array;
  readonly now?: () => number;
  /** Sin el token: sólo motivo, estado y bytes. */
  readonly log?: (line: string) => void;
}

export type RangeParse =
  | { readonly kind: "none" }
  | { readonly kind: "range"; readonly range: ByteRange }
  | { readonly kind: "unsatisfiable" };

/** `Range` contra un objeto de `size` bytes. Ver la cabecera. */
export function parseRange(header: string | undefined, size: number): RangeParse {
  if (header === undefined) return { kind: "none" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Multi-rango, otra unidad o basura: se ignora y va entero.
  if (m === null) return { kind: "none" };
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return { kind: "none" };
  if (size === 0) return { kind: "unsatisfiable" };
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0) return { kind: "unsatisfiable" };
    return { kind: "range", range: { start: Math.max(0, size - suffix), end: size - 1 } };
  }
  const start = Number(a);
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (!Number.isSafeInteger(start) || start >= size || end < start) {
    return { kind: "unsatisfiable" };
  }
  return { kind: "range", range: { start, end } };
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": "10",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end("Not Found\n");
}

export function createPublicMediaHandler(deps: PublicMediaHandlerDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    let reason: VerifyFailure | "route" | "method" | "missing" | "error" | null = null;
    try {
      // Sólo la ruta, sin query: `new URL` con una base fija no confía en `Host`.
      const path = new URL(req.url ?? "/", "http://public-media.invalid").pathname;
      if (!path.startsWith(PUBLIC_MEDIA_PATH)) {
        reason = "route";
        return notFound(res);
      }
      const token = path.slice(PUBLIC_MEDIA_PATH.length);
      if (token.length === 0 || token.includes("/")) {
        reason = "route";
        return notFound(res);
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        reason = "method";
        res.writeHead(405, { Allow: "GET, HEAD", "Content-Length": "0" });
        res.end();
        return;
      }

      const verified = verifyPublicMediaToken(
        deps.signingKey,
        token,
        Math.floor(now() / 1000),
      );
      if (!verified.ok) {
        reason = verified.reason;
        return notFound(res);
      }

      const info = await deps.source.head(verified.objectKey);
      if (info === null) {
        reason = "missing";
        return notFound(res);
      }

      const ifRange = req.headers["if-range"];
      const rangeHeader =
        ifRange !== undefined && ifRange !== info.etag ? undefined : req.headers.range;
      const parsed = parseRange(rangeHeader, info.sizeBytes);

      const headers: Record<string, string> = {
        "Content-Type": info.contentType,
        "Accept-Ranges": "bytes",
        // Capacidad bearer: que ningún cache intermedio (ni el de Cloudflare)
        // la guarde más allá de su vida.
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      };
      if (info.etag !== undefined) headers["ETag"] = info.etag;
      if (info.lastModified !== undefined) {
        headers["Last-Modified"] = info.lastModified.toUTCString();
      }

      if (parsed.kind === "unsatisfiable") {
        res.writeHead(416, {
          "Content-Range": `bytes */${info.sizeBytes}`,
          "Content-Length": "0",
          "Cache-Control": "no-store",
        });
        res.end();
        return;
      }

      const range = parsed.kind === "range" ? parsed.range : undefined;
      const length = range === undefined ? info.sizeBytes : range.end - range.start + 1;
      headers["Content-Length"] = String(length);
      if (range !== undefined) {
        headers["Content-Range"] = `bytes ${range.start}-${range.end}/${info.sizeBytes}`;
      }
      const status = range === undefined ? 200 : 206;

      if (req.method === "HEAD") {
        res.writeHead(status, headers);
        res.end();
        return;
      }
      const body = await deps.source.read(verified.objectKey, range);
      res.writeHead(status, headers);
      await pipeline(Readable.from(body), res);
    } catch {
      reason = "error";
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Length": "0", "Cache-Control": "no-store" });
        res.end();
      } else {
        res.destroy();
      }
    } finally {
      log(
        `${req.method ?? "?"} ${res.statusCode}${reason === null ? "" : ` (${reason})`} ${
          Date.now() - started
        }ms`,
      );
    }
  };
}
