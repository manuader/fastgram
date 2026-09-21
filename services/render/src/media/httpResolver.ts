/**
 * Descarga de media ya autorizada.
 *
 * Importante: este resolver NO decide nada sobre permisos. Para cuando se lo
 * llama, `urlPolicy` ya rechazó todo lo que no pertenece al workspace o a la
 * librería compartida. Acá sólo se aplica el límite de tamaño de `NFR-013`
 * (imágenes 10 MB, videos 50 MB) y un timeout.
 *
 * El límite se chequea mientras se descarga, no después: un `Content-Length`
 * mentiroso no debe poder llenar el disco.
 */
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { createHash } from "node:crypto";
import { RenderError } from "../errors.js";
import type { MediaResolver } from "../render/engine.js";

export interface HttpResolverOptions {
  readonly downloadDir: string;
  readonly maxBytes: (role: "image" | "video" | "audio") => number;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

function limitStream(maxBytes: number, url: string): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        callback(
          new RenderError("unsupported_media_format", "el medio excede el tamaño permitido", {
            details: { maxBytes, host: safeHost(url) },
          }),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

/** Sólo el host: una URL firmada puede llevar un token en la query. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "desconocido";
  }
}

export function createHttpMediaResolver(options: HttpResolverOptions): MediaResolver {
  const doFetch = options.fetchImpl ?? fetch;
  return async (url, role) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const name = createHash("sha256").update(url).digest("hex").slice(0, 32);
    const target = path.join(options.downloadDir, `${name}.${role}`);

    try {
      const response = await doFetch(url, { signal: controller.signal, redirect: "follow" });
      if (!response.ok || response.body === null) {
        throw new RenderError("media_probe_failed", "no se pudo descargar el medio", {
          details: { status: response.status, host: safeHost(url) },
        });
      }
      const max = options.maxBytes(role);
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > max) {
        throw new RenderError("unsupported_media_format", "el medio excede el tamaño permitido", {
          details: { maxBytes: max, host: safeHost(url) },
        });
      }
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        limitStream(max, url),
        createWriteStream(target),
      );
      return target;
    } catch (cause) {
      await unlink(target).catch(() => undefined);
      if (cause instanceof RenderError) throw cause;
      throw new RenderError("media_probe_failed", "no se pudo descargar el medio", {
        details: { host: safeHost(url) },
        cause,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}
