/**
 * El `HttpMediaRenderer` de `media-normalization` — y **sólo** de esa cola.
 *
 * `content-build` sigue con `MemoryMediaRenderer` (ver `main.ts` y
 * `P2-RENDER-015`: sin las fuentes, el real rompería todos los builds). `probe`
 * y `normalize` no dibujan texto, así que ese bloqueo no les aplica, y por eso
 * esta instancia existe aparte.
 *
 * ## La versión del motor, al arrancar
 *
 * El adaptador la exige en el constructor (entra al fingerprint) y no tiene
 * default a propósito. `probe`/`normalize` no calculan fingerprint, pero
 * inventar una etiqueta sería dejar una instancia que, el día que alguien la
 * reutilice para `content-build`, sirve frames viejos de la cache sin avisar.
 * Se pide a `GET /capabilities`, que además comprueba **que la URL apunta de
 * verdad a un servicio de render con FFmpeg**.
 *
 * Consecuencia que hay que saber: con la configuración puesta y el servicio
 * caído, **el worker no levanta** — tampoco las otras colas. Es la misma regla
 * que el entorno (P0-REPO-009): quien configuró el render lo quiere, y un
 * worker que arranca sin él lo diría sólo en la base, video por video.
 */
import {
  fetchRenderEngineVersion,
  HttpMediaRenderer,
  type RenderFetch,
} from "@fastgram/adapters";
import type { Clock } from "@fastgram/ports";

import type { RenderServiceConfig } from "../env.js";
import { JOB_CATALOG } from "../jobs/catalog.js";

/**
 * Presupuesto de un pedido HTTP de normalización.
 *
 * El default del adaptador (2 min) es el techo de un **build** (`NFR-001`), y
 * transcodificar un MOV de 50 MB (`NFR-013`) puede pasarlo. El techo acá es el
 * del job en el catálogo, con margen para el `put` a storage y la escritura
 * final: si el HTTP se comiera los 600 s enteros, el job vencería con el
 * trabajo hecho y sin guardar.
 */
export const NORMALIZATION_REQUEST_TIMEOUT_MS = Math.floor(
  JOB_CATALOG.mediaNormalization.timeoutSeconds * 1000 * 0.8,
);

/**
 * Cubre un pedido completo más la bajada de su artefacto: el grant se acuña
 * **por pedido** (ver el adaptador), así que no tiene que sobrevivir al job.
 */
export const NORMALIZATION_GRANT_TTL_MS =
  JOB_CATALOG.mediaNormalization.timeoutSeconds * 1000;

/** Arrancar no espera dos minutos a un servicio que no contesta. */
const CAPABILITIES_TIMEOUT_MS = 10_000;

export interface NormalizationRendererOptions {
  /** Para test. En producción, el `fetch` global. */
  readonly fetch?: RenderFetch;
  readonly clock?: Clock;
}

export async function createNormalizationRenderer(
  config: RenderServiceConfig,
  options: NormalizationRendererOptions = {},
): Promise<HttpMediaRenderer> {
  const engineVersion = await fetchRenderEngineVersion({
    baseUrl: config.baseUrl,
    timeoutMs: CAPABILITIES_TIMEOUT_MS,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return new HttpMediaRenderer({
    baseUrl: config.baseUrl,
    engineVersion,
    grantSecret: config.grantSecret,
    grantTtlMs: NORMALIZATION_GRANT_TTL_MS,
    timeoutMs: NORMALIZATION_REQUEST_TIMEOUT_MS,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}
