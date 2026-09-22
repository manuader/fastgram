/**
 * Onboarding — `FR-010` (PRD:735-790), `FLOW-001` (PRD:1885), `FLOW-009`
 * (PRD:1990), `DATA-030` (PRD:2185).
 *
 * `packages/core/src/onboarding/onboarding.ts` tenía la máquina de cinco pasos
 * con reanudación, las validaciones del cuestionario y el plan de cierre — todo
 * con tests, y **sin una sola ruta detrás**. Esto es el borde que faltaba.
 *
 * ## Lo que este archivo NO hace, y hay que saberlo antes de leerlo
 *
 * **No persiste el paso del wizard.** `DATA-030` declara la tabla
 * `onboarding_records` (`step`, `payload`, `draftCompanyId`) y **`packages/db`
 * no expone ningún repositorio para ella** — es la única de las 33 tablas sin
 * uno. Así que el paso **se deriva** del estado que sí está guardado, y la
 * derivación no la escribe este archivo: la hace `advanceOnboarding` de `core`,
 * caminando desde `brand_source` hasta donde deje de poder avanzar. Ver
 * {@link deriveRecord}.
 *
 * Qué compra y qué no, con precisión:
 *  - `FR-010` criterio 3 (*"recargar la página conserva el progreso"*) se
 *    cumple **para todo lo que está guardado**: fuentes, detalles, cuestionario.
 *  - Lo que **no** está guardado en ninguna columna no sobrevive, y sólo hay
 *    dos cosas así: la rama manual (`Use description instead`) y el hecho de
 *    que `POST /onboarding/complete` ya corrió. Las dos están abajo, cada una
 *    en su sitio, y en el reporte.
 *
 * **No crea el workspace.** `FR-010` lo pide (`F-008`, PRD:436) y
 * `assertCanCreateWorkspace` está escrito y testeado en `core`. No se puede
 * llamar desde acá y son **dos** bloqueos distintos, no uno:
 *
 *  1. `companyRepository` de `packages/db` es **sólo de lectura** —lo dice su
 *     cabecera: *"Crear un workspace es `P1-TENANT-001`"*— así que no hay
 *     `INSERT` en `companies` ni forma de mover `status` de `draft` a `active`.
 *  2. Aunque lo hubiera, `assertCanCreateWorkspace(plan, currentCount)` pide
 *     **cuántos workspaces tiene ya el usuario**, y eso es una consulta *sin*
 *     scope de company: los 28 repositorios exigen `TenantScope` por diseño y
 *     RLS taparía la lectura igual. Falta un
 *     `companyRepository.countOwnedBy(exec, userId)` deliberadamente sin scope,
 *     documentado como el bootstrap de `resolveApiKeyByHash`.
 *
 * Y hay un tercer problema, que es de especificación y está en el reporte: el
 * PRD dice que el límite es **por usuario** (`F-008`) y lo implementado es
 * **por plan** (`PLANS[plan].workspaces`). No se elige ninguno acá.
 *
 * **No tiene paso de detalles.** El paso 2 del wizard escribe `Company Name` y
 * `Company Logo`, que son columnas de `companies` — la tabla sin escritura. Un
 * `POST /onboarding/details` que guardara la descripción y descartara en
 * silencio el nombre y el logo sería peor que no existir. La descripción, que
 * sí tiene dónde vivir, ya se escribe por `PATCH /brand/profile`.
 *
 * ## De dónde sale cada campo
 *
 * | Wizard | Columna |
 * |---|---|
 * | fuentes (paso 1) | `brand_sources` |
 * | `Company Name` | `companies.name` |
 * | `Company Description` | `company_profiles.core_identity` |
 * | `Company Logo` | `companies.logo_url` |
 * | cuestionario (paso 3) | `company_profiles.{owner_role,team_size,business_model,business_categories,monthly_revenue_band,expectations}` |
 *
 * La fila de `Company Description` es una **elección**, no una lectura del PRD:
 * no hay ninguna columna `companies.description`, y `CORE IDENTITY` es el campo
 * del perfil que el paso 2 alimenta (*"We'll enhance your input with AI"*,
 * PRD:743). La alternativa honesta sería una columna nueva, y `packages/db` no
 * es de este agente. Queda en el reporte.
 *
 * ## Los mensajes de error son del dominio, no de acá
 *
 * `FR-010` fija copy literal por campo (*"Please select your role"*, *"Each
 * answer is limited to 4,000 characters."*). Vive en `ONBOARDING_MESSAGES` y en
 * `REQUIRED_PROFILING_ANSWERS` de `core`, y llega al cliente tal cual: lo único
 * que esta capa cambia es el **código del cable**, porque `out_of_range` no
 * está en `errorCodeSchema` (§9.3: *"un código que el PRD no nombra no puede
 * salir por la v1"*). Ver {@link asApiRejection}.
 */
import {
  idempotencyHeaderSchema,
  submitOnboardingProfilingRequestSchema,
  type OnboardingCompletion,
  type OnboardingDetails,
  type OnboardingProfiling,
  type OnboardingState,
  type OnboardingStep,
} from "@fastgram/contracts";
import {
  HARD_CAPS,
  JOB_QUEUES,
  advanceOnboarding,
  assertNoOAuthRequired,
  assertValidProfiling,
  isDomainError,
  planOnboardingCompletion,
  resumeOnboarding,
  type CompanyDetails,
  type DiscoveryRefillJob,
  type OnboardingRecord,
  type OnboardingSourceDraft,
  type ProfilingAnswers,
} from "@fastgram/core";
import {
  brandSourceRepository,
  companyProfileRepository,
  companyRepository,
  contentAngleRepository,
  type Transaction,
  type brandSources,
  type companyProfiles,
  type CompanyRow,
} from "@fastgram/db";

import { ApiRejection } from "../../http/errors.js";
import { rateLimit } from "../../plugins/rate-limit.js";
import { toBrandSource } from "../../support/serializers.js";
import { data, idempotencyKeyOf, notFound, withIdempotency } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

type BrandSourceRow = (typeof brandSources)["$inferSelect"];
type CompanyProfileRow = (typeof companyProfiles)["$inferSelect"];

/** §9.3 — la ruta tal como la nombra el registro de idempotencia. */
const COMPLETE_ROUTE = "POST /onboarding/complete";

/**
 * Las claves del cuestionario: nombre del contrato → nombre del dominio.
 *
 * `core` llama `role` y `monthlyRevenue` a lo que `DATA-004` y
 * `companyProfileSchema` llaman `ownerRole` y `monthlyRevenueBand`. El cable
 * usa los del contrato (un campo con dos nombres en la misma v1 es una pregunta
 * que todo integrador tiene que hacerse una vez), así que la traducción vive
 * acá, en una tabla, y no repartida por tres funciones.
 *
 * Se usa en los **dos** sentidos: para armar las respuestas que `core` valida y
 * para devolver el `details.field` del error con el nombre que el cliente
 * mandó. Un error que señala un campo que no existe en el cuerpo es peor que no
 * señalar ninguno: la UI resalta un input que no está.
 */
const PROFILING_FIELDS = {
  ownerRole: "role",
  teamSize: "teamSize",
  businessModel: "businessModel",
  businessCategories: "businessCategories",
  monthlyRevenueBand: "monthlyRevenue",
  expectations: "expectations",
} as const satisfies Readonly<Record<keyof OnboardingProfiling, string>>;

const WIRE_FIELD: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PROFILING_FIELDS).map(([wire, domain]) => [domain, wire]),
);

/** Contrato → las respuestas tal como `assertValidProfiling` las espera. */
export function toDomainAnswers(profiling: OnboardingProfiling): ProfilingAnswers {
  return {
    [PROFILING_FIELDS.ownerRole]: profiling.ownerRole,
    [PROFILING_FIELDS.teamSize]: profiling.teamSize,
    [PROFILING_FIELDS.businessModel]: profiling.businessModel,
    [PROFILING_FIELDS.businessCategories]: profiling.businessCategories,
    [PROFILING_FIELDS.monthlyRevenueBand]: profiling.monthlyRevenueBand,
    // La sexta pregunta de `F-006`. `REQUIRED_PROFILING_ANSWERS` no la exige
    // —el PRD no le da copy de error—, pero el bucle de 4 000 caracteres de
    // `assertValidProfiling` recorre **todo** lo que se le pase, así que
    // mandarla es lo que la acota. Ver el contrato.
    [PROFILING_FIELDS.expectations]: profiling.expectations,
  };
}

/**
 * Traduce un `DomainError` del onboarding al contrato.
 *
 * `out_of_range` **no** está en `errorCodeSchema`, así que dejarlo pasar emite
 * un `code` que ningún SDK generado desde el contrato sabe manejar. Todos los
 * rechazos de validación de `FR-010` salen con ese código, así que sin esta
 * traducción el wizard entero respondería algo imparseable.
 *
 * El **mensaje se conserva palabra por palabra**: es copy CONFIRMED del PRD y
 * es lo que la UI muestra. Lo único que cambia es el código y, si el dominio
 * señaló un campo, el nombre con el que se publica.
 */
export function asApiRejection(error: unknown): unknown {
  if (!isDomainError(error) || error.code !== "out_of_range") return error;

  const details = error.details ?? {};
  const field = typeof details["field"] === "string" ? details["field"] : undefined;
  const code = typeof details["code"] === "string" ? details["code"] : undefined;

  return new ApiRejection(400, "bad_request", error.message, {
    // `field` es lo que permite a la UI resaltar el input correcto, y es el
    // único dato de `details` que sale: el resto (longitudes, pasos) es
    // diagnóstico y se queda en el log, como manda `http/errors.ts`.
    ...(field === undefined ? {} : { field: WIRE_FIELD[field] ?? field }),
    ...(code === undefined ? {} : { code }),
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Lecturas — todas con scope, todas dentro de la misma transacción
// ───────────────────────────────────────────────────────────────────────────

/**
 * Todas las fuentes del workspace, en una página.
 *
 * `+1` sobre el cap de 5 no es un atajo: es lo que permite **detectar** que el
 * cap se rompió por otra vía en vez de truncar en silencio. Mismo criterio que
 * `brand.ts`.
 */
async function listSources(
  tx: Transaction,
  companyId: string,
): Promise<readonly BrandSourceRow[]> {
  const result = await brandSourceRepository.list(
    tx,
    { companyId },
    { limit: HARD_CAPS.brandSources + 1 },
  );
  return result.items;
}

/** El perfil del workspace, o `null` si nunca se escribió. */
async function loadProfile(
  tx: Transaction,
  companyId: string,
): Promise<CompanyProfileRow | null> {
  const found = await companyProfileRepository.list(tx, { companyId }, { limit: 1 });
  return found.items[0] ?? null;
}

/**
 * El workspace del scope.
 *
 * `null` no puede pasar —el `companyId` salió de una credencial válida— pero la
 * firma lo permite y tratarlo como `404` es más barato que un `!`. Si ocurre,
 * es que la company se borró entre la resolución de la key y esta lectura.
 */
async function loadCompany(tx: Transaction, companyId: string): Promise<CompanyRow> {
  const row = await companyRepository.load(tx, { companyId });
  if (row === null) throw notFound("workspace");
  return row;
}

// ───────────────────────────────────────────────────────────────────────────
// Derivación del registro — el corazón del archivo
// ───────────────────────────────────────────────────────────────────────────

/**
 * `company_profiles` → los detalles del paso 2, o `undefined`.
 *
 * `undefined` significa *"el paso no se respondió"*, que es el estado que
 * `advanceOnboarding` distingue con *"Add your company details before finishing
 * setup."*. El proxy observable de "se respondió" es `core_identity is not
 * null`: sin repositorio de `onboarding_records` no hay bandera que consultar,
 * y un workspace recién creado no tiene ni fila de perfil.
 */
export function detailsOf(
  company: CompanyRow,
  profile: CompanyProfileRow | null,
): CompanyDetails | undefined {
  if (profile === null || profile.coreIdentity === null) return undefined;
  return {
    name: company.name,
    description: profile.coreIdentity,
    ...(company.logoUrl === null ? {} : { logoUrl: company.logoUrl }),
  };
}

/**
 * `company_profiles` → las respuestas del paso 3, o `undefined`.
 *
 * Con fila de perfil devuelve el mapa aunque esté vacío, **a propósito**: así
 * `advanceOnboarding` llega a `assertValidProfiling` y el usuario recibe
 * *"Please select your role"* en vez del genérico *"Add your company details
 * before finishing setup."*, que es el que sale cuando el paso entero falta.
 */
export function profilingOf(
  profile: CompanyProfileRow | null,
): ProfilingAnswers | undefined {
  if (profile === null) return undefined;
  return {
    [PROFILING_FIELDS.ownerRole]: profile.ownerRole ?? "",
    [PROFILING_FIELDS.teamSize]: profile.teamSize ?? "",
    [PROFILING_FIELDS.businessModel]: profile.businessModel ?? "",
    [PROFILING_FIELDS.businessCategories]: profile.businessCategories,
    [PROFILING_FIELDS.monthlyRevenueBand]: profile.monthlyRevenueBand ?? "",
    [PROFILING_FIELDS.expectations]: profile.expectations,
  };
}

function sourceDraftsOf(
  rows: readonly BrandSourceRow[],
): readonly OnboardingSourceDraft[] {
  return rows.map((row) => ({
    sourceType: row.sourceType,
    handle: row.handle ?? "",
    canonicalUrl: row.canonicalUrl ?? "",
  }));
}

/**
 * El registro **en el paso 1**, antes de caminar.
 *
 * `manualBranch` va siempre en `false`, y es el segundo de los dos huecos de la
 * cabecera: `Use description instead` produce una `BrandSource` de tipo
 * `manual` (PRD:753) y hoy **nadie puede crear una**. `POST /brand/sources` la
 * rechaza a propósito —con `handle` vacío chocaría contra
 * `brand_sources_type_handle_uq`, que es `WHERE handle is not null` y deja
 * pasar la cadena vacía— y este archivo no la crea porque el dominio no dice
 * con qué `status` nace una fuente que no tiene extractor. Consecuencia
 * concreta: **un workspace sin ninguna fuente se queda en `brand_source`**, que
 * es exactamente lo que `assertBrandSourceStepComplete` dice.
 *
 * `oauthConsents` va en `0` porque **ninguna columna los cuenta**. No es una
 * simplificación inocente: `assertNoOAuthRequired` existe para poder *afirmar*
 * `D-01` (*"el alta social no pide OAuth"*) en vez de confiar, y con un 0
 * constante la afirmación es cierta por construcción, no por medición. Lo que
 * la vuelve medible es una columna `onboarding_records.oauth_consents`, que no
 * se puede escribir sin repositorio. En el reporte.
 */
function baseRecord(args: {
  readonly companyId: string;
  readonly company: CompanyRow;
  readonly profile: CompanyProfileRow | null;
  readonly sources: readonly BrandSourceRow[];
}): OnboardingRecord {
  const details = detailsOf(args.company, args.profile);
  const profiling = profilingOf(args.profile);
  return {
    id: args.companyId,
    ownerUserId: args.company.ownerUserId,
    draftCompanyId: args.companyId,
    step: "brand_source",
    sources: sourceDraftsOf(args.sources),
    manualBranch: false,
    ...(details === undefined ? {} : { details }),
    ...(profiling === undefined ? {} : { profiling }),
    oauthConsents: 0,
    createdAt: args.company.createdAt,
  };
}

/**
 * Camina el wizard hasta donde el estado guardado deje de poder avanzar.
 *
 * **La lógica de los pasos no se reimplementa acá**, y eso es lo que hace que
 * esta ruta no se desincronice de `core`: cada gate lo aplica
 * `advanceOnboarding`, que es la misma función que los tests de dominio fijan.
 * Si mañana el paso de detalles exige un campo más, esta derivación lo respeta
 * sin tocar una línea.
 *
 * Se para en `processing` porque `advanceOnboarding("processing")` devuelve
 * `ready` **sin comprobar nada**: pasar a `ready` es lo que hace
 * `POST /onboarding/complete`, no una consecuencia de tener el formulario
 * lleno. Y `ready` sólo se alcanza con la company en `active`, que es la única
 * marca persistida de que el alta cerró — y que hoy no escribe nadie (ver la
 * cabecera).
 */
export function walkToFurthestStep(record: OnboardingRecord): OnboardingRecord {
  let current = record;
  for (let guard = 0; guard < 8; guard++) {
    if (current.step === "processing" || current.step === "ready") return current;
    try {
      current = advanceOnboarding(current);
    } catch {
      // Lo que impide avanzar es justamente lo que el usuario tiene que
      // completar: el paso en el que quedó es la respuesta, no el error.
      return current;
    }
  }
  /* c8 ignore next 4 */
  throw new Error(
    "`advanceOnboarding` no terminó en 8 pasos sobre un wizard de 5. " +
      "Si pasa, ONBOARDING_STEPS creció y esta guarda se quedó corta.",
  );
}

function deriveRecord(args: {
  readonly companyId: string;
  readonly company: CompanyRow;
  readonly profile: CompanyProfileRow | null;
  readonly sources: readonly BrandSourceRow[];
}): OnboardingRecord {
  const base = baseRecord(args);
  // `active` es la única señal persistida de que el alta terminó. Un workspace
  // en `draft` o `preparing` todavía está en el wizard, por muy lleno que esté
  // su formulario.
  if (args.company.status === "active") return { ...base, step: "ready" };
  return walkToFurthestStep(base);
}

// ───────────────────────────────────────────────────────────────────────────
// Serialización
// ───────────────────────────────────────────────────────────────────────────

function toDetails(details: CompanyDetails | undefined): OnboardingDetails | null {
  if (details === undefined) return null;
  return {
    name: details.name,
    description: details.description,
    logoUrl: details.logoUrl ?? null,
  };
}

function toProfiling(answers: ProfilingAnswers | undefined): OnboardingProfiling | null {
  if (answers === undefined) return null;
  const text = (key: string): string => {
    const value = answers[key];
    return typeof value === "string" ? value : "";
  };
  const list = (key: string): string[] => {
    const value = answers[key];
    return Array.isArray(value) ? [...value] : [];
  };
  return {
    ownerRole: text(PROFILING_FIELDS.ownerRole),
    teamSize: text(PROFILING_FIELDS.teamSize),
    businessModel: text(PROFILING_FIELDS.businessModel),
    businessCategories: list(PROFILING_FIELDS.businessCategories),
    monthlyRevenueBand: text(PROFILING_FIELDS.monthlyRevenueBand),
    expectations: list(PROFILING_FIELDS.expectations),
  };
}

function toState(
  record: OnboardingRecord,
  sources: readonly BrandSourceRow[],
): OnboardingState {
  return {
    // Literal de `FR-010` criterio 3: se devuelve **el paso guardado**, que es
    // lo que `resumeOnboarding` significa. Llamarla en vez de leer
    // `record.step` mantiene el significado en un solo sitio.
    step: resumeOnboarding(record) satisfies OnboardingStep,
    sources: sources.map(toBrandSource),
    manualBranch: record.manualBranch,
    details: toDetails(record.details),
    profiling: toProfiling(record.profiling),
    oauthConsents: record.oauthConsents,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Rutas
// ───────────────────────────────────────────────────────────────────────────

export function registerOnboardingRoutes(app: ZodApp): void {
  const { clock, idempotency, limiter } = app.deps;

  /** Lee las tres fuentes de verdad y deriva. Se repite en las tres rutas. */
  async function loadState(
    tx: Transaction,
    companyId: string,
  ): Promise<{
    readonly record: OnboardingRecord;
    readonly sources: readonly BrandSourceRow[];
    readonly company: CompanyRow;
    readonly profile: CompanyProfileRow | null;
  }> {
    const company = await loadCompany(tx, companyId);
    const profile = await loadProfile(tx, companyId);
    const sources = await listSources(tx, companyId);
    return {
      record: deriveRecord({ companyId, company, profile, sources }),
      sources,
      company,
      profile,
    };
  }

  // ── GET /onboarding ──
  //
  // Sin 404 cuando el wizard no arrancó, por el mismo motivo que
  // `GET /brand/profile`: el onboarding es un estado del workspace, no un
  // recurso con vida propia. Un workspace nuevo devuelve `step: "brand_source"`
  // y todo lo demás vacío, que es la respuesta correcta a *"¿dónde retomo?"*.
  app.get("/onboarding", async (request) => {
    const companyId = request.auth.companyId;
    const loaded = await request.tx((tx) => loadState(tx, companyId));
    return data(toState(loaded.record, loaded.sources));
  });

  // ── POST /onboarding/profiling ──
  //
  // El cuestionario de `F-006`. Las seis claves las exige el schema; los
  // **valores** los juzga `assertValidProfiling`, que es quien tiene la copy
  // literal de `FR-010`. Ver la cabecera del contrato.
  app.post(
    "/onboarding/profiling",
    {
      schema: { body: submitOnboardingProfilingRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const body = request.body;

      const answers = toDomainAnswers(body);
      try {
        assertValidProfiling(answers);
      } catch (error) {
        throw asApiRejection(error);
      }

      const state = await request.tx(async (tx): Promise<OnboardingState> => {
        const scope = { companyId };
        const company = await loadCompany(tx, companyId);
        const current = await loadProfile(tx, companyId);

        const values = {
          ownerRole: body.ownerRole,
          teamSize: body.teamSize,
          businessModel: body.businessModel,
          businessCategories: [...body.businessCategories],
          monthlyRevenueBand: body.monthlyRevenueBand,
          expectations: [...body.expectations],
          // DATA-004: *"Incrementa en cada guardado"*. Se mueve igual que en
          // `PATCH /brand/profile` y por la misma razón: `AI-005` usa
          // `brandRevision` como `expectedBrandRevision` de los ángulos, así que
          // un perfil que cambia sin moverlo deja sugerencias que se creen
          // vigentes. El cuestionario **es** parte del perfil (DATA-004).
          brandRevision: (current?.brandRevision ?? 0) + 1,
        };

        // `fieldMeta` **no se toca**, a diferencia de `PATCH /brand/profile`.
        // La marca `editedByUser` existe para que la fusión de `FR-011.6` no
        // pise una edición manual, y sólo aplica a los ocho campos que la
        // síntesis deriva (`BRAND_PROFILE_FIELDS`). Ninguna síntesis escribe
        // nunca el cuestionario: marcarlo pondría metadatos que nadie lee sobre
        // campos que nadie pisa.
        const profile =
          current === null
            ? await companyProfileRepository.create(tx, scope, values)
            : await companyProfileRepository.update(tx, scope, current.id, values);
        if (profile === null) {
          throw new Error(
            "El UPDATE no encontró el perfil que la lectura acababa de devolver, en " +
              "la misma transacción. Si pasa, cambió el aislamiento del repositorio.",
          );
        }

        const sources = await listSources(tx, companyId);
        return toState(deriveRecord({ companyId, company, profile, sources }), sources);
      });

      return reply.status(200).send(data(state));
    },
  );

  // ── POST /onboarding/complete ──
  //
  // `FR-010` **System behavior** (PRD:759), repetido en `FLOW-001` (PRD:1890) y
  // `FLOW-009` (PRD:2006): *"crear el workspace real, sembrar content angles
  // iniciales, **arrancar el relleno de la discovery queue** y marcar
  // onboarding como completo."*
  //
  // De los cuatro efectos, **el tercero es el único que hoy tiene ejecutor**, y
  // es el que este endpoint existe para disparar: era el disparador que el PRD
  // define y que faltaba (ver la nota de `pedirRelleno` en `blitz.ts`, que
  // encolaba desde el único otro momento en que el PRD promete el relleno).
  //
  // `202` y no `200`: lo que termina al devolver es el encolado, no el trabajo.
  app.post(
    "/onboarding/complete",
    {
      // Encola trabajo con coste, así que lleva key — misma regla de §9.3 que
      // `POST /brand/sources`.
      schema: { headers: idempotencyHeaderSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const { queue } = app.deps;
      if (queue === undefined) {
        // Se responde **antes** de tocar la `Idempotency-Key`: quemarla por una
        // indisponibilidad de infraestructura impediría el reintento, que es lo
        // contrario de para qué existe el header. Mismo criterio que `brand.ts`.
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Setup can't finish right now. Please try again.",
          },
        });
      }

      const companyId = request.auth.companyId;
      const key = idempotencyKeyOf({ ...request.headers });

      return withIdempotency(
        idempotency,
        request,
        reply,
        // El cuerpo es vacío: la idempotencia protege del doble clic en
        // `Continue to Dashboard`, no de dos cierres distintos.
        { key, route: COMPLETE_ROUTE, body: {}, successStatus: 202 },
        () =>
          request.tx(async (tx): Promise<OnboardingCompletion> => {
            const loaded = await loadState(tx, companyId);

            // `D-01` / `FLOW-009` criterio 11. Va **antes** que cualquier
            // escritura: si el alta llegó hasta acá habiendo pedido un
            // consentimiento OAuth, lo que está roto es el camino, no el cierre.
            // Hoy no puede disparar (ver `baseRecord`), y está igual porque el
            // día que la columna exista, este llamado ya está en su sitio.
            assertNoOAuthRequired(loaded.record);

            // Cerrar dos veces no vuelve a encolar: `advanceOnboarding` sobre
            // `ready` lanza *"This onboarding is already finished."* con
            // `invalid_state`, que `http/errors.ts` traduce a `409`. El mensaje
            // y el status los decide el dominio, no esta ruta.
            if (loaded.record.step === "ready") advanceOnboarding(loaded.record);

            // Si falta un paso, el error que sale es el del paso que falta,
            // con su copy literal. Es el mismo camino que `GET /onboarding`
            // recorre en silencio; acá se deja lanzar.
            let record = loaded.record;
            while (record.step !== "processing") {
              try {
                record = advanceOnboarding(record);
              } catch (error) {
                throw asApiRejection(error);
              }
            }

            // `FR-011.7` #7: los ángulos se siembran **sólo en el primer
            // análisis del workspace**. El conteo va con scope, como todo.
            const existingAngles = await contentAngleRepository.count(tx, { companyId });
            const plan = planOnboardingCompletion(record, existingAngles);

            let discoveryRefillQueued = false;
            if (plan.startDiscoveryRefill) {
              // ADR-005: el encolado va **dentro** de la transacción.
              //
              // La clave lleva un cubo por minuto por la misma razón que en
              // `blitz.ts`: el adaptador deriva de `singletonKey` un id
              // determinista y permanente, así que una clave fija por workspace
              // encolaría el relleno **una sola vez en la vida**. Con el cubo,
              // dos cierres con keys distintas dentro del mismo minuto se
              // deduplican y el siguiente minuto vuelve a poder pedirlo.
              const minuto = Math.floor(clock.nowMs() / 60_000);
              await queue.enqueue<DiscoveryRefillJob>({
                queue: JOB_QUEUES.discoveryRefill,
                payload: { companyId },
                options: {
                  transaction: tx,
                  singletonKey: `${JOB_QUEUES.discoveryRefill}:${companyId}:${String(minuto)}`,
                },
              });
              discoveryRefillQueued = true;
            }

            // Los otros tres efectos del plan no se ejecutan y **no se
            // simulan**:
            //  - `createWorkspace` y `markComplete` necesitan escritura sobre
            //    `companies` (ver la cabecera). Por eso el `step` que vuelve es
            //    `processing` y no `ready`: `ready` sería mentira, y la próxima
            //    lectura de `GET /onboarding` la desmentiría.
            //  - `seedContentAngles` necesita el generador de `AI-005`, que es
            //    `deps.angleGenerator` y no está montado. Devolver ángulos
            //    inventados sería peor que ninguno.
            return {
              ...toState(record, loaded.sources),
              discoveryRefillQueued,
            };
          }),
      );
    },
  );
}
