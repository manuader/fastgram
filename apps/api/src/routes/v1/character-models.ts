/**
 * Biblioteca de modelos del dueño — sprint 8 (agente K), `P5-LIBR-001/002`.
 * El contrato está en `@fastgram/contracts` (`resources/character-models.ts`).
 *
 * ## Del dueño, no de la marca
 *
 * Igual que `/workspaces`: todas estas rutas son **owner-level**
 * (`isOwnerLevelRoute` en `server/app.ts`) e ignoran `X-Fastgram-Workspace`.
 * El dueño sale de la company de la credencial (`homeCompanyId`), y las que
 * actúan sobre una marca la reciben **explícita** y la validan contra él
 * (`workspaceDirectory.find`): una marca ajena es 404, como un cruce de
 * tenant. Fuera del modo personal responden 404, como `/workspaces`.
 *
 * ## Asignar = una fila de `influencers` en la marca, sin entrenar
 *
 * El modelo lleva el Soul ID. Asignarlo a una marca crea (o reactiva) en esa
 * marca una fila de `influencers` con `model_id`, el mismo `soul_id`, estado
 * `ready` y el retrato del modelo como portada. Desde ahí todo lo que ya
 * existe por marca (galería, Animate, Configuration, Blitz con
 * `influencerChance`, `JV-6`) funciona sin saber que hay una biblioteca.
 * Desasignar = desactivarla (no se borra: la galería queda). No cobra nada:
 * no se entrena.
 *
 * ## UGC para una marca: se delega en las rutas de la marca
 *
 * Generar la imagen del modelo, animarla y armar la pieza ya existen **por
 * marca** (`/influencers/:id/images`, `/videos`, `/content/studio`), con sus
 * reglas: estimador, tope mensual, cola, cuota de saves, idempotencia. En vez
 * de duplicarlas, estas rutas validan dueño + marca + asignación y **repiten
 * la request contra la ruta de la marca** con `app.inject`, con la misma
 * credencial y el header de marca puesto. Así hay una sola implementación de
 * cada regla, y el resultado cae en el Media Bank y la Library **de esa
 * marca**. El costo es una vuelta extra por Fastify en memoria (sin red).
 *
 * ## Decisiones que el PRD no cubre
 *
 * - **Las fotos y el retrato se eligen del Media Bank de una marca**
 *   (`fromBrandId`) y se **copian** a `models/{ownerUserId}/{modelId}/`. No hay
 *   una subida propia de la biblioteca: la de la Library ya tiene sus
 *   validaciones (`FR-100`), y la copia deja al modelo independiente de que
 *   alguien borre la foto de esa marca.
 * - **Soul ID pegado**: se valida contra `GET /v1/custom-references/{id}` de
 *   Higgsfield (`docs.higgsfield.ai/docs/models/soul-id/create-character`).
 *   Sólo se acepta `completed`: uno que todavía entrena o que falló es 400
 *   (no hay quien lo siga en segundo plano).
 * - **El producto no entra en la imagen del modelo**: SOUL V2 no acepta
 *   imágenes de referencia además del personaje
 *   (`/docs/models/soul-2/generate`, verificado 2026-09-24). Se compone en la
 *   pieza: slideshow con el modelo y después los productos.
 * - **Voz**: proveedor `fal` y un modelo del catálogo del contrato; el
 *   `voiceId` es texto libre (fal no tiene endpoint de listado).
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";
import {
  CHARACTER_UGC_PRODUCTS_MAX,
  MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE,
  WORKSPACE_HEADER,
  characterUgcAnimateRequestSchema,
  characterUgcImageRequestSchema,
  characterUgcListQuerySchema,
  characterUgcPieceRequestSchema,
  createCharacterModelRequestSchema,
  cursorQuerySchema,
  idempotencyHeaderSchema,
  setCharacterModelBrandsRequestSchema,
  updateCharacterModelRequestSchema,
  type CharacterModel,
  type CharacterModelSetup,
  type FastgramMode,
  type InfluencerFailureCode,
} from "@fastgram/contracts";
import {
  CHARACTER_MODEL_TRAIN_OP,
  characterModelDirectory,
  characterModelTrainSingletonKey,
  influencerRepository,
  mediaRepository,
  withoutCompany,
  workspaceDirectory,
  type CharacterModelBrandLink,
  type CharacterModelRow,
  type CharacterModelTrainJob,
  type OwnerScope,
  type Transaction,
} from "@fastgram/db";
import {
  INFLUENCER_CHARACTER_PROVIDER,
  INFLUENCER_REFERENCE_LIMITS,
  JOB_QUEUES,
  budgetSummary,
  canStartCharacter,
  monthKey,
  type CharacterGen,
} from "@fastgram/core";
import { canonicalObjectUrl } from "@fastgram/adapters";
import { isPortError, type Storage } from "@fastgram/ports";
import type { FastifyReply, FastifyRequest } from "fastify";

import { ownerOrFail, runScoped } from "../../auth/scope.js";
import { ApiRejection } from "../../http/errors.js";
import { ledgerOrFail, toBudgetView } from "./genai.js";
import {
  defaultInfluencerRouteDeps,
  higgsfieldConfigFor,
  type InfluencerRouteDeps,
} from "./influencers.js";
import { data, idempotencyKeyOf, notFound, withIdempotency } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const modelParams = z.object({ id: z.string().min(1) });
const brandParams = z.object({ brandId: z.string().min(1) });
/** `characterUgcListQuerySchema` con `brandId` opcional: ver `GET …/ugc`. */
const ugcListQuery = characterUgcListQuerySchema.partial();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Donde las rutas de la marca viven; `app.ts` monta `/api/v1`. */
const V1 = "/api/v1";
const CREATE_ROUTE = "POST /character-models";
/** Ninguna foto razonable se acerca; es para no llenar la memoria al copiar. */
const COPY_MAX_BYTES = 25 * 1024 * 1024;
const BRAND_MEDIA_LIMIT_DEFAULT = 60;

/** Los estados de un modelo cuyo `failure_code` se muestra. */
const FAILURE_CODES: ReadonlySet<string> = new Set<InfluencerFailureCode>([
  "not_configured",
  "references_missing",
  "upload_failed",
  "training_failed",
  "quota_exceeded",
  "unauthorized",
  "rate_limited",
  "provider_unavailable",
  "bad_request",
  "timeout",
  "provider_contract_violation",
]);

/** La fila → el recurso. `soulId` y las claves de storage no salen. */
export function characterModelView(
  row: CharacterModelRow,
  links: readonly CharacterModelBrandLink[],
): CharacterModel {
  const voice =
    row.voiceProvider === "fal" && row.voiceModel !== null && row.voiceId !== null
      ? { provider: "fal" as const, model: row.voiceModel, voiceId: row.voiceId }
      : null;
  return {
    id: row.id,
    name: row.name,
    portraitUrl: row.portraitUrl ?? "",
    status: row.status,
    voice,
    brandIds: links
      .filter((l) => l.modelId === row.id && l.isActive)
      .map((l) => l.companyId),
    progress: row.progress,
    source: row.source,
    notes: row.notes,
    age: row.age,
    style: row.style,
    failure:
      row.status === "failed" &&
      row.failureCode !== null &&
      FAILURE_CODES.has(row.failureCode)
        ? {
            code: row.failureCode as InfluencerFailureCode,
            message: row.failureMessage ?? "The model could not be created.",
          }
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Extensión de la clave de origen (`.png`, `.jpg`…), o ninguna. */
function extensionOf(key: string): string {
  const match = /\.[a-z0-9]{2,5}$/i.exec(key);
  return match === null ? "" : match[0].toLowerCase();
}

async function readAllBytes(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > COPY_MAX_BYTES) {
      throw new ApiRejection(400, "bad_request", "One of the photos is too large.", {
        field: "referenceMediaIds",
      });
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Copia un objeto de la marca a la biblioteca. Devuelve la clave nueva. */
async function copyToLibrary(
  storage: Storage,
  sourceKey: string,
  targetKey: string,
): Promise<{ key: string; url: string }> {
  const head = await storage.head(sourceKey);
  if (head === null) {
    throw new ApiRejection(
      400,
      "bad_request",
      "A photo is missing from storage. Pick another one.",
      { field: "referenceMediaIds" },
    );
  }
  const body = await readAllBytes(await storage.get(sourceKey));
  await storage.put({ key: targetKey, body, contentType: head.contentType });
  return { key: targetKey, url: await canonicalObjectUrl(storage, targetKey) };
}

export function registerCharacterModelRoutes(
  app: ZodApp,
  deps: InfluencerRouteDeps = defaultInfluencerRouteDeps(),
): void {
  const { db, storage, clock, idempotency, appRole } = app.deps;
  const mode: FastgramMode = app.deps.mode ?? "standard";
  const { genai } = deps;

  /** Como `/workspaces`: en `standard` estas rutas no existen para el cliente. */
  const requirePersonal = (): void => {
    if (mode !== "personal") throw notFound("route");
  };

  const homeCompanyOf = (request: FastifyRequest): string =>
    request.auth.homeCompanyId ?? request.auth.companyId;

  const inBrand = <T>(brandId: string, fn: (tx: Transaction) => Promise<T>) =>
    runScoped(db, brandId, appRole, fn);

  async function ownerOf(request: FastifyRequest): Promise<OwnerScope> {
    requirePersonal();
    const owner = await withoutCompany(db, (tx) =>
      ownerOrFail(tx, homeCompanyOf(request)),
    );
    return { ownerUserId: owner.ownerUserId };
  }

  /** La marca, si es viva y del dueño. Si no, 404 (ajena = inexistente). */
  async function requireBrand(owner: OwnerScope, brandId: string): Promise<void> {
    if (!UUID_RE.test(brandId)) throw notFound("workspace");
    const found = await withoutCompany(db, (tx) =>
      workspaceDirectory.find(tx, owner, brandId),
    );
    if (found === null) throw notFound("workspace");
  }

  async function requireModel(owner: OwnerScope, id: string): Promise<CharacterModelRow> {
    const row = await withoutCompany(db, (tx) =>
      characterModelDirectory.find(tx, owner, id),
    );
    if (row === null) throw notFound("character model");
    return row;
  }

  async function linksOf(
    owner: OwnerScope,
    ids: readonly string[],
  ): Promise<CharacterModelBrandLink[]> {
    return withoutCompany(db, (tx) => characterModelDirectory.brandLinks(tx, owner, ids));
  }

  async function viewOf(
    owner: OwnerScope,
    row: CharacterModelRow,
  ): Promise<CharacterModel> {
    return characterModelView(row, await linksOf(owner, [row.id]));
  }

  /** Imágenes `ready` del Media Bank de la marca, por id. Falta alguna → 400. */
  async function brandImages(
    brandId: string,
    ids: readonly string[],
    field: string,
  ): Promise<Map<string, { storageKey: string; r2Url: string }>> {
    const found = await inBrand(brandId, (tx) =>
      mediaRepository.list(
        tx,
        { companyId: brandId },
        { limit: ids.length, filter: { mediaId: { in: [...ids] } } },
      ),
    );
    const usable = new Map(
      found.items
        .filter((m) => m.mediaType === "image" && m.status === "ready")
        .map((m) => [m.mediaId, { storageKey: m.storageKey, r2Url: m.r2Url }]),
    );
    const missing = ids.filter((id) => !usable.has(id));
    if (missing.length > 0) {
      throw new ApiRejection(
        400,
        "bad_request",
        "Some photos are not ready images in that brand's Media Bank.",
        { field, missing },
      );
    }
    return usable;
  }

  async function deleteKeysQuietly(request: FastifyRequest, keys: readonly string[]) {
    for (const key of new Set(keys)) {
      try {
        await storage.delete(key);
      } catch (error) {
        request.log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "no se pudo borrar un objeto de la biblioteca de modelos",
        );
      }
    }
  }

  /**
   * Repite la request contra una ruta **de la marca** (ver cabecera). Misma
   * credencial, header de marca puesto; la respuesta vuelve tal cual (status
   * y cuerpo), así el cliente ve los mismos errores que en la pantalla de la
   * marca.
   */
  async function delegate(
    request: FastifyRequest,
    reply: FastifyReply,
    args: {
      readonly method: "GET" | "POST";
      readonly path: string;
      readonly brandId: string;
      readonly body?: unknown;
      readonly query?: Record<string, string>;
      readonly idempotencyKey?: string;
    },
  ): Promise<FastifyReply> {
    const headers: Record<string, string> = { [WORKSPACE_HEADER]: args.brandId };
    const auth = request.headers.authorization;
    if (typeof auth === "string") headers["authorization"] = auth;
    const cookie = request.headers.cookie;
    if (typeof cookie === "string") headers["cookie"] = cookie;
    const requestId = request.headers["x-request-id"];
    if (typeof requestId === "string") headers["x-request-id"] = requestId;
    if (args.idempotencyKey !== undefined)
      headers["idempotency-key"] = args.idempotencyKey;
    const res = await app.inject({
      method: args.method,
      url: `${V1}${args.path}`,
      headers,
      ...(args.query === undefined ? {} : { query: args.query }),
      ...(args.body === undefined ? {} : { payload: args.body as object }),
    });
    const contentType = res.headers["content-type"];
    const out = reply.status(res.statusCode);
    if (typeof contentType === "string") out.header("content-type", contentType);
    return out.send(res.body);
  }

  /** Dueño + modelo + marca + asignación activa → la fila del modelo en la marca. */
  async function assignedInfluencer(
    request: FastifyRequest,
    modelId: string,
    brandId: string,
  ): Promise<string> {
    const owner = await ownerOf(request);
    await requireModel(owner, modelId);
    await requireBrand(owner, brandId);
    const link = (await linksOf(owner, [modelId])).find(
      (l) => l.companyId === brandId && l.isActive,
    );
    if (link === undefined) {
      throw new ApiRejection(
        404,
        "not_found",
        "This model isn't assigned to that brand.",
        {
          reason: "not_assigned",
        },
      );
    }
    return link.influencerId;
  }

  // ── GET /character-models ──
  app.get("/character-models", async (request) => {
    const owner = await ownerOf(request);
    const rows = await withoutCompany(db, (tx) =>
      characterModelDirectory.list(tx, owner),
    );
    const links = await linksOf(
      owner,
      rows.map((r) => r.id),
    );
    return data(rows.map((row) => characterModelView(row, links)));
  });

  // ── GET /character-models/setup ──
  app.get("/character-models/setup", async (request) => {
    requirePersonal();
    const config = await higgsfieldConfigFor(genai);
    const summary = budgetSummary(
      ledgerOrFail(await genai.ledger.read()),
      monthKey(clock.now()),
      genai.env,
    );
    request.log.debug({ configured: config !== null }, "character models setup");
    const view: CharacterModelSetup = {
      configured: config !== null,
      canTrain: config !== null && canStartCharacter(summary),
      references: {
        min: INFLUENCER_REFERENCE_LIMITS.min,
        max: INFLUENCER_REFERENCE_LIMITS.max,
      },
      budget: toBudgetView(summary),
    };
    return data(view);
  });

  /** Higgsfield configurado o 409 `not_configured`, como `/influencers`. */
  async function characterClient(): Promise<CharacterGen> {
    const config = await higgsfieldConfigFor(genai);
    if (config === null) {
      throw new ApiRejection(
        409,
        "conflict",
        "The model library needs Higgsfield: set it as the image or video provider in Settings → Models.",
        { reason: "not_configured" },
      );
    }
    try {
      return deps.characterClientFor(config);
    } catch {
      throw new ApiRejection(503, "service_unavailable", "Higgsfield is not available.", {
        reason: "provider_unavailable",
      });
    }
  }

  // ── POST /character-models ──
  app.post(
    "/character-models",
    {
      schema: {
        body: createCharacterModelRequestSchema,
        headers: idempotencyHeaderSchema,
      },
    },
    async (request, reply) => {
      const owner = await ownerOf(request);
      const body = request.body;
      await requireBrand(owner, body.fromBrandId);
      return withIdempotency(
        idempotency,
        request,
        reply,
        {
          key: idempotencyKeyOf({ ...request.headers }),
          route: CREATE_ROUTE,
          body,
          successStatus: 201,
        },
        async (): Promise<CharacterModel> => {
          const modelId = randomUUID();
          const prefix = `models/${owner.ownerUserId}/${modelId}`;
          const traits = {
            notes: body.notes === undefined || body.notes === "" ? null : body.notes,
            age: body.age ?? null,
            style: body.style === undefined || body.style === "" ? null : body.style,
          };

          if (body.source === "photos") {
            const queue = app.deps.queue;
            if (queue === undefined) {
              throw new ApiRejection(
                503,
                "service_unavailable",
                "Model training is temporarily unavailable.",
              );
            }
            await characterClient();
            const summary = budgetSummary(
              ledgerOrFail(await genai.ledger.read()),
              monthKey(clock.now()),
              genai.env,
            );
            if (!canStartCharacter(summary)) {
              throw new ApiRejection(
                402,
                "payment_required",
                "This month's AI budget is used up. Raise it in Settings → Models to train a model.",
                {
                  reason: "budget_exceeded",
                  remainingUsd: summary.remainingUsd,
                  budgetUsd: summary.budgetUsd,
                },
              );
            }
            const photos = await brandImages(
              body.fromBrandId,
              body.referenceMediaIds,
              "referenceMediaIds",
            );
            const copied: { key: string; url: string }[] = [];
            try {
              for (const [i, mediaId] of body.referenceMediaIds.entries()) {
                const src = photos.get(mediaId);
                if (src === undefined) continue;
                copied.push(
                  await copyToLibrary(
                    storage,
                    src.storageKey,
                    `${prefix}/ref-${String(i + 1).padStart(2, "0")}${extensionOf(src.storageKey)}`,
                  ),
                );
              }
              const portrait = copied[0];
              if (portrait === undefined) throw new Error("sin fotos copiadas");
              const row = await withoutCompany(db, async (tx) => {
                const created = await characterModelDirectory.create(tx, owner, {
                  id: modelId,
                  name: body.name,
                  source: "photos",
                  status: "training",
                  progress: 0,
                  provider: INFLUENCER_CHARACTER_PROVIDER,
                  portraitKey: portrait.key,
                  portraitUrl: portrait.url,
                  referenceKeys: copied.map((c) => c.key),
                  ...traits,
                });
                const job: CharacterModelTrainJob = {
                  op: CHARACTER_MODEL_TRAIN_OP,
                  modelId,
                  ownerUserId: owner.ownerUserId,
                };
                // ADR-005: fila y job en la misma transacción.
                await queue.enqueue({
                  queue: JOB_QUEUES.influencerPipeline,
                  payload: job,
                  options: {
                    transaction: tx,
                    singletonKey: characterModelTrainSingletonKey(modelId),
                  },
                });
                return created;
              });
              request.log.info(
                { modelId, photos: copied.length },
                "modelo encolado para entrenar",
              );
              return characterModelView(row, []);
            } catch (error) {
              await deleteKeysQuietly(
                request,
                copied.map((c) => c.key),
              );
              throw error;
            }
          }

          if (body.source === "soul_id") {
            const client = await characterClient();
            let status: string;
            try {
              status = (await client.getCharacter(body.soulId)).status;
            } catch (error) {
              if (isPortError(error) && error.code === "not_found") {
                throw new ApiRejection(
                  400,
                  "bad_request",
                  "We couldn't find that Soul ID in your Higgsfield account.",
                  { field: "soulId", reason: "not_found" },
                );
              }
              if (isPortError(error) && error.code === "bad_request") {
                throw new ApiRejection(
                  400,
                  "bad_request",
                  "That isn't a valid Soul ID.",
                  {
                    field: "soulId",
                  },
                );
              }
              throw new ApiRejection(
                503,
                "service_unavailable",
                "Higgsfield didn't answer. Try again in a moment.",
                { reason: isPortError(error) ? error.code : "provider_unavailable" },
              );
            }
            if (status !== "completed") {
              throw new ApiRejection(
                400,
                "bad_request",
                status === "failed"
                  ? "That Soul ID failed training on Higgsfield."
                  : "That Soul ID is still training on Higgsfield. Paste it again when it's done.",
                { field: "soulId", reason: status === "failed" ? "failed" : "not_ready" },
              );
            }
            const portraits = await brandImages(
              body.fromBrandId,
              [body.portraitMediaId],
              "portraitMediaId",
            );
            const src = portraits.get(body.portraitMediaId);
            if (src === undefined) throw notFound("media");
            const portrait = await copyToLibrary(
              storage,
              src.storageKey,
              `${prefix}/portrait${extensionOf(src.storageKey)}`,
            );
            try {
              const row = await withoutCompany(db, (tx) =>
                characterModelDirectory.create(tx, owner, {
                  id: modelId,
                  name: body.name,
                  source: "soul_id",
                  status: "ready",
                  progress: 100,
                  provider: INFLUENCER_CHARACTER_PROVIDER,
                  soulId: body.soulId,
                  portraitKey: portrait.key,
                  portraitUrl: portrait.url,
                  referenceKeys: [portrait.key],
                  ...traits,
                }),
              );
              return characterModelView(row, []);
            } catch (error) {
              await deleteKeysQuietly(request, [portrait.key]);
              throw error;
            }
          }

          // source === "influencer": promover, sin reentrenar.
          const brandId = body.fromBrandId;
          const influencer = await inBrand(brandId, (tx) =>
            influencerRepository.findById(tx, { companyId: brandId }, body.influencerId),
          );
          if (influencer === null) throw notFound("influencer");
          if (influencer.modelId !== null) {
            throw new ApiRejection(
              409,
              "conflict",
              "This influencer is already in your model library.",
              {
                reason: "already_in_library",
                modelId: influencer.modelId,
              },
            );
          }
          if (
            influencer.status !== "ready" ||
            influencer.soulId === null ||
            influencer.provider !== INFLUENCER_CHARACTER_PROVIDER
          ) {
            throw new ApiRejection(
              409,
              "conflict",
              "Only a ready influencer with a Higgsfield character can join the library.",
              { reason: "not_ready", status: influencer.status },
            );
          }
          // El retrato: la primera foto de referencia, copiada; si no hay
          // (camino viejo de imagen base), su portada tal cual (ya es nuestra).
          let portrait: { key: string | null; url: string } | null = null;
          const firstRef = influencer.referenceMediaIds[0];
          if (firstRef !== undefined) {
            const found = await inBrand(brandId, (tx) =>
              mediaRepository.list(
                tx,
                { companyId: brandId },
                { limit: 1, filter: { mediaId: { eq: firstRef } } },
              ),
            );
            const media = found.items[0];
            if (
              media !== undefined &&
              media.mediaType === "image" &&
              media.status === "ready"
            ) {
              portrait = await copyToLibrary(
                storage,
                media.storageKey,
                `${prefix}/portrait${extensionOf(media.storageKey)}`,
              );
            }
          }
          if (portrait === null && influencer.baseImageUrl !== null) {
            portrait = { key: null, url: influencer.baseImageUrl };
          }
          if (portrait === null) {
            throw new ApiRejection(
              409,
              "conflict",
              "This influencer has no cover image to use as the model's portrait.",
              { reason: "no_portrait" },
            );
          }
          const cover = portrait;
          const row = await withoutCompany(db, (tx) =>
            characterModelDirectory.create(tx, owner, {
              id: modelId,
              name: body.name ?? influencer.name,
              source: "influencer",
              status: "ready",
              progress: 100,
              provider: INFLUENCER_CHARACTER_PROVIDER,
              soulId: influencer.soulId,
              portraitKey: cover.key,
              portraitUrl: cover.url,
              referenceKeys: cover.key === null ? [] : [cover.key],
              sourceInfluencerId: influencer.id,
              sourceCompanyId: brandId,
              notes: traits.notes,
              age: traits.age ?? influencer.age,
              style: traits.style,
            }),
          );
          try {
            // El influencer queda como la fila del modelo en su marca.
            await inBrand(brandId, (tx) =>
              influencerRepository.update(tx, { companyId: brandId }, influencer.id, {
                modelId: row.id,
              }),
            );
          } catch (error) {
            await withoutCompany(db, (tx) =>
              characterModelDirectory.remove(tx, owner, row.id),
            );
            if (cover.key !== null) await deleteKeysQuietly(request, [cover.key]);
            throw error;
          }
          return viewOf(owner, row);
        },
      );
    },
  );

  // ── GET /character-models/:id ──
  app.get(
    "/character-models/:id",
    { schema: { params: modelParams } },
    async (request) => {
      const owner = await ownerOf(request);
      return data(await viewOf(owner, await requireModel(owner, request.params.id)));
    },
  );

  // ── PATCH /character-models/:id ──
  app.patch(
    "/character-models/:id",
    { schema: { params: modelParams, body: updateCharacterModelRequestSchema } },
    async (request) => {
      const owner = await ownerOf(request);
      const body = request.body;
      const current = await requireModel(owner, request.params.id);
      const blankToNull = (v: string | null | undefined) =>
        v === undefined ? undefined : v === null || v === "" ? null : v;
      const patch = {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.notes === undefined ? {} : { notes: blankToNull(body.notes) ?? null }),
        ...(body.style === undefined ? {} : { style: blankToNull(body.style) ?? null }),
        ...(body.age === undefined ? {} : { age: body.age }),
        ...(body.voice === undefined
          ? {}
          : body.voice === null
            ? { voiceProvider: null, voiceModel: null, voiceId: null }
            : {
                voiceProvider: body.voice.provider,
                voiceModel: body.voice.model,
                voiceId: body.voice.voiceId,
              }),
      };
      const row = await withoutCompany(db, (tx) =>
        characterModelDirectory.update(tx, owner, current.id, patch),
      );
      if (row === null) throw notFound("character model");
      // El nombre del modelo es el de sus filas en las marcas.
      if (body.name !== undefined && body.name !== current.name) {
        for (const link of await linksOf(owner, [row.id])) {
          await inBrand(link.companyId, (tx) =>
            influencerRepository.update(
              tx,
              { companyId: link.companyId },
              link.influencerId,
              {
                name: row.name,
              },
            ),
          );
        }
      }
      return data(await viewOf(owner, row));
    },
  );

  // ── DELETE /character-models/:id ──
  app.delete(
    "/character-models/:id",
    { schema: { params: modelParams } },
    async (request, reply) => {
      const owner = await ownerOf(request);
      const row = await requireModel(owner, request.params.id);
      // Primero se apaga en cada marca: si esto falla a la mitad, el modelo
      // sigue en la biblioteca y se puede reintentar.
      for (const link of await linksOf(owner, [row.id])) {
        if (!link.isActive) continue;
        await inBrand(link.companyId, (tx) =>
          influencerRepository.update(
            tx,
            { companyId: link.companyId },
            link.influencerId,
            {
              isActive: false,
            },
          ),
        );
      }
      await withoutCompany(db, (tx) => characterModelDirectory.remove(tx, owner, row.id));
      await deleteKeysQuietly(request, [
        ...row.referenceKeys,
        ...(row.portraitKey === null ? [] : [row.portraitKey]),
      ]);
      request.log.info({ modelId: row.id }, "modelo borrado de la biblioteca");
      return reply.status(204).send();
    },
  );

  // ── PUT /character-models/:id/brands ──
  app.put(
    "/character-models/:id/brands",
    { schema: { params: modelParams, body: setCharacterModelBrandsRequestSchema } },
    async (request) => {
      const owner = await ownerOf(request);
      const row = await requireModel(owner, request.params.id);
      const target = new Set(request.body.brandIds);
      // Todas las marcas pedidas tienen que ser del dueño, antes de tocar nada.
      for (const brandId of target) await requireBrand(owner, brandId);
      if (target.size > 0 && (row.status !== "ready" || row.soulId === null)) {
        throw new ApiRejection(
          409,
          "conflict",
          "This model isn't ready yet. Assign it when training is done.",
          { reason: "not_ready", status: row.status },
        );
      }
      const soulId = row.soulId;
      const links = await linksOf(owner, [row.id]);

      for (const brandId of target) {
        const link = links.find((l) => l.companyId === brandId);
        if (link?.isActive === true) continue;
        await inBrand(brandId, async (tx) => {
          const scope = { companyId: brandId };
          const active = await influencerRepository.count(tx, scope, {
            filter: { isActive: { eq: true } },
          });
          if (active >= MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE) {
            throw new ApiRejection(
              402,
              "payment_required",
              `A brand can have up to ${String(MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE)} active influencers. Deactivate one there to make room.`,
              { cap: MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE, active, brandId },
            );
          }
          const values = {
            name: row.name,
            soulId,
            provider: INFLUENCER_CHARACTER_PROVIDER,
            status: "ready" as const,
            progress: 100,
            isActive: true,
            ...(row.portraitUrl === null ? {} : { baseImageUrl: row.portraitUrl }),
          };
          if (link === undefined) {
            await influencerRepository.create(tx, scope, { ...values, modelId: row.id });
          } else {
            await influencerRepository.update(tx, scope, link.influencerId, values);
          }
        });
      }
      for (const link of links) {
        if (!link.isActive || target.has(link.companyId)) continue;
        await inBrand(link.companyId, (tx) =>
          influencerRepository.update(
            tx,
            { companyId: link.companyId },
            link.influencerId,
            {
              isActive: false,
            },
          ),
        );
      }
      request.log.info(
        { modelId: row.id, brands: target.size },
        "asignación de marcas del modelo",
      );
      return data(await viewOf(owner, row));
    },
  );

  // ── GET /character-models/brands/:brandId/media ──
  app.get(
    "/character-models/brands/:brandId/media",
    { schema: { params: brandParams, querystring: cursorQuerySchema } },
    async (request, reply) => {
      const owner = await ownerOf(request);
      const { brandId } = request.params;
      await requireBrand(owner, brandId);
      const q = request.query;
      return delegate(request, reply, {
        method: "GET",
        path: "/media",
        brandId,
        query: {
          type: "image",
          limit: String(q.limit ?? BRAND_MEDIA_LIMIT_DEFAULT),
          ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        },
      });
    },
  );

  // ── UGC: imagen, video y pieza, delegados en la marca ──

  app.get(
    "/character-models/:id/ugc",
    // `brandId` se valida en el handler y no en el schema: así un modelo que no
    // existe es 404 aunque falte la marca (el barrido de NFR-006 lo mide).
    { schema: { params: modelParams, querystring: ugcListQuery } },
    async (request, reply) => {
      const { brandId } = request.query;
      if (brandId === undefined) {
        await requireModel(await ownerOf(request), request.params.id);
        throw new ApiRejection(400, "bad_request", "Pick a brand.", { field: "brandId" });
      }
      const influencerId = await assignedInfluencer(request, request.params.id, brandId);
      return delegate(request, reply, {
        method: "GET",
        path: `/influencers/${influencerId}/generations`,
        brandId,
      });
    },
  );

  for (const suffix of ["", "/estimate"] as const) {
    app.post(
      `/character-models/:id/ugc${suffix}`,
      { schema: { params: modelParams, body: characterUgcImageRequestSchema } },
      async (request, reply) => {
        const { brandId, ...body } = request.body;
        const influencerId = await assignedInfluencer(
          request,
          request.params.id,
          brandId,
        );
        return delegate(request, reply, {
          method: "POST",
          path: `/influencers/${influencerId}/images${suffix}`,
          brandId,
          body,
        });
      },
    );
    app.post(
      `/character-models/:id/ugc/animate${suffix}`,
      { schema: { params: modelParams, body: characterUgcAnimateRequestSchema } },
      async (request, reply) => {
        const { brandId, ...body } = request.body;
        const influencerId = await assignedInfluencer(
          request,
          request.params.id,
          brandId,
        );
        return delegate(request, reply, {
          method: "POST",
          path: `/influencers/${influencerId}/videos${suffix}`,
          brandId,
          body,
        });
      },
    );
  }

  app.post(
    "/character-models/:id/ugc/piece",
    { schema: { params: modelParams, body: characterUgcPieceRequestSchema } },
    async (request, reply) => {
      const body = request.body;
      await assignedInfluencer(request, request.params.id, body.brandId);
      const products = [...new Set(body.productMediaIds)].slice(
        0,
        CHARACTER_UGC_PRODUCTS_MAX,
      );
      let studio: Record<string, unknown>;
      if (body.kind === "image") {
        const slides = [
          body.sourceMediaId,
          ...products.filter((p) => p !== body.sourceMediaId),
        ];
        if (body.texts.length !== slides.length) {
          throw new ApiRejection(400, "bad_request", "Write one text per slide.", {
            field: "texts",
            slides: slides.length,
          });
        }
        studio = { format: "slideshow", media: { slides }, texts: body.texts };
      } else {
        if (products.length > 0 || body.texts.length !== 1) {
          throw new ApiRejection(
            400,
            "bad_request",
            "A video piece takes the video and one text.",
            { field: products.length > 0 ? "productMediaIds" : "texts" },
          );
        }
        studio = {
          format: "wall-of-text",
          media: { video: body.sourceMediaId },
          texts: body.texts,
        };
      }
      const key = request.headers["idempotency-key"];
      return delegate(request, reply, {
        method: "POST",
        path: "/content/studio",
        brandId: body.brandId,
        body: studio,
        idempotencyKey: typeof key === "string" && key.length > 0 ? key : randomUUID(),
      });
    },
  );
}
