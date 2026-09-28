/**
 * La cola `design-system` — `PU-S9-001` (import) y `PU-S9-004` (generar).
 *
 * ## Import: leer corto, trabajar largo, escribir corto
 *
 * ```
 *   [tx 1]  la fila (tiene que estar `importing`) y el activo anterior    ~ms
 *           bajar el zip, abrirlo, parsearlo (core), subir assets y
 *           fuentes, rasterizar SVG (render), resumir el estilo (LLM)    ~s–min
 *   [tx 2]  lock de la marca, media nueva, activar esta versión          ~ms
 * ```
 *
 * ## Idempotencia
 *
 * Las claves de storage son deterministas (design system + sha256), así que
 * una reentrega sube los mismos bytes a las mismas claves; la tx 2 inserta en
 * `media` sólo las claves sin fila, bajo el lock. Una fila que ya no está
 * `importing` (terminó, o falló definitivamente) no se vuelve a procesar.
 *
 * ## Fallos
 *
 * Un zip malo (traversal, bomba, no es zip, vacío) cierra la fila `failed`
 * con su código estable **sin reintentar**: el mismo zip falla igual. Un
 * storage o un render caídos (`PortError` reintentable) se relanzan mientras
 * queden intentos; en el último, `failed` con `storage_failed`. El resumen de
 * estilo **nunca** hace fallar el import: sin modelo, o si el modelo contesta
 * algo inservible, queda el resumen heurístico.
 */
import { randomBytes } from "node:crypto";

import { canonicalObjectUrl } from "@fastgram/adapters";
import { BYTES_PER_MB } from "@fastgram/contracts";
import {
  BLITZ_MEDIA_CATEGORIES,
  buildDesignStyleRequest,
  contentTypeForExtension,
  designSystemAssetKey,
  designSystemFontKey,
  designSystemGeneratePalette,
  designSystemGeneratedKey,
  designSystemPalette,
  extensionOf,
  generateAspect,
  generateSeed,
  designSystemImagePrompt,
  heuristicDesignStyle,
  parseDesignStyle,
  parseDesignSystem,
  parseDesignSystemJob,
  readDesignSystemStyle,
  readDesignSystemTokens,
  readPendingAssets,
  type DesignSystemGenerateJob,
  type DesignSystemImportFailure,
  type DesignSystemImportJob,
  type DesignSystemStyle,
  type DesignSystemTokens,
  type DsAsset,
  type ParsedDesignSystem,
  type PendingDesignAsset,
} from "@fastgram/core";
import {
  designSystemRepository,
  lockCompanyDesignSystem,
  withCompany,
  type BrandDesignSystemRow,
  type Database,
  type DesignSystemMediaInput,
  type Transaction,
} from "@fastgram/db";
import {
  PortError,
  type BrandBackgroundGenerator,
  type JobContext,
  type JobHandler,
  type Llm,
  type Storage,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import type { SvgRasterizer } from "./render-client.js";
import { openDesignSystemZip } from "./unzip.js";

/** Lo que genera una imagen con el modelo `image` del registro (ver `mount.ts`). */
export interface DesignSystemImageModel {
  generate(input: {
    readonly prompt: string;
    readonly aspectRatio: "4:5" | "9:16";
    /** Id estable del pedido: entra al registro de gasto. */
    readonly generationId: string;
    readonly companyId: string;
  }): Promise<{ readonly bytes: Uint8Array; readonly contentType: string }>;
}

export interface DesignSystemHandlerDeps {
  readonly db: Database;
  readonly storage: Storage;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  /** El LLM de la tarea `text`, releído en cada job. `null` = sin modelo. */
  readonly textLlm: () => Promise<Llm | null>;
  /** `null` sin `services/render`: los SVG se saltean con aviso. */
  readonly rasterizer: SvgRasterizer | null;
  /** `null` sin `services/render`: no hay generación local. */
  readonly generator: BrandBackgroundGenerator | null;
  /** `null` sin modelo `image` configurado. Se pide en cada job. */
  readonly imageModel: () => Promise<DesignSystemImageModel | null>;
  readonly fence?: () => string;
  readonly now?: () => Date;
}

/** El zip entero se lee a memoria: el tope es el de `DESIGN_SYSTEM_ZIP_LIMITS`. */
const MAX_ZIP_BYTES = 100 * 1024 * 1024;
/** Lado mayor de un motivo rasterizado. */
const MOTIF_PX = 2048;
/** El resumen de estilo con un modelo local (Ollama) tarda: medido 204 s con FOCUS (1 835 tokens de entrada) en esta Mac con la app y otros agentes usando el mismo Ollama. */
const STYLE_TIMEOUT_MS = 300_000;

class ZipTooLarge extends Error {}

async function readObject(
  storage: Storage,
  key: string,
  max: number,
): Promise<Uint8Array> {
  const stream = await storage.get(key);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > max) throw new ZipTooLarge(`${key} exceeds ${String(max)} bytes`);
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Lo que se guarda en `brand_design_systems.assets`. */
export interface StoredDsAsset {
  readonly mediaId: string;
  readonly kind: "logo" | "imagery" | "motif" | "generated";
  readonly path: string;
  readonly filename: string;
}

/** Lo que se guarda en `brand_design_systems.fonts`. */
export interface StoredDsFontFile {
  readonly fileRef: string;
  readonly familyId: string;
  readonly weight: number;
  readonly style: "normal" | "italic";
  readonly storageKey: string;
  readonly url: string;
  readonly contentType: string;
  readonly bytes: number;
}

interface Uploaded {
  readonly media: DesignSystemMediaInput[];
  readonly assets: (Omit<StoredDsAsset, "mediaId"> & { readonly storageKey: string })[];
  readonly fonts: StoredDsFontFile[];
}

export function fontFileRef(
  familyId: string,
  weight: number,
  style: "normal" | "italic",
): string {
  return `${familyId}-${String(weight)}${style === "italic" ? "i" : ""}`;
}

/** Las licencias que el dueño ya tildó en la versión anterior siguen tildadas. */
export function carryLicenses(
  tokens: DesignSystemTokens,
  previous: DesignSystemTokens | null,
): DesignSystemTokens {
  if (previous === null) return tokens;
  const confirmed = new Set(
    previous.families.filter((f) => f.licenseConfirmed).map((f) => f.id),
  );
  return {
    ...tokens,
    families: tokens.families.map((f) =>
      f.license === "needs_confirmation" && confirmed.has(f.id)
        ? { ...f, licenseConfirmed: true }
        : f,
    ),
  };
}

export function createDesignSystemHandler(
  deps: DesignSystemHandlerDeps,
): JobHandler<unknown> {
  const fence = deps.fence ?? (() => `data-${randomBytes(16).toString("hex")}`);
  const now = deps.now ?? (() => new Date());
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

  async function fail(
    job: { companyId: string; designSystemId: string },
    code: DesignSystemImportFailure,
    message: string,
  ): Promise<void> {
    await inCompany(job.companyId, (tx) =>
      designSystemRepository.update(
        tx,
        { companyId: job.companyId },
        job.designSystemId,
        {
          status: "failed",
          failureCode: code,
          failureMessage: message.slice(0, 500),
        },
      ),
    );
  }

  /* ---------------------------------------------------------------- *
   * Resumen de estilo
   * ---------------------------------------------------------------- */

  async function summarize(
    ds: ParsedDesignSystem,
    base: Record<string, unknown>,
  ): Promise<DesignSystemStyle> {
    const heuristic = heuristicDesignStyle(ds);
    let llm: Llm | null = null;
    try {
      llm = await deps.textLlm();
    } catch (error: unknown) {
      deps.logger.warn(
        { ...base, error },
        "no se pudo resolver el modelo text: resumen heurístico",
      );
    }
    if (llm === null || (ds.readme === null && ds.rules.length === 0)) return heuristic;
    try {
      const request = buildDesignStyleRequest(ds, fence());
      const completion = await llm.completeJson({
        ...request,
        timeoutMs: STYLE_TIMEOUT_MS,
      });
      if (completion.finishReason !== "stop") {
        deps.logger.warn(
          { ...base, finishReason: completion.finishReason, model: completion.model },
          "el resumen de estilo no terminó: se usa el heurístico",
        );
        return heuristic;
      }
      const parsed = parseDesignStyle(completion.value);
      if (parsed === null) {
        deps.logger.warn(
          { ...base, model: completion.model },
          "resumen de estilo inservible: heurístico",
        );
        return heuristic;
      }
      // Lo que el modelo no vio o dejó vacío, de la heurística (nunca inventado).
      return {
        ...parsed,
        tagline: parsed.tagline ?? heuristic.tagline,
        values: parsed.values.length > 0 ? parsed.values : heuristic.values,
        language: parsed.language ?? heuristic.language,
      };
    } catch (error: unknown) {
      deps.logger.warn(
        { ...base, code: error instanceof PortError ? error.code : "internal_error" },
        "el modelo text falló en el resumen de estilo: heurístico",
      );
      return heuristic;
    }
  }

  /* ---------------------------------------------------------------- *
   * Import
   * ---------------------------------------------------------------- */

  async function runImport(
    ctx: JobContext<unknown>,
    job: DesignSystemImportJob,
  ): Promise<void> {
    const scope = { companyId: job.companyId };
    const base = {
      jobId: ctx.jobId,
      companyId: job.companyId,
      designSystemId: job.designSystemId,
    };

    const subject = await inCompany(job.companyId, async (tx) => {
      const row = await designSystemRepository.findById(tx, scope, job.designSystemId);
      const active = await designSystemRepository.findActive(tx, scope);
      return {
        row,
        previous: active === null ? null : readDesignSystemTokens(active.tokens),
      };
    });
    if (subject.row === null) {
      deps.logger.info(base, "import de design system omitido: la fila no existe");
      return;
    }
    if (subject.row.status !== "importing") {
      deps.logger.info(
        { ...base, status: subject.row.status },
        "import de design system ya cerrado",
      );
      return;
    }

    let zip: Uint8Array;
    try {
      zip = await readObject(deps.storage, job.zipKey, MAX_ZIP_BYTES);
    } catch (error: unknown) {
      if (error instanceof ZipTooLarge) {
        await fail(job, "zip_too_large", error.message);
        return;
      }
      if (error instanceof PortError && error.code === "not_found") {
        await fail(job, "storage_failed", "the uploaded zip is not in storage");
        return;
      }
      throw error;
    }

    const opened = openDesignSystemZip(zip);
    if (!opened.ok) {
      deps.logger.warn(
        { ...base, code: opened.code, detail: opened.detail },
        "zip de design system rechazado",
      );
      await fail(job, opened.code, opened.detail);
      return;
    }
    const parsed = parseDesignSystem(opened.entries);
    if (!parsed.ok) {
      await fail(job, parsed.code, parsed.detail);
      return;
    }
    const ds = parsed.ds;
    const warnings = [...ds.warnings];

    let uploaded: Uploaded;
    try {
      uploaded = await uploadFiles(job, ds, opened.files, warnings);
    } catch (error: unknown) {
      const retryable = error instanceof PortError ? error.isRetryable : true;
      if (retryable && ctx.attempt < ctx.maxAttempts) {
        deps.logger.warn(
          { ...base, code: error instanceof PortError ? error.code : "internal_error" },
          "subida del design system incompleta, se reintenta",
        );
        throw error instanceof Error ? error : new Error("upload failed");
      }
      await fail(
        job,
        "storage_failed",
        error instanceof PortError ? error.code : "upload failed",
      );
      return;
    }

    const style = await summarize(ds, base);
    const tokens = carryLicenses(ds.tokens, subject.previous);

    const row = await inCompany(job.companyId, async (tx) => {
      await lockCompanyDesignSystem(tx, scope);
      const ids = await designSystemRepository.insertMedia(tx, scope, uploaded.media);
      const assets: StoredDsAsset[] = [];
      for (const { storageKey, ...a } of uploaded.assets) {
        const mediaId = ids.get(storageKey);
        if (mediaId !== undefined) assets.push({ ...a, mediaId });
      }
      return designSystemRepository.activate(tx, scope, job.designSystemId, {
        name: ds.name,
        description: ds.description,
        tokens,
        style,
        assets,
        fonts: uploaded.fonts,
        warnings: warnings.slice(0, 50),
        failureCode: null,
        failureMessage: null,
      });
    });

    deps.logger.info(
      {
        ...base,
        activated: row !== null,
        colors: ds.tokens.colors.length,
        families: ds.tokens.families.length,
        media: uploaded.media.length,
        fontFiles: uploaded.fonts.length,
        style: style.origin,
        skipped: opened.skipped,
        warnings: warnings.length,
      },
      "design system importado",
    );
  }

  /** Sube assets y fuentes. Devuelve las filas de media a crear y lo que va a la fila. */
  async function uploadFiles(
    job: DesignSystemImportJob,
    ds: ParsedDesignSystem,
    files: ReadonlyMap<string, Uint8Array>,
    warnings: string[],
  ): Promise<Uploaded> {
    const media: DesignSystemMediaInput[] = [];
    const assets: Uploaded["assets"][number][] = [];
    const motifColor =
      ds.tokens.semantic.accents[0] ?? ds.tokens.semantic.textOnDark ?? "#FFFFFF";

    for (const asset of ds.assets) {
      if (asset.kind === "font") continue;
      const bytes = files.get(asset.path);
      if (bytes === undefined) continue;
      const ext = extensionOf(asset.path);
      let body = bytes;
      let outExt = ext;
      if (ext === ".svg") {
        if (deps.rasterizer === null) {
          warnings.push(
            `${asset.path}: skipped (the render service is not configured to rasterize SVG)`,
          );
          continue;
        }
        body = await deps.rasterizer.rasterize(
          new TextDecoder().decode(bytes),
          motifColor,
          MOTIF_PX,
        );
        outExt = ".png";
      }
      const contentType = contentTypeForExtension(outExt);
      if (contentType === null) continue;
      const key = designSystemAssetKey(
        job.companyId,
        job.designSystemId,
        asset.kind,
        asset.sha256,
        outExt,
      );
      const stored = await deps.storage.put({ key, body, contentType });
      const filename = fileName(asset.path).replace(/\.svg$/iu, ".png");
      media.push({
        mediaType: "image",
        filename,
        r2Url: await canonicalObjectUrl(deps.storage, stored.key),
        storageKey: stored.key,
        sizeMb: stored.sizeBytes / BYTES_PER_MB,
        categories: asset.kind === "imagery" ? categoriesFor(asset) : [],
        tags: [asset.kind],
      });
      assets.push({
        kind: asset.kind,
        path: asset.path,
        filename,
        storageKey: stored.key,
      });
    }

    const fonts: StoredDsFontFile[] = [];
    for (const family of ds.tokens.families) {
      for (const face of family.faces) {
        const bytes = files.get(face.file);
        if (bytes === undefined) continue;
        const ext = extensionOf(face.file);
        const contentType = contentTypeForExtension(ext);
        if (contentType === null) continue;
        const key = designSystemFontKey(
          job.companyId,
          job.designSystemId,
          family.id,
          face.weight,
          face.style,
          ext,
        );
        const stored = await deps.storage.put({ key, body: bytes, contentType });
        fonts.push({
          fileRef: fontFileRef(family.id, face.weight, face.style),
          familyId: family.id,
          weight: face.weight,
          style: face.style,
          storageKey: stored.key,
          url: await canonicalObjectUrl(deps.storage, stored.key),
          contentType,
          bytes: stored.sizeBytes,
        });
      }
    }
    return { media, assets, fonts };
  }

  /* ---------------------------------------------------------------- *
   * Generar (pendientes de aprobación)
   * ---------------------------------------------------------------- */

  async function runGenerate(
    ctx: JobContext<unknown>,
    job: DesignSystemGenerateJob,
  ): Promise<void> {
    const scope = { companyId: job.companyId };
    const base = {
      jobId: ctx.jobId,
      companyId: job.companyId,
      designSystemId: job.designSystemId,
      requestId: job.requestId,
    };
    const row = await inCompany(job.companyId, (tx) =>
      designSystemRepository.findById(tx, scope, job.designSystemId),
    );
    if (row === null || row.status !== "ready") {
      deps.logger.info(
        base,
        "generación omitida: el design system no existe o no está listo",
      );
      return;
    }
    const tokens = readDesignSystemTokens(row.tokens);
    if (tokens === null) {
      deps.logger.error(base, "generación omitida: tokens ilegibles");
      return;
    }
    const style = readDesignSystemStyle(row.style);
    const already = new Set(
      readPendingAssets(row.pendingAssets).map((p) => p.storageKey),
    );
    const palette = designSystemPalette(tokens);
    const created: PendingDesignAsset[] = [];
    let failure: unknown = null;

    const push = async (
      index: number,
      generator: "local" | "model",
      body: Uint8Array | AsyncIterable<Uint8Array>,
      contentType: string,
    ) => {
      const ext =
        contentType === "image/png"
          ? ".png"
          : contentType === "image/webp"
            ? ".webp"
            : ".jpg";
      const key = designSystemGeneratedKey(
        job.companyId,
        job.designSystemId,
        job.requestId,
        index,
        ext,
      );
      if (already.has(key)) return;
      const stored = await deps.storage.put({ key, body, contentType });
      created.push({
        id: `${job.requestId.slice(0, 8)}-${String(index + 1)}`,
        requestId: job.requestId,
        storageKey: stored.key,
        url: await canonicalObjectUrl(deps.storage, stored.key),
        generator,
        contentType,
        sizeBytes: stored.sizeBytes,
        createdAt: now().getTime(),
      });
    };

    try {
      if (job.localImages > 0) {
        if (deps.generator === null || palette === null) {
          deps.logger.warn(
            { ...base, render: deps.generator !== null, palette: palette !== null },
            "generación local omitida: sin render o sin paleta",
          );
        } else {
          for (let i = 0; i < job.localImages; i += 1) {
            const key = designSystemGeneratedKey(
              job.companyId,
              job.designSystemId,
              job.requestId,
              i,
              ".jpg",
            );
            if (already.has(key)) continue;
            const media = await deps.generator.generateBrandBackground(
              {
                kind: "image",
                palette: designSystemGeneratePalette(tokens, i) ?? palette,
                seed: generateSeed(job.requestId, i),
                aspectRatio: generateAspect(i),
              },
              { companyId: job.companyId, mediaPrefixes: [], sharedPrefixes: [] },
            );
            await push(i, "local", media.body, media.contentType);
          }
        }
      }
      if (job.modelImages > 0) {
        const model = await deps.imageModel();
        if (model === null) {
          deps.logger.warn(
            base,
            "generación con modelo omitida: no hay modelo image configurado",
          );
        } else {
          for (let j = 0; j < job.modelImages; j += 1) {
            const index = job.localImages + j;
            const out = await model.generate({
              prompt: designSystemImagePrompt(tokens, style, j),
              aspectRatio: generateAspect(j + 1),
              generationId: `${job.requestId}:${String(index)}`,
              companyId: job.companyId,
            });
            await push(index, "model", out.bytes, out.contentType);
          }
        }
      }
    } catch (error: unknown) {
      failure = error;
    }

    if (created.length > 0) {
      await inCompany(job.companyId, async (tx) => {
        await lockCompanyDesignSystem(tx, scope);
        const fresh = await designSystemRepository.findById(
          tx,
          scope,
          job.designSystemId,
        );
        if (fresh === null) return;
        const pending = readPendingAssets(fresh.pendingAssets);
        const keys = new Set(pending.map((p) => p.storageKey));
        await designSystemRepository.update(tx, scope, job.designSystemId, {
          pendingAssets: [...pending, ...created.filter((c) => !keys.has(c.storageKey))],
        });
      });
    }
    if (failure === null) {
      deps.logger.info(
        { ...base, created: created.length },
        "assets del design system generados (pendientes)",
      );
      return;
    }
    const retryable = failure instanceof PortError ? failure.isRetryable : true;
    if (retryable && ctx.attempt < ctx.maxAttempts) {
      deps.logger.warn(
        { ...base, created: created.length },
        "generación incompleta, se reintenta",
      );
      throw failure instanceof Error ? failure : new Error("generate failed");
    }
    deps.logger.error(
      {
        ...base,
        created: created.length,
        code: failure instanceof PortError ? failure.code : "internal_error",
      },
      "generación de assets del design system fallida",
    );
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parseDesignSystemJob(ctx.payload);
    if (!parsed.ok) {
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de design-system inválido",
      );
      return;
    }
    if (parsed.job.kind === "import") await runImport(ctx, parsed.job);
    else await runGenerate(ctx, parsed.job);
  };
}

/** Imágenes del design system → las categorías que usa Blitz para fondos. */
function categoriesFor(_asset: DsAsset): string[] {
  return [
    BLITZ_MEDIA_CATEGORIES.slideshowImage,
    BLITZ_MEDIA_CATEGORIES.greenScreenBackground,
  ];
}

export type { BrandDesignSystemRow };
