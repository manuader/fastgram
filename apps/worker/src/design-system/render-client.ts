/**
 * Lo que el design system le pide a `services/render` — `PU-S9-001`.
 *
 * El worker no tiene `sharp` (y agregarlo es una dependencia que este sprint
 * no instala): rasterizar los motivos SVG lo hace el render, que ya lo trae,
 * en `POST /design-system/rasterize` (`services/render/src/render/
 * designSystemAssets.ts`). La respuesta trae el PNG en base64: pesa decenas
 * de KB y `/artifact/` sólo sirve MP4/JPEG.
 *
 * El servicio es interno (sin auth, como el resto de sus rutas); la URL sale
 * de `RENDER_SERVICE_URL`. Un error del servicio se traduce a `PortError`:
 * nunca sale su cuerpo crudo.
 */
import { PortError } from "@fastgram/ports";

export interface SvgRasterizer {
  /** PNG del SVG, con `currentColor` pintado de `color`, lado mayor `size`. */
  rasterize(svg: string, color: string, size: number): Promise<Uint8Array>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 30_000;
/** Un motivo rasterizado a 2048 px no pasa de unos MB. */
const MAX_PNG_BYTES = 20 * 1024 * 1024;

export function createRenderRasterizer(options: {
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
}): SvgRasterizer {
  const base = options.baseUrl.replace(/\/+$/u, "");
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    async rasterize(svg, color, size) {
      let response: Response;
      try {
        response = await doFetch(`${base}/design-system/rasterize`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ svg, color, size }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (cause) {
        throw new PortError(
          "provider_unavailable",
          "the render service did not respond",
          {
            source: "worker/design-system",
            cause,
          },
        );
      }
      if (!response.ok) {
        throw new PortError(
          response.status >= 500 ? "provider_unavailable" : "bad_request",
          `the render service rejected the SVG (${String(response.status)})`,
          { source: "worker/design-system" },
        );
      }
      const body = (await response.json()) as {
        dataBase64?: unknown;
        contentType?: unknown;
      };
      if (typeof body.dataBase64 !== "string" || body.contentType !== "image/png") {
        throw new PortError(
          "provider_contract_violation",
          "the render service returned no PNG",
          { source: "worker/design-system" },
        );
      }
      const bytes = new Uint8Array(Buffer.from(body.dataBase64, "base64"));
      if (bytes.byteLength > MAX_PNG_BYTES) {
        throw new PortError(
          "provider_contract_violation",
          "rasterized SVG is too large",
          {
            source: "worker/design-system",
          },
        );
      }
      return bytes;
    },
  };
}
