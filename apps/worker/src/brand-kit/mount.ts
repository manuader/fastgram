/**
 * Cómo se monta `brand-backgrounds` y cómo lo dispara el refill — `PU-MEDIA-002`.
 */
import {
  AUTO_BRAND_KIT_SEED,
  DEFAULT_BRAND_KIT_IMAGES,
  DEFAULT_BRAND_KIT_VIDEOS,
  JOB_QUEUES,
  brandKitSingletonKey,
  type BrandBackgroundsJob,
} from "@fastgram/core";
import type { BrandBackgroundGenerator, MediaRenderer, Queue } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";

export const BRAND_BACKGROUNDS_UNMOUNTED_WHY =
  "RENDER_SERVICE_URL y RENDER_MEDIA_GRANT_SECRET no están configuradas: los kits " +
  "de fondos de marca esperan en la cola hasta que un worker con el servicio de " +
  "render configurado los tome, y una marca sin media sigue sin poder usar Blitz";

/**
 * El generador, sacado del renderer de `media-normalization`.
 *
 * Ese renderer existe **sólo** con `services/render` configurado (el de
 * memoria no se usa para normalizar, trampa 46), y es un `HttpMediaRenderer`,
 * que implementa también `BrandBackgroundGenerator`. Su presupuesto de tiempo
 * (el de un transcode, minutos) le sirve a un loop de video de 8 s. Así el
 * worker no pide `/capabilities` una tercera vez ni arma otra instancia.
 *
 * Se decide por la **forma** y no por `instanceof` para que un doble de test
 * que implemente los dos puertos también cuente.
 */
export function brandBackgroundGeneratorFrom(
  renderer: MediaRenderer | null,
): BrandBackgroundGenerator | null {
  if (renderer === null) return null;
  const candidate = renderer as Partial<BrandBackgroundGenerator>;
  return typeof candidate.generateBrandBackground === "function"
    ? (renderer as unknown as BrandBackgroundGenerator)
    : null;
}

/** El kit automático: la semilla fija de `core` y las cantidades por defecto. */
export function autoBrandKitJob(companyId: string): BrandBackgroundsJob {
  return {
    companyId,
    seed: AUTO_BRAND_KIT_SEED,
    images: DEFAULT_BRAND_KIT_IMAGES,
    videos: DEFAULT_BRAND_KIT_VIDEOS,
  };
}

/** Los `maxAttempts: 3` del catálogo. pg-boss cuenta reintentos, no intentos. */
const RETRY_LIMIT = 2;

/**
 * Lo que el refill llama cuando no pudo planificar por falta de media.
 *
 * **Una vez en la vida de la marca**: la clave es fija (trampa 39, a
 * propósito — ver `AUTO_BRAND_KIT_SEED`). Se mira `created` (trampa 45): el
 * log dice si encoló o si ya estaba, en vez de afirmar siempre lo primero.
 *
 * Nunca lanza: un refill que no pudo planificar no tiene que fallar además
 * por no poder encolar el remedio. Lo dice el log.
 */
export function createAutoBrandKitTrigger(
  queue: Pick<Queue, "enqueue">,
  logger: BuildLogger,
): (companyId: string) => Promise<void> {
  return async (companyId) => {
    const job = autoBrandKitJob(companyId);
    try {
      const enqueued = await queue.enqueue<BrandBackgroundsJob>({
        queue: JOB_QUEUES.brandBackgrounds,
        payload: job,
        options: {
          singletonKey: brandKitSingletonKey(job),
          retryLimit: RETRY_LIMIT,
          retryBackoff: true,
        },
      });
      logger.info(
        { companyId, jobId: enqueued.jobId, created: enqueued.created },
        enqueued.created
          ? "Media Bank sin media para Blitz: kit de fondos de marca encolado"
          : "Media Bank sin media para Blitz: el kit automático ya se había encolado antes",
      );
    } catch (error: unknown) {
      logger.error(
        { companyId, error },
        "no se pudo encolar el kit de fondos automático",
      );
    }
  };
}
