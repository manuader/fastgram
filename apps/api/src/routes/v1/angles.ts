/**
 * Content angles — `GET|POST /blitz/angles`, `GET /blitz/angles/page`,
 * `PATCH|DELETE /blitz/angles/:id`, `POST /blitz/angles/generate`.
 *
 * Fuente: PRD §9.3, §9.4, §9.10, FR-055, FR-056, AI-005.
 *
 * ## Las tres mutaciones reconcilian dentro de la transacción
 *
 * §9.4 lo pide literal: *"Transacciones que abarquen mutación + reconcile (crear
 * ángulo **y** reescribir `angleWeights` en la misma transacción)"*. Acá eso se
 * cumple porque **todo el handler corre dentro de un solo `request.tx`** y los
 * repositorios reciben ese `tx`: ninguno abre transacción propia.
 *
 * Qué se rompe si se separan, y es lo que no se ve en un test feliz: entre las dos
 * escrituras hay un instante en que el ángulo existe y los pesos no lo cubren. Si el
 * proceso muere ahí, el mapa suma 100 sobre N-1 ángulos y el nuevo **no sale nunca**
 * — sin error y sin alerta. Y al revés, si se escriben pesos que no suman 100, el
 * CHECK `blitz_preferences_format_weights_sum` no lo ve (mira los pesos de formato,
 * no éstos), así que el sesgo queda instalado en silencio.
 *
 * `reconcileAngleWeights` de `core` es el que produce el reparto par que suma
 * **exactamente** 100: con 3 ángulos da 34/33/33, no 33/33/33. El orden del array
 * decide quién se queda el punto sobrante; acá es el del repositorio (el más nuevo
 * primero), porque el PRD no dice quién debe quedárselo.
 *
 * ## Qué NO dispara reconcile
 *
 * Renombrar o editar la descripción, por FR-055: si lo disparara, corregir una falta
 * de ortografía borraría los pesos personalizados que el usuario puso a mano.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createContentAngleRequestSchema,
  cursorQuerySchema,
  // §9.10, paginación **numerada**. Vivía escrito a mano acá con una nota que
  // decía que debía estar en el contrato; ahora está, y el coste de que no
  // estuviera se vio: `GET /blitz/angles/page` no aparecía en el OpenAPI.
  numberedPageQuerySchema,
  updateContentAngleRequestSchema,
} from "@fastgram/contracts";
import {
  DomainError,
  HARD_CAPS,
  activateAngle,
  assertAngleIsActiveForLinking,
  assertCanLinkInfluencer,
  assertValidInfluencerLinks,
  createContentAngle,
  deactivateAngle,
  editAngleText,
  type AngleWeights,
  type ContentAngle as DomainContentAngle,
  type ContentAngleRepository,
  type InfluencerRef,
} from "@fastgram/core";
import {
  companyProfileRepository,
  contentAngleRepository,
  influencerRepository,
  type Transaction,
} from "@fastgram/db";

import { consumeOnSuccess } from "../../plugins/rate-limit.js";
import { toContentAngle } from "../../support/serializers.js";
import {
  activeAngleIdsOf,
  listAllAngles,
  persistAngleWeights,
  type AngleRow,
} from "./blitz.js";
import { data, notFound, page } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const angleParams = z.object({ id: z.string().min(1) });

/** Lo que devuelve `listByPage`. `OffsetPage` no se exporta del índice de `@fastgram/db`. */
interface NumberedPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
  readonly hasMore: boolean;
}

/**
 * Envelope de la paginación numerada.
 *
 * **El PRD nombra la ruta (§9.3) pero no detalla su respuesta**, así que esto es una
 * decisión, no una transcripción. Lo que sí está fijado y se respeta:
 *
 *  - §9.3 fija **dos claves** de primer nivel para un listado: `data` y `pagination`.
 *    Cambiarlas acá pondría dos formas distintas de listado en el mismo cable, que es
 *    exactamente lo que `P1-DATA-015` acaba de terminar de limpiar con los cursores.
 *  - §9.10 fija lo que esta ruta tiene que poder mostrar: `Page X of Y`. De ahí
 *    `page` y `totalPages`; `totalItems` es el número que la UI de pickers muestra al
 *    lado y que ya cuesta pagado (el `COUNT(*)` va igual para calcular `Y`).
 *
 * **`cursor` se omite a propósito**, y es la parte que importa: incluirlo en `null`
 * lo haría parecer un cursor que el cliente puede guardar y reenviar, y esta ruta no
 * acepta ninguno. Un campo que siempre es `null` no es información, es una invitación
 * a un bug del lado del cliente. `hasMore` sí se conserva porque significa lo mismo
 * que en el envelope de cursor: hay algo después de esta página.
 */
export function numberedPageEnvelope<TRow, TOut>(
  p: NumberedPage<TRow>,
  map: (row: TRow) => TOut,
): {
  data: TOut[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    hasMore: boolean;
  };
} {
  return {
    data: p.items.map(map),
    pagination: {
      page: p.page,
      pageSize: p.pageSize,
      totalItems: p.totalItems,
      totalPages: p.totalPages,
      hasMore: p.hasMore,
    },
  };
}

/** Fila de base → la entidad que entienden las funciones de `core`. */
const toDomainAngle = (row: AngleRow): DomainContentAngle => ({
  id: row.id,
  title: row.title,
  description: row.description ?? "",
  targetAudience: row.targetAudience ?? "",
  isActive: row.isActive,
  influencerIds: row.influencerIds,
});

/**
 * `InfluencerRef` del dominio a partir de la fila.
 *
 * **`isTrained` no es una columna**: DATA-013 modela el entrenamiento como el enum
 * `status` (`generating_variations` → `training` → `ready` → `failed`/`inactive`), y
 * "entrenado" es `ready`. Se traduce acá, en un solo sitio, en vez de repartir la
 * comparación por los handlers.
 */
const toInfluencerRef = (row: {
  id: string;
  isActive: boolean;
  status: string;
}): InfluencerRef => ({
  id: row.id,
  isActive: row.isActive,
  isTrained: row.status === "ready",
});

/**
 * Cuántos ángulos vivos tiene enlazado cada influencer, excluyendo uno.
 *
 * `excludeAngleId` existe para el PATCH: al reescribir los enlaces de un ángulo, los
 * suyos propios no cuentan contra el cap de 10 — si contaran, reenviar la misma lista
 * sin cambios fallaría al llegar al décimo.
 */
function countLinksPerInfluencer(
  rows: readonly AngleRow[],
  influencerIds: readonly string[],
  excludeAngleId?: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of influencerIds) counts[id] = 0;
  for (const row of rows) {
    if (row.id === excludeAngleId) continue;
    for (const linked of row.influencerIds) {
      if (linked in counts) counts[linked] = (counts[linked] ?? 0) + 1;
    }
  }
  return counts;
}

/** Mismos enlaces y en el mismo orden: el array de `influencerIds` es posicional en la base. */
const sameLinks = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** `HARD_CAPS.idsPerBatch` (PRD §16.2) — tope de ids por operación en lote. */
function assertBatchSize(influencerIds: readonly string[]): void {
  if (influencerIds.length > HARD_CAPS.idsPerBatch) {
    throw new DomainError(
      "out_of_range",
      `Send at most ${HARD_CAPS.idsPerBatch} influencer ids at a time.`,
      { given: influencerIds.length, max: HARD_CAPS.idsPerBatch },
    );
  }
}

/** Los influencers nombrados, y sólo ésos: el filtro por id evita paginar la galería. */
async function loadInfluencerRefs(
  tx: Transaction,
  companyId: string,
  influencerIds: readonly string[],
): Promise<InfluencerRef[]> {
  if (influencerIds.length === 0) return [];
  const found = await influencerRepository.list(
    tx,
    { companyId },
    { limit: HARD_CAPS.idsPerBatch, filter: { id: { in: [...influencerIds] } } },
  );
  return found.items.map(toInfluencerRef);
}

/**
 * `brandRevision` actual del workspace — guardarraíl de AI-005.
 *
 * Sin fila de perfil vale 0, que es el default de la columna: un workspace que nunca
 * guardó su marca no puede haberla cambiado desde que se generó el ángulo.
 */
async function loadBrandRevision(tx: Transaction, companyId: string): Promise<number> {
  const profiles = await companyProfileRepository.list(tx, { companyId }, { limit: 1 });
  return profiles.items[0]?.brandRevision ?? 0;
}

export function registerAngleRoutes(app: ZodApp): void {
  const { limiter, angleGenerator } = app.deps;

  // ── GET /blitz/angles ──
  app.get(
    "/blitz/angles",
    { schema: { querystring: cursorQuerySchema } },
    async (request) => {
      const q = request.query;
      const result = await request.tx((tx) =>
        contentAngleRepository.list(
          tx,
          { companyId: request.auth.companyId },
          { limit: q.limit, ...(q.cursor === undefined ? {} : { cursor: q.cursor }) },
        ),
      );
      return page(result, toContentAngle);
    },
  );

  // ── GET /blitz/angles/page ──
  // Se registra antes que `/blitz/angles/:id` por claridad; el router de Fastify
  // prefiere el segmento estático al paramétrico, así que `page` nunca cae en `:id`.
  app.get(
    "/blitz/angles/page",
    { schema: { querystring: numberedPageQuerySchema } },
    async (request) => {
      const q = request.query;
      const result = await request.tx((tx) =>
        contentAngleRepository.listByPage(
          tx,
          { companyId: request.auth.companyId },
          { page: q.page, limit: q.limit },
        ),
      );
      return numberedPageEnvelope(result, toContentAngle);
    },
  );

  // ── POST /blitz/angles ──
  app.post(
    "/blitz/angles",
    { schema: { body: createContentAngleRequestSchema } },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const body = request.body;
      const influencerIds = body.influencerIds ?? [];
      assertBatchSize(influencerIds);

      const row = await request.tx(async (tx) => {
        // Se captura la fila que devuelve el INSERT porque `core` trabaja con la
        // entidad de dominio, que no tiene `createdAt`/`updatedAt`, y el contrato sí
        // los exige. Leerla otra vez después sería una consulta de más por un dato
        // que el `RETURNING` ya trajo.
        let created: AngleRow | undefined;

        // Snapshot previo al INSERT. Sirve para el cap de 100 y para el cap por
        // influencer; el conjunto activo **no** se lee de acá, porque el reconcile
        // tiene que ver el ángulo recién insertado.
        const before = await listAllAngles(tx, companyId);

        /**
         * El puerto de `createContentAngle`, sobre los repositorios de `@fastgram/db`.
         *
         * Cada método recibe un handle de transacción que acá se **ignora**: el
         * adaptador se construye dentro de `request.tx`, así que ya está cerrado sobre
         * la única transacción que existe. Usar el parámetro obligaría a castear un
         * `unknown` —`core` no puede tipar la transacción sin importar la base— y el
         * cast no compraría ninguna garantía que el cierre no dé ya.
         */
        const repository: ContentAngleRepository = {
          // `content_angles` no tiene soft-delete, así que "vivos" son todos.
          countLiveAngles: async () => before.length,

          listActiveAngleIds: async () =>
            activeAngleIdsOf(await listAllAngles(tx, companyId)),

          countAnglesPerInfluencer: async (_companyId, ids) =>
            countLinksPerInfluencer(before, ids),

          listWorkspaceInfluencers: async () =>
            loadInfluencerRefs(tx, companyId, influencerIds),

          currentBrandRevision: async () => loadBrandRevision(tx, companyId),

          insertAngle: async (_companyId, angle) => {
            created = await contentAngleRepository.create(
              tx,
              { companyId },
              {
                id: angle.id,
                title: angle.title,
                description: angle.description,
                targetAudience: angle.targetAudience,
                isActive: angle.isActive,
                influencerIds: [...angle.influencerIds],
              },
            );
          },

          // Éste es el paso que §9.4 exige en la misma transacción. Va después del
          // INSERT y con el mismo `tx`: si falla, el ángulo se va con él. El mapa ya
          // viene reconciliado por `core` (reparto par que suma 100); acá sólo se
          // materializa.
          writeAngleWeights: async (_companyId, weights) => {
            await persistAngleWeights(tx, companyId, weights);
          },
        };

        await createContentAngle(
          { ids: { newId: () => randomUUID() }, repository },
          {
            companyId,
            actorId: request.auth.apiKeyId ?? request.auth.userId ?? companyId,
            transaction: tx,
            title: body.title,
            description: body.description,
            targetAudience: body.targetAudience,
            influencerIds,
            expectedBrandRevision: body.expectedBrandRevision,
          },
        );

        if (created === undefined) {
          throw new Error(
            "`createContentAngle` devolvió sin pasar por `insertAngle`. Es un cambio " +
              "en el caso de uso, no un caso de datos.",
          );
        }
        return created;
      });

      return reply.status(201).send(data(toContentAngle(row)));
    },
  );

  // ── PATCH /blitz/angles/:id ──
  app.patch(
    "/blitz/angles/:id",
    { schema: { params: angleParams, body: updateContentAngleRequestSchema } },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const { id } = request.params;
      const body = request.body;
      const requestedLinks = body.influencerIds;
      if (requestedLinks !== undefined) assertBatchSize(requestedLinks);

      const row = await request.tx(async (tx) => {
        // Se listan todos los ángulos en vez de hacer `findById`: hacen falta igual
        // para el reconcile y para contar el cap por influencer, y buscar en memoria
        // evita además que un id mal formado llegue como `uuid` a Postgres y salga
        // como 500 en lugar del 404 que corresponde.
        const rows = await listAllAngles(tx, companyId);
        const current = rows.find((candidate) => candidate.id === id);
        // Ajeno e inexistente son el mismo 404 (§9.2): el listado ya viene con scope,
        // así que un id de otro workspace simplemente no está.
        if (current === undefined) throw notFound("content angle");

        const angle = toDomainAngle(current);
        const otherActiveIds = activeAngleIdsOf(rows).filter(
          (activeId) => activeId !== id,
        );

        // 1. Texto. `editAngleText` valida los topes de FR-056 y **no** reconcilia.
        const textChanges = {
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.targetAudience === undefined
            ? {}
            : { targetAudience: body.targetAudience }),
        };
        let next = editAngleText(angle, textChanges, {}).angle;

        // 2. `isActive`. Es lo único que cambia cuántos ángulos compiten, así que es
        //    lo único que dispara reconcile. Activar y desactivar **dejan los enlaces
        //    de influencer en cero**: FR-056 dice que desactivar los borra y que
        //    reactivar no los restaura, y `core` lo implementa en las dos direcciones.
        let reconciled: AngleWeights | undefined;
        if (body.isActive !== undefined && body.isActive !== angle.isActive) {
          const transition = body.isActive
            ? activateAngle(next, otherActiveIds)
            : deactivateAngle(next, otherActiveIds);
          next = transition.angle;
          // `weightsChanged` es siempre `true` en las dos transiciones; se respeta el
          // campo en vez de asumirlo, porque es el contrato que `core` publica.
          reconciled = transition.weightsChanged ? transition.weights : undefined;
        }

        // 3. Enlaces de influencer, después de la transición: un PATCH que activa y
        //    asigna en la misma llamada deja el ángulo activo, así que la asignación
        //    es legal. El PRD no cubre esa combinación —sólo dice que asignar a un
        //    ángulo inactivo es 400—; queda anotado como abierto en el reporte.
        if (requestedLinks !== undefined) {
          assertAngleIsActiveForLinking(next);
          const refs = await loadInfluencerRefs(tx, companyId, requestedLinks);
          assertValidInfluencerLinks(requestedLinks, refs);
          const perInfluencer = countLinksPerInfluencer(rows, requestedLinks, id);
          for (const influencerId of requestedLinks) {
            assertCanLinkInfluencer(influencerId, perInfluencer[influencerId] ?? 0);
          }
          next = { ...next, influencerIds: requestedLinks };
        }

        // Sólo viajan los campos que el patch tocó o que la transición cambió. Mandar
        // los cinco siempre parece inofensivo y no lo es: `toDomainAngle` traduce
        // `null` a `""` para poder hablar con `core`, así que un PATCH de `title`
        // reescribiría `description` de `null` a `""` en una fila que nadie pidió
        // cambiar. Además, un patch vacío deja `updatedAt` quieto, que es lo correcto:
        // mover la fecha diría que algo cambió.
        const updated = await contentAngleRepository.update(tx, { companyId }, id, {
          ...(body.title === undefined ? {} : { title: next.title }),
          ...(body.description === undefined ? {} : { description: next.description }),
          ...(body.targetAudience === undefined
            ? {}
            : { targetAudience: next.targetAudience }),
          ...(next.isActive === current.isActive ? {} : { isActive: next.isActive }),
          ...(sameLinks(current.influencerIds, next.influencerIds)
            ? {}
            : { influencerIds: [...next.influencerIds] }),
        });
        if (updated === null) {
          throw new Error(
            "El UPDATE no encontró el ángulo que el listado acababa de devolver, en " +
              "la misma transacción. Si pasa, cambió el aislamiento del repositorio.",
          );
        }

        // 4. Reconcile, con el mismo `tx` y sólo si el conjunto activo cambió. Los
        //    pesos son los que calculó `core` en la transición, no unos recalculados
        //    acá: recalcularlos duplicaría la regla del reparto par y las dos copias
        //    se desincronizarían el día que cambie el criterio del resto.
        if (reconciled !== undefined) {
          await persistAngleWeights(tx, companyId, reconciled);
        }

        return updated;
      });

      return reply.status(200).send(data(toContentAngle(row)));
    },
  );

  // ── DELETE /blitz/angles/:id ──
  app.delete(
    "/blitz/angles/:id",
    { schema: { params: angleParams } },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const { id } = request.params;

      await request.tx(async (tx) => {
        const rows = await listAllAngles(tx, companyId);
        const current = rows.find((candidate) => candidate.id === id);
        if (current === undefined) throw notFound("content angle");

        // **Acá borrar es desactivar** (FR-056, PRD:1319): *"Borrar es un soft-delete
        // (desactivación) reversible por PATCH"*. No es `softDelete` del repositorio
        // —`content_angles` no tiene `deletedAt`— ni `hardDelete`: es un
        // `UPDATE isActive = false`. Si fuera un borrado real, el PATCH que el PRD
        // promete para revertirlo no tendría sobre qué correr.
        if (!current.isActive) {
          // Ya estaba desactivado: no cambia el conjunto activo, así que **no** se
          // reconcilia. Reconciliar acá reescribiría unos pesos que el usuario pudo
          // haber personalizado, por una petición que no cambió nada.
          return;
        }

        const transition = deactivateAngle(
          toDomainAngle(current),
          activeAngleIdsOf(rows).filter((activeId) => activeId !== id),
        );

        const updated = await contentAngleRepository.update(tx, { companyId }, id, {
          isActive: false,
          // Desactivar borra todos sus enlaces de influencer (FR-056). Reactivar
          // **no** los restaura, y conviene que la UI lo avise antes, no después.
          influencerIds: [...transition.angle.influencerIds],
        });
        if (updated === null) {
          throw new Error(
            "El UPDATE no encontró el ángulo que el listado acababa de devolver, en " +
              "la misma transacción. Si pasa, cambió el aislamiento del repositorio.",
          );
        }

        await persistAngleWeights(tx, companyId, transition.weights);
      });

      return reply.status(204).send();
    },
  );

  // ── POST /blitz/angles/generate ──
  app.post("/blitz/angles/generate", async (request, reply) => {
    if (angleGenerator === undefined) {
      // Sin adaptador de LLM no hay sugerencia que dar. `service_unavailable` es un
      // código del PRD (§19, ERR-R06); inventar un ángulo de relleno sería peor que
      // decir que el servicio no está.
      return reply.status(503).send({
        error: {
          code: "service_unavailable",
          message: "Angle generation is temporarily unavailable.",
        },
      });
    }

    const generated = await angleGenerator.generate({
      companyId: request.auth.companyId,
    });

    // §9.6: "5 sugerencias **exitosas** por minuto". Se cobra acá, después del éxito,
    // no en un preHandler. Ver la nota en `plugins/rate-limit.ts`.
    const limited = await consumeOnSuccess(limiter, "angleGeneration", request, reply);
    if (limited !== null) return limited;

    // AI-005: la sugerencia **no se persiste**. `brandRevision` vuelve al cliente para
    // que la reenvíe como `expectedBrandRevision` al crear.
    return reply.status(200).send(data(generated));
  });
}
