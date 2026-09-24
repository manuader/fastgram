/**
 * El callback de OAuth por el túnel (PU-PUB-002 + PU-RUN-005).
 *
 * El túnel apunta **sólo** a este proceso, que sirve `/public-media/*`. Pero las
 * plataformas que exigen https en el redirect URI (TikTok, verificado) mandan
 * al usuario a `${FASTGRAM_PUBLIC_URL}/api/fastgram/oauth/<red>/callback`, que
 * vive en la web. Decisión del coordinador (2026-09-24): este proceso reenvía a
 * la web **exactamente** ese `GET` —y nada más— en vez de abrir una segunda ruta
 * del túnel hacia la app entera. El resto sigue siendo 404.
 *
 * Qué se reenvía: método `GET`, la ruta y el query (`code`, `state`, errores de
 * la plataforma). Ningún header del cliente: la web no necesita cookies acá (la
 * marca viaja dentro del `state` firmado, que la API verifica). Qué vuelve: el
 * status, `Location` y `Content-Type`, y el cuerpo.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

const CALLBACK_RE =
  /^\/api\/fastgram\/oauth\/(instagram|facebook|threads|tiktok|x)\/callback$/;

/** `true` si la ruta es un callback de OAuth que hay que reenviar a la web. */
export function isOAuthCallbackPath(pathname: string): boolean {
  return CALLBACK_RE.test(pathname);
}

export interface OAuthCallbackProxyDeps {
  /** `http://127.0.0.1:3000`: la web local. */
  readonly webOrigin: string;
  readonly fetch?: typeof fetch;
  readonly log?: (line: string) => void;
}

export function createOAuthCallbackProxy(deps: OAuthCallbackProxyDeps) {
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? (() => undefined);

  return async function proxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://public-media.invalid");
    if (req.method !== "GET" || !isOAuthCallbackPath(url.pathname)) {
      res.writeHead(404, { "Content-Length": "0", "Cache-Control": "no-store" });
      res.end();
      return;
    }
    try {
      const upstream = await doFetch(`${deps.webOrigin}${url.pathname}${url.search}`, {
        method: "GET",
        redirect: "manual",
      });
      const headers: Record<string, string> = { "Cache-Control": "no-store" };
      const location = upstream.headers.get("location");
      if (location !== null) headers["Location"] = location;
      const type = upstream.headers.get("content-type");
      if (type !== null) headers["Content-Type"] = type;
      const body = Buffer.from(await upstream.arrayBuffer());
      headers["Content-Length"] = String(body.byteLength);
      res.writeHead(upstream.status, headers);
      res.end(body);
      // Ni el code ni el state al log: son de un solo uso, pero no hace falta.
      log(`oauth-callback ${url.pathname} → ${String(upstream.status)}`);
    } catch {
      log(`oauth-callback ${url.pathname} → 502`);
      res.writeHead(502, { "Content-Length": "0", "Cache-Control": "no-store" });
      res.end();
    }
  };
}
