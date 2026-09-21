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
 * Tres de las cuatro están acá. La que falta es la reserva de créditos, y no está por
 * falta de datos, no por olvido — ver abajo.
 *
 * ## La reserva de créditos NO se aplica, y conviene saber exactamente por qué
 *
 * `core` ya tiene `reserveCredits`/`releaseCredits` y el coste (`AI_STUDIO_COST.influencer`
 * = 250) está fijado. Lo que no existe es de dónde leer el saldo:
 *
 *  - el saldo vive en `quota_ledgers.aiCredits`, cuya PK es `(companyId, period)`, y
 *    **el formato de `period` está sin decidir** — el propio schema lo dice: depende del
 *    día ancla de facturación (§16.2), no del mes calendario. Elegir un formato acá
 *    fijaría el particionado de la facturación desde una ruta;
 *  - `companies` tiene `planId` y `billingAnchorDay`, pero **no hay repositorio de
 *    `companies`**: los 28 son company-scoped y la raíz de la tenencia no está entre
 *    ellos.
 *
 * Consecuencia real y sin maquillar: **hoy crear un influencer no descuenta créditos**.
 * Está en el reporte como lo que es, un agujero de facturación con nombre y tarea.
 *
 * ## Por qué el cap de 50 viaja como excepción y no como `DomainError`
 *
 * FR-080 dice que el cap alcanzado es `402 payment_required` con `details`. Ningún
 * `DomainErrorCode` mapea a ese código —`out_of_range` es 400— y `DomainError.details`
 * nunca se serializa hacia el cliente, así que por esa vía el `402` del PRD no sale.
 * Tampoco puede ser un `return`: el chequeo tiene que ocurrir **dentro** de la
 * transacción que escribe (si no, dos peticiones leen 49 y crean las dos) y dentro de
 * `withIdempotency` (si no, un reintento legítimo con la misma key recibiría el 402 en
 * vez del replay que promete FR-080 (4)). Una excepción propia es lo único que atraviesa
 * las dos capas sin romper ninguna: `withIdempotency` libera la key —correcto, no se
 * creó nada— y acá afuera se traduce al código literal del PRD.
 */
import { z } from "zod";
import {
  MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE,
  createInfluencerRequestSchema,
  cursorQuerySchema,
  idempotencyHeaderSchema,
  imageUploadReservationRequestSchema,
  type ErrorCode,
} from "@fastgram/contracts";
import { influencerRepository, uploadReservationRepository } from "@fastgram/db";

import { rateLimit } from "../../plugins/rate-limit.js";
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
 * Cola del pipeline de §9.5 #5 (*"Influencer pipeline — generación de variaciones +
 * entrenamiento, 15–20 min, con progress"*).
 *
 * El nombre es local porque **no hay registro compartido de colas** en el monorepo. El
 * worker que consuma esto tiene que usar el mismo string y hoy nada lo verifica: está
 * en el reporte.
 */
const INFLUENCER_PIPELINE_QUEUE = "influencer-pipeline";

/** §9.3 — la ruta tal como la nombra `IDEMPOTENT_ROUTES`. */
const CREATE_ROUTE = "POST /influencers";

/**
 * Rechazo de negocio que tiene que salir con el código literal del PRD.
 *
 * Ver la cabecera: existe para cruzar `withIdempotency` y la transacción sin perder ni
 * el `details` ni el status. No se usa para errores de infraestructura, que ya tienen
 * su traducción en `http/errors.ts`.
 */
class CreationRejected extends Error {
  override readonly name = "CreationRejected";
  constructor(
    readonly status: number,
    readonly payload: {
      readonly code: ErrorCode;
      readonly message: string;
      readonly details?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(payload.message);
  }
}

export function registerInfluencerRoutes(app: ZodApp): void {
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
      return page(result, toInfluencer);
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

      try {
        return await withIdempotency(
          idempotency,
          request,
          reply,
          { key, route: CREATE_ROUTE, body, successStatus: 201 },
          () =>
            request.tx(async (tx): Promise<InfluencerResource> => {
              const scope = { companyId };

              // El cap es sobre **activos** (FR-080, `HARD_CAPS.activeInfluencers`) y
              // el conteo sale de la misma transacción que va a insertar: contarlo
              // fuera deja que dos peticiones lean 49 y creen las dos.
              const activeCount = await influencerRepository.count(tx, scope, {
                filter: { isActive: { eq: true } },
              });
              if (activeCount >= MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE) {
                throw new CreationRejected(402, {
                  code: "payment_required",
                  message: `You can have up to ${MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE} active influencers. Deactivate one to make room.`,
                  details: {
                    cap: MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE,
                    active: activeCount,
                  },
                });
              }

              // FR-080: dos caminos excluyentes. Con `baseImageUploadId` el usuario
              // subió su imagen y hay que confirmar que el objeto llegó; sin él, la
              // genera el pipeline (4 créditos) y `baseImageUrl` nace nulo.
              let baseImageUrl: string | null = null;
              if (body.baseImageUploadId !== undefined) {
                const claim = await claimReservation({
                  tx,
                  storage,
                  companyId,
                  uploadId: body.baseImageUploadId,
                  nowMs: clock.nowMs(),
                });
                if (!claim.ok) {
                  throw new CreationRejected(claim.rejection.status, {
                    code: claim.rejection.code,
                    message: claim.rejection.message,
                  });
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

              const created = await influencerRepository.create(tx, scope, {
                name: body.name,
                gender: body.gender,
                age: body.age,
                ethnicity: body.ethnicity,
                ...(baseImageUrl === null ? {} : { baseImageUrl }),
                // `status` y `progress` los pone el default del schema
                // (`generating_variations`, 0): son el estado inicial del pipeline y
                // repetirlos acá crearía un segundo sitio donde cambiarlos.
              });

              // ADR-005: el encolado va **dentro** de la transacción. Si la cola no
              // responde, esto lanza y la fila no existe; si el commit falla, el job
              // tampoco. El día que se reserven créditos, es esta misma propiedad la
              // que impide cobrar sin trabajo.
              //
              // `additionalDetails` viaja en el payload y no en la fila: DATA-013 no
              // tiene ese campo, y es entrada del generador, no estado del personaje.
              await queue.enqueue({
                queue: INFLUENCER_PIPELINE_QUEUE,
                payload: {
                  influencerId: created.id,
                  companyId,
                  name: created.name,
                  gender: created.gender,
                  age: created.age,
                  ethnicity: created.ethnicity,
                  ...(body.additionalDetails === undefined
                    ? {}
                    : { additionalDetails: body.additionalDetails }),
                  ...(baseImageUrl === null ? {} : { baseImageUrl }),
                },
                options: {
                  transaction: tx,
                  // El id de la fila recién creada es único por definición, así que
                  // esto no deduplica dos peticiones distintas —de eso se ocupa la
                  // `Idempotency-Key`— sino un reintento del propio encolado.
                  singletonKey: `influencer:${created.id}`,
                },
              });

              return toInfluencer(created);
            }),
        );
      } catch (e: unknown) {
        if (e instanceof CreationRejected) {
          request.log.info(
            { route: CREATE_ROUTE, status: e.status, code: e.payload.code },
            "influencer creation rejected",
          );
          return reply.status(e.status).send({ error: { ...e.payload } });
        }
        throw e;
      }
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
      return data(toInfluencer(row));
    },
  );
}
