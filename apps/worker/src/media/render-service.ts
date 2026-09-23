/**
 * Qué renderer recibe cada cola — `P2-RENDER-015`.
 *
 * Con `RENDER_SERVICE_URL` + `RENDER_MEDIA_GRANT_SECRET` (las dos o ninguna; lo
 * corta `loadWorkerEnv`) hay **dos** `HttpMediaRenderer` contra el mismo
 * servicio, con la misma versión de motor pedida **una** vez a
 * `GET /capabilities`:
 *
 *  - **`build`**, compartido por `content-build` y `content-rebuild`. Una sola
 *    instancia para las dos, y no por ahorro: un rebuild es el mismo render con
 *    otra revisión, y con otro motor o con otra versión de motor una edición
 *    que no cambia nada produciría una pieza que se ve distinta (ver el
 *    comentario de `content-rebuild` en `handlers.ts`).
 *  - **`normalization`**, aparte, porque su presupuesto es otro: transcodificar
 *    un MOV de 50 MB puede pasar los 2 min que son el techo de un build
 *    (`NFR-001`, el default del adaptador). Ver `normalization-renderer.ts`.
 *
 * Sin configuración, `content-build` y `content-rebuild` siguen con
 * `MemoryMediaRenderer` —el pipeline corre de punta a punta con bytes
 * sintéticos— y `media-normalization` no se monta.
 *
 * ## Por qué ahora sí se monta el real para los builds
 *
 * Hasta el 2026-09-23 no se montaba porque «rompería todos los builds»: las
 * fuentes no cargaban y cada build habría terminado `font_unavailable` —pieza
 * fallada y save reembolsado, en bucle—. Eso se cerró del lado de
 * `services/render` (`render/fontActivation.ts`): con `RENDER_FONT_DIR`
 * poblado por `pnpm fonts:fetch`, las 10 familias OFL cargan por nombre sin
 * instalar nada. Quien configura el servicio de render lo quiere para
 * renderizar; si el servicio arranca sin fuentes, `GET /capabilities` y su log
 * de arranque lo dicen, y cada build falla con un código que lo nombra.
 *
 * Lo que sigue abierto y **no** bloquea a Blitz: `tiktok`/`snapchat` sin
 * archivo (una pieza que las pida falla `font_unavailable`, y ningún payload
 * de hoy las pide: sin `fontFamily`, el adaptador usa `inter`), y el audio sin
 * origen (`sharedPrefixes` vacío: una pieza **con** audio se rechaza).
 */
import {
  fetchRenderEngineVersion,
  HttpMediaRenderer,
  MemoryMediaRenderer,
  type RenderFetch,
} from "@fastgram/adapters";
import type { Clock, MediaRenderer } from "@fastgram/ports";

import type { RenderServiceConfig } from "../env.js";
import { normalizationRendererFor } from "./normalization-renderer.js";

/** Arrancar no espera dos minutos a un servicio que no contesta. */
const CAPABILITIES_TIMEOUT_MS = 10_000;

export interface RenderServiceRenderers {
  /** `content-build` y `content-rebuild`. */
  readonly build: HttpMediaRenderer;
  /** `media-normalization`. */
  readonly normalization: HttpMediaRenderer;
}

export interface RenderServiceOptions {
  /** Para test. En producción, el `fetch` global. */
  readonly fetch?: RenderFetch;
  readonly clock?: Clock;
}

/**
 * Pide la versión del motor y arma los dos renderers. Si el servicio no
 * contesta, **lanza**: el worker no levanta (ver `normalization-renderer.ts`
 * por qué esa es la regla).
 */
export async function createRenderServiceRenderers(
  config: RenderServiceConfig,
  options: RenderServiceOptions = {},
): Promise<RenderServiceRenderers> {
  const engineVersion = await fetchRenderEngineVersion({
    baseUrl: config.baseUrl,
    timeoutMs: CAPABILITIES_TIMEOUT_MS,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const shared = {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  };
  return {
    // Timeout y TTL del grant: los defaults del adaptador, que son el techo de
    // un build (`NFR-001`, 2 min) y un grant que cubre pedido + bajada.
    build: new HttpMediaRenderer({
      baseUrl: config.baseUrl,
      engineVersion,
      grantSecret: config.grantSecret,
      ...shared,
    }),
    normalization: normalizationRendererFor(config, engineVersion, shared),
  };
}

export interface WorkerRenderers {
  readonly renderer: MediaRenderer;
  readonly normalizationRenderer: MediaRenderer | null;
}

/**
 * La decisión de `main.ts`, sacada de ahí para que un test la atraviese junto
 * con `createHandlers` (trampa 46: un test de «qué se monta» no ve «con qué»).
 */
export function selectWorkerRenderers(
  created: RenderServiceRenderers | null,
): WorkerRenderers {
  if (created === null) {
    return { renderer: new MemoryMediaRenderer(), normalizationRenderer: null };
  }
  return { renderer: created.build, normalizationRenderer: created.normalization };
}
