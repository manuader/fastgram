/**
 * Brand Sources y Company Profile — **EXTENSION · EXT-001**, PRD §9.14.
 *
 * Fuente: PRD §9.14 (endpoints), FR-011.1 a FR-011.12, DATA-031, DATA-004,
 * AI-016, §19.5.1 (los 14 `ERR-B`), §9.2 (404 cruzado), §9.3 (envelopes).
 *
 * ## Lo que este archivo NO hace, y es lo primero que hay que saber
 *
 * **No valida URLs.** La protección SSRF de `FR-011.9` está entera en
 * `packages/core/src/brand/source-input.ts` (`assertHostAllowed`), con tests de
 * IP en decimal y del borde `172.32`. `detectBrandSource` la llama por dentro,
 * así que toda URL que entra por acá pasa por ella sin que estas rutas escriban
 * una sola comprobación. Si la ruta hiciera la suya, habría **dos definiciones
 * de "URL segura"** y el día que alguien agregue un rango privado a una sola,
 * el agujero queda abierto en la otra sin que nada falle.
 *
 * **No detecta plataformas ni normaliza handles.** `x.com` ≡ `twitter.com`, el
 * quitado de `igshid`/`si`/`fbclid`/`utm_*`, el `@handle` ambiguo y el enlace a
 * un post que se resuelve al perfil del autor: todo sale de `detectBrandSource`.
 *
 * **No decide caps ni transiciones de estado.** El cap de 5
 * (`assertCanAddBrandSource`), el arranque del análisis (`startAnalysis`), el
 * cooldown de re-análisis (`assertCanReanalyse`), la primaria
 * (`setPrimarySource`) y quién puede borrarla (`assertCanRemoveSource`) son de
 * `core`. Acá sólo se traducen a HTTP y se persisten.
 *
 * ## La unicidad global, que es lo que hace rara a esta tabla
 *
 * `brand_sources_type_handle_uq` es `UNIQUE (source_type, handle)` **sin
 * `company_id`**: la misma regla que Fastlane aplica a `websiteUrl`. Dos
 * consecuencias, y ninguna es obvia:
 *
 * 1. **El choque con otro workspace no se puede consultar.** RLS
 *    (`brand_sources_tenant_isolation`) hace que un `SELECT` desde una
 *    transacción con scope **no vea** la fila del otro workspace, así que
 *    ningún pre-chequeo puede responder "ese handle ya existe en otro lado".
 *    Lo único que lo sabe es el índice, y sólo cuando el `INSERT` falla con
 *    `23505`. Por eso `createBrandSource` se llama con
 *    `takenByAnotherWorkspace: false` **siempre** y el choque se detecta
 *    atrapando la violación: no es un atajo, es que la alternativa (leer sin
 *    scope con `withoutCompany`) rompería la única regla de la que depende
 *    todo el aislamiento del servicio.
 *
 * 2. **La respuesta no puede distinguir los dos choques.** Un `409` que diga
 *    "ya está en otro workspace" convierte el alta en un oráculo: quien pruebe
 *    handles aprende qué marcas son clientes de FastGram. Por eso
 *    {@link alreadyRegistered} devuelve **exactamente la misma respuesta**
 *    —status, código, mensaje y `details`— tanto si el choque es con una fuente
 *    del propio workspace como si es con la de otro. El usuario que choca
 *    consigo mismo puede resolverlo mirando su propio listado, que ya ve; el
 *    que sondea no aprende nada.
 *
 *    El mensaje **no es el literal de `ERR-B06`** (*"This profile is already
 *    connected to another workspace."*), justamente porque ese literal es el
 *    que filtra. Se usa la forma neutra que el propio PRD ya eligió para el
 *    caso equivalente de la rama web (`FR-010`, PRD:767: *"This website is
 *    already registered."*). El código estable `ERR-B06` sí viaja en `details`,
 *    porque es el que el PRD nombra y hay que poder correlacionar. Queda en el
 *    reporte que el copy de `ERR-B06` en `packages/ui` debería alinearse con el
 *    de `FR-010`.
 *
 * ## Códigos de error
 *
 * Los 14 `ERR-B` de §19.5.1 son códigos de **catálogo**, no del cable: el
 * `code` del envelope tiene que salir de `errorCodeSchema` (§9.3: *"un código
 * que el PRD no nombra no puede salir por la v1"*). Así que el `ERR-B` viaja en
 * `details.code`, que es donde el PRD lo puede correlacionar, y el código del
 * cable es el estable (`bad_request`, `conflict`, `rate_limited`, …).
 *
 * Los `DomainError` de `core` se traducen en vez de dejarse pasar cuando su
 * código no está en el contrato: `out_of_range` **no** está en
 * `errorCodeSchema`, así que un cap que sale crudo emite un `code` que el SDK
 * no sabe parsear. Ver {@link asApiRejection}.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createBrandSourceRequestSchema,
  cursorQuerySchema,
  idempotencyHeaderSchema,
  resolveBrandSourceRequestSchema,
  updateBrandSourceRequestSchema,
  updateCompanyProfileRequestSchema,
  type BrandSource as BrandSourceResource,
  type FieldMeta,
  type ResolveBrandSourceResponse,
} from "@fastgram/contracts";
import {
  BRAND_PROFILE_FIELDS,
  HARD_CAPS,
  JOB_QUEUES,
  acquisitionPlan,
  canonicalSocialUrl,
  createBrandSource,
  detectBrandSource,
  isDomainError,
  setPrimarySource,
  startAnalysis,
  assertCanRemoveSource,
  type BrandSource as DomainBrandSource,
  type BrandSourceDetection,
  type CoreBrandSourceType,
  type ResolvedInput,
  type SocialSourceType,
} from "@fastgram/core";
import type { AcquisitionTier } from "@fastgram/ports";
import {
  brandSourceRepository,
  companyProfileRepository,
  connectionRepository,
  lockBrandSource,
  workspaceMembershipRepository,
  type Transaction,
  type brandSources,
  type companyProfiles,
  type connections,
} from "@fastgram/db";

import { ApiRejection } from "../../http/errors.js";
import { rateLimit } from "../../plugins/rate-limit.js";
import {
  emptyCompanyProfile,
  toBrandSource,
  toCompanyProfile,
} from "../../support/serializers.js";
import { crossTenant, data, idempotencyKeyOf, page, withIdempotency } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

type BrandSourceRow = (typeof brandSources)["$inferSelect"];
type CompanyProfileRow = (typeof companyProfiles)["$inferSelect"];

const brandSourceParams = z.object({ id: z.string().min(1) });

/** §9.3 — la ruta tal como la nombra el registro de idempotencia. */
const CREATE_ROUTE = "POST /brand/sources";

/** `brand_sources_type_handle_uq` — el índice de la unicidad **global**. */
const TYPE_HANDLE_CONSTRAINT = "brand_sources_type_handle_uq";

/**
 * Plataformas con `Connection` OAuth posible.
 *
 * `x` no está: `socialPlatformEnum` (DATA-016) no lo tiene, así que un workspace
 * no puede tener una conexión de X ni aunque quiera. Que falte acá no es un
 * olvido — es lo que hace que el plan de adquisición de una fuente de X nunca
 * arranque por el tier A, que es correcto.
 */
type ConnectionPlatform = (typeof connections)["$inferSelect"]["platform"];

const CONNECTION_PLATFORM: Partial<Record<CoreBrandSourceType, ConnectionPlatform>> = {
  instagram: "instagram",
  tiktok: "tiktok",
  youtube: "youtube",
  linkedin: "linkedin",
};

/**
 * La violación de unicidad de Postgres, reconocida sin importar el driver.
 *
 * `apps/api` no puede importar `postgres` ni `drizzle-orm` (ver la nota de
 * `auth/scope.ts`), así que se comprueba la forma del error en vez del tipo.
 * `23505` es `unique_violation` en el catálogo de SQLSTATE, y `constraint_name`
 * es lo que distingue el choque de `(sourceType, handle)` del de la primaria —
 * que sería un bug nuestro y tiene que seguir saliendo como 500.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const shape = error as { code?: unknown; constraint_name?: unknown };
  return shape.code === "23505" && shape.constraint_name === constraint;
}

/**
 * El 409 de la unicidad global. **Una sola respuesta para los dos choques.**
 *
 * Ver la cabecera: que el choque propio y el ajeno sean indistinguibles es la
 * propiedad, no un efecto de no haber podido distinguirlos.
 */
export function alreadyRegistered(): ApiRejection {
  return new ApiRejection(
    409,
    "conflict",
    // Forma neutra, calcada de `FR-010` (PRD:767). El literal de `ERR-B06`
    // nombra el otro workspace y por eso no se usa: ver la cabecera.
    "This profile is already registered.",
    { code: "ERR-B06", reason: "already_registered" },
  );
}

/**
 * Traduce un `DomainError` de `core` cuyo código no existe en el contrato.
 *
 * `out_of_range` no está en `errorCodeSchema`, así que dejarlo pasar emite un
 * `code` que ningún SDK generado desde el contrato sabe manejar. Los dos casos
 * que esta capa produce son caps con código `ERR-B`, y los dos tienen un código
 * del contrato que los describe bien.
 *
 * Todo lo demás se relanza tal cual: `conflict`, `not_found` e `invalid_state`
 * ya tienen su traducción en `http/errors.ts`.
 */
export function asApiRejection(error: unknown): unknown {
  if (!isDomainError(error) || error.code !== "out_of_range") return error;

  const details = error.details ?? {};
  const code = typeof details["code"] === "string" ? details["code"] : undefined;

  if (code === "ERR-B10") {
    // El cap de 5 fuentes. `bad_request` y no `payment_required`: §9.14 dice que
    // el análisis **no** consume content saves, así que no es un problema de
    // plan — es una petición que no cabe.
    return new ApiRejection(400, "bad_request", error.message, {
      code,
      cap: HARD_CAPS.brandSources,
    });
  }
  return error;
}

// ───────────────────────────────────────────────────────────────────────────
// Detección
// ───────────────────────────────────────────────────────────────────────────

/**
 * Lo que el usuario escribió → texto que `detectBrandSource` sabe leer.
 *
 * Un `handle` suelto **no se pasa crudo**, y el motivo es concreto: `"acme"` no
 * empieza por `@`, así que el detector lo trata como URL sin esquema, lo
 * convierte en `https://acme`, y `assertHostAllowed` lo rechaza con *"Blocked
 * URL for security reasons"* porque un host sin punto es una IP en forma rara.
 * El usuario vería un error de seguridad por escribir su propio handle.
 *
 * Con una plataforma social, `canonicalSocialUrl` arma la URL canónica y el
 * detector la lee de vuelta. Eso además resuelve gratis los dos handles que no
 * son una palabra: `company/acme` (LinkedIn) y `channel/UCxxxx` (YouTube, con
 * mayúsculas que **no** se pueden bajar porque el id es sensible a caja).
 *
 * **La invariante** —la cubre `brand.test.ts`, plataforma por plataforma— es
 * que escribir el handle equivale a pegar la URL del perfil: el
 * `(sourceType, handle)` que sale del detector es el mismo en los dos caminos.
 * Si no lo fuera, la unicidad global de `DATA-031` dejaría pasar la misma
 * cuenta dos veces, una por cada camino.
 */
export function detectionInputOf(
  sourceType: CoreBrandSourceType,
  body: {
    readonly handle?: string | undefined;
    readonly canonicalUrl?: string | undefined;
  },
): string {
  if (body.canonicalUrl !== undefined) return body.canonicalUrl;
  const handle = (body.handle ?? "").trim().replace(/^@/, "");
  return isSocialType(sourceType)
    ? canonicalSocialUrl(sourceType, profileHandleOf(sourceType, handle))
    : handle;
}

/**
 * El handle tal como lo escribe `core` en `(sourceType, handle)`.
 *
 * Existe por **un** caso: un handle de LinkedIn a secas. `detectBrandSource`
 * sólo reconoce `linkedin.com/company|school|in/<slug>` y guarda el handle
 * **con** el prefijo; `canonicalSocialUrl("linkedin", "acme")` arma
 * `linkedin.com/acme`, que el propio detector no reconoce (`ERR-B02`). O sea
 * que `core` no hace ida y vuelta consigo mismo para LinkedIn, y el alta con
 * `{sourceType: "linkedin", handle: "acme"}` fallaba.
 *
 * El prefijo por defecto es `company/` porque LinkedIn entra en `FR-011.1`
 * como *"URL de company page o perfil"* con el ejemplo
 * `linkedin.com/company/mimarca`, y porque las señales de `FR-011.3` para
 * LinkedIn (tagline, industria, tamaño de empresa, sede) son de una página de
 * empresa: un slug suelto es una marca, no una persona. Quien quiera un
 * perfil personal o una escuela manda el prefijo (`in/…`, `school/…`).
 *
 * **Este arreglo es de `core`, no de acá**: el lugar natural es
 * `canonicalSocialUrl` (o el `@handle` + `hint: "linkedin"` de
 * `detectBrandSource`, que tiene el mismo defecto y devuelve `handle: "acme"`
 * en vez de `company/acme`). Está en el reporte; mientras tanto el test de ida
 * y vuelta de `brand.test.ts` se pone rojo si alguien lo quita de este lado.
 */
export function profileHandleOf(sourceType: SocialSourceType, handle: string): string {
  if (sourceType === "linkedin" && !handle.includes("/")) return `company/${handle}`;
  return handle;
}

/**
 * La detección de un alta **por handle** tiene que caer en la plataforma y el
 * handle pedidos; si no, se rechaza en vez de dar de alta otra cosa.
 *
 * El caso que lo motiva no es teórico: `{sourceType: "youtube", handle:
 * "user/acme"}` arma `youtube.com/@user/acme`, el detector lee el primer
 * segmento y resuelve **`@user`** — un canal que existe y no es el de la
 * marca. Sin esta guarda el alta sale `202` con la cuenta equivocada y nadie
 * se entera hasta ver el perfil sintetizado. Lo mismo `instagram` + `a/b`
 * (resuelve `a`, marcado como post).
 *
 * Se compara sin caja: el detector baja a minúsculas los `@handle` pero no
 * los ids de canal de YouTube, y lo que se quiere detectar es un cambio de
 * **estructura**, no de mayúsculas.
 */
export function assertHandleRoundTrip(
  requested: { readonly sourceType: SocialSourceType; readonly handle: string },
  resolved: ResolvedInput,
): void {
  const wanted = profileHandleOf(
    requested.sourceType,
    requested.handle.trim().replace(/^@/, ""),
  ).toLowerCase();
  if (
    resolved.sourceType !== requested.sourceType ||
    resolved.handle.toLowerCase() !== wanted ||
    resolved.resolvedFromPost
  ) {
    throw new ApiRejection(
      400,
      "bad_request",
      "We couldn't tell what this is. Paste a website URL or a social profile link.",
      { code: "ERR-B02" },
    );
  }
}

const SOCIAL_TYPES: readonly string[] = [
  "instagram",
  "tiktok",
  "x",
  "youtube",
  "linkedin",
];

function isSocialType(t: CoreBrandSourceType): t is SocialSourceType {
  return SOCIAL_TYPES.includes(t);
}

/**
 * Exige una detección resuelta, o traduce el desenlace a HTTP.
 *
 * Los tres desenlaces que no resuelven son distintos y se responden distinto:
 *
 *  - **`ambiguous`** (`ERR-B03`): un `@handle` sin plataforma no es un error de
 *    formato, es una pregunta. Va con `details.candidates` y con la plataforma
 *    preseleccionada, que es lo que `FR-011.12` pide para que el desambiguador
 *    no arranque vacío.
 *  - **`unrecognized`** (`ERR-B02`): copy literal de §19.5.1.
 *  - **`needs_lookup`**: un enlace a un post de Instagram, YouTube o LinkedIn
 *    **no contiene el handle del autor**. Resolverlo exige preguntárselo a la
 *    plataforma y no hay ningún `SocialReader` montado en `ApiDeps`. Se
 *    responde `503 service_unavailable` —código del PRD— con el mismo criterio
 *    que `POST /blitz/angles/generate` sin adaptador de LLM: decir que no está
 *    es mejor que inventar un handle. En TikTok y X el handle **sí** está en la
 *    URL y el detector los resuelve sin preguntar a nadie.
 */
export function requireResolved(detection: BrandSourceDetection): ResolvedInput {
  switch (detection.kind) {
    case "resolved":
      return detection;
    case "ambiguous":
      throw new ApiRejection(
        400,
        "bad_request",
        `Which platform is @${detection.handle} on?`,
        {
          code: "ERR-B03",
          handle: detection.handle,
          candidates: [...detection.candidates],
          preselected: detection.preselected,
        },
      );
    case "needs_lookup":
      throw new ApiRejection(
        503,
        "service_unavailable",
        "We can't resolve a post link to its profile yet. Paste the profile link instead.",
        { sourceType: detection.sourceType },
      );
    case "unrecognized":
      throw new ApiRejection(
        400,
        "bad_request",
        "We couldn't tell what this is. Paste a website URL or a social profile link.",
        { code: "ERR-B02" },
      );
  }
}

/**
 * `detectBrandSource` con los rechazos de SSRF traducidos al contrato.
 *
 * `assertHostAllowed` lanza `DomainError("out_of_range", …)`, y ese código no
 * está en `errorCodeSchema`. El mensaje —que **sí** es literal de `FR-010`
 * (PRD:767)— se conserva palabra por palabra; lo único que cambia es el código
 * del cable. `400` y no `403`: el PRD lista esos tres mensajes bajo
 * **Validation**, o sea como entrada inválida, no como permiso denegado.
 */
export function detect(
  input: string,
  options: {
    readonly hint?: CoreBrandSourceType | undefined;
    readonly connectedPlatforms?: readonly SocialSourceType[] | undefined;
  },
): BrandSourceDetection {
  try {
    return detectBrandSource(input, options);
  } catch (error) {
    if (isDomainError(error) && error.code === "out_of_range") {
      throw new ApiRejection(400, "bad_request", error.message);
    }
    throw error;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Lecturas auxiliares (todas con scope, todas dentro de la misma transacción)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Todas las fuentes del workspace.
 *
 * Una sola página alcanza y no es un atajo: el cap de `HARD_CAPS.brandSources`
 * es 5, y `+1` es lo que permite **detectar** que el cap se rompió por otra vía
 * en vez de truncar en silencio.
 */
async function listAllSources(
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

/** Fila → la entidad que entienden las funciones de `core`. */
function toDomainSource(row: BrandSourceRow): DomainBrandSource {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceType: row.sourceType,
    handle: row.handle ?? "",
    canonicalUrl: row.canonicalUrl ?? "",
    ...(row.displayName === null ? {} : { displayName: row.displayName }),
    ...(row.avatarUrl === null ? {} : { avatarUrl: row.avatarUrl }),
    isPrimary: row.isPrimary,
    status: row.status,
    ...(row.failureReason === null ? {} : { failureReason: row.failureReason }),
    ...(row.lastAnalysedAt === null ? {} : { lastAnalysedAt: row.lastAnalysedAt }),
    analysisCount: row.analysisCount,
    // ── El hueco que hay que conocer antes de tocar el cooldown ──
    //
    // `assertCanReanalyse` necesita saber **cuándo empezó la ventana** de 24 h,
    // y `brand_sources` no tiene una columna para eso: sólo `analysisCount` y
    // `lastAnalysedAt`. `packages/db` no es de este agente, así que la ventana
    // se ancla en `lastAnalysedAt ?? createdAt`.
    //
    // Qué compra y qué no, con precisión:
    //  - Dentro de la primera ventana el cap se aplica y es **igual o más
    //    estricto** que el diseñado: nunca deja pasar de más.
    //  - Una vez vencida la ventana sin que ningún análisis haya completado
    //    (que es hoy el caso normal, porque el handler de
    //    `brand-source-analysis` todavía no existe y nadie escribe
    //    `lastAnalysedAt`), `startAnalysis` ve la ventana vencida y resetea el
    //    contador **en cada llamada**, así que el cooldown deja de aplicar.
    //
    // La columna que cierra esto es `analysis_window_started_at timestamptz` en
    // `brand_sources`. Está en el reporte.
    analysisWindowStartedAt: row.lastAnalysedAt ?? row.createdAt,
    createdAt: row.createdAt,
  };
}

/** Las plataformas con OAuth activo, para el desambiguador de `FR-011.12`. */
async function connectedPlatforms(
  tx: Transaction,
  companyId: string,
): Promise<readonly SocialSourceType[]> {
  const result = await connectionRepository.list(
    tx,
    { companyId },
    { limit: HARD_CAPS.idsPerBatch, filter: { status: { eq: "active" } } },
  );
  const platforms = new Set(result.items.map((row) => row.platform as string));
  return SOCIAL_TYPES.filter((p) => platforms.has(p)) as readonly SocialSourceType[];
}

/**
 * El tier con el que **arranca** la fuente.
 *
 * `acquisition_tier` es `NOT NULL` sin default, así que hay que poner algo al
 * insertar aunque el tier real lo resuelva el job. Se guarda el **primero del
 * plan** de `FR-011.4`, que es la mejor respuesta disponible antes de intentar
 * nada: con una conexión OAuth activa es `A_oauth` (usarla no le pide nada al
 * usuario), y sin ella `B_public_api`, que es el punto de partida de `D-01`.
 *
 * `renderedFetchEnabled: false` porque el tier C está apagado hasta `OQ-16` y
 * `apps/api` no tiene de dónde leer ese flag. `requiresConnection: false`
 * porque quien lo sabe es `SocialReadCapabilities` del adaptador, y no hay
 * adaptador montado: asumir `true` mandaría todas las altas a `D_assisted`.
 */
async function initialTier(
  tx: Transaction,
  companyId: string,
  sourceType: CoreBrandSourceType,
): Promise<AcquisitionTier> {
  const platform = CONNECTION_PLATFORM[sourceType];
  let hasConnection = false;
  if (platform !== undefined) {
    const found = await connectionRepository.count(
      tx,
      { companyId },
      {
        filter: { platform: { eq: platform }, status: { eq: "active" } },
      },
    );
    hasConnection = found > 0;
  }
  const plan = acquisitionPlan({
    renderedFetchEnabled: false,
    hasConnection,
    requiresConnection: false,
  });
  // `acquisitionPlan` nunca devuelve una lista vacía: `D_assisted` siempre la
  // cierra. El `?? "D_assisted"` es por el tipo, no por el caso.
  //
  // Acá vivía `persistableTier`, que traducía el `C_rendered_fetch` de `ports`
  // al `C_page_fetch` de la columna. Los dos enums se unificaron
  // (`P1-BRAND-013`), así que la traducción dejó de tapar nada — y el
  // compilador lo dijo: `This comparison appears to be unintentional because
  // the types … have no overlap`.
  return plan[0] ?? "D_assisted";
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
 * El rol del actor para `FR-011.10` (*"sólo el owner puede eliminar la fuente
 * primaria"*).
 *
 * Con una **sesión de usuario** se lee de `workspace_memberships`, que es donde
 * vive el rol. Con una **API key** no hay usuario detrás: una key de workspace
 * es la credencial del workspace, no la de un miembro, así que se trata como
 * `owner`. Es una decisión, no una omisión — la alternativa (negar siempre)
 * haría que ningún integrador pudiera borrar su fuente primaria por la API, y
 * `FR-011.10` habla de miembros, no de credenciales de servicio. Queda en el
 * reporte, porque el día que las API keys tengan scopes (FR-180 los insinúa) la
 * respuesta correcta es mirarlos.
 */
async function actorRole(
  tx: Transaction,
  auth: {
    readonly companyId: string;
    readonly kind: string;
    readonly userId?: string | undefined;
  },
): Promise<"owner" | "member"> {
  if (auth.userId === undefined) return "owner";
  const memberships = await workspaceMembershipRepository.list(
    tx,
    { companyId: auth.companyId },
    { limit: 1, filter: { userId: { eq: auth.userId } } },
  );
  return memberships.items[0]?.role ?? "member";
}

// ───────────────────────────────────────────────────────────────────────────
// Rutas
// ───────────────────────────────────────────────────────────────────────────

export function registerBrandRoutes(app: ZodApp): void {
  const { clock, idempotency, limiter } = app.deps;

  // ── POST /brand/sources/resolve ──
  //
  // "Idempotente y barato" (PRD:2368): no escribe nada y no encola nada.
  app.post(
    "/brand/sources/resolve",
    {
      schema: { body: resolveBrandSourceRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const companyId = request.auth.companyId;

      const result = await request.tx(async (tx): Promise<ResolveBrandSourceResponse> => {
        // `hint` sólo puede ser `website` (el chip de `FR-011.2`), y
        // `detectBrandSource` sólo lo mira para un host que no es de ninguna
        // red social: no convierte una URL de Instagram en web ni resuelve un
        // `@handle` suelto. Ver `brandSourceResolveHintSchema` en contracts.
        const resolved = requireResolved(
          detect(request.body.input, {
            hint: request.body.hint,
            connectedPlatforms: await connectedPlatforms(tx, companyId),
          }),
        );

        // **`available` sólo puede hablar de ESTE workspace.**
        //
        // La unicidad es global, así que la respuesta honesta a "¿está
        // libre?" exigiría mirar las filas de todos los workspaces — que RLS
        // impide y que, si no lo impidiera, convertiría este endpoint en un
        // buscador de clientes de FastGram: probar `@nike` y leer `false`
        // dice que Nike es cliente. Así que `available` significa "no está ya
        // entre tus fuentes", y el choque global se descubre en el alta, con
        // una respuesta que no distingue (ver la cabecera).
        const mine = await brandSourceRepository.count(
          tx,
          { companyId },
          {
            filter: {
              sourceType: { eq: resolved.sourceType },
              handle: { eq: resolved.handle },
            },
          },
        );

        return {
          sourceType: resolved.sourceType,
          handle: resolved.handle === "" ? null : resolved.handle,
          canonicalUrl: resolved.canonicalUrl === "" ? null : resolved.canonicalUrl,
          // Sin `SocialReader` montado no hay de dónde sacarlos. `null` es el
          // valor que el contrato ya prevé; inventarlos sería peor.
          displayName: null,
          avatarUrl: null,
          available: mine === 0,
          // `ERR-B12`: *"We'll analyse the whole @{handle} profile, not just
          // that post."* Es un aviso, no un error, y éste es el único momento
          // en que se puede dar.
          ...(resolved.resolvedFromPost ? { resolvedFromPost: true } : {}),
        };
      });

      return reply.status(200).send(data(result));
    },
  );

  // ── GET /brand/sources ──
  app.get(
    "/brand/sources",
    { schema: { querystring: cursorQuerySchema } },
    async (request) => {
      const q = request.query;
      const result = await request.tx((tx) =>
        brandSourceRepository.list(
          tx,
          { companyId: request.auth.companyId },
          { limit: q.limit, ...(q.cursor === undefined ? {} : { cursor: q.cursor }) },
        ),
      );
      return page(result, toBrandSource);
    },
  );

  // ── POST /brand/sources ──
  //
  // `202` y no `201`: lo que termina al devolver no es el recurso, es el
  // encolado. El recurso existe pero está en `pending` y su contenido real
  // llega después (PRD:2370).
  app.post(
    "/brand/sources",
    {
      schema: {
        body: createBrandSourceRequestSchema,
        // §9.14: *"Requiere `Idempotency-Key` porque el análisis tiene coste"*.
        headers: idempotencyHeaderSchema,
      },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const { queue } = app.deps;
      if (queue === undefined) {
        // Sin cola, crear la fila dejaría una fuente en `pending` que nadie va
        // a analizar nunca — el mismo fallo silencioso que `POST /content`
        // evita. Se responde antes de consumir la `Idempotency-Key`: quemarla
        // por una indisponibilidad de infraestructura impediría el reintento.
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Brand source analysis is temporarily unavailable.",
          },
        });
      }

      const body = request.body;
      const companyId = request.auth.companyId;
      const key = idempotencyKeyOf({ ...request.headers });

      if (body.sourceType === "manual") {
        // `manual` es la rama asistida (tier D): el usuario pega su bio o
        // responde el cuestionario. No hay nada que analizar ni handle que
        // normalizar, y guardarlo con `handle = ""` chocaría contra el índice
        // global —`WHERE handle is not null` deja pasar la cadena vacía— con
        // el **primer** `manual` de **cualquier** workspace. El caso de uso no
        // está escrito en `core`; queda reportado, no inventado.
        throw new ApiRejection(
          400,
          "bad_request",
          "A manual brand source is created through onboarding, not through this endpoint.",
        );
      }

      return withIdempotency(
        idempotency,
        request,
        reply,
        { key, route: CREATE_ROUTE, body, successStatus: 202 },
        () =>
          request.tx(async (tx): Promise<BrandSourceResource> => {
            const scope = { companyId };

            // El detector es la autoridad sobre el tipo: `sourceType` del
            // cuerpo entra como **pista**. Con un `@handle` la pista manda;
            // con una URL manda el host, que es lo que `FR-011.1` decide. El
            // tipo que quedó viaja en el 202, así que nunca es invisible.
            const resolved = requireResolved(
              detect(detectionInputOf(body.sourceType, body), {
                hint: body.sourceType,
                connectedPlatforms: await connectedPlatforms(tx, companyId),
              }),
            );
            // Por handle (sin URL) no hay host que mande: lo que se pidió es lo
            // que se tiene que dar de alta, o nada. Ver `assertHandleRoundTrip`.
            if (
              body.canonicalUrl === undefined &&
              body.handle !== undefined &&
              isSocialType(body.sourceType)
            ) {
              assertHandleRoundTrip(
                { sourceType: body.sourceType, handle: body.handle },
                resolved,
              );
            }

            const existing = await listAllSources(tx, companyId);

            // El choque **dentro** del workspace se detecta acá, y responde
            // exactamente igual que el choque con otro workspace. Ver cabecera.
            //
            // **Este pre-chequeo NO es redundante, aunque lo parezca.** Quitarlo
            // deja que el índice haga el trabajo y la respuesta sale idéntica...
            // salvo en un caso: con el workspace en el cap de 5, `createBrandSource`
            // se evalúa antes que el `INSERT` y responde `ERR-B10` ("no te caben más
            // fuentes") sobre una fuente que el usuario **ya tiene**. El consejo
            // sería falso: borrar otra no arreglaría nada. Se comprobó quitándolo:
            // los 40 tests seguían verdes hasta que se escribió el caso del cap.
            if (
              existing.some(
                (row) =>
                  row.sourceType === resolved.sourceType &&
                  row.handle === resolved.handle,
              )
            ) {
              throw alreadyRegistered();
            }

            const sourceId = randomUUID();
            let created: DomainBrandSource;
            try {
              created = createBrandSource({
                id: sourceId,
                companyId,
                sourceType: resolved.sourceType,
                handle: resolved.handle,
                canonicalUrl: resolved.canonicalUrl,
                existingCount: existing.length,
                // Siempre `false`: desde una transacción con scope no hay forma
                // de saberlo. Lo dice el índice, al insertar. Ver la cabecera.
                takenByAnotherWorkspace: false,
                now: new Date(clock.nowMs()),
              });
            } catch (error) {
              throw asApiRejection(error);
            }

            // `isPrimary` explícito en el cuerpo. `core` sólo sabe que la
            // primera fuente es primaria; promover una posterior exige
            // **degradar la actual antes de insertar**, porque
            // `brand_sources_primary_uq` es un índice único parcial y no es
            // diferible: insertar la segunda primaria falla si la primera
            // sigue marcada.
            const wantsPrimary = body.isPrimary === true || created.isPrimary;
            if (wantsPrimary) {
              for (const row of existing) {
                if (row.isPrimary) {
                  await brandSourceRepository.update(tx, scope, row.id, {
                    isPrimary: false,
                  });
                }
              }
            }

            let row: BrandSourceRow;
            try {
              row = await brandSourceRepository.create(tx, scope, {
                id: created.id,
                sourceType: created.sourceType,
                handle: created.handle,
                canonicalUrl: created.canonicalUrl,
                isPrimary: wantsPrimary,
                acquisitionTier: await initialTier(tx, companyId, created.sourceType),
                status: created.status,
                analysisCount: created.analysisCount,
              });
            } catch (error) {
              // El único detector posible de la unicidad global. La transacción
              // ya está abortada, así que acá sólo se puede lanzar.
              if (isUniqueViolation(error, TYPE_HANDLE_CONSTRAINT)) {
                throw alreadyRegistered();
              }
              throw error;
            }

            // ADR-005: el encolado va **dentro** de la transacción. Si la cola
            // no responde, la fuente no queda creada en `pending` esperando un
            // job que nunca se encoló.
            await queue.enqueue({
              queue: JOB_QUEUES.brandSourceAnalysis,
              payload: {
                brandSourceId: row.id,
                companyId,
                sourceType: row.sourceType,
                handle: row.handle,
                canonicalUrl: row.canonicalUrl,
                itemsPerAnalysis: HARD_CAPS.itemsPerBrandAnalysis,
              },
              options: {
                transaction: tx,
                // El id recién creado es único por definición: esto deduplica
                // un reintento del propio encolado, no dos altas distintas —de
                // eso se ocupa la `Idempotency-Key`.
                singletonKey: `brand-source:${row.id}`,
              },
            });

            return toBrandSource(row);
          }),
      );
    },
  );

  // ── GET /brand/sources/:id ──
  app.get(
    "/brand/sources/:id",
    { schema: { params: brandSourceParams } },
    async (request) => {
      const { id } = request.params;
      const companyId = request.auth.companyId;
      const row = await request.tx((tx) =>
        brandSourceRepository.findById(tx, { companyId }, id),
      );
      // §9.2: ajeno e inexistente son el mismo 404, con el mismo cuerpo.
      if (row === null) throw crossTenant("brand source", id, companyId);
      return data(toBrandSource(row));
    },
  );

  // ── POST /brand/sources/:id/reanalyse ──
  app.post(
    "/brand/sources/:id/reanalyse",
    {
      schema: { params: brandSourceParams },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const { queue } = app.deps;
      if (queue === undefined) {
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Brand source analysis is temporarily unavailable.",
          },
        });
      }

      const { id } = request.params;
      const companyId = request.auth.companyId;
      const now = new Date(clock.nowMs());

      const outcome = await request.tx(
        async (
          tx,
        ): Promise<
          | { readonly kind: "ok"; readonly row: BrandSourceRow }
          | {
              readonly kind: "cooldown";
              readonly hours: number;
              readonly message: string;
            }
        > => {
          const scope = { companyId };
          // `FOR UPDATE`: un segundo pedido simultáneo espera acá hasta que éste
          // confirme, y entonces lee `analyzing` y `startAnalysis` lo rechaza
          // con 409. Con `findById` los dos leían `ready`, los dos pasaban, y el
          // `UPDATE` de abajo no frena al segundo: su `WHERE` es sólo id +
          // workspace, que siguen siendo ciertos (ver `brand-source-lock.ts`).
          const current = await lockBrandSource(tx, scope, id);
          if (current === null) throw crossTenant("brand source", id, companyId);

          let next: DomainBrandSource;
          try {
            // `startAnalysis` aplica `assertCanReanalyse` (ERR-B11) y rechaza
            // un segundo análisis sobre una fuente que ya está `analyzing`.
            next = startAnalysis(toDomainSource(current), now);
          } catch (error) {
            if (isDomainError(error) && error.code === "out_of_range") {
              const details = error.details ?? {};
              const hours =
                typeof details["retryAfterHours"] === "number"
                  ? details["retryAfterHours"]
                  : 1;
              return { kind: "cooldown", hours, message: error.message };
            }
            throw asApiRejection(error);
          }

          const updated = await brandSourceRepository.update(tx, scope, id, {
            status: next.status,
            analysisCount: next.analysisCount,
            failureReason: null,
          });
          if (updated === null) {
            throw new Error(
              "El UPDATE no encontró la fuente que `findById` acababa de devolver, " +
                "en la misma transacción. Si pasa, cambió el aislamiento del repositorio.",
            );
          }

          await queue.enqueue({
            queue: JOB_QUEUES.brandSourceAnalysis,
            payload: {
              brandSourceId: updated.id,
              companyId,
              sourceType: updated.sourceType,
              handle: updated.handle,
              canonicalUrl: updated.canonicalUrl,
              itemsPerAnalysis: HARD_CAPS.itemsPerBrandAnalysis,
            },
            options: {
              transaction: tx,
              // A diferencia del alta, acá el id **se repite** entre
              // re-análisis, y pg-boss deriva un id determinista de la clave:
              // una clave repetida no se encola nunca más (trampa 39).
              //
              // Llevaba el contador de la ventana, y **no alcanzaba**: el
              // contador vuelve a 1 al vencer la ventana, así que el segundo
              // re-análisis de otro día repetía `:1`, se deduplicaba contra el
              // job viejo y la fuente quedaba `analyzing` sin nadie que la
              // analice. Con el instante, dos pedidos aceptados son dos jobs.
              //
              // Dos pedidos **simultáneos** ya no llegan los dos hasta acá: la
              // lectura de arriba es `FOR UPDATE`, así que el segundo espera,
              // lee `analyzing` y sale con 409 sin encolar. Antes, con
              // `findById` sin lock, los dos pasaban y esta clave —distinta por
              // instante— los convertía en dos jobs. El test concurrente de
              // `brand-sources.int.test.ts` lo mide con el lock quitado.
              singletonKey: `brand-source:${updated.id}:reanalyse:${now.toISOString()}`,
            },
          });

          return { kind: "ok", row: updated };
        },
      );

      if (outcome.kind === "cooldown") {
        // `ERR-B11`. §9.6 fija la forma del 429: header `Retry-After` (en
        // segundos) y `details.retryAfterMs`. Se responde acá y no por
        // `ApiRejection` porque `translateError` sólo pone `Retry-After` para
        // los errores de puerto, y el header es obligatorio.
        const retryAfterMs = outcome.hours * 3_600_000;
        return reply
          .status(429)
          .header("Retry-After", String(outcome.hours * 3600))
          .send({
            error: {
              code: "rate_limited",
              message: outcome.message,
              details: { code: "ERR-B11", retryAfterMs },
            },
          });
      }

      return reply.status(202).send(data(toBrandSource(outcome.row)));
    },
  );

  // ── PATCH /brand/sources/:id ──
  //
  // "Sólo `isPrimary`" (PRD:2372), y el contrato ya lo hace cumplir: cualquier
  // otra clave la rechaza el `.strict()` del schema antes de llegar acá.
  app.patch(
    "/brand/sources/:id",
    {
      schema: { params: brandSourceParams, body: updateBrandSourceRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const { id } = request.params;
      const companyId = request.auth.companyId;

      if (!request.body.isPrimary) {
        // Degradar la primaria dejaría el workspace **sin** primaria, y
        // `FR-011.6` dice "exactamente una por workspace" — es el desempate de
        // la fusión de perfiles, así que sin ella la precedencia no resuelve.
        // La operación que el usuario quiere es promover otra.
        throw new ApiRejection(
          400,
          "bad_request",
          "Promote another source instead: a workspace always has exactly one primary brand source.",
        );
      }

      const row = await request.tx(async (tx) => {
        const scope = { companyId };
        const sources = await listAllSources(tx, companyId);
        if (!sources.some((s) => s.id === id)) {
          throw crossTenant("brand source", id, companyId);
        }

        // `setPrimarySource` devuelve **todas** las fuentes: el invariante es
        // del conjunto, no de una fila, y por eso su firma no permite marcar
        // una sin desmarcar las otras.
        const next = setPrimarySource(sources.map(toDomainSource), id);

        // **Primero las bajas, después el alta.** `brand_sources_primary_uq` es
        // un índice parcial único no diferible: marcar la nueva antes de
        // desmarcar la vieja falla con 23505 en medio de la transacción.
        for (const source of next) {
          const current = sources.find((s) => s.id === source.id);
          if (current === undefined || current.isPrimary === source.isPrimary) continue;
          if (source.isPrimary) continue;
          await brandSourceRepository.update(tx, scope, source.id, { isPrimary: false });
        }

        const promoted = await brandSourceRepository.update(tx, scope, id, {
          isPrimary: true,
        });
        if (promoted === null) {
          throw new Error(
            "El UPDATE no encontró la fuente que el listado acababa de devolver, en " +
              "la misma transacción. Si pasa, cambió el aislamiento del repositorio.",
          );
        }
        return promoted;
      });

      return reply.status(200).send(data(toBrandSource(row)));
    },
  );

  // ── DELETE /brand/sources/:id ──
  app.delete(
    "/brand/sources/:id",
    {
      schema: { params: brandSourceParams },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const { id } = request.params;
      const companyId = request.auth.companyId;

      await request.tx(async (tx) => {
        const scope = { companyId };
        const sources = await listAllSources(tx, companyId);
        const current = sources.find((s) => s.id === id);
        if (current === undefined) throw crossTenant("brand source", id, companyId);

        // `FR-011.10`. `invalid_state` no está en `errorCodeSchema`, así que se
        // traduce: es una regla de **rol**, no de estado, y `forbidden` es el
        // código que el PRD tiene para eso. No filtra existencia —quien llega
        // acá ya vio la fuente en su propio listado—, así que no choca con §9.2.
        try {
          assertCanRemoveSource(
            toDomainSource(current),
            await actorRole(tx, request.auth),
          );
        } catch (error) {
          if (isDomainError(error) && error.code === "invalid_state") {
            throw new ApiRejection(403, "forbidden", error.message);
          }
          throw error;
        }

        // PRD:2373: *"Rechazado si es la única fuente y el perfil quedaría sin
        // origen."* Son **dos** condiciones y se implementan las dos: con el
        // perfil todavía en `pending` no hay nada materializado que quede
        // huérfano, y bloquear ahí dejaría a un workspace que se equivocó de
        // handle sin forma de corregirlo. El predicado de "perfil con origen"
        // es `status !== "pending"`, que es la única señal que `DATA-004`
        // ofrece; `core` no tiene esta regla escrita, así que la elección es de
        // acá y está en el reporte.
        if (sources.length === 1) {
          const profile = await loadProfile(tx, companyId);
          if (profile !== null && profile.status !== "pending") {
            throw new ApiRejection(
              409,
              "conflict",
              "This is the only source behind your brand profile. Add another one first.",
              { code: "ERR-B01" },
            );
          }
        }

        // `brand_sources` no tiene `deletedAt` (DATA-031 no declara soft-delete),
        // así que el borrado es real. Los snapshots se van con la FK
        // `ON DELETE CASCADE`; el `CompanyProfile` ya materializado **no** se
        // toca, que es lo que `FR-011.11` exige literalmente.
        const deleted = await brandSourceRepository.hardDelete(tx, scope, id);
        if (!deleted) throw crossTenant("brand source", id, companyId);

        // Borrar la primaria deja el workspace sin desempate para `FR-011.6`.
        // El PRD no dice quién hereda, así que hereda **la más antigua**, que es
        // la que el usuario dio de alta primero y la que `core` habría marcado
        // primaria si hubiera sido la única. Con cero fuentes no hay nada que
        // promover y el invariante es vacío.
        const remaining = sources.filter((s) => s.id !== id);
        if (current.isPrimary && remaining.length > 0) {
          const oldest = remaining.reduce((a, b) =>
            a.createdAt.getTime() <= b.createdAt.getTime() ? a : b,
          );
          await brandSourceRepository.update(tx, scope, oldest.id, { isPrimary: true });
        }
      });

      return reply.status(204).send();
    },
  );

  // ── GET /brand/profile ──
  app.get("/brand/profile", async (request) => {
    const row = await request.tx((tx) => loadProfile(tx, request.auth.companyId));
    // Sin fila no hay 404: ver `emptyCompanyProfile`.
    return data(row === null ? emptyCompanyProfile() : toCompanyProfile(row));
  });

  // ── PATCH /brand/profile ──
  app.patch(
    "/brand/profile",
    {
      schema: { body: updateCompanyProfileRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const body = request.body;

      const row = await request.tx(async (tx): Promise<CompanyProfileRow> => {
        const scope = { companyId };
        const current = await loadProfile(tx, companyId);

        const fieldMeta = markEditedByUser(
          (current?.fieldMeta ?? {}) as Record<string, FieldMeta>,
          Object.keys(body),
        );

        const values = {
          ...body,
          fieldMeta,
          // DATA-004: *"Incrementa en cada guardado"*. Es lo que `AI-005` usa
          // como `expectedBrandRevision` al crear un ángulo: si no se moviera,
          // una edición manual del perfil no invalidaría las sugerencias que se
          // generaron contra el perfil anterior.
          brandRevision: (current?.brandRevision ?? 0) + 1,
        };

        if (current === null) {
          return companyProfileRepository.create(tx, scope, values);
        }
        const updated = await companyProfileRepository.update(
          tx,
          scope,
          current.id,
          values,
        );
        if (updated === null) {
          throw new Error(
            "El UPDATE no encontró el perfil que la lectura acababa de devolver, en " +
              "la misma transacción. Si pasa, cambió el aislamiento del repositorio.",
          );
        }
        return updated;
      });

      return reply.status(200).send(data(toCompanyProfile(row)));
    },
  );
}

/**
 * Marca `editedByUser` en los campos que el PATCH tocó — `FR-011.6`.
 *
 * Es la mitad del requisito que no se ve: *"un campo con `editedByUser` no se
 * pisa"*. `mergeFieldCandidates` de `core` ya respeta la marca; alguien tiene
 * que **escribirla**, y el único momento en que se sabe que una edición fue
 * manual es éste.
 *
 * Sólo se marcan los campos de `BRAND_PROFILE_FIELDS`, que son los ocho que
 * `AI-016` deriva. Marcar `teamSize` o `monthlyRevenueBand` —que salen del
 * cuestionario y que ninguna síntesis escribe nunca— pondría metadatos que
 * nadie lee sobre campos que nadie pisa.
 *
 * Un campo editado a mano **no tiene fuente ni extracto**: por eso `sourceId` y
 * `excerptRef` van en `null` (ver la nota de `fieldMetaSchema`). Y la confianza
 * es `high` porque la escribió quien es dueño de la respuesta, que es la mejor
 * evidencia que el sistema puede tener.
 */
export function markEditedByUser(
  current: Record<string, FieldMeta>,
  touched: readonly string[],
): Record<string, FieldMeta> {
  const derivable = new Set<string>(BRAND_PROFILE_FIELDS);
  const next: Record<string, FieldMeta> = { ...current };
  for (const field of touched) {
    if (!derivable.has(field)) continue;
    const existing = next[field];
    next[field] =
      existing === undefined
        ? {
            confidence: "high",
            sourceId: null,
            excerptRef: null,
            editedByUser: true,
          }
        : { ...existing, editedByUser: true };
  }
  return next;
}
