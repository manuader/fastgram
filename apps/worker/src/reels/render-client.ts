/**
 * Lo que el planificador de reels le pide a `services/render` fuera del puerto
 * `ReelRenderer` — sprint 9 (U), `PU-S9-014`:
 *
 *  - `POST /reels/poster`: un cuadro del reel (JPEG) para la tarjeta del deck,
 *    compuesto por el mismo motor sin renderizar el video entero;
 *  - `POST /reels/image-stats`: la luminancia de los logos y del fondo, para
 *    elegir el logo claro u oscuro por código (el worker no tiene `sharp`).
 *
 * Mismo criterio que `design-system/render-client.ts` (M): cliente chico, la
 * URL de `RENDER_SERVICE_URL`, errores traducidos a `PortError` (nunca sale el
 * cuerpo crudo del servicio). A diferencia de aquél, estas rutas bajan media:
 * llevan el **mismo grant firmado** que un render (`signMediaGrant`).
 */
import { signMediaGrant } from "@fastgram/adapters";
import { PortError, type MediaAuthorization } from "@fastgram/ports";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ReelRenderClient {
  poster(
    spec: unknown,
    auth: MediaAuthorization,
  ): Promise<{ readonly bytes: Uint8Array; readonly atSec: number }>;
  imageStats(
    urls: readonly string[],
    auth: MediaAuthorization,
  ): Promise<ReadonlyMap<string, number | null>>;
}

const SOURCE = "worker/reels";
/** El póster espera en la cola del render detrás de un reel: hasta 12 min. */
const POSTER_TIMEOUT_MS = 12 * 60_000;
const STATS_TIMEOUT_MS = 60_000;
/** Un JPEG de 720 px de ancho no pasa de unos cientos de KB. */
const MAX_POSTER_BYTES = 8 * 1024 * 1024;
/** Lo mismo que el adaptador: una hora. */
const GRANT_TTL_MS = 60 * 60_000;

export function createReelRenderClient(options: {
  readonly baseUrl: string;
  readonly grantSecret: string | null;
  readonly fetch?: FetchLike;
  readonly nowMs?: () => number;
}): ReelRenderClient {
  const base = options.baseUrl.replace(/\/+$/u, "");
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.nowMs ?? Date.now;
  const grantOf = (auth: MediaAuthorization) =>
    options.grantSecret === null
      ? {}
      : { grant: signMediaGrant(auth, { secret: options.grantSecret, nowMs: now(), ttlMs: GRANT_TTL_MS }) };

  async function post(route: string, body: unknown, timeoutMs: number): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${base}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new PortError("provider_unavailable", "the render service did not respond", {
        source: SOURCE,
        cause,
      });
    }
    if (!response.ok) {
      throw new PortError(
        response.status >= 500 ? "provider_unavailable" : "bad_request",
        `the render service rejected ${route} (${String(response.status)})`,
        { source: SOURCE },
      );
    }
    return response.json() as Promise<unknown>;
  }

  return {
    async poster(spec, auth) {
      const out = (await post("/reels/poster", { spec, ...grantOf(auth) }, POSTER_TIMEOUT_MS)) as {
        href?: unknown;
        atSec?: unknown;
      };
      const href = out.href;
      if (typeof href !== "string" || !/^\/artifact\/[0-9a-f]{64}\.jpg$/u.test(href)) {
        throw new PortError("provider_contract_violation", "the poster response has no href", {
          source: SOURCE,
        });
      }
      let response: Response;
      try {
        response = await doFetch(`${base}${href}`, {
          signal: AbortSignal.timeout(STATS_TIMEOUT_MS),
        });
      } catch (cause) {
        throw new PortError("provider_unavailable", "the poster could not be downloaded", {
          source: SOURCE,
          cause,
        });
      }
      if (!response.ok) {
        throw new PortError("provider_unavailable", "the poster could not be downloaded", {
          source: SOURCE,
        });
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_POSTER_BYTES) {
        throw new PortError("provider_contract_violation", "the poster has an odd size", {
          source: SOURCE,
        });
      }
      return { bytes, atSec: typeof out.atSec === "number" ? out.atSec : 0 };
    },

    async imageStats(urls, auth) {
      if (urls.length === 0) return new Map();
      const out = (await post(
        "/reels/image-stats",
        { urls, ...grantOf(auth) },
        STATS_TIMEOUT_MS,
      )) as { images?: unknown };
      const map = new Map<string, number | null>();
      if (!Array.isArray(out.images)) return map;
      for (const i of out.images as unknown[]) {
        if (typeof i !== "object" || i === null) continue;
        const r = i as { url?: unknown; luminance?: unknown };
        if (typeof r.url !== "string") continue;
        map.set(r.url, typeof r.luminance === "number" ? r.luminance : null);
      }
      return map;
    },
  };
}

/** El cliente desde el entorno del worker, o `null` sin `RENDER_SERVICE_URL`. */
export function reelRenderClientFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ReelRenderClient | null {
  const baseUrl = env["RENDER_SERVICE_URL"]?.trim() ?? "";
  if (baseUrl === "") return null;
  const secret = env["RENDER_MEDIA_GRANT_SECRET"]?.trim() ?? "";
  return createReelRenderClient({ baseUrl, grantSecret: secret === "" ? null : secret });
}
