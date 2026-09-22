/**
 * Blitz — `POST /blitz`, `GET|PATCH /blitz/preferences`.
 *
 * Fuente: PRD §9.3, FR-050, FR-055, DATA-006.
 *
 * ## El reconcile de `angleWeights` vive acá, y no en `angles.ts`
 *
 * §9.4 exige *"crear ángulo **y** reescribir `angleWeights` en la misma
 * transacción"*. El mapa de pesos es una columna de `blitz_preferences`, así que
 * escribirlo es una operación de **este** recurso aunque lo dispare una mutación de
 * ángulo. Por eso {@link persistAngleWeights} y {@link listAllAngles} se exportan
 * desde acá y `angles.ts` las importa: la dependencia va en una sola dirección y no
 * hay dos sitios que sepan cómo se materializa la fila de preferencias.
 *
 * ## Lo que `POST /blitz` NO puede hacer hoy, y por qué no se inventa
 *
 * FR-050 dice que aceptar una sugerencia *"descuenta 1 swipe diario y 1 content
 * save"*, y `packages/core` ya tiene el gate (`acceptBlitzSuggestion` en
 * `quota/content-saves.ts`) y el caso de uso completo
 * (`acceptBlitzSuggestionUseCase`). **No se pueden llamar desde acá**, y no por una
 * omisión de esta ruta: faltan cuatro datos, cada uno documentado como pendiente en
 * su propio sitio.
 *
 *  1. `SavesLedger.plan` y `overageEnabled` salen de `companies.planId` y
 *     `companies.apiOverageEnabled`. **`packages/db` no expone ningún repositorio de
 *     `companies`** — la tabla no tiene columna `companyId`, su PK *es* el id, y
 *     `createCompanyScopedRepository` no la cubre.
 *  2. `SavesLedger.resetAt` necesita `companies.billingAnchorDay` (mismo hueco).
 *  3. `quota_ledgers.period` no tiene formato decidido: el schema lo dice literal
 *     (*"PENDIENTE — el formato tiene que decidirlo la tarea de cuotas"*). Sin
 *     formato no hay fila que leer ni que escribir.
 *  4. `SwipesLedger.dailyLimit` **no está en el PRD**: §2 lo lista entre lo que falta
 *     (*"límites exactos de swipes diarios por plan"*).
 *
 * Elegir cualquiera de los cuatro desde una ruta sería fijar para todo el sistema un
 * número o un formato que nadie decidió. La restricción del proyecto es explícita:
 * *"no inventes … precios; límites; comportamiento backend; si no existe evidencia
 * suficiente"*.
 *
 * Así que la ruta hace **todo lo que sí está soportado** —validación, perfil listo,
 * cola vacía— y se detiene en el gate de facturación con `503 service_unavailable`,
 * **antes de escribir nada**. El precedente del código es el de
 * `POST /blitz/angles/generate`, y el del PRD es §9.6: *"Si el sistema no puede
 * comprobar el límite de forma segura, devuelve `503 service_unavailable` (no 429) —
 * esto **no** significa cuota agotada"*. La alternativa —crear el `Content` y encolar
 * el build sin cobrar— regala el driver de costo #1 del producto y el PRD la prohíbe
 * en su criterio de aceptación 2.
 */
import {
  runBlitzRequestSchema,
  updateBlitzPreferencesRequestSchema,
} from "@fastgram/contracts";
import {
  DomainError,
  assertValidBlitzRequest,
  assertValidPreferencesPatch,
  type AngleWeights,
} from "@fastgram/core";
import {
  blitzPreferencesRepository,
  companyProfileRepository,
  contentAngleRepository,
  suggestionRepository,
  type Transaction,
  type contentAngles,
} from "@fastgram/db";

import { rateLimit } from "../../plugins/rate-limit.js";
import { toBlitzPreferences } from "../../support/serializers.js";
import { data } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

export type AngleRow = (typeof contentAngles)["$inferSelect"];

/**
 * Defaults sintetizados de `BlitzPreferences` (DATA-006: *"Sintetiza defaults si no
 * existe fila"*).
 *
 * **Sólo dos de estos números están en el PRD**: `influencerChance` 50 (PRD:1273) y
 * `smartTextPositioning` true (AI-014). Los demás son asunciones documentadas:
 *  - los cuatro pesos de formato van 25/25/25/25 porque la única restricción del PRD es
 *    que sumen 100, y el reparto par es la única elección que no privilegia un formato
 *    sin que nadie lo haya pedido;
 *  - los tres porcentajes arrancan en 0 porque son opt-in: remixar contenido ajeno o
 *    mencionar el negocio son decisiones del usuario, no defaults razonables.
 *
 * Están fijadas por un test para que cambiarlas sea deliberado y no un descuido.
 */
export const DEFAULT_BLITZ_PREFERENCES = {
  slideshowWeight: 25,
  wallOfTextWeight: 25,
  greenScreenWeight: 25,
  videoHookWeight: 25,
  remixPercentage: 0,
  ownMediaPercentage: 0,
  mentionBusinessPercentage: 0,
  influencerChance: 50,
  smartTextPositioning: true,
  genderFilter: null,
} as const;

/** FR-055 (PRD:1288) — `settingsApplication` es sólo de respuesta y constante. */
export const SETTINGS_APPLICATION = {
  mode: "future_generations",
  targetQueuedItems: 5,
} as const;

/**
 * `HARD_CAPS.contentAngles` es 100, así que una página de 100 trae el workspace
 * entero. El bucle existe igual porque el cap lo hace cumplir la ruta de creación y
 * no la base: una fila escrita por una migración o por un import podría pasarlo, y
 * un reconcile que sólo viera las primeras 100 dejaría a las demás con peso 0 sin
 * decirlo. El tope de páginas convierte ese caso en un error ruidoso.
 */
const ANGLE_PAGE_SIZE = 100;
const MAX_ANGLE_PAGES = 10;

/** Todos los ángulos del workspace, en el orden del repositorio (más nuevo primero). */
export async function listAllAngles(
  tx: Transaction,
  companyId: string,
): Promise<AngleRow[]> {
  const all: AngleRow[] = [];
  for (let page = 1; page <= MAX_ANGLE_PAGES; page += 1) {
    const result = await contentAngleRepository.listByPage(
      tx,
      { companyId },
      { page, limit: ANGLE_PAGE_SIZE },
    );
    all.push(...result.items);
    if (!result.hasMore) return all;
  }
  throw new Error(
    `El workspace tiene más de ${ANGLE_PAGE_SIZE * MAX_ANGLE_PAGES} content angles, ` +
      "muy por encima del cap de FR-056. Reconciliar pesos con una lista incompleta " +
      "dejaría ángulos en 0 sin avisar, así que se corta acá.",
  );
}

/**
 * Ids de los ángulos activos, **en el orden de entrada**.
 *
 * El parámetro pide las dos columnas que mira y no la fila entera: es lo que la
 * función necesita, y obliga a que un test no tenga que fabricar nueve campos que no
 * participan del resultado.
 */
export const activeAngleIdsOf = (
  rows: readonly { readonly id: string; readonly isActive: boolean }[],
): string[] => rows.filter((row) => row.isActive).map((row) => row.id);

/**
 * Escribe `angleWeights` en `blitz_preferences`, creando la fila si no existe.
 *
 * **No usa `upsert` a secas y la diferencia importa**: `upsert` reescribe *todas* las
 * columnas que se le pasan, así que pasarle los defaults junto al mapa le borraría al
 * usuario el content mix que configuró a mano cada vez que toca un ángulo. Por eso va
 * primero el `update` del único campo que cambia, y el `upsert` con defaults queda
 * sólo para el workspace que todavía no tiene fila — el caso que DATA-006 describe
 * como normal.
 */
export async function persistAngleWeights(
  tx: Transaction,
  companyId: string,
  weights: AngleWeights,
): Promise<void> {
  const updated = await blitzPreferencesRepository.update(tx, { companyId }, companyId, {
    angleWeights: weights,
  });
  if (updated !== null) return;

  const created = await blitzPreferencesRepository.upsert(
    tx,
    { companyId },
    { ...DEFAULT_BLITZ_PREFERENCES, angleWeights: weights, textStyleWeights: {} },
  );
  if (created === null) {
    throw new Error(
      "El upsert de `blitz_preferences` no devolvió fila. La PK de la tabla es el " +
        "propio `companyId` y el scope es el mismo, así que un conflicto con otro " +
        "workspace no es alcanzable: si pasa, cambió el modelo de datos.",
    );
  }
}

/** Un campo ausente en el patch conserva su valor; `null` es un valor, no una ausencia. */
const patched = <T, U>(fromPatch: T | undefined, current: U): T | U =>
  fromPatch === undefined ? current : fromPatch;

/**
 * `influencerChance` es el único campo donde el contrato y el schema no coinciden:
 * FR-055 (PRD:1273) dice *"decimales aceptados"* y `blitz_preferences.influencer_chance`
 * es `integer`.
 *
 * Se rechaza con `400` en vez de redondear, por el mismo criterio que
 * `unsupportedFilter`: redondear cambia en silencio el valor que el usuario eligió y
 * nadie se entera; un `400` con el motivo es visible y se arregla. Queda reportado
 * como un cambio pendiente en `packages/db` o en el contrato — no es una decisión que
 * corresponda tomar desde una ruta.
 */
function assertStorableInfluencerChance(value: number | undefined): void {
  if (value === undefined || Number.isInteger(value)) return;
  throw new DomainError(
    "out_of_range",
    "influencerChance must be a whole number: the stored column is an integer.",
    { field: "influencerChance", value },
  );
}

export function registerBlitzRoutes(app: ZodApp): void {
  const { limiter, queue } = app.deps;

  // ── GET /blitz/preferences ──
  app.get("/blitz/preferences", async (request) => {
    const companyId = request.auth.companyId;

    // `blitzPreferences` es 1:1 con la company: su PK **es** el `companyId`, y el
    // repositorio lo refleja. Por eso el id que se le pasa es el propio companyId.
    const row = await request.tx((tx) =>
      blitzPreferencesRepository.findById(tx, { companyId }, companyId),
    );

    // DATA-006: sin fila, se sintetizan defaults. **No se crea la fila**: leer no
    // escribe, y materializarla acá fijaría todos los campos por un GET.
    if (row === null) {
      return data({
        ...DEFAULT_BLITZ_PREFERENCES,
        angleWeights: {},
        textStyleWeights: {},
        settingsApplication: SETTINGS_APPLICATION,
      });
    }
    return data(toBlitzPreferences(row));
  });

  // ── PATCH /blitz/preferences ──
  app.patch(
    "/blitz/preferences",
    {
      schema: { body: updateBlitzPreferencesRequestSchema },
      // §9.6: límite dedicado de 3/min para este endpoint. Va en `preHandler` y no
      // después, al revés que la generación de ángulos: acá el PRD cuenta
      // actualizaciones, no actualizaciones exitosas.
      preHandler: rateLimit(limiter, "blitzPreferencesUpdate"),
    },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const patch = request.body;

      assertStorableInfluencerChance(patch.influencerChance);

      const row = await request.tx(async (tx) => {
        // `angleWeights` no se puede validar contra el schema: la regla de FR-055 es
        // que cubra **todos los ángulos activos de este workspace**, y eso sólo se
        // sabe leyendo la base. Se lee sólo cuando el patch lo trae.
        const activeIds =
          patch.angleWeights === undefined
            ? []
            : activeAngleIdsOf(await listAllAngles(tx, companyId));
        assertValidPreferencesPatch(patch, activeIds);

        // El upsert reescribe todas las columnas que recibe, así que hay que
        // mandarle la fila entera: patch sobre lo que ya había, o sobre los defaults
        // sintetizados si el workspace todavía no tiene fila. Mandar sólo el patch
        // dejaría los demás campos en su default de schema —no en el de DATA-006— y
        // un PATCH de `remixPercentage` resetearía el content mix.
        const current = await blitzPreferencesRepository.findById(
          tx,
          { companyId },
          companyId,
        );
        const base =
          current === null
            ? { ...DEFAULT_BLITZ_PREFERENCES, angleWeights: {}, textStyleWeights: {} }
            : {
                slideshowWeight: current.slideshowWeight,
                wallOfTextWeight: current.wallOfTextWeight,
                greenScreenWeight: current.greenScreenWeight,
                videoHookWeight: current.videoHookWeight,
                remixPercentage: current.remixPercentage,
                ownMediaPercentage: current.ownMediaPercentage,
                mentionBusinessPercentage: current.mentionBusinessPercentage,
                influencerChance: current.influencerChance,
                smartTextPositioning: current.smartTextPositioning,
                genderFilter: current.genderFilter,
                angleWeights: current.angleWeights,
                textStyleWeights: current.textStyleWeights,
              };

        // El merge va campo a campo y no con un spread, por dos razones:
        //  - con `exactOptionalPropertyTypes`, `{...base, ...patch}` produce
        //    `number | undefined` en cada peso y no compila contra columnas `notNull`;
        //  - `genderFilter: null` es un valor **legítimo** ("sin filtro"), así que un
        //    `patch.genderFilter ?? base.genderFilter` lo descartaría y el usuario no
        //    podría quitar nunca el filtro. La comparación tiene que ser con
        //    `undefined`, no con nullish.
        const saved = await blitzPreferencesRepository.upsert(
          tx,
          { companyId },
          {
            slideshowWeight: patched(patch.slideshowWeight, base.slideshowWeight),
            wallOfTextWeight: patched(patch.wallOfTextWeight, base.wallOfTextWeight),
            greenScreenWeight: patched(patch.greenScreenWeight, base.greenScreenWeight),
            videoHookWeight: patched(patch.videoHookWeight, base.videoHookWeight),
            remixPercentage: patched(patch.remixPercentage, base.remixPercentage),
            ownMediaPercentage: patched(
              patch.ownMediaPercentage,
              base.ownMediaPercentage,
            ),
            mentionBusinessPercentage: patched(
              patch.mentionBusinessPercentage,
              base.mentionBusinessPercentage,
            ),
            influencerChance: patched(patch.influencerChance, base.influencerChance),
            smartTextPositioning: patched(
              patch.smartTextPositioning,
              base.smartTextPositioning,
            ),
            genderFilter: patched(patch.genderFilter, base.genderFilter),
            angleWeights: patched(patch.angleWeights, base.angleWeights),
            textStyleWeights: patched(patch.textStyleWeights, base.textStyleWeights),
          },
        );
        if (saved === null) {
          throw new Error(
            "El upsert de `blitz_preferences` no devolvió fila. Ver la nota de " +
              "`persistAngleWeights`: con la PK igual al `companyId` no es alcanzable.",
          );
        }
        return saved;
      });

      // FR-055 regla 1: la respuesta describe que el cambio aplica a generaciones
      // futuras. La cola existente **no** se toca, ni acá ni en un job disparado
      // desde acá.
      return reply.status(200).send(data(toBlitzPreferences(row)));
    },
  );

  // ── POST /blitz ──
  app.post(
    "/blitz",
    { schema: { body: runBlitzRequestSchema } },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const body = request.body;

      // FR-050 Validation: `aspectRatio` sólo aplica a slideshow. Sólo se puede
      // comprobar cuando el cliente fijó el tipo; sin `contentType` lo elige la cola
      // según los pesos y la combinación se resuelve al popear, no acá.
      if (body.contentType !== undefined) {
        assertValidBlitzRequest({
          contentType: body.contentType,
          aspectRatio: body.aspectRatio,
        });
      }

      if (queue === undefined) {
        // ADR-005: el build se encola **dentro** de la transacción que descuenta la
        // cuota. Sin cola, crear el `Content` en `BUILDING` lo dejaría colgado para
        // siempre — y sin job que falle, tampoco habría reembolso del save. Fallar
        // acá es estrictamente mejor que crear la fila.
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Content builds are temporarily unavailable.",
          },
        });
      }

      const outcome = await request.tx(async (tx) => {
        // PRD:1023 — *"Perfil incompleto/fallido → Blitz devuelve
        // `409 company_profile_not_ready`"*. `company_profiles` tiene un único índice
        // por `companyId`, así que la primera fila del listado es la fila.
        //
        // `partial` (AI-016, análisis sin OCR) se trata como no listo. El PRD no
        // distingue "incompleto por el usuario" de "parcial por un motor ausente";
        // queda anotado como abierto en el reporte.
        const profiles = await companyProfileRepository.list(
          tx,
          { companyId },
          {
            limit: 1,
          },
        );
        const profile = profiles.items[0];
        if (profile === undefined || profile.status !== "ready") {
          return { kind: "profile_not_ready" as const };
        }

        // El orden es el del repositorio (`createdAt` desc, más nueva primero). El
        // PRD no dice en qué orden sale la cola, así que no se elige uno: se usa el
        // único que el repositorio sabe dar.
        const queued = await suggestionRepository.list(
          tx,
          { companyId },
          {
            limit: 1,
            filter: {
              status: { eq: "queued" },
              contentType:
                body.contentType === undefined ? undefined : { eq: body.contentType },
            },
          },
        );
        const suggestion = queued.items[0];
        if (suggestion === undefined) return { kind: "empty_queue" as const };

        // Acá iría `acceptBlitzSuggestionUseCase`. Ver la cabecera: el gate de
        // facturación no se puede evaluar todavía. **No se escribe nada**: la
        // transacción termina sin mutaciones.
        return { kind: "quota_unavailable" as const, suggestionId: suggestion.id };
      });

      if (outcome.kind === "profile_not_ready") {
        return reply.status(409).send({
          error: {
            code: "company_profile_not_ready",
            message: "Finish your brand profile before running Blitz.",
          },
        });
      }

      if (outcome.kind === "empty_queue") {
        // Mensaje literal de FR-050 (estado `empty`). La UI lo usa para mostrar el
        // estado de espera y reintentar sin recargar.
        return reply.status(404).send({
          error: {
            code: "not_found",
            message:
              "discovery queue has no ready items yet. Try again shortly; the queue replenishes in the background.",
          },
        });
      }

      request.log.error(
        { suggestionId: outcome.suggestionId, route: "POST /blitz" },
        "blitz acceptance blocked: the content-save and swipe ledgers cannot be read yet",
      );
      return reply.status(503).send({
        error: {
          code: "service_unavailable",
          message:
            "Blitz acceptance is temporarily unavailable: the content-save and daily-swipe allowances cannot be checked right now.",
          // §9.6 lo pide explícito para el caso análogo de rate limiting: un 503 acá
          // **no** significa cuota agotada, y el cliente no debe tratarlo como tal.
          details: { quotaExhausted: false },
        },
      });
    },
  );
}
