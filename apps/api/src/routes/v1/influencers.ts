/**
 * Influencers — `GET /influencers`, `GET /influencers/:id`, `POST /influencers` y la
 * reserva de subida de la base image.
 *
 * Fuente: PRD §9.3, FR-080, DATA-013, §9.4, §9.8.
 *
 * ## Por qué `POST /influencers` tiene tanto andamiaje para una fila
 *
 * Es el endpoint más caro de la API (250 créditos, pipeline de 15-20 min) y el PRD le
 * exige cuatro cosas a la vez: `Idempotency-Key` obligatoria (§9.3), cap de 50 activos
 * (FR-080), reserva de cuota **antes** del trabajo caro (§9.4) y encolado del pipeline.
 * Las cuatro están acá.
 *
 * ## Por qué los rechazos viajan como excepción y no como `DomainError`
 *
 * FR-080 dice que el cap alcanzado es `402 payment_required` con `details`. Ningún
 * `DomainErrorCode` mapea a ese código —`out_of_range` es 400— y `DomainError.details`
 * nunca se serializa hacia el cliente, así que por esa vía el `402` del PRD no sale.
 * Tampoco puede ser un `return`: el chequeo tiene que ocurrir **dentro** de la
 * transacción que escribe (si no, dos peticiones leen 49 y crean las dos) y dentro de
 * `withIdempotency` (si no, un reintento legítimo con la misma key recibiría el 402 en
 * vez del replay que promete FR-080 (4)). Una excepción atraviesa las dos capas sin
 * romper ninguna: `withIdempotency` libera la key —correcto, no se creó nada— y el
 * manejador de errores la traduce al código literal del PRD.
 *
 * Esa excepción es `ApiRejection` (`http/errors.ts`) y no una clase local. Había una
 * acá, `CreationRejected`, escrita antes de que `ApiRejection` existiera; su cabecera
 * cuenta que tres agentes inventaron por separado el mismo parche y que `ApiRejection`
 * es la abstracción que salió de eso. Con el cobro de créditos este archivo necesitaba
 * un segundo rechazo con `details` público, y dos mecanismos para lo mismo en el mismo
 * archivo es justamente lo que esa nota pide no volver a hacer.
 *
 * ## El orden de los chequeos, que no es arbitrario
 *
 * 1. **Cap de 50 activos.** Un `count` y nada más: es el rechazo más barato y el que no
 *    toma ningún lock.
 * 2. **La base image subida.** Valida entrada del cliente (404 / 410 / 409) y hace un
 *    `HEAD` contra el storage. Va **antes** del cobro por una razón medible: cobrar
 *    toma el lock de la fila del ledger (`SELECT … FOR UPDATE`) y ese lock se sostiene
 *    hasta el commit. Cobrar primero lo dejaría tomado durante una llamada de red,
 *    serializando toda la cuota del workspace por el tiempo que tarde S3.
 * 3. **Concurrencia y créditos** (`consumeAiStudioCredits`), en ese orden interno, que
 *    lo fija `startAiStudioGeneration`.
 * 4. **La fila y el encolado.** Lo caro, cuando ya está pago.
 *
 * ## `inFlightCount` se cuenta sobre los influencers, y eso NO es el cap completo
 *
 * `NFR-025` acota a 10 las *generaciones de AI Studio en vuelo* por workspace:
 * imágenes (4 créditos), videos (60) e influencers (250), todas juntas. Acá se cuentan
 * **sólo los pipelines de influencer** —las filas en `generating_variations` o
 * `training`— porque es lo único que el schema sabe: `influencer_assets` guarda los
 * resultados, no las generaciones en curso, y no hay ninguna tabla de generaciones
 * (las 33 del schema están listadas en `COMPANY_SCOPED_TABLES`). Contar los jobs de la
 * cola tampoco se puede desde acá: el puerto `Queue` no expone un conteo por workspace.
 *
 * Lo que se cuenta es verdad y es la mitad que más cuesta —250 créditos y 15–20 min de
 * GPU contra 4 créditos y 30–60 s—, así que el cap **sí frena** el abuso caro. Pero es
 * un conteo parcial y hay que decirlo: un workspace con 9 pipelines y 40 imágenes en
 * vuelo pasa. La alternativa era pasar `0`, y un `0` silencioso convierte el cap en
 * decoración. Queda en el reporte con lo que hace falta para cerrarlo.
 *
 * ## Personajes de Higgsfield — `PU-LATER-004`
 *
 *   GET  /influencers/setup                  ¿se puede crear? (Higgsfield + saldo)
 *   POST /influencers  {referenceMediaIds}   4–20 fotos del Media Bank → Soul ID
 *   POST /influencers/:id/images/estimate    estimador de SOUL V2 con el personaje
 *   POST /influencers/:id/images             estimar → reservar → encolar (202)
 *   GET  /influencers/:id/generations        los pedidos y su media
 *
 * - **Higgsfield tiene que estar en Settings → Models** (tarea de imagen o de
 *   video): es el único proveedor que documenta personajes por API. Sin él,
 *   `409 conflict` con `details.reason = "not_configured"`, antes de tocar nada.
 * - **El tope mensual**: las imágenes reservan su estimado en el mismo libro que
 *   AI Studio (`~/.fastgram/spend.json`) → `402` con `budget_exceeded`. Crear el
 *   personaje no tiene precio publicado ni estimador; se permite sólo si el mes
 *   tiene saldo (`canStartCharacter`) y la UI dice que el costo no se conoce.
 * - Los errores del proveedor salen como `503`/`400` con `details.reason`, nunca
 *   como un `401` (que la web leería como sesión vencida). Mismo criterio que
 *   `ai-studio.ts`.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";
import {
  MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE,
  createInfluencerRequestSchema,
  cursorQuerySchema,
  idempotencyHeaderSchema,
  imageUploadReservationRequestSchema,
  influencerImageRequestSchema,
  type CostEstimate,
  type InfluencerGeneration,
  type InfluencerImageEstimate,
  type InfluencerSetup,
} from "@fastgram/contracts";
import {
  influencerGenerationRepository,
  influencerRepository,
  mediaRepository,
  uploadReservationRepository,
  type Transaction,
} from "@fastgram/db";
import { HiggsfieldClient } from "@fastgram/adapters";
import { isPortError, type GenCostEstimate } from "@fastgram/ports";

import { ApiRejection } from "../../http/errors.js";
import {
  INFLUENCER_CHARACTER_PROVIDER,
  INFLUENCER_IMAGE_MODEL,
  INFLUENCER_REFERENCE_LIMITS,
  JOB_QUEUES,
  budgetSummary,
  canStartCharacter,
  fitsBudget,
  generationErrorFromPort,
  influencerImageSingletonKey,
  monthKey,
  releaseSpend,
  reserveSpend,
  resolveGenAiConfig,
  type CharacterGen,
  type ReserveResult,
  type ResolvedGenAiConfig,
} from "@fastgram/core";
import {
  GENAI_API_TIMEOUT_MS,
  defaultGenAiRouteDeps,
  ledgerOrFail,
  toBudgetView,
  type GenAiRouteDeps,
} from "./genai.js";

import { rateLimit } from "../../plugins/rate-limit.js";
import { consumeAiStudioCredits, quotaPolicyFor } from "../../support/quota.js";
import { toInfluencer, type InfluencerResource } from "../../support/serializers.js";
import {
  canonicalObjectUrl,
  claimReservation,
  reserveUpload,
} from "../../support/upload-reservations.js";
import { crossTenant, data, idempotencyKeyOf, page, withIdempotency } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const influencerParams = z.object({ id: z.string().min(1) });

/**
 * Los estados de `DATA-013` que significan "el pipeline está corriendo".
 *
 * `ready`, `failed` e `inactive` son terminales: los tres liberan el slot de
 * concurrencia, que es lo que `NFR-025` mide. Se listan los dos que cuentan en vez de
 * excluir los tres que no, para que agregar un estado nuevo al enum obligue a decidir
 * de qué lado cae en vez de caer en "en vuelo" por descarte.
 */
const IN_FLIGHT_INFLUENCER_STATUSES = ["generating_variations", "training"] as const;

/**
 * Cola del pipeline de §9.5 #5 (*"Influencer pipeline — generación de variaciones +
 * entrenamiento, 15–20 min, con progress"*).
 *
 * Era un literal local, escrito cuando **no había registro compartido de colas**, con la
 * nota de que nada verificaba que el worker usara el mismo string. Ahora sale de
 * `JOB_QUEUES`. Éste **coincidía por casualidad** con el nombre declarado; el de
 * `posts.ts` no, y programar un post devolvía 500 por eso.
 */
const INFLUENCER_PIPELINE_QUEUE = JOB_QUEUES.influencerPipeline;

/** §9.3 — la ruta tal como la nombra `IDEMPOTENT_ROUTES`. */
const CREATE_ROUTE = "POST /influencers";

/**
 * Dónde queda anotado el cargo de 250 créditos, y por qué en un `jsonb`.
 *
 * ## El problema
 *
 * `releaseAiStudioGeneration` existe en `core` y **nadie la llama**. Quien tiene que
 * llamarla es el handler del job `influencer-pipeline` cuando el pipeline falla, y ese
 * handler todavía no existe. Para que pueda hacerlo necesita tres datos de la fila: a
 * qué **período** se cobró (el ancla de facturación puede cambiar, así que derivarlo
 * después daría otro ledger), **cuánto** se cobró (`AI_STUDIO_COST` es un número del
 * PRD y puede moverse) y si **ya se devolvió** (un reembolso que corre dos veces
 * regala 250 créditos).
 *
 * Es exactamente lo que `contents.save_bucket` / `save_period` / `save_refunded_at`
 * resuelven para el content save — y ahí son **columnas tipadas con CHECK**. En
 * `influencers` esas columnas no existen y la migración vive en `packages/db`, que no
 * es de este agente.
 *
 * ## Lo que se hizo, que es interino y está marcado como tal
 *
 * El registro va en `internal_refs`, el `jsonb` que `DATA-013` declara nunca expuesto
 * (`toInfluencer` no lo mapea, y el tipo de retorno lo hace un error de compilación si
 * alguien lo agrega). No es donde debería vivir: un `jsonb` no tiene CHECK que exija
 * que los tres campos estén o falten juntos, no se indexa, y el worker que escriba
 * `soulId` ahí tiene que **mergear y no reemplazar** o borra el registro del cargo sin
 * que nada falle.
 *
 * La alternativa era cobrar y no anotar nada, y eso es precisamente el fallo que este
 * proyecto acaba de pagar con los content saves: se cobraba, la pieza que disparaba el
 * reembolso no se construía nunca, y **un cargo sin quien lo devuelva no vuelve
 * nunca**. Entre un registro interino en el lugar equivocado y ningún registro, el
 * interino es recuperable con una migración; el otro no se recupera: el dato no existe.
 *
 * La migración concreta que reemplaza esto está en el reporte.
 */
const CREDITS_REF_KEY = "aiStudioCharge";

/** La forma del registro de arriba. Se escribe una sola vez, al crear la fila. */
interface AiStudioChargeRef {
  /** Clave del ledger que se cobró — `quota_ledgers.period`. */
  readonly period: string;
  /** Créditos reservados. Es lo que hay que devolver, ni más ni menos. */
  readonly charged: number;
  /** `AiStudioOperation`, para que el reembolso no tenga que adivinar la tarifa. */
  readonly operation: "influencer";
  /** ms epoch del cargo. `null` mientras no se haya devuelto. */
  readonly chargedAtMs: number;
  readonly refundedAtMs: number | null;
}

/** pg-boss cuenta reintentos: 1 = dos intentos, la política de la cola. */
const IMAGE_RETRY_LIMIT = 1;
/** Por encima de los 25 min de polling del worker, igual que AI Studio. */
const IMAGE_EXPIRE_SECONDS = 30 * 60;
const GENERATIONS_LIST_LIMIT = 50;

/** Lo que las rutas de personaje necesitan, inyectable en los tests. */
export interface InfluencerRouteDeps {
  readonly genai: GenAiRouteDeps;
  /** Un cliente de personajes para la configuración de Higgsfield resuelta. */
  readonly characterClientFor: (config: ResolvedGenAiConfig) => CharacterGen;
}

export function defaultInfluencerRouteDeps(
  genai: GenAiRouteDeps = defaultGenAiRouteDeps(),
): InfluencerRouteDeps {
  return {
    genai,
    characterClientFor: (config) =>
      new HiggsfieldClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: GENAI_API_TIMEOUT_MS,
      }),
  };
}

/**
 * La configuración de Higgsfield, venga de la tarea de imagen o de la de video.
 * `null` si ninguna de las dos está completa con Higgsfield.
 */
export async function higgsfieldConfigFor(
  genai: GenAiRouteDeps,
): Promise<ResolvedGenAiConfig | null> {
  const snapshot = await genai.registry.read();
  for (const task of ["image", "video"] as const) {
    const config = resolveGenAiConfig(task, snapshot, genai.env);
    if (config?.provider === INFLUENCER_CHARACTER_PROVIDER) return config;
  }
  return null;
}

function notConfigured(): ApiRejection {
  return new ApiRejection(
    409,
    "conflict",
    "Influencers need Higgsfield: set it as the image or video provider in Settings → Models.",
    { reason: "not_configured" },
  );
}

/** Un error del proveedor → una respuesta que no se confunde con la sesión. */
function providerRejection(error: unknown): ApiRejection {
  if (isPortError(error)) {
    const reason = generationErrorFromPort(error.code);
    return reason === "bad_request"
      ? new ApiRejection(400, "bad_request", error.message, { reason })
      : new ApiRejection(503, "service_unavailable", error.message, { reason });
  }
  return new ApiRejection(503, "service_unavailable", "Higgsfield failed.", {
    reason: "provider_unavailable",
  });
}

function estimateView(e: GenCostEstimate): CostEstimate {
  return { usd: e.usd, source: e.source, basis: e.basis, sourceUrl: e.sourceUrl ?? null };
}

type InfluencerRow = NonNullable<
  Awaited<ReturnType<typeof influencerRepository.findById>>
>;

/**
 * La fila → el recurso. Los campos internos (`soulId`, `internalRefs`, el cargo
 * de créditos) no salen. Los rasgos opcionales se omiten cuando no hay.
 */
export function influencerView(row: InfluencerRow): InfluencerResource {
  const base = toInfluencer(row) as InfluencerResource & Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };
  for (const k of ["gender", "age", "ethnicity"] as const) {
    if (row[k] === null) delete out[k];
  }
  out["referenceMediaIds"] = [...row.referenceMediaIds];
  if (row.status === "failed" && row.failureCode !== null) {
    out["failure"] = {
      code: row.failureCode,
      message: row.failureMessage ?? "The character could not be created.",
    };
  }
  return out as InfluencerResource;
}

type GenerationRow = NonNullable<
  Awaited<ReturnType<typeof influencerGenerationRepository.findById>>
>;

async function generationViews(
  tx: Transaction,
  companyId: string,
  rows: readonly GenerationRow[],
): Promise<InfluencerGeneration[]> {
  const ids = [...new Set(rows.flatMap((r) => r.mediaIds))];
  const byId = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const found = await mediaRepository.list(
      tx,
      { companyId },
      { limit: chunk.length, filter: { mediaId: { in: chunk } } },
    );
    for (const m of found.items) byId.set(m.mediaId, m.r2Url);
  }
  return rows.map((r) => ({
    id: r.id,
    influencerId: r.influencerId,
    status: r.status as InfluencerGeneration["status"],
    model: r.model,
    prompt: r.prompt,
    aspectRatio: r.aspectRatio,
    count: r.count,
    estimate: {
      usd: r.estimateUsd,
      source: "provider",
      basis: r.estimateBasis,
      sourceUrl: "https://docs.higgsfield.ai/docs/concepts/billing-and-retention",
    },
    // Una imagen borrada del Media Bank deja de mostrarse acá.
    media: r.mediaIds.flatMap((mediaId) => {
      const url = byId.get(mediaId);
      return url === undefined ? [] : [{ mediaId, mediaType: "image" as const, url }];
    }),
    error:
      r.errorCode === null
        ? null
        : {
            code: r.errorCode as NonNullable<InfluencerGeneration["error"]>["code"],
            message: r.errorMessage ?? "The generation failed.",
          },
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export function registerInfluencerRoutes(
  app: ZodApp,
  deps: InfluencerRouteDeps = defaultInfluencerRouteDeps(),
): void {
  const { genai } = deps;
  const now = (): Date => app.deps.clock.now();

  /** El personaje listo para generar, o el rechazo que corresponde. */
  async function readyCharacter(
    tx: Transaction,
    companyId: string,
    id: string,
  ): Promise<{ readonly row: InfluencerRow; readonly soulId: string }> {
    const row = await influencerRepository.findById(tx, { companyId }, id);
    if (row === null) throw crossTenant("influencer", id, companyId);
    if (
      row.status !== "ready" ||
      row.soulId === null ||
      row.provider !== INFLUENCER_CHARACTER_PROVIDER
    ) {
      throw new ApiRejection(
        409,
        "conflict",
        "This influencer is not ready to generate images yet.",
        { reason: "not_ready", status: row.status },
      );
    }
    return { row, soulId: row.soulId };
  }

  async function estimateFor(
    soulId: string,
    body: z.infer<typeof influencerImageRequestSchema>,
  ): Promise<{ config: ResolvedGenAiConfig; cost: GenCostEstimate }> {
    const config = await higgsfieldConfigFor(genai);
    if (config === null) throw notConfigured();
    let client: CharacterGen;
    try {
      client = deps.characterClientFor(config);
    } catch (error) {
      throw providerRejection(error);
    }
    try {
      const cost = await client.estimateCharacterImage({
        characterId: soulId,
        prompt: body.prompt,
        aspectRatio: body.aspectRatio,
        n: body.count,
      });
      return { config, cost };
    } catch (error) {
      throw providerRejection(error);
    }
  }

  // ── GET /influencers/setup ──
  app.get("/influencers/setup", async () => {
    const config = await higgsfieldConfigFor(genai);
    const ledger = ledgerOrFail(await genai.ledger.read());
    const summary = budgetSummary(ledger, monthKey(now()), genai.env);
    const view: InfluencerSetup = {
      configured: config !== null,
      provider: config === null ? null : "higgsfield",
      references: {
        min: INFLUENCER_REFERENCE_LIMITS.min,
        max: INFLUENCER_REFERENCE_LIMITS.max,
      },
      trainingCost: null,
      canCreate: config !== null && canStartCharacter(summary),
      budget: toBudgetView(summary),
    };
    return data(view);
  });

  const { clock, idempotency, limiter, storage } = app.deps;

  // ── GET /influencers ──
  app.get(
    "/influencers",
    { schema: { querystring: cursorQuerySchema } },
    async (request) => {
      const q = request.query;
      const result = await request.tx((tx) =>
        influencerRepository.list(
          tx,
          { companyId: request.auth.companyId },
          { limit: q.limit, ...(q.cursor === undefined ? {} : { cursor: q.cursor }) },
        ),
      );
      return page(result, influencerView);
    },
  );

  // ── POST /influencers/base-image/upload-url ──
  app.post(
    "/influencers/base-image/upload-url",
    {
      // FR-080: *"formatos `image/jpeg`, `image/png`, `image/webp`; la extensión del
      // filename debe coincidir con el content type; máx. 10 MB"*. Los tres los
      // comprueba este schema, que es el mismo que publica el SDK.
      schema: { body: imageUploadReservationRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const body = request.body;
      const companyId = request.auth.companyId;

      const reservation = await request.tx((tx) =>
        reserveUpload({
          tx,
          storage,
          companyId,
          apiKeyId: request.auth.apiKeyId,
          // Prefijo propio y no el del Media Bank: una base image no es un asset del
          // Media Bank —no se lista, no se categoriza— y compartir prefijo haría que
          // cualquier barrido por prefijo las mezclara.
          prefix: `influencers/${companyId}/base-images`,
          filename: body.filename,
          contentType: body.contentType,
          sizeBytes: body.sizeBytes,
        }),
      );

      return reply.status(200).send(data(reservation));
    },
  );

  // ── POST /influencers ──
  app.post(
    "/influencers",
    {
      schema: {
        body: createInfluencerRequestSchema,
        // §9.3: obligatoria en este endpoint. Que la exija el schema y no el handler
        // hace que la falta salga como el mismo `bad_request` que cualquier otro campo
        // que falte, en vez de como un caso especial.
        headers: idempotencyHeaderSchema,
      },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const queue = app.deps.queue;
      if (queue === undefined) {
        // Mismo criterio que `POST /blitz/angles/generate` con `angleGenerator`: crear
        // el influencer sin encolar el pipeline deja una fila en
        // `generating_variations` con `progress` 0 para siempre, y el usuario ve un
        // personaje que nunca termina. `service_unavailable` es un código del PRD
        // (§19, ERR-R06) y no se crea nada.
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Influencer creation is temporarily unavailable.",
          },
        });
      }

      const body = request.body;
      const companyId = request.auth.companyId;
      // El spread es para no depender de cómo tipa los headers el type provider: lo
      // que `idempotencyKeyOf` necesita es un registro, y el schema ya garantizó que
      // la clave está y es un string.
      const key = idempotencyKeyOf({ ...request.headers });

      return withIdempotency(
        idempotency,
        request,
        reply,
        { key, route: CREATE_ROUTE, body, successStatus: 201 },
        async () => {
          // `PU-LATER-004`: con fotos de referencia el personaje lo crea
          // Higgsfield. Se chequea **antes** de la transacción (lee archivos
          // locales) y dentro de `withIdempotency`: un replay no vuelve a
          // preguntar, devuelve lo de la primera vez.
          const references = body.referenceMediaIds;
          if (references !== undefined) {
            if ((await higgsfieldConfigFor(genai)) === null) throw notConfigured();
            const ledger = ledgerOrFail(await genai.ledger.read());
            const summary = budgetSummary(ledger, monthKey(now()), genai.env);
            if (!canStartCharacter(summary)) {
              throw new ApiRejection(
                402,
                "payment_required",
                "This month's AI budget is used up. Raise it in Settings → Models to create a character.",
                {
                  reason: "budget_exceeded",
                  remainingUsd: summary.remainingUsd,
                  budgetUsd: summary.budgetUsd,
                },
              );
            }
          }
          return request.tx(async (tx): Promise<InfluencerResource> => {
            const scope = { companyId };

            // El cap es sobre **activos** (FR-080, `HARD_CAPS.activeInfluencers`) y
            // el conteo sale de la misma transacción que va a insertar: contarlo
            // fuera deja que dos peticiones lean 49 y creen las dos.
            const activeCount = await influencerRepository.count(tx, scope, {
              filter: { isActive: { eq: true } },
            });
            if (activeCount >= MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE) {
              throw new ApiRejection(
                402,
                "payment_required",
                `You can have up to ${String(MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE)} active influencers. Deactivate one to make room.`,
                {
                  cap: MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE,
                  active: activeCount,
                },
              );
            }

            // FR-080: dos caminos excluyentes. Con `baseImageUploadId` el usuario
            // subió su imagen y hay que confirmar que el objeto llegó; sin él, la
            // genera el pipeline (4 créditos) y `baseImageUrl` nace nulo.
            let baseImageUrl: string | null = null;
            if (references !== undefined) {
              // Las fotos tienen que ser imágenes vivas y listas de **esta**
              // marca: una de otra marca no existe acá (mismo 400 que una
              // borrada: el id no dice nada).
              const found = await mediaRepository.list(tx, scope, {
                limit: references.length,
                filter: { mediaId: { in: references } },
              });
              const usable = new Map(
                found.items
                  .filter((m) => m.mediaType === "image" && m.status === "ready")
                  .map((m) => [m.mediaId, m.r2Url]),
              );
              const missing = references.filter((id) => !usable.has(id));
              if (missing.length > 0) {
                throw new ApiRejection(
                  400,
                  "bad_request",
                  "Some reference photos are not ready images in this brand's Media Bank.",
                  { field: "referenceMediaIds", missing },
                );
              }
              // La portada: la primera foto elegida, de **nuestro** storage.
              baseImageUrl = usable.get(references[0] as string) ?? null;
            } else if (body.baseImageUploadId !== undefined) {
              const claim = await claimReservation({
                tx,
                storage,
                companyId,
                uploadId: body.baseImageUploadId,
                nowMs: clock.nowMs(),
              });
              if (!claim.ok) {
                throw new ApiRejection(
                  claim.rejection.status,
                  claim.rejection.code,
                  claim.rejection.message,
                );
              }
              // Lo que se persiste es la dirección del objeto, no la URL firmada:
              // §9.10 prohíbe persistir esas, que son capacidades de una hora.
              baseImageUrl = await canonicalObjectUrl(storage, claim.row.storageKey);
              await uploadReservationRepository.update(
                tx,
                scope,
                body.baseImageUploadId,
                { state: "committed" },
              );
            }

            // `NFR-025`: el cap de concurrencia se aplica **antes de encolar**. Ver
            // la cabecera sobre por qué este conteo es parcial y por qué aun así se
            // pasa el número real en vez de un `0`.
            const inFlightCount = await influencerRepository.count(tx, scope, {
              filter: { status: { in: IN_FLIGHT_INFLUENCER_STATUSES } },
            });

            // §9.4, literal: *"reserva la allowance antes de la generación del
            // modelo, y la libera si falla"*. Son 250 créditos y el driver de coste
            // número uno del producto; cobrar después del encolado dejaría que un
            // workspace Free con 10 créditos encolara pipelines indefinidamente.
            // Lanza `402 payment_required` (créditos) o `409 conflict`
            // (concurrencia), los dos con el copy literal del PRD.
            const charge = await consumeAiStudioCredits(tx, scope, clock, {
              operation: "influencer",
              inFlightCount,
              policy: quotaPolicyFor(app.deps.mode),
            });

            const chargeRef: AiStudioChargeRef = {
              period: charge.period,
              charged: charge.charged,
              operation: "influencer",
              chargedAtMs: clock.nowMs(),
              refundedAtMs: null,
            };

            const created = await influencerRepository.create(tx, scope, {
              name: body.name,
              gender: body.gender ?? null,
              age: body.age ?? null,
              ethnicity: body.ethnicity ?? null,
              ...(baseImageUrl === null ? {} : { baseImageUrl }),
              ...(references === undefined
                ? {}
                : {
                    referenceMediaIds: [...references],
                    provider: INFLUENCER_CHARACTER_PROVIDER,
                  }),
              // Ver `CREDITS_REF_KEY`: sin esto el cargo de 250 créditos no tiene
              // quien lo devuelva cuando el pipeline falle.
              internalRefs: { [CREDITS_REF_KEY]: chargeRef },
              // `status` y `progress` los pone el default del schema
              // (`generating_variations`, 0): son el estado inicial del pipeline y
              // repetirlos acá crearía un segundo sitio donde cambiarlos.
            });

            // ADR-005: el encolado va **dentro** de la transacción. Si la cola no
            // responde, esto lanza y ni la fila ni el cargo existen; si el commit
            // falla, el job tampoco. Es esta propiedad la que impide cobrar 250
            // créditos por un pipeline que nunca se encoló.
            //
            // `additionalDetails` viaja en el payload y no en la fila: DATA-013 no
            // tiene ese campo, y es entrada del generador, no estado del personaje.
            await queue.enqueue({
              queue: INFLUENCER_PIPELINE_QUEUE,
              payload: {
                influencerId: created.id,
                companyId,
                name: created.name,
                ...(created.gender === null ? {} : { gender: created.gender }),
                ...(created.age === null ? {} : { age: created.age }),
                ...(created.ethnicity === null ? {} : { ethnicity: created.ethnicity }),
                ...(body.additionalDetails === undefined
                  ? {}
                  : { additionalDetails: body.additionalDetails }),
                ...(baseImageUrl === null ? {} : { baseImageUrl }),
                // Para que el handler pueda reembolsar sin volver a derivar el
                // período: el ancla de facturación puede cambiar entre el cargo y
                // el fallo, y entonces el reembolso iría a otro ledger. Sigue
                // estando en la fila, que es la fuente; esto es para que el job no
                // tenga que leerla antes de saber si hay algo que devolver.
                creditsPeriod: charge.period,
                creditsCharged: charge.charged,
              },
              options: {
                transaction: tx,
                // El id de la fila recién creada es único por definición, así que
                // esto no deduplica dos peticiones distintas —de eso se ocupa la
                // `Idempotency-Key`— sino un reintento del propio encolado.
                singletonKey: `influencer:${created.id}`,
              },
            });

            return influencerView(created);
          });
        },
      );
    },
  );

  // ── GET /influencers/:id ──
  app.get(
    "/influencers/:id",
    { schema: { params: influencerParams } },
    async (request) => {
      const { id } = request.params;
      const companyId = request.auth.companyId;
      const row = await request.tx((tx) =>
        influencerRepository.findById(tx, { companyId }, id),
      );
      if (row === null) throw crossTenant("influencer", id, companyId);
      // `soulId`, `baseCharacterCmlId` e `internalRefs` no salen: DATA-013 los marca
      // "nunca expuestos" y `toInfluencer` simplemente no los mapea.
      return data(influencerView(row));
    },
  );
  // ── POST /influencers/:id/images/estimate ──
  app.post(
    "/influencers/:id/images/estimate",
    { schema: { params: influencerParams, body: influencerImageRequestSchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const { soulId } = await request.tx((tx) =>
        readyCharacter(tx, companyId, request.params.id),
      );
      const { cost } = await estimateFor(soulId, request.body);
      const ledger = ledgerOrFail(await genai.ledger.read());
      const summary = budgetSummary(ledger, monthKey(now()), genai.env);
      const view: InfluencerImageEstimate = {
        model: INFLUENCER_IMAGE_MODEL,
        estimate: estimateView(cost),
        budget: toBudgetView(summary),
        fits: fitsBudget(summary, cost.usd),
      };
      return data(view);
    },
  );

  // ── POST /influencers/:id/images ──
  app.post(
    "/influencers/:id/images",
    { schema: { params: influencerParams, body: influencerImageRequestSchema } },
    async (request, reply) => {
      const queue = app.deps.queue;
      if (queue === undefined) {
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Influencer images are temporarily unavailable.",
          },
        });
      }
      const companyId = request.auth.companyId;
      const influencerId = request.params.id;
      const body = request.body;
      const { soulId } = await request.tx((tx) =>
        readyCharacter(tx, companyId, influencerId),
      );
      const { config, cost } = await estimateFor(soulId, body);

      const at = now();
      const month = monthKey(at);
      const id = randomUUID();
      const reserved = await genai.ledger.update<ReserveResult>((raw) => {
        const r = reserveSpend(
          ledgerOrFail(raw),
          {
            month,
            generationId: id,
            usd: cost.usd,
            provider: config.provider,
            model: INFLUENCER_IMAGE_MODEL,
            kind: "image",
            companyId,
            at: at.toISOString(),
          },
          genai.env,
        );
        return r.ok ? { next: r.next, result: r } : { result: r };
      });
      if (!reserved.ok) {
        throw new ApiRejection(
          402,
          "payment_required",
          "This generation would go over this month's AI budget.",
          {
            reason: "budget_exceeded",
            estimateUsd: cost.usd,
            remainingUsd: reserved.summary.remainingUsd,
            budgetUsd: reserved.summary.budgetUsd,
          },
        );
      }

      let row: GenerationRow;
      try {
        // ADR-005: la fila y el job en la misma transacción. Si encolar falla,
        // no queda una fila `queued` que nadie va a procesar.
        row = await request.tx(async (tx) => {
          const created = await influencerGenerationRepository.create(
            tx,
            { companyId },
            {
              id,
              influencerId,
              status: "queued",
              provider: config.provider,
              model: INFLUENCER_IMAGE_MODEL,
              prompt: body.prompt,
              aspectRatio: body.aspectRatio,
              count: body.count,
              estimateUsd: cost.usd,
              estimateBasis: cost.basis,
              spendMonth: month,
            },
          );
          await queue.enqueue({
            queue: JOB_QUEUES.influencerPipeline,
            payload: { op: "image", companyId, influencerId, generationId: id },
            options: {
              transaction: tx,
              singletonKey: influencerImageSingletonKey(id),
              retryLimit: IMAGE_RETRY_LIMIT,
              retryBackoff: true,
              expireInSeconds: IMAGE_EXPIRE_SECONDS,
            },
          });
          return created;
        });
      } catch (error) {
        await genai.ledger
          .update((raw) => {
            const next = releaseSpend(ledgerOrFail(raw), month, id);
            return next === null ? { result: null } : { next, result: null };
          })
          .catch(() => undefined);
        throw error;
      }

      request.log.info(
        { generationId: id, influencerId, estimateUsd: cost.usd },
        "influencer images queued",
      );
      const [view] = await request.tx((tx) => generationViews(tx, companyId, [row]));
      return reply.status(202).send(data(view));
    },
  );

  // ── GET /influencers/:id/generations ──
  app.get(
    "/influencers/:id/generations",
    { schema: { params: influencerParams } },
    async (request) => {
      const companyId = request.auth.companyId;
      const { id } = request.params;
      const views = await request.tx(async (tx) => {
        const row = await influencerRepository.findById(tx, { companyId }, id);
        if (row === null) throw crossTenant("influencer", id, companyId);
        const rows = await influencerGenerationRepository.list(
          tx,
          { companyId },
          { limit: GENERATIONS_LIST_LIMIT, filter: { influencerId: { eq: id } } },
        );
        return generationViews(tx, companyId, rows.items);
      });
      return data(views);
    },
  );
}
