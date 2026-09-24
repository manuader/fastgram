/**
 * El handler de `brand-backgrounds` — `PU-MEDIA-002`.
 *
 * Genera el kit de fondos de una marca en `services/render` (sin proveedor,
 * sin keys), lo sube al storage y crea las filas de `media`: `ready`,
 * `origin = 'brand_kit'` (visibles en el Media Bank, migración `0013`) y ya
 * categorizadas (elegibles por Blitz: imágenes → `slideshow-image` +
 * `green-screen-background`, videos → `background-video`). Qué se genera y
 * con qué claves lo decide `planBrandKit` de `core`.
 *
 * ## La forma: leer corto, generar largo, escribir corto
 *
 * ```
 *   [tx 1]  perfil (paleta) + qué claves del kit ya tienen fila          ~ms
 *           render → put, pieza por pieza, sólo las que faltan           ~1 min
 *   [tx 2]  lock de la marca, insertar las que sigan faltando            ~ms
 * ```
 *
 * ## Idempotencia
 *
 * Las claves de storage son deterministas por semilla, y la misma semilla da
 * los mismos bytes. Entonces:
 *
 *  - una **reentrega** lee qué claves ya tienen fila y genera sólo el resto;
 *  - dos entregas **solapadas** pueden generar y subir la misma pieza dos
 *    veces —mismos bytes a la misma clave, inofensivo— y el lock de la tx 2
 *    hace que sólo una inserte (ver `packages/db/src/repositories/brand-kit.ts`);
 *  - nadie borra: a diferencia de la normalización, no hay un «archivo del
 *    ganador» que el perdedor pueda pisar con otra cosa.
 *
 * ## Fallos
 *
 * Si una pieza falla con un error **reintentable** (render caído, timeout), lo
 * ya generado se escribe igual y se relanza: la cola reintenta con backoff y
 * la próxima entrega sólo hace lo que falta. Un error **no reintentable**
 * (`bad_request`: el servicio rechazó la paleta o el grant) se loguea y el job
 * termina: repetirlo daría el mismo rechazo.
 */

import { canonicalObjectUrl } from "@fastgram/adapters";
import { BYTES_PER_MB } from "@fastgram/contracts";
import {
  parseBrandBackgroundsJob,
  planBrandKit,
  resolveBrandPalette,
  type BrandBackgroundsJob,
  type BrandKitItem,
} from "@fastgram/core";
import {
  brandKitStore,
  companyProfileRepository,
  companyRepository,
  withCompany,
  type BrandKitMediaInput,
  type Database,
  type Transaction,
} from "@fastgram/db";
import {
  PortError,
  type BrandBackgroundGenerator,
  type JobContext,
  type JobHandler,
  type MediaAuthorization,
  type Storage,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";

export interface BrandBackgroundsDeps {
  readonly db: Database;
  readonly generator: BrandBackgroundGenerator;
  readonly storage: Storage;
  /** Ver `ContentBuildDeps.appRole`: sin él, un superusuario saltea RLS. */
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
}

interface KitSubject {
  readonly palette: readonly string[];
  readonly paletteSource: "profile" | "default";
  readonly pending: readonly BrandKitItem[];
  readonly total: number;
}

/** `videoDurationSec` es entero en `DATA-010`. */
function wholeSeconds(seconds: number | undefined): number | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds);
}

export function createBrandBackgroundsHandler(
  deps: BrandBackgroundsDeps,
): JobHandler<unknown> {
  const inCompany = <T>(
    companyId: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> =>
    withCompany(
      deps.db,
      companyId,
      fn,
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );

  /** Tx 1: la paleta y qué falta. `null` si la marca no existe (o no es visible). */
  async function read(job: BrandBackgroundsJob): Promise<KitSubject | null> {
    return inCompany(job.companyId, async (tx) => {
      const scope = { companyId: job.companyId };
      const company = await companyRepository.load(tx, scope);
      if (company === null) return null;
      // `company_profiles` tiene un único índice por `companyId`.
      const profile = (await companyProfileRepository.list(tx, scope, { limit: 1 }))
        .items[0];
      const { palette, source } = resolveBrandPalette({
        companyId: job.companyId,
        profileTexts:
          profile === undefined
            ? []
            : [
                profile.coreIdentity,
                profile.productOffering,
                profile.uniqueBenefits,
                profile.problemSolution,
                profile.marketAndCompetition,
                profile.toneOfVoice,
                profile.targetAudience,
              ],
      });
      const items = planBrandKit(job);
      const existing = await brandKitStore.existingBrandKitKeys(
        tx,
        scope,
        items.map((i) => i.storageKey),
      );
      return {
        palette,
        paletteSource: source,
        pending: items.filter((i) => !existing.has(i.storageKey)),
        total: items.length,
      };
    });
  }

  /** Una pieza: render → put. Devuelve la fila a insertar. */
  async function generate(
    job: BrandBackgroundsJob,
    palette: readonly string[],
    item: BrandKitItem,
  ): Promise<BrandKitMediaInput> {
    // No hay media que leer: el grant sólo dice quién pide. Sin prefijos.
    const auth: MediaAuthorization = {
      companyId: job.companyId,
      mediaPrefixes: [],
      sharedPrefixes: [],
    };
    const media = await deps.generator.generateBrandBackground(
      item.kind === "image"
        ? { kind: "image", palette, seed: item.seed, aspectRatio: item.aspectRatio }
        : {
            kind: "video",
            palette,
            seed: item.seed,
            durationSeconds: item.durationSeconds,
          },
      auth,
    );
    const stored = await deps.storage.put({
      key: item.storageKey,
      body: media.body,
      contentType: media.contentType,
    });
    return {
      mediaType: item.kind,
      filename: item.filename,
      // La misma función que usa la API al finalizar una subida: la URL que el
      // grant del build va a autorizar (`media/<companyId>/`).
      r2Url: await canonicalObjectUrl(deps.storage, stored.key),
      storageKey: stored.key,
      sizeMb: stored.sizeBytes / BYTES_PER_MB,
      videoDurationSec:
        item.kind === "video" ? wholeSeconds(media.durationSeconds) : null,
      categories: item.categories,
    };
  }

  async function write(
    job: BrandBackgroundsJob,
    rows: readonly BrandKitMediaInput[],
  ): Promise<number> {
    if (rows.length === 0) return 0;
    return inCompany(job.companyId, async (tx) => {
      const scope = { companyId: job.companyId };
      // Antes de contar: ver la cabecera de `repositories/brand-kit.ts`.
      await brandKitStore.lockCompanyBrandKit(tx, scope);
      return brandKitStore.insertBrandKitMedia(tx, scope, rows);
    });
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parseBrandBackgroundsJob(ctx.payload);
    if (!parsed.ok) {
      // No se relanza: el mismo payload roto fallaría igual en cada intento.
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de brand-backgrounds inválido",
      );
      return;
    }
    const job = parsed.payload;
    const base = {
      jobId: ctx.jobId,
      companyId: job.companyId,
      seed: job.seed,
      attempt: ctx.attempt,
    };

    const subject = await read(job);
    if (subject === null) {
      deps.logger.info(base, "kit de fondos omitido: la marca no existe");
      return;
    }
    if (subject.pending.length === 0) {
      deps.logger.info(
        { ...base, total: subject.total },
        "kit de fondos omitido: todas las piezas ya tienen fila",
      );
      return;
    }

    const rows: BrandKitMediaInput[] = [];
    let failure: unknown = null;
    for (const item of subject.pending) {
      try {
        rows.push(await generate(job, subject.palette, item));
      } catch (error: unknown) {
        failure = error;
        break;
      }
    }

    // Lo generado se guarda aunque algo haya fallado: la reentrega sólo va a
    // hacer lo que falte.
    const inserted = await write(job, rows);

    if (failure === null) {
      deps.logger.info(
        {
          ...base,
          inserted,
          generated: rows.length,
          total: subject.total,
          paletteSource: subject.paletteSource,
        },
        "kit de fondos generado",
      );
      return;
    }

    const code = failure instanceof PortError ? failure.code : "internal_error";
    const retryable = failure instanceof PortError ? failure.isRetryable : true;
    const ultimoIntento = ctx.attempt >= ctx.maxAttempts;
    if (retryable && !ultimoIntento) {
      deps.logger.warn(
        { ...base, code, inserted, pending: subject.pending.length - rows.length },
        "kit de fondos incompleto, se reintenta",
      );
      throw failure instanceof Error ? failure : new Error(code);
    }
    // El mensaje de un `PortError` no lleva stderr ni rutas (lo garantiza el
    // adaptador); el código es lo que sirve para diagnosticar.
    deps.logger.error(
      { ...base, code, inserted, pending: subject.pending.length - rows.length },
      "kit de fondos fallido definitivamente",
    );
  };
}
