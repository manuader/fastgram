/**
 * Design system por marca — `/design-system` (sprint 9, agente M,
 * `PU-S9-001…004`, migración `0035`). Contratos en
 * `packages/contracts/src/resources/design-system.ts`.
 *
 * ## El import es la subida de siempre, con otro prefijo
 *
 * §9.8: `POST /design-system/upload-url` reserva con `reserveUpload` bajo
 * `design-systems/{companyId}/uploads` (el render **no** lee ese prefijo: el
 * zip no es media), el navegador hace el PUT, y `POST /design-system/import`
 * reclama la reserva, crea la versión nueva `importing` (inactiva: la marca
 * sigue con el activo anterior) y encola `design-system` (`kind: import`).
 * Todo lo pesado —abrir el zip, guardas, subir assets y fuentes, resumir el
 * estilo— es del worker (`apps/worker/src/design-system`).
 *
 * ## Qué se puede editar
 *
 * La paleta (reemplaza los colores y recalcula los roles), la licencia de
 * cada familia con archivos («tengo licencia»), el reemplazo registrado de
 * cada familia, el resumen de estilo y el nombre. Las ediciones van sobre la
 * versión pedida (normalmente la activa) sin crear otra.
 *
 * ## Generados
 *
 * `POST …/generate` encola; lo generado queda en `pending_assets` y recién
 * `…/approve` lo suma al Media Bank con el tag `design-system` (y las
 * categorías de fondo de Blitz). Descartar lo saca de la lista y borra el
 * objeto (best effort: si el borrado falla, queda un huérfano en el bucket,
 * no un pendiente fantasma).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { FileModelRegistry, modelRegistryPath } from "@fastgram/adapters";
import {
  BYTES_PER_MB,
  DEFAULT_BUILD_LOGO,
  brandLogoLayerSchema,
  type BrandLogoLayerResource,
  designSystemGenerateRequestSchema,
  designSystemImportRequestSchema,
  designSystemUpdateRequestSchema,
  designSystemUploadRequestSchema,
  type DesignSystemResource,
} from "@fastgram/contracts";
import {
  BLITZ_MEDIA_CATEGORIES,
  FONT_FAMILIES,
  JOB_QUEUES,
  REGISTERED_FONT_NAMES,
  deriveDesignSystem,
  designSystemSingletonKey,
  designSystemTextDefaults,
  designSystemUploadPrefix,
  familyUsable,
  readDesignSystemStyle,
  readDesignSystemTokens,
  readPendingAssets,
  readStoredAssets,
  readStoredFontFiles,
  resolveGenAiConfig,
  withEditedPalette,
  withFontFallbacks,
  withFontLicenses,
  type DesignSystemGenerateJob,
  type DesignSystemImportJob,
  type ResolvedDsFont,
} from "@fastgram/core";
import {
  companyProfileRepository,
  companyRepository,
  designSystemRepository,
  lockCompanyDesignSystem,
  uploadReservationRepository,
  type BrandDesignSystemRow,
  type Transaction,
} from "@fastgram/db";
import { PortError, type Storage } from "@fastgram/ports";

import { ApiRejection } from "../../http/errors.js";
import { rateLimit } from "../../plugins/rate-limit.js";
import {
  canonicalObjectUrl,
  claimReservation,
  reserveUpload,
  type UploadRejection,
} from "../../support/upload-reservations.js";
import { sendRejection } from "./media.js";
import { crossTenant, data } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE = "design system";

/** Los `maxAttempts: 2` del catálogo del worker, en reintentos. */
const RETRY_LIMIT = 1;
/** Un archivo de fuente para el specimen. Las OTF de FOCUS pesan ~25 KB. */
const MAX_FONT_BYTES = 4 * 1024 * 1024;

const idParams = z.object({ designSystemId: z.string().min(1) });
const pendingParams = z.object({
  designSystemId: z.string().min(1),
  assetRef: z.string().min(1).max(80),
});
const fontParams = z.object({
  designSystemId: z.string().min(1),
  fileRef: z.string().min(1).max(80),
});

function resolvedFont(f: ResolvedDsFont): DesignSystemResource["textDefaults"]["title"] {
  return f.kind === "brand"
    ? {
        kind: "brand",
        family: f.familyId,
        displayName: f.name,
        weight: f.weight,
        mappedFrom: null,
        reason: null,
      }
    : {
        kind: "registered",
        family: f.family,
        displayName: REGISTERED_FONT_NAMES[f.family] ?? f.family,
        weight: f.weight,
        mappedFrom: f.mappedFrom,
        reason: f.reason,
      };
}

/** La fila → el recurso. Lee la media de los assets (url, nombre) en la misma tx. */
export async function toDesignSystem(
  tx: Transaction,
  companyId: string,
  row: BrandDesignSystemRow,
): Promise<DesignSystemResource> {
  const tokens = readDesignSystemTokens(row.tokens) ?? {
    colors: [],
    semantic: {
      surfaceDark: null,
      surfaceLight: null,
      textOnDark: null,
      textOnLight: null,
      accents: [],
    },
    families: [],
    roles: [],
    spacing: [],
  };
  const fonts = readStoredFontFiles(row.fonts);
  const stored = readStoredAssets(row.assets);
  const live = new Map(
    (
      await designSystemRepository.liveMediaByIds(
        tx,
        { companyId },
        stored.map((a) => a.mediaId),
      )
    ).map((m) => [m.mediaId, m]),
  );
  const defaults = designSystemTextDefaults(tokens);
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    active: row.active,
    version: row.version,
    name: row.name,
    description: row.description,
    palette: tokens.colors.map((c) => ({ name: c.name, hex: c.hex, aliasOf: c.aliasOf })),
    semantic: {
      surfaceDark: tokens.semantic.surfaceDark,
      surfaceLight: tokens.semantic.surfaceLight,
      textOnDark: tokens.semantic.textOnDark,
      textOnLight: tokens.semantic.textOnLight,
      accents: [...tokens.semantic.accents],
    },
    families: tokens.families.map((f) => ({
      id: f.id,
      name: f.name,
      origin: f.origin,
      category: f.category,
      license: f.license,
      licenseConfirmed: f.licenseConfirmed,
      weights: [...f.weights],
      faces: f.faces.map((face) => ({
        weight: face.weight,
        style: face.style,
        fileRef:
          fonts.find(
            (x) =>
              x.familyId === f.id && x.weight === face.weight && x.style === face.style,
          )?.fileRef ?? null,
      })),
      fallback: f.fallback,
      fallbackName: REGISTERED_FONT_NAMES[f.fallback] ?? f.fallback,
      usable: familyUsable(f),
    })),
    roles: tokens.roles.map((r) => ({
      role: r.role,
      stack: [...r.stack],
      familyId: r.familyId,
    })),
    textDefaults: {
      title: resolvedFont(defaults.title),
      body: resolvedFont(defaults.body),
      color: defaults.style?.color ?? null,
      backgroundColor: defaults.style?.backgroundColor ?? null,
    },
    spacing: tokens.spacing.map((s) => ({ name: s.name, px: s.px })),
    style: (() => {
      const s = readDesignSystemStyle(row.style);
      return s === null
        ? null
        : {
            voice: s.voice.slice(0, 400),
            values: s.values.slice(0, 8),
            tagline: s.tagline,
            compositionRules: s.compositionRules.slice(0, 10),
            dos: s.dos.slice(0, 8),
            donts: s.donts.slice(0, 8),
            language: s.language,
            origin: s.origin,
          };
    })(),
    assets: stored.flatMap((a) => {
      const m = live.get(a.mediaId);
      return m === undefined
        ? []
        : [{ mediaId: a.mediaId, kind: a.kind, url: m.r2Url, filename: m.filename }];
    }),
    pendingAssets: readPendingAssets(row.pendingAssets).map((p) => ({
      id: p.id,
      url: p.url,
      generator: p.generator,
      createdAt: p.createdAt,
    })),
    warnings: [...row.warnings],
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

type ImportOutcome =
  | { readonly ok: true; readonly row: BrandDesignSystemRow; readonly zipKey: string }
  | { readonly ok: false; readonly rejection: UploadRejection };

async function readSmall(
  storage: Storage,
  key: string,
  max: number,
): Promise<Uint8Array | null> {
  let stream: AsyncIterable<Uint8Array>;
  try {
    stream = await storage.get(key);
  } catch (error) {
    if (error instanceof PortError && error.code === "not_found") return null;
    throw error;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** ¿Hay un modelo `image` usable en el registro? Para avisar en la respuesta. */
async function imageModelConfigured(): Promise<boolean> {
  try {
    const registry = new FileModelRegistry({ path: modelRegistryPath(process.env) });
    return resolveGenAiConfig("image", await registry.read(), process.env) !== null;
  } catch {
    return false;
  }
}

export function registerDesignSystemRoutes(app: ZodApp): void {
  const { clock, limiter, storage, queue } = app.deps;

  const noQueue = () =>
    new ApiRejection(
      503,
      "service_unavailable",
      "Design systems are temporarily unavailable.",
    );

  async function loadOwned(
    tx: Transaction,
    companyId: string,
    id: string,
  ): Promise<BrandDesignSystemRow> {
    if (!UUID.test(id)) throw crossTenant(RESOURCE, id, companyId);
    const row = await designSystemRepository.findById(tx, { companyId }, id);
    if (row === null) throw crossTenant(RESOURCE, id, companyId);
    return row;
  }

  // ── GET /design-system ──
  app.get("/design-system", async (request) => {
    const companyId = request.auth.companyId;
    return request.tx(async (tx) => {
      const active = await designSystemRepository.findActive(tx, { companyId });
      const latest = await designSystemRepository.findLatest(tx, { companyId });
      return data({
        active: active === null ? null : await toDesignSystem(tx, companyId, active),
        latest:
          latest === null || latest.id === active?.id
            ? null
            : await toDesignSystem(tx, companyId, latest),
      });
    });
  });

  // ── POST /design-system/upload-url ──
  app.post(
    "/design-system/upload-url",
    {
      schema: { body: designSystemUploadRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const body = request.body;
      const reservation = await request.tx((tx) =>
        reserveUpload({
          tx,
          storage,
          companyId,
          apiKeyId: request.auth.apiKeyId,
          prefix: designSystemUploadPrefix(companyId),
          filename: body.filename,
          contentType: body.contentType,
          sizeBytes: body.sizeBytes,
        }),
      );
      // 200 como `POST /media/upload-url`: es una capacidad con vencimiento.
      return reply.status(200).send(data(reservation));
    },
  );

  // ── POST /design-system/import ──
  app.post(
    "/design-system/import",
    {
      schema: { body: designSystemImportRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      if (queue === undefined) throw noQueue();
      const companyId = request.auth.companyId;
      const { uploadId } = request.body;
      const outcome = await request.tx(async (tx): Promise<ImportOutcome> => {
        const claim = await claimReservation({
          tx,
          storage,
          companyId,
          uploadId,
          nowMs: clock.nowMs(),
        });
        if (!claim.ok) return claim;
        const reservation = claim.row;
        // Una reserva de otro prefijo (Media Bank, audio) no es un zip de
        // design system: el mismo 404 que una ajena.
        if (
          !reservation.storageKey.startsWith(`${designSystemUploadPrefix(companyId)}/`)
        ) {
          return {
            ok: false,
            rejection: {
              status: 404,
              code: "not_found",
              message: "upload reservation not found",
            },
          };
        }
        await lockCompanyDesignSystem(tx, { companyId });
        const row = await designSystemRepository.create(
          tx,
          { companyId },
          {
            source: "zip",
            status: "importing",
            name:
              reservation.filename.replace(/\.zip$/iu, "").slice(0, 120) ||
              "Design system",
            zipKey: reservation.storageKey,
            zipBytes: claim.sizeBytes,
          },
        );
        await uploadReservationRepository.update(tx, { companyId }, uploadId, {
          state: "committed",
        });
        return { ok: true, row, zipKey: reservation.storageKey };
      });
      if (!outcome.ok) return sendRejection(reply, outcome.rejection);

      const job: DesignSystemImportJob = {
        kind: "import",
        companyId,
        designSystemId: outcome.row.id,
        zipKey: outcome.zipKey,
      };
      await queue.enqueue<DesignSystemImportJob>({
        queue: JOB_QUEUES.designSystem,
        payload: job,
        options: {
          singletonKey: designSystemSingletonKey(job),
          retryLimit: RETRY_LIMIT,
          retryBackoff: true,
        },
      });
      const body = await request.tx((tx) => toDesignSystem(tx, companyId, outcome.row));
      return reply.status(202).send(data(body));
    },
  );

  // ── POST /design-system/derive ──
  app.post(
    "/design-system/derive",
    { preHandler: rateLimit(limiter, "restPerWorkspace") },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const scope = { companyId };
      const body = await request.tx(async (tx) => {
        const company = await companyRepository.load(tx, scope);
        const profile = (await companyProfileRepository.list(tx, scope, { limit: 1 }))
          .items[0];
        const media = await designSystemRepository.listDerivableMedia(tx, scope, 24);
        const isLogo = (m: { filename: string; tags: string[] }) =>
          m.tags.includes("logo") || /logo/iu.test(m.filename);
        const logos = media.filter(isLogo).slice(0, 2);
        const images = media.filter((m) => !isLogo(m)).slice(0, 12);
        const derived = deriveDesignSystem({
          companyId,
          brandName: company?.name ?? "",
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
          toneOfVoice: profile?.toneOfVoice ?? null,
          media: [
            ...logos.map((m) => ({
              mediaId: m.mediaId,
              kind: "logo" as const,
              bytes: m.sizeMb * BYTES_PER_MB,
            })),
            ...images.map((m) => ({
              mediaId: m.mediaId,
              kind: "imagery" as const,
              bytes: m.sizeMb * BYTES_PER_MB,
            })),
          ],
        });
        await lockCompanyDesignSystem(tx, scope);
        const created = await designSystemRepository.create(tx, scope, {
          source: "derived",
          status: "ready",
          name: derived.name,
          tokens: derived.tokens,
          style: derived.style,
          assets: derived.assets.map((a) => ({
            mediaId: a.path.slice("media:".length),
            kind: a.kind,
            path: a.path,
            filename: "",
          })),
        });
        const activated = await designSystemRepository.activate(tx, scope, created.id);
        return toDesignSystem(tx, companyId, activated ?? created);
      });
      return reply.status(201).send(data(body));
    },
  );

  // ── PATCH /design-system/:designSystemId ──
  app.patch(
    "/design-system/:designSystemId",
    {
      schema: { params: idParams, body: designSystemUpdateRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request) => {
      const companyId = request.auth.companyId;
      const body = request.body;
      return request.tx(async (tx) => {
        const row = await loadOwned(tx, companyId, request.params.designSystemId);
        if (row.status !== "ready") {
          throw new ApiRejection(
            409,
            "conflict",
            "This design system is not ready yet.",
            {
              status: row.status,
            },
          );
        }
        let tokens = readDesignSystemTokens(row.tokens);
        if (tokens === null) {
          throw new ApiRejection(
            409,
            "conflict",
            "This design system has no readable tokens.",
          );
        }
        if (body.palette !== undefined) {
          const edited = withEditedPalette(tokens, body.palette);
          if (edited === null) {
            throw new ApiRejection(
              400,
              "bad_request",
              "A palette needs at least two distinct colors.",
              {
                reason: "palette_too_small",
              },
            );
          }
          tokens = edited;
        }
        if (body.fontLicenses !== undefined)
          tokens = withFontLicenses(tokens, body.fontLicenses);
        if (body.fontFallbacks !== undefined) {
          tokens = withFontFallbacks(tokens, body.fontFallbacks, FONT_FAMILIES);
        }
        const updated = await designSystemRepository.update(tx, { companyId }, row.id, {
          tokens,
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.style === undefined
            ? {}
            : { style: { ...body.style, origin: "owner" } }),
        });
        if (updated === null) throw crossTenant(RESOURCE, row.id, companyId);
        return data(await toDesignSystem(tx, companyId, updated));
      });
    },
  );

  // ── POST /design-system/:designSystemId/generate ──
  app.post(
    "/design-system/:designSystemId/generate",
    {
      schema: { params: idParams, body: designSystemGenerateRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      if (queue === undefined) throw noQueue();
      const companyId = request.auth.companyId;
      const row = await request.tx((tx) =>
        loadOwned(tx, companyId, request.params.designSystemId),
      );
      if (row.status !== "ready") {
        throw new ApiRejection(409, "conflict", "This design system is not ready yet.", {
          status: row.status,
        });
      }
      const configured = await imageModelConfigured();
      const job: DesignSystemGenerateJob = {
        kind: "generate",
        companyId,
        designSystemId: row.id,
        requestId: randomUUID(),
        localImages: request.body.localImages,
        // Sin modelo `image` no se pide: el worker lo saltearía igual.
        modelImages: configured ? request.body.modelImages : 0,
      };
      if (job.localImages + job.modelImages === 0) {
        throw new ApiRejection(
          400,
          "bad_request",
          "There is no image model configured: ask for local backgrounds instead.",
          { reason: "no_image_model" },
        );
      }
      await queue.enqueue<DesignSystemGenerateJob>({
        queue: JOB_QUEUES.designSystem,
        payload: job,
        options: {
          singletonKey: designSystemSingletonKey(job),
          retryLimit: RETRY_LIMIT,
          retryBackoff: true,
        },
      });
      return reply.status(202).send(
        data({
          requestId: job.requestId,
          localImages: job.localImages,
          modelImages: job.modelImages,
          imageModelConfigured: configured,
        }),
      );
    },
  );

  // ── POST /design-system/:designSystemId/pending/:assetRef/approve ──
  app.post(
    "/design-system/:designSystemId/pending/:assetRef/approve",
    {
      schema: { params: pendingParams },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request) => {
      const companyId = request.auth.companyId;
      const scope = { companyId };
      const { assetRef } = request.params;
      return request.tx(async (tx) => {
        await lockCompanyDesignSystem(tx, scope);
        const row = await loadOwned(tx, companyId, request.params.designSystemId);
        const pending = readPendingAssets(row.pendingAssets);
        const asset = pending.find((p) => p.id === assetRef);
        if (asset === undefined) throw crossTenant("pending asset", assetRef, companyId);
        const ids = await designSystemRepository.insertMedia(tx, scope, [
          {
            mediaType: "image",
            filename: `design-system-${asset.id}${asset.storageKey.slice(asset.storageKey.lastIndexOf("."))}`,
            r2Url: await canonicalObjectUrl(storage, asset.storageKey),
            storageKey: asset.storageKey,
            sizeMb: asset.sizeBytes / BYTES_PER_MB,
            categories: [
              BLITZ_MEDIA_CATEGORIES.slideshowImage,
              BLITZ_MEDIA_CATEGORIES.greenScreenBackground,
            ],
            tags: ["generated", asset.generator],
          },
        ]);
        const mediaId = ids.get(asset.storageKey);
        if (mediaId === undefined) throw new Error("approved asset without media row");
        await designSystemRepository.update(tx, scope, row.id, {
          pendingAssets: pending.filter((p) => p.id !== assetRef),
          assets: [
            ...readStoredAssets(row.assets),
            { mediaId, kind: "generated", path: asset.storageKey, filename: "" },
          ],
        });
        return data({ mediaId });
      });
    },
  );

  // ── DELETE /design-system/:designSystemId/pending/:assetRef ──
  app.delete(
    "/design-system/:designSystemId/pending/:assetRef",
    { schema: { params: pendingParams } },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const scope = { companyId };
      const { assetRef } = request.params;
      const removed = await request.tx(async (tx) => {
        await lockCompanyDesignSystem(tx, scope);
        const row = await loadOwned(tx, companyId, request.params.designSystemId);
        const pending = readPendingAssets(row.pendingAssets);
        const asset = pending.find((p) => p.id === assetRef);
        if (asset === undefined) throw crossTenant("pending asset", assetRef, companyId);
        await designSystemRepository.update(tx, scope, row.id, {
          pendingAssets: pending.filter((p) => p.id !== assetRef),
        });
        return asset;
      });
      await storage.delete(removed.storageKey).catch((error: unknown) => {
        request.log.warn(
          { error },
          "no se pudo borrar el objeto de un pendiente descartado",
        );
      });
      return reply.status(204).send();
    },
  );

  // ── GET|PUT /design-system/:designSystemId/logo-layer ── (sprint 9, S)
  // Si las piezas clásicas nuevas de la marca salen con el logo del design
  // system. Vive en `tokens.logoLayer` (ver `core/design-system/types.ts`).
  async function logoLayerOf(
    tx: Transaction,
    companyId: string,
    row: BrandDesignSystemRow,
  ): Promise<BrandLogoLayerResource> {
    const layer = readDesignSystemTokens(row.tokens)?.logoLayer;
    const logoIds = readStoredAssets(row.assets)
      .filter((a) => a.kind === "logo")
      .map((a) => a.mediaId);
    const live =
      logoIds.length === 0
        ? []
        : await designSystemRepository.liveMediaByIds(tx, { companyId }, logoIds);
    return {
      enabled: layer?.enabled ?? false,
      corner: layer?.corner ?? DEFAULT_BUILD_LOGO.corner,
      size: layer?.size ?? DEFAULT_BUILD_LOGO.size,
      opacity: layer?.opacity ?? DEFAULT_BUILD_LOGO.opacity,
      available: live.length > 0,
    };
  }

  app.get(
    "/design-system/:designSystemId/logo-layer",
    { schema: { params: idParams } },
    async (request) => {
      const companyId = request.auth.companyId;
      return request.tx(async (tx) => {
        const row = await loadOwned(tx, companyId, request.params.designSystemId);
        return data(await logoLayerOf(tx, companyId, row));
      });
    },
  );

  app.put(
    "/design-system/:designSystemId/logo-layer",
    {
      schema: { params: idParams, body: brandLogoLayerSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request) => {
      const companyId = request.auth.companyId;
      return request.tx(async (tx) => {
        await lockCompanyDesignSystem(tx, { companyId });
        const row = await loadOwned(tx, companyId, request.params.designSystemId);
        const tokens = readDesignSystemTokens(row.tokens);
        if (row.status !== "ready" || tokens === null) {
          throw new ApiRejection(
            409,
            "conflict",
            "This design system is not ready yet.",
            {
              status: row.status,
            },
          );
        }
        const updated = await designSystemRepository.update(tx, { companyId }, row.id, {
          tokens: { ...tokens, logoLayer: request.body },
        });
        if (updated === null) throw crossTenant(RESOURCE, row.id, companyId);
        return data(await logoLayerOf(tx, companyId, updated));
      });
    },
  );

  // ── GET /design-system/:designSystemId/font-files/:fileRef ──
  app.get(
    "/design-system/:designSystemId/font-files/:fileRef",
    { schema: { params: fontParams } },
    async (request) => {
      const companyId = request.auth.companyId;
      const { fileRef } = request.params;
      const row = await request.tx((tx) =>
        loadOwned(tx, companyId, request.params.designSystemId),
      );
      const file = readStoredFontFiles(row.fonts).find((f) => f.fileRef === fileRef);
      // La clave sale de la fila (nunca del parámetro) y tiene que estar bajo
      // el prefijo de la marca: una fila editada a mano no lee otra marca.
      if (file === undefined || !file.storageKey.startsWith(`fonts/${companyId}/`)) {
        throw crossTenant("font file", fileRef, companyId);
      }
      const bytes = await readSmall(storage, file.storageKey, MAX_FONT_BYTES);
      if (bytes === null) throw crossTenant("font file", fileRef, companyId);
      return data({
        fileRef,
        contentType: file.contentType,
        dataUrl: `data:${file.contentType};base64,${Buffer.from(bytes).toString("base64")}`,
      });
    },
  );

  // ── DELETE /design-system/:designSystemId ──
  app.delete(
    "/design-system/:designSystemId",
    { schema: { params: idParams } },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      await request.tx(async (tx) => {
        await lockCompanyDesignSystem(tx, { companyId });
        const row = await loadOwned(tx, companyId, request.params.designSystemId);
        await designSystemRepository.delete(tx, { companyId }, row.id);
      });
      return reply.status(204).send();
    },
  );
}
