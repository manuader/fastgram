/**
 * Auto-slot y calendario — `PU-CAL-001`, `PU-CAL-002` · `docs/PLAN-USO-PERSONAL.md`
 * §2 paso 5 y §5 · FR-060, FR-110.
 *
 *   POST  /content/:id/autoschedule    aprobar → próximo horario libre por red
 *   GET   /calendar?from&to&brands     posts + slots, de esta marca o de todas
 *   PATCH /calendar/items/:kind/:id    mover (drag & drop)
 *
 * ## Post o slot planificado
 *
 * Por cada red activa de la estrategia, `core` elige la hora
 * (`planAutoSlots`). Después:
 *
 * - si la marca tiene **exactamente una** conexión activa en esa red y la red
 *   puede ser un post hoy (`planSlotConversion`), se crea un `Post` por el
 *   mismo camino que `POST /content/:id/schedule` (`schedulePostsInTx`): misma
 *   resolución de cuenta, mismo job de publicación en la misma transacción;
 * - si no, un **slot planificado** (`planned_slots`, migración `0014`): contenido
 *   + red + hora, sin cuenta. El sprint 3 lo convierte con
 *   {@link convertPlannedSlot}, que hoy no llama nadie.
 *
 * ## La separación entre marcas mira a todas las del dueño
 *
 * El auto-slot lee lo ocupado en **todas** las marcas del dueño (modo personal;
 * en `standard` hay una sola). Las otras marcas se leen cada una con su scope
 * (`runScoped`), así que RLS sigue aplicando marca por marca: nunca hay una
 * consulta que cruce companies. Para que dos auto-slot simultáneos no tomen la
 * misma ventana, la transacción toma primero un lock por dueño
 * (`calendarLocks.lockOwner`) y recién después lee.
 *
 * ## Mover un post es cancelarlo y recrearlo
 *
 * El job de publicación se encola con `startAfter` = la hora vieja y **no se
 * puede cancelar**: no guardamos su `jobId` (ver `POST /posts/cancel`). Y el
 * worker publica todo post `SCHEDULED` que le llega sin mirar la hora
 * (`apps/worker/src/publishing/publish-handler.ts`). Cambiar la hora en el lugar
 * haría que un post movido a más tarde salga **a la hora vieja**.
 *
 * Así que mover = la fila vieja pasa a `CANCELLED` (el worker la saltea cuando
 * su job dispara) y se crea una fila nueva con la hora nueva y su propio job.
 * Es la misma máquina de estados de FR-060, sin estados nuevos. El precio: el
 * post cambia de id, y la Library muestra el cancelado. Cuando el worker
 * compare `scheduledAtUtc` con la hora del job, esto puede pasar a un `UPDATE`.
 */
import { z } from "zod";
import {
  CALENDAR_RANGE_MAX_DAYS,
  autoscheduleRequestSchema,
  calendarItemKindSchema,
  calendarQuerySchema,
  moveCalendarItemRequestSchema,
  type CalendarCounts,
  type CalendarItem,
  type CalendarNetwork,
  type FastgramMode,
  type PlannedSlot,
  type ScheduleOptions,
} from "@fastgram/contracts";
import {
  AUTO_SLOT_HORIZON_DAYS,
  assertCanMovePost,
  assertCanMoveSlot,
  deriveCaptionsForAll,
  effectiveDailyQuota,
  isMovablePost,
  planAutoSlots,
  planSlotConversion,
  type OccupiedSlot,
  type StrategyNetwork,
} from "@fastgram/core";
import {
  CALENDAR_IDLE_POST_STATUSES,
  calendarLocks,
  companyRepository,
  connectionRepository,
  contentRepository,
  plannedSlotRepository,
  postCalendar,
  postRepository,
  withoutCompany,
  workspaceDirectory,
  type Database,
  type Executor,
  type PlannedSlotRow,
  type PostRowForCalendar,
} from "@fastgram/db";
import type { Queue } from "@fastgram/ports";
import type { FastifyRequest } from "fastify";

import { ownerOrFail, runScoped } from "../../auth/scope.js";
import { ApiRejection } from "../../http/errors.js";
import { toPost } from "../../support/serializers.js";
import {
  isStorableId,
  schedulePostsInTx,
  supersedePost,
  type FlatTarget,
} from "./posts.js";
import { crossTenant, data, notFound } from "./shared.js";
import { loadStrategy, toSlotStrategy } from "./strategy.js";
import { xAllowLinksFromEnv } from "./posts-caption.js";
import type { ZodApp } from "../../server/types.js";

const DAY_MS = 86_400_000;
/** Tope de ítems por marca en un rango. Un mes de 3 piezas × 7 redes son ~650. */
export const CALENDAR_ITEMS_PER_BRAND_MAX = 1000;

const idParams = z.object({ id: z.string().min(1) });
/**
 * `kind` es un string libre y no el enum: un `kind` desconocido es un recurso que
 * no existe (404), no un pedido mal formado (400). Es lo que `malformed-ids` pide
 * de todo parámetro de ruta (NFR-006): que basura e inexistente respondan igual.
 */
const itemParams = z.object({ kind: z.string().min(1), id: z.string().min(1) });

interface Brand {
  readonly id: string;
  readonly name: string;
}

interface BrandContext {
  /** La clave del lock y de "todas las marcas": el dueño, o la company en `standard`. */
  readonly ownerKey: string;
  readonly brands: readonly Brand[];
}

/** Un rechazo de `schedulePostsInTx` que tiene que abortar la transacción. */
class ScheduleRejected extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function registerCalendarRoutes(
  app: ZodApp,
  options: { readonly xAllowLinks?: boolean } = {},
): void {
  const { db, clock, queue, appRole } = app.deps;
  const mode: FastgramMode = app.deps.mode ?? "standard";
  // Sprint 7: la caption derivada de X lleva links sólo si la instalación los permite.
  const xAllowLinks = options.xAllowLinks ?? xAllowLinksFromEnv(process.env);

  // ── POST /content/:id/autoschedule ──
  app.post(
    "/content/:id/autoschedule",
    { schema: { params: idParams, body: autoscheduleRequestSchema } },
    async (request, reply) => {
      const { id: contentId } = request.params;
      const companyId = request.auth.companyId;
      if (!isStorableId(contentId)) throw notFound("content");

      const nowMs = clock.nowMs();
      const context = await brandContext(db, appRole, mode, request, "all");

      let outcome: Awaited<ReturnType<typeof autoschedule>>;
      try {
        outcome = await request.tx((tx) =>
          autoschedule(tx, {
            db,
            appRole,
            queue,
            context,
            companyId,
            contentId,
            nowMs,
            xAllowLinks,
            ...(request.body.networks === undefined
              ? {}
              : { networks: request.body.networks }),
          }),
        );
      } catch (error) {
        if (error instanceof ScheduleRejected) {
          return reply.status(error.status).send({
            error: {
              code: error.code,
              message: error.message,
              ...(error.details === undefined ? {} : { details: error.details }),
            },
          });
        }
        throw error;
      }

      switch (outcome.kind) {
        case "content_missing":
          throw crossTenant("content", contentId, companyId);
        case "content_failed":
          return reply.status(409).send({
            error: {
              code: "unsupported_content_state",
              message: "This content failed to build and cannot be scheduled.",
            },
          });
        case "no_networks":
          return reply.status(409).send({
            error: {
              code: "conflict",
              message: "Turn on at least one network in this brand's strategy first.",
            },
          });
        case "no_queue":
          // Mismo trato que `schedule`: un post sin job no se crea.
          return reply.status(503).send({
            error: {
              code: "service_unavailable",
              message: "Scheduling is temporarily unavailable.",
            },
          });
        default:
          return reply.status(201).send(
            data({
              posts: outcome.posts.map(toPost),
              plannedSlots: outcome.slots.map(toPlannedSlot),
              skipped: outcome.skipped,
            }),
          );
      }
    },
  );

  // ── GET /content/:id/schedule-options ── (sprint 7: el diálogo de Schedule)
  //
  // Lo mismo que calcula el auto-slot, **sin escribir nada**: el próximo horario
  // libre de cada red de la estrategia (mirando todas las marcas del dueño), más
  // la caption derivada por red y las conexiones activas. Sin lock de dueño: es
  // una sugerencia; la hora la confirma el usuario y el `schedule` la valida.
  app.get(
    "/content/:id/schedule-options",
    { schema: { params: idParams } },
    async (request) => {
      const { id: contentId } = request.params;
      const companyId = request.auth.companyId;
      if (!isStorableId(contentId)) throw notFound("content");
      const nowMs = clock.nowMs();
      const context = await brandContext(db, appRole, mode, request, "all");
      const options = await request.tx((tx) =>
        scheduleOptions(tx, {
          db,
          appRole,
          queue,
          context,
          companyId,
          contentId,
          nowMs,
          xAllowLinks,
        }),
      );
      if (options === null) throw crossTenant("content", contentId, companyId);
      return data(options);
    },
  );

  // ── GET /calendar ──
  app.get(
    "/calendar",
    { schema: { querystring: calendarQuerySchema } },
    async (request) => {
      const { from, to, brands } = request.query;
      if (to <= from) {
        throw new ApiRejection(400, "bad_request", "to must be after from.");
      }
      if (to - from > CALENDAR_RANGE_MAX_DAYS * DAY_MS) {
        throw new ApiRejection(
          400,
          "bad_request",
          `The range can't be longer than ${String(CALENDAR_RANGE_MAX_DAYS)} days.`,
        );
      }

      const context = await brandContext(db, appRole, mode, request, brands);
      const items: CalendarItem[] = [];
      const counts: { posted: number; inbox: number; scheduled: number } = {
        posted: 0,
        inbox: 0,
        scheduled: 0,
      };
      const brandsOut: { id: string; name: string; timezone: string }[] = [];
      let truncated = false;

      // Marca por marca, cada una con su scope: RLS aplica en cada lectura.
      for (const brand of context.brands) {
        const part = await runScoped(db, brand.id, appRole, (tx) =>
          readBrandCalendar(tx, brand, from, to),
        );
        items.push(...part.items);
        counts.posted += part.counts.posted;
        counts.inbox += part.counts.inbox;
        counts.scheduled += part.counts.scheduled;
        truncated ||= part.truncated;
        brandsOut.push({ id: brand.id, name: brand.name, timezone: part.timezone });
      }

      items.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return data({ items, brands: brandsOut, counts, truncated });
    },
  );

  // ── PATCH /calendar/items/:kind/:id ──
  app.patch(
    "/calendar/items/:kind/:id",
    { schema: { params: itemParams, body: moveCalendarItemRequestSchema } },
    async (request) => {
      const parsedKind = calendarItemKindSchema.safeParse(request.params.kind);
      if (!parsedKind.success) throw notFound("item");
      const kind = parsedKind.data;
      const { id } = request.params;
      const body = request.body;
      if (!isStorableId(id)) throw notFound(kind);

      const brand = await resolveOwnedBrand(db, appRole, mode, request, body.brandId);
      const to = new Date(body.scheduledAtUtc);
      const now = new Date(clock.nowMs());

      if (kind === "post" && queue === undefined) {
        throw new ApiRejection(
          503,
          "service_unavailable",
          "Moving posts is temporarily unavailable.",
        );
      }

      const item = await runScoped(db, brand.id, appRole, async (tx) => {
        const scope = { companyId: brand.id };
        if (kind === "slot") {
          const slot = await plannedSlotRepository.findById(tx, scope, id);
          if (slot === null) throw crossTenant("slot", id, brand.id);
          assertCanMoveSlot(slot, to, now);
          const moved = await plannedSlotRepository.update(tx, scope, id, {
            scheduledAtUtc: to,
          });
          if (moved === null) throw notFound("slot");
          const content = await contentRepository.findById(tx, scope, moved.contentId, {
            includeDeleted: true,
          });
          return slotItem(moved, brand, content);
        }

        const post = await postRepository.findById(tx, scope, id);
        if (post === null) throw crossTenant("post", id, brand.id);
        assertCanMovePost(movableOf(post), to, now);
        const next = await supersedePost(tx, brand.id, post, to, queue as Queue);
        const content = await contentRepository.findById(tx, scope, next.contentId, {
          includeDeleted: true,
        });
        return postItem(next, brand, content);
      });
      return data(item);
    },
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Marcas
// ───────────────────────────────────────────────────────────────────────────

/** La company de la credencial, antes del header. Es la puerta al dueño. */
function homeCompanyOf(request: FastifyRequest): string {
  return request.auth.homeCompanyId ?? request.auth.companyId;
}

/**
 * Las marcas que entran: la de la request, o todas las del dueño.
 *
 * En `standard` no hay marcas (una key = un workspace), así que "todas" es la
 * de la request. En `personal`, la lista sale de `workspaceDirectory`, que
 * corre sin scope de tenant por la razón de su cabecera — y **sólo** lista:
 * los datos de cada marca se leen después con su propio scope.
 */
export async function brandContext(
  db: Database,
  appRole: string | undefined,
  mode: FastgramMode,
  request: FastifyRequest,
  which: "current" | "all",
): Promise<BrandContext> {
  const companyId = request.auth.companyId;
  if (mode !== "personal") {
    const company = await runScoped(db, companyId, appRole, (tx) =>
      companyRepository.load(tx, { companyId }),
    );
    return {
      ownerKey: companyId,
      brands: [{ id: companyId, name: company?.name ?? "" }],
    };
  }
  return withoutCompany(db, async (tx) => {
    const owner = await ownerOrFail(tx, homeCompanyOf(request));
    const all = await workspaceDirectory.list(tx, owner);
    const brands = all
      .filter((w) => which === "all" || w.id === companyId)
      .map((w) => ({ id: w.id, name: w.name }));
    return { ownerKey: owner.ownerUserId, brands };
  });
}

/**
 * La marca de un ítem a mover. Sin `brandId`, la de la request. Con uno
 * distinto, tiene que ser del mismo dueño: el mismo criterio —y el mismo 404—
 * que `X-Fastgram-Workspace` en `auth/scope.ts`.
 */
async function resolveOwnedBrand(
  db: Database,
  appRole: string | undefined,
  mode: FastgramMode,
  request: FastifyRequest,
  brandId: string | undefined,
): Promise<Brand> {
  const companyId = request.auth.companyId;
  const target = brandId?.toLowerCase() ?? companyId;
  if (target === companyId.toLowerCase()) {
    const context = await brandContext(db, appRole, mode, request, "current");
    return context.brands[0] ?? { id: companyId, name: "" };
  }
  if (mode !== "personal") throw notFound("brand");
  const found = await withoutCompany(db, async (tx) => {
    const owner = await ownerOrFail(tx, homeCompanyOf(request));
    return workspaceDirectory.find(tx, owner, target);
  });
  if (found === null) throw notFound("brand");
  return { id: found.id, name: found.name };
}

// ───────────────────────────────────────────────────────────────────────────
// Auto-slot
// ───────────────────────────────────────────────────────────────────────────

interface AutoscheduleInput {
  readonly db: Database;
  readonly appRole: string | undefined;
  readonly queue: Queue | undefined;
  readonly context: BrandContext;
  readonly companyId: string;
  readonly contentId: string;
  readonly nowMs: number;
  readonly networks?: readonly StrategyNetwork[];
  readonly xAllowLinks?: boolean;
}

type AutoscheduleOutcome =
  | { readonly kind: "content_missing" }
  | { readonly kind: "content_failed" }
  | { readonly kind: "no_networks" }
  | { readonly kind: "no_queue" }
  | {
      readonly kind: "scheduled";
      readonly posts: PostRowForCalendar[];
      readonly slots: PlannedSlotRow[];
      readonly skipped: {
        network: StrategyNetwork;
        reason: "already_scheduled" | "no_free_slot";
      }[];
    };

async function autoschedule(
  tx: Executor,
  input: AutoscheduleInput,
): Promise<AutoscheduleOutcome> {
  const { companyId, contentId, nowMs } = input;
  const scope = { companyId };

  // Primero el lock, después cualquier lectura: ver la cabecera.
  await calendarLocks.lockOwner(tx, input.context.ownerKey);

  const content = await contentRepository.findById(tx, scope, contentId);
  if (content === null) return { kind: "content_missing" };
  if (content.status === "FAILED") return { kind: "content_failed" };

  const strategy = await loadStrategy(tx, companyId);
  const occupied = await occupiedAcrossBrands(tx, input);
  const alreadyScheduled = [
    ...(await postCalendar.livePlatformsOf(tx, scope, contentId)),
    ...(await plannedSlotRepository.plannedNetworksOf(tx, scope, contentId)),
  ];

  const outcomes = planAutoSlots({
    strategy: toSlotStrategy(strategy),
    brandId: companyId,
    contentId,
    nowMs,
    occupied,
    alreadyScheduled,
    ...(input.networks === undefined ? {} : { networks: input.networks }),
  });
  if (outcomes.length === 0) return { kind: "no_networks" };

  const connections = await connectionRepository.list(tx, scope, {
    limit: 100,
    filter: { status: { eq: "active" } },
  });
  const active = connections.items.map((c) => ({ id: c.id, platform: c.platform }));

  // Se decide todo antes de escribir nada: si hace falta un post y no hay cola, no
  // se crea ni siquiera el slot de otra red (la respuesta es un 503 entero).
  const decided = outcomes.map((outcome) =>
    outcome.kind === "slot"
      ? { outcome, conversion: planSlotConversion(outcome.slot.network, active) }
      : { outcome, conversion: null },
  );
  if (
    input.queue === undefined &&
    decided.some((d) => d.conversion?.kind === "convert")
  ) {
    return { kind: "no_queue" };
  }

  const posts: PostRowForCalendar[] = [];
  const slots: PlannedSlotRow[] = [];
  const skipped: {
    network: StrategyNetwork;
    reason: "already_scheduled" | "no_free_slot";
  }[] = [];

  for (const { outcome, conversion } of decided) {
    if (outcome.kind === "skipped") {
      skipped.push({ network: outcome.network, reason: outcome.reason });
      continue;
    }
    const at = new Date(outcome.slot.atMs);
    if (conversion?.kind === "convert" && input.queue !== undefined) {
      posts.push(
        ...(await createPost(tx, {
          companyId,
          contentId,
          platform: conversion.platform,
          connectionId: conversion.connectionId,
          at,
          nowMs,
          queue: input.queue,
          xAllowLinks: input.xAllowLinks === true,
        })),
      );
      continue;
    }
    slots.push(
      await plannedSlotRepository.create(tx, scope, {
        contentId,
        network: outcome.slot.network,
        scheduledAtUtc: at,
      }),
    );
  }
  return { kind: "scheduled", posts, slots, skipped };
}

async function scheduleOptions(
  tx: Executor,
  input: AutoscheduleInput,
): Promise<ScheduleOptions | null> {
  const { companyId, contentId, nowMs } = input;
  const scope = { companyId };
  const content = await contentRepository.findById(tx, scope, contentId);
  if (content === null) return null;

  const strategy = await loadStrategy(tx, companyId);
  const occupied = await occupiedAcrossBrands(tx, input);
  const already = new Set<string>([
    ...(await postCalendar.livePlatformsOf(tx, scope, contentId)),
    ...(await plannedSlotRepository.plannedNetworksOf(tx, scope, contentId)),
  ]);
  // Sin `alreadyScheduled`: la sugerencia es "cuándo iría", aunque ya haya uno.
  const outcomes = planAutoSlots({
    strategy: toSlotStrategy(strategy),
    brandId: companyId,
    contentId,
    nowMs,
    occupied,
  });
  const suggested = new Map<string, number>();
  for (const outcome of outcomes) {
    if (outcome.kind === "slot") suggested.set(outcome.slot.network, outcome.slot.atMs);
  }
  const inStrategy = new Set<string>(
    strategy.networks.filter((n) => effectiveDailyQuota(n) > 0).map((n) => n.network),
  );

  const connections = await connectionRepository.list(tx, scope, {
    limit: 100,
    filter: { status: { eq: "active" } },
  });
  const captions = deriveCaptionsForAll(
    SCHEDULABLE_PLATFORMS,
    { generatedText: content.generatedText },
    { allowXLinks: input.xAllowLinks === true },
  );

  const networks = SCHEDULABLE_PLATFORMS.map((network) => ({
    network,
    inStrategy: inStrategy.has(network),
    suggestedAtUtc: suggested.get(network) ?? null,
    alreadyScheduled: already.has(network),
    connections: connections.items
      .filter((c) => c.platform === network)
      .map((c) => ({
        connectionId:
          c.id as ScheduleOptions["networks"][number]["connections"][number]["connectionId"],
        username: c.platformUsername,
      })),
    caption: captions[network]?.caption ?? null,
    description: captions[network]?.description ?? null,
  }));
  const times = [...suggested.values()];
  return {
    contentId: content.id as ScheduleOptions["contentId"],
    contentType: content.type,
    contentStatus: content.status,
    timezone: strategy.timezone,
    suggestedAtUtc: times.length === 0 ? null : Math.min(...times),
    xAllowLinks: input.xAllowLinks === true,
    networks,
  };
}

/**
 * Lo ocupado desde ayer hasta el final del horizonte, en todas las marcas.
 * La propia se lee en la transacción del auto-slot; las otras, cada una en la
 * suya y con su scope.
 */
async function occupiedAcrossBrands(
  tx: Executor,
  input: AutoscheduleInput,
): Promise<OccupiedSlot[]> {
  const fromMs = input.nowMs - DAY_MS;
  const toMs = input.nowMs + (AUTO_SLOT_HORIZON_DAYS + 2) * DAY_MS;
  const out: OccupiedSlot[] = [];

  const read = async (exec: Executor, brandId: string): Promise<void> => {
    const scope = { companyId: brandId };
    const range = { fromMs, toMs, limit: 5000 };
    const posts = await postCalendar.listInRange(exec, scope, {
      ...range,
      excludeStatuses: [...CALENDAR_IDLE_POST_STATUSES],
    });
    for (const post of posts) {
      out.push({
        brandId,
        network: post.platform,
        atMs: (post.postedAt ?? post.scheduledAtUtc).getTime(),
      });
    }
    const slots = await plannedSlotRepository.listInRange(exec, scope, range);
    for (const slot of slots) {
      out.push({ brandId, network: slot.network, atMs: slot.scheduledAtUtc.getTime() });
    }
  };

  await read(tx, input.companyId);
  for (const brand of input.context.brands) {
    if (brand.id === input.companyId) continue;
    await runScoped(input.db, brand.id, input.appRole, (other) => read(other, brand.id));
  }
  return out;
}

const SCHEDULABLE_PLATFORMS = [
  "tiktok",
  "instagram",
  "youtube",
  "linkedin", // PU-LATER-002
  "reddit",
  "x",
  "threads",
  "facebook",
] as const;
type SchedulablePlatform = (typeof SCHEDULABLE_PLATFORMS)[number];

function isSchedulable(platform: string): platform is SchedulablePlatform {
  return (SCHEDULABLE_PLATFORMS as readonly string[]).includes(platform);
}

/**
 * Un target de `schedule` sin copy. `caption: null` no es «vacía»: sprint 7,
 * `schedulePostsInTx` la deriva de la copy de la pieza (`captionFieldsFor`).
 */
function bareTarget(platform: SchedulablePlatform, connectionId: string): FlatTarget {
  return {
    platform,
    connectionId,
    warmedAccountId: null,
    caption: null,
    description: null,
    discloseAsAds: null,
    aiContentDisclaimer: null,
    instagramSlideshowFormat: null,
    postingMode: null,
    privacyLevel: null,
    tiktokSoundId: null,
    tiktokSoundMode: null,
  };
}

async function createPost(
  tx: Executor,
  input: {
    readonly companyId: string;
    readonly contentId: string;
    readonly platform: string;
    readonly connectionId: string;
    readonly at: Date;
    readonly nowMs: number;
    readonly queue: Queue;
    readonly xAllowLinks?: boolean;
  },
): Promise<PostRowForCalendar[]> {
  if (!isSchedulable(input.platform)) {
    // `planSlotConversion` sólo convierte redes de `POSTABLE_NETWORKS`, que es un
    // subconjunto de éstas. Si llega otra, cambió una de las dos listas.
    throw new Error(`La red ${input.platform} no se puede programar como post.`);
  }
  const result = await schedulePostsInTx(tx, {
    companyId: input.companyId,
    contentId: input.contentId,
    targets: [bareTarget(input.platform, input.connectionId)],
    scheduledAt: input.at,
    nowMs: input.nowMs,
    queue: input.queue,
    xAllowLinks: input.xAllowLinks === true,
  });
  if (result.kind === "created") return result.rows;
  if (result.kind === "rejected") {
    const { status, code, message, details } = result.rejection;
    throw new ScheduleRejected(status, code, message, details);
  }
  // `content_missing` / `content_failed` ya se miraron antes de llegar acá.
  throw new ScheduleRejected(
    409,
    "unsupported_content_state",
    "This content can't be scheduled.",
  );
}

/**
 * Slot planificado → `Post`, **para el sprint 3** (cuando la marca tenga la
 * conexión). Hoy no la llama ninguna ruta; está probada en
 * `test/calendar.int.test.ts`.
 *
 * Corre en la transacción de quien llama, con el scope de la marca del slot.
 * Si la marca todavía no puede publicar en esa red (sin conexión, con varias,
 * o una red que no es post todavía), devuelve `wait` y no toca nada. Si la hora
 * del slot ya pasó, el post no se crea (`past`): publicarlo "ya" sería un
 * publicar-ahora que nadie pidió, mismo motivo que en `schedule`.
 */
export async function convertPlannedSlot(
  tx: Executor,
  input: {
    readonly companyId: string;
    readonly slotId: string;
    readonly nowMs: number;
    readonly queue: Queue;
    readonly xAllowLinks?: boolean;
  },
): Promise<
  | { readonly kind: "converted"; readonly post: PostRowForCalendar }
  | { readonly kind: "wait"; readonly reason: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "past" }
> {
  const scope = { companyId: input.companyId };
  const slot = await plannedSlotRepository.findById(tx, scope, input.slotId);
  if (slot === null || slot.status !== "planned") return { kind: "not_found" };
  if (slot.scheduledAtUtc.getTime() <= input.nowMs) return { kind: "past" };

  const connections = await connectionRepository.list(tx, scope, {
    limit: 100,
    filter: { status: { eq: "active" } },
  });
  const plan = planSlotConversion(
    slot.network,
    connections.items.map((c) => ({ id: c.id, platform: c.platform })),
  );
  if (plan.kind === "wait") return { kind: "wait", reason: plan.reason };

  const [post] = await createPost(tx, {
    companyId: input.companyId,
    contentId: slot.contentId,
    platform: plan.platform,
    connectionId: plan.connectionId,
    at: slot.scheduledAtUtc,
    nowMs: input.nowMs,
    queue: input.queue,
    xAllowLinks: input.xAllowLinks === true,
  });
  if (post === undefined) throw new Error("schedulePostsInTx no devolvió el post.");
  const closed = await plannedSlotRepository.markConverted(tx, scope, slot.id, post.id);
  if (closed === null) {
    // Otra conversión lo cerró entre la lectura y acá. Abortar deshace el post.
    throw new Error(`El slot ${slot.id} ya no estaba planificado.`);
  }
  return { kind: "converted", post };
}

// ───────────────────────────────────────────────────────────────────────────
// Mover
// ───────────────────────────────────────────────────────────────────────────

function movableOf(post: PostRowForCalendar) {
  return {
    id: post.id,
    status: post.status,
    accountType: post.accountType,
    tiktokProcessingDelayed: post.tiktokProcessingDelayed,
    cancellationPending: post.cancellationPending,
    scheduledFor: post.scheduledAtUtc,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Lectura del calendario
// ───────────────────────────────────────────────────────────────────────────

type ContentRow = NonNullable<Awaited<ReturnType<typeof contentRepository.findById>>>;

async function readBrandCalendar(
  tx: Executor,
  brand: Brand,
  fromMs: number,
  toMs: number,
): Promise<{
  items: CalendarItem[];
  counts: CalendarCounts;
  truncated: boolean;
  timezone: string;
}> {
  const scope = { companyId: brand.id };
  const limit = CALENDAR_ITEMS_PER_BRAND_MAX + 1;
  // `CANCELLED` y `DELETED` no se dibujan: mover un post deja uno cancelado, y
  // verlo al lado del nuevo es ruido. `FAILED` sí: es algo que mirar.
  const posts = await postCalendar.listInRange(tx, scope, {
    fromMs,
    toMs,
    limit,
    excludeStatuses: ["CANCELLED", "DELETED"],
  });
  const slots = await plannedSlotRepository.listInRange(tx, scope, {
    fromMs,
    toMs,
    limit,
  });
  const truncated = posts.length >= limit || slots.length >= limit;

  const contentIds = [...new Set([...posts, ...slots].map((row) => row.contentId))];
  const contents = new Map<string, ContentRow>();
  for (let i = 0; i < contentIds.length; i += 100) {
    const chunk = contentIds.slice(i, i + 100);
    const page = await contentRepository.list(tx, scope, {
      limit: 100,
      includeDeleted: true,
      filter: { id: { in: chunk } },
    });
    for (const row of page.items) contents.set(row.id, row);
  }

  const items = [
    ...posts
      .slice(0, CALENDAR_ITEMS_PER_BRAND_MAX)
      .map((post) => postItem(post, brand, contents.get(post.contentId) ?? null)),
    ...slots
      .slice(0, CALENDAR_ITEMS_PER_BRAND_MAX)
      .map((slot) => slotItem(slot, brand, contents.get(slot.contentId) ?? null)),
  ];

  const count = (statuses: ("POSTED" | "IN_USER_INBOX" | "SCHEDULED" | "BUILDING")[]) =>
    postRepository.count(tx, scope, { filter: { status: { in: statuses } } });
  const posted = await count(["POSTED"]);
  const inbox = await count(["IN_USER_INBOX"]);
  const scheduledPosts = await count(["SCHEDULED", "BUILDING"]);
  const plannedCount = await plannedSlotRepository.count(tx, scope, {
    filter: { status: { eq: "planned" } },
  });
  const company = await companyRepository.load(tx, scope);

  return {
    items,
    counts: { posted, inbox, scheduled: scheduledPosts + plannedCount },
    truncated,
    timezone: company?.timezone ?? "UTC",
  };
}

function contentFields(
  content: ContentRow | null,
): Pick<CalendarItem, "contentType" | "thumbnailUrl"> {
  if (content === null) return {};
  const thumbnail = content.thumbnailUrl;
  return {
    contentType: content.type,
    ...(thumbnail !== null && isUrl(thumbnail) ? { thumbnailUrl: thumbnail } : {}),
  };
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function postItem(
  post: PostRowForCalendar,
  brand: Brand,
  content: ContentRow | null,
): CalendarItem {
  return {
    kind: "post",
    id: post.id,
    brandId: brand.id,
    brandName: brand.name,
    contentId: post.contentId as CalendarItem["contentId"],
    ...contentFields(content),
    network: post.platform as CalendarNetwork,
    status: post.status,
    at: (post.postedAt ?? post.scheduledAtUtc).getTime(),
    movable: isMovablePost(movableOf(post)),
    // El motivo sólo tiene sentido en un fallido: un post reprogramado después
    // de un fallo puede arrastrar el `errorCode` viejo y no hay que mostrarlo.
    ...(post.status === "FAILED" && post.errorCode !== null
      ? { errorCode: post.errorCode }
      : {}),
    ...(post.status === "FAILED" && post.errorMessage !== null
      ? { errorMessage: post.errorMessage }
      : {}),
    ...(post.postUrl !== null && isUrl(post.postUrl) ? { postUrl: post.postUrl } : {}),
  };
}

function slotItem(
  slot: PlannedSlotRow,
  brand: Brand,
  content: ContentRow | null,
): CalendarItem {
  return {
    kind: "slot",
    id: slot.id,
    brandId: brand.id,
    brandName: brand.name,
    contentId: slot.contentId as CalendarItem["contentId"],
    ...contentFields(content),
    network: slot.network,
    status: "PLANNED",
    at: slot.scheduledAtUtc.getTime(),
    movable: slot.status === "planned",
  };
}

export function toPlannedSlot(slot: PlannedSlotRow): PlannedSlot {
  return {
    _id: slot.id,
    contentId: slot.contentId as PlannedSlot["contentId"],
    network: slot.network,
    scheduledAtUtc: slot.scheduledAtUtc.getTime(),
    status: slot.status,
    ...(slot.postId === null ? {} : { postId: slot.postId }),
  };
}
