/**
 * Automations (campañas multi-semana) — `FR-150`, `MOD-015` (`F-210…F-220`),
 * `DATA-021`, `DATA-022`, `AI-012`, `P3-AUTO-001…013`.
 *
 * El dominio (máquinas de estados, reglas duras, reparto de tipos, gates) está
 * en `@fastgram/core` (`automations/`); la generación, en el worker
 * (`apps/worker/src/automations/`). Esto es la capa HTTP: scope por marca
 * (`X-Fastgram-Workspace`), 404 para lo ajeno, y las transiciones con la fila
 * bloqueada.
 *
 * ## El camino de una campaña
 *
 * ```
 *   POST /automations               DRAFT, prefsSnapshot congelado (F-212)
 *   POST …/generate                 DRAFT → GENERATING: la grilla de slots y el job
 *   (worker)                        slots READY / FAILED_GEN → REVIEW
 *   PATCH/DELETE …/slots/:id, reroll   revisión humana (F-214/F-215)
 *   GET …/launch-validation         todos los gates (F-216)
 *   POST …/launch                   REVIEW → BUILDING: piezas + builds + slots planificados
 *   (worker, build-schedule)        BUILDING → ACTIVE → COMPLETED
 *   POST …/cancel                   revoca lo pendiente, lo publicado queda (F-219)
 * ```
 *
 * ## "Reserva y cobra" en uso personal (`D-06`)
 *
 * El launch **registra** un content save por pieza en el ledger (el uso se
 * ve), con la misma `QuotaPolicy` que `POST /content`: en `personal` no corta
 * nunca; en `standard` el gate `content_budget` lo avisa antes y
 * `consumeContentSave` lo hace cumplir. No hay "post slots" que cobrar: son de
 * las cuentas warmed, que no existen acá.
 *
 * ## Reservar = slots planificados
 *
 * Un launch no crea posts: crea la pieza (`BUILDING`, con su `content-build`) y
 * un **slot planificado** por destino a la hora del slot, con la conexión que
 * eligió la campaña (`0023`). El calendario los muestra en el acto, y el
 * barrido de publicación los convierte en posts —con la caption del slot—
 * cuando la pieza está `CREATED`; las guardas anti-bot deciden al publicar.
 * Es el camino que ya usa el piloto: no hay una tercera copia de "crear el
 * post y su job de publicación".
 */
import { randomUUID } from "node:crypto";

import {
  AUTOMATION_LIST_MAX,
  contentBuildPayloadSchema,
  createAutomationRequestSchema,
  rerollAutomationSlotRequestSchema,
  updateAutomationRequestSchema,
  updateAutomationSlotRequestSchema,
  type Automation,
  type AutomationSlot,
  type FastgramMode,
  type LaunchValidation,
} from "@fastgram/contracts";
import {
  AUTOMATION_BUILD_RECHECK_MS,
  AUTOMATION_PENDING_POST_STATUSES,
  AUTOMATION_REVOCABLE_POST_STATUSES,
  AutomationGenerationBlocked,
  DEFAULT_BLITZ_PREFERENCES,
  JOB_QUEUES,
  LAUNCH_MIN_LEAD_MS,
  accountProblems,
  applyTextEdit,
  assertGenerationAllowed,
  assertValidSchedulingConfig,
  assignContentTypes,
  automationBuildJobKey,
  automationCampaignJobKey,
  automationGenerationQuota,
  buildMediaBank,
  buildPrefsSnapshot,
  canDeleteAutomation,
  captionProblems,
  civilDateOf,
  civilKey,
  composeBlitzBuildPayload,
  contentMixOf,
  evaluateLaunchGates,
  formatsWithMedia,
  generatedTextOf,
  isBlitzContentType,
  isConfigEditable,
  parseAutomationAccounts,
  parseCivilDate,
  parseLaunchValidation,
  parsePrefsSnapshot,
  parseSuggestionData,
  patchPrefsSnapshot,
  planCampaignSchedule,
  platformsOf,
  rebindMediaUrls,
  reconcileAngleWeights,
  rerollTypeProblem,
  savesRemaining,
  selectionMediaIds,
  slotStatusOnCancel,
  zonedWallTimeToUtc,
  type AutomationAccount,
  type AutomationPrefsSnapshot,
  type BlitzPreferences,
  type ContentBuildJob,
  type TextStylePreset,
} from "@fastgram/core";
import {
  CALENDAR_IDLE_POST_STATUSES,
  automationStore,
  blitzPreferencesRepository,
  brandStrategyRepository,
  connectionAccountRepository,
  contentRepository,
  findLiveMedia,
  listPlanningMedia,
  lockLiveMedia,
  plannedSlotRepository,
  postCalendar,
  type AutomationRow,
  type AutomationSlotRow,
  type CampaignPostRow,
  type Transaction,
} from "@fastgram/db";
import type { Clock, Queue } from "@fastgram/ports";
import { z } from "zod";

import { ApiRejection } from "../../http/errors.js";
import {
  consumeContentSave,
  lockLedger,
  quotaPolicyFor,
  type QuotaPolicy,
} from "../../support/quota.js";
import { activeAngleIdsOf, listAllAngles } from "./blitz.js";
import { crossTenant, data } from "./shared.js";
import { loadStrategy } from "./strategy.js";
import type { ZodApp } from "../../server/types.js";

const automationParams = z.object({ automationId: z.string().min(1) });
const slotParams = z.object({
  automationId: z.string().min(1),
  slotId: z.string().min(1),
});

const DAY_MS = 86_400_000;
const CONTENT_TEXT_MAX = 2_000;

// ───────────────────────────────────────────────────────────────────────────
// Vistas
// ───────────────────────────────────────────────────────────────────────────

const ms = (d: Date | null): number | null => (d === null ? null : d.getTime());

function emptyPrefs(): AutomationPrefsSnapshot {
  return {
    ...DEFAULT_BLITZ_PREFERENCES,
    angleWeights: {},
    textStyleWeights: {},
    topics: [],
  };
}

export function toAutomation(
  row: AutomationRow,
  counts: Partial<Record<string, number>>,
  posts?: readonly CampaignPostRow[],
): Automation {
  const prefs = parsePrefsSnapshot(row.prefsSnapshot) ?? emptyPrefs();
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const [status, n] of Object.entries(counts)) {
    if (n === undefined) continue;
    byStatus[status] = n;
    total += n;
  }
  const published = (posts ?? []).filter(
    (p) => p.status === "POSTED" || p.status === "IN_USER_INBOX",
  );
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    accounts: parseAutomationAccounts(row.accounts) ?? [],
    perAccountPerDay: row.perAccountPerDay,
    durationWeeks: row.durationWeeks,
    startDate: civilKey(civilDateOf(row.startDateUtc.getTime(), row.timezone)),
    startDateUtc: row.startDateUtc.getTime(),
    timezone: row.timezone,
    postingTimes: row.postingTimes ?? null,
    postingMode: row.postingMode ?? null,
    youtubePrivacyStatus:
      row.youtubePrivacyStatus === "public" ||
      row.youtubePrivacyStatus === "private" ||
      row.youtubePrivacyStatus === "unlisted"
        ? row.youtubePrivacyStatus
        : null,
    discloseAsAds: row.discloseAsAds,
    aiContentDisclaimer: row.aiContentDisclaimer,
    prefsSnapshot: {
      slideshowWeight: prefs.slideshowWeight,
      wallOfTextWeight: prefs.wallOfTextWeight,
      greenScreenWeight: prefs.greenScreenWeight,
      videoHookWeight: prefs.videoHookWeight,
      remixPercentage: prefs.remixPercentage,
      ownMediaPercentage: prefs.ownMediaPercentage,
      mentionBusinessPercentage: prefs.mentionBusinessPercentage,
      influencerChance: prefs.influencerChance,
      angleWeights: { ...prefs.angleWeights },
      textStyleWeights: { ...prefs.textStyleWeights },
      topics: [...prefs.topics],
    },
    generationQuota: row.generationQuota,
    generationQuotaUsed: row.generationQuotaUsed,
    failureCode: row.failureCode,
    launchValidation: parseLaunchValidation(
      row.launchValidation,
    ) as LaunchValidation | null,
    progress: { total, byStatus },
    ...(posts === undefined
      ? {}
      : {
          stats: {
            posts: posts.length,
            published: published.length,
            pending: posts.filter((p) =>
              (AUTOMATION_PENDING_POST_STATUSES as readonly string[]).includes(p.status),
            ).length,
            failed: posts.filter((p) => p.status === "FAILED").length,
            views: published.reduce((s, p) => s + p.views, 0),
            likes: published.reduce((s, p) => s + p.likes, 0),
            comments: published.reduce((s, p) => s + p.comments, 0),
          },
        }),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    launchedAt: ms(row.launchedAt),
    cancelledAt: ms(row.cancelledAt),
    completedAt: ms(row.completedAt),
  };
}

function previewOf(
  slot: AutomationSlotRow,
  live: ReadonlyMap<string, string>,
): AutomationSlot["preview"] {
  if (!isBlitzContentType(slot.contentType)) return null;
  const parsed = parseSuggestionData(slot.suggestionData, slot.contentType);
  if (!parsed.ok) return null;
  const media = parsed.data.buildPlan.media;
  const pick = (id: string, kind: "image" | "video") => {
    const url = live.get(id);
    return url === undefined ? null : { url, kind };
  };
  switch (media.format) {
    case "slideshow":
      return media.slides[0] === undefined
        ? null
        : pick(media.slides[0].mediaId, "image");
    case "green-screen":
      return pick(media.image.mediaId, "image");
    case "wall-of-text":
      return pick(media.video.mediaId, "video");
    case "video-hook":
      return pick(media.hookVideo.mediaId, "video");
  }
}

function slotMediaIds(slot: AutomationSlotRow): readonly string[] {
  if (!isBlitzContentType(slot.contentType)) return [];
  const parsed = parseSuggestionData(slot.suggestionData, slot.contentType);
  return parsed.ok ? selectionMediaIds(parsed.data.buildPlan.media) : [];
}

function captionsOf(raw: unknown): AutomationSlot["captionsByPlatform"] {
  const out: AutomationSlot["captionsByPlatform"] = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [platform, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    if (typeof v["caption"] !== "string") continue;
    out[platform] =
      typeof v["description"] === "string"
        ? { caption: v["caption"], description: v["description"] }
        : { caption: v["caption"] };
  }
  return out;
}

export function toSlot(
  slot: AutomationSlotRow,
  posts: readonly CampaignPostRow[],
  live: ReadonlyMap<string, string>,
): AutomationSlot {
  const contentType = isBlitzContentType(slot.contentType)
    ? slot.contentType
    : "slideshow";
  const parsed = parseSuggestionData(slot.suggestionData, contentType);
  return {
    id: slot.id,
    index: slot.slotIndex,
    status: slot.status,
    contentType,
    scheduledAt: ms(slot.scheduledAtUtc),
    generatedText: slot.generatedText,
    texts: parsed.ok ? [...parsed.data.buildPlan.texts] : [],
    aiExplanation:
      parsed.ok && parsed.data.aiExplanation !== "" ? parsed.data.aiExplanation : null,
    topic: parsed.ok ? parsed.data.topic : null,
    captionsByPlatform: captionsOf(slot.captionsByPlatform),
    failureReason: slot.failureReason,
    errorCode: slot.errorCode,
    contentId: slot.contentId,
    preview: previewOf(slot, live),
    generationAttempts: slot.generationAttempts,
    posts: posts
      .filter((p) => p.automationSlotId === slot.id)
      .map((p) => ({
        id: p.id,
        platform: p.platform,
        status: p.status,
        scheduledAt: p.scheduledAtUtc.getTime(),
        postedAt: ms(p.postedAt),
        postUrl: p.postUrl,
        views: p.views,
        likes: p.likes,
        comments: p.comments,
        errorCode: p.errorCode,
      })),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Lecturas compartidas
// ───────────────────────────────────────────────────────────────────────────

/** Las preferencias de Blitz de la marca, con defaults sintetizados (`DATA-006`). */
async function brandPreferences(
  tx: Transaction,
  companyId: string,
): Promise<BlitzPreferences> {
  const row = await blitzPreferencesRepository.findById(tx, { companyId }, companyId);
  if (row === null) {
    // Mismo criterio que el refill (`readRefillSubject`): sin fila, los pesos
    // de ángulo que el reconcile habría escrito, no un mapa vacío.
    const active = activeAngleIdsOf(await listAllAngles(tx, companyId));
    return {
      ...DEFAULT_BLITZ_PREFERENCES,
      angleWeights: reconcileAngleWeights(active),
      textStyleWeights: {},
    };
  }
  return {
    slideshowWeight: row.slideshowWeight,
    wallOfTextWeight: row.wallOfTextWeight,
    greenScreenWeight: row.greenScreenWeight,
    videoHookWeight: row.videoHookWeight,
    remixPercentage: row.remixPercentage,
    ownMediaPercentage: row.ownMediaPercentage,
    mentionBusinessPercentage: row.mentionBusinessPercentage,
    influencerChance: row.influencerChance,
    smartTextPositioning: row.smartTextPositioning,
    genderFilter: row.genderFilter,
    angleWeights: (row.angleWeights ?? {}) as Readonly<Record<string, number>>,
    textStyleWeights: (row.textStyleWeights ?? {}) as Readonly<
      Record<TextStylePreset, number>
    >,
  };
}

async function connectionFacts(tx: Transaction, companyId: string) {
  const rows = await connectionAccountRepository.list(tx, { companyId });
  return rows.map((c) => ({
    id: c.id,
    platform: c.platform,
    active: c.status === "active",
  }));
}

/**
 * Los destinos, contra las conexiones de la marca. Una conexión desconectada
 * se puede guardar (se reconecta antes del launch, y el gate lo dice); todo lo
 * demás es un `400`.
 */
async function assertAccounts(
  tx: Transaction,
  companyId: string,
  accounts: readonly AutomationAccount[],
): Promise<void> {
  const problems = accountProblems(accounts, await connectionFacts(tx, companyId)).filter(
    (p) => p.kind !== "connection_inactive",
  );
  if (problems.length > 0) {
    throw new ApiRejection(
      400,
      "bad_request",
      "Some accounts can't be used in this campaign.",
      {
        problems: problems.map((p) => ({ platform: p.platform, reason: p.kind })),
      },
    );
  }
}

function startDateUtcOf(startDate: string, timezone: string): Date {
  const civil = parseCivilDate(startDate);
  if (civil === null) {
    throw new ApiRejection(
      400,
      "bad_request",
      "startDate must be a real day (YYYY-MM-DD).",
      {
        field: "startDate",
      },
    );
  }
  return new Date(zonedWallTimeToUtc(civil, 0, timezone));
}

function accountsOf(row: AutomationRow): AutomationAccount[] {
  return parseAutomationAccounts(row.accounts) ?? [];
}

function prefsOf(row: AutomationRow): AutomationPrefsSnapshot {
  const prefs = parsePrefsSnapshot(row.prefsSnapshot);
  if (prefs === null) {
    throw new ApiRejection(
      409,
      "conflict",
      "This campaign's preferences are unreadable.",
      {
        reason: "invalid_prefs_snapshot",
      },
    );
  }
  return prefs;
}

async function lockOwn(tx: Transaction, companyId: string, automationId: string) {
  const row = await automationStore.lock(tx, { companyId }, automationId);
  if (row === null) throw crossTenant("automation", automationId, companyId);
  return row;
}

async function lockOwnSlot(
  tx: Transaction,
  companyId: string,
  automationId: string,
  slotId: string,
) {
  const slot = await automationStore.lockSlot(tx, { companyId }, automationId, slotId);
  if (slot === null) throw crossTenant("automation slot", slotId, companyId);
  return slot;
}

function conflict(
  message: string,
  reason: string,
  extra: Record<string, unknown> = {},
): ApiRejection {
  return new ApiRejection(409, "conflict", message, { reason, ...extra });
}

function requireReview(row: AutomationRow): void {
  if (row.status !== "REVIEW")
    throw conflict("The campaign isn't in review.", "not_in_review", {
      status: row.status,
    });
}

async function slotView(
  tx: Transaction,
  companyId: string,
  slot: AutomationSlotRow,
): Promise<AutomationSlot> {
  const scope = { companyId };
  const posts = await automationStore.postsOfSlots(tx, scope, [slot.id]);
  const live = new Map(
    (await findLiveMedia(tx, scope, [...slotMediaIds(slot)])).map((m) => [
      m.mediaId,
      m.url,
    ]),
  );
  return toSlot(slot, posts, live);
}

async function automationView(
  tx: Transaction,
  companyId: string,
  row: AutomationRow,
  withStats: boolean,
): Promise<Automation> {
  const scope = { companyId };
  const counts =
    (await automationStore.slotCounts(tx, scope, [row.id])).get(row.id) ?? {};
  if (!withStats) return toAutomation(row, counts);
  const slots = await automationStore.listSlots(tx, scope, row.id);
  const posts = await automationStore.postsOfSlots(
    tx,
    scope,
    slots.map((s) => s.id),
  );
  return toAutomation(row, counts, posts);
}

// ───────────────────────────────────────────────────────────────────────────
// La pieza de un slot (launch y "Edit post")
// ───────────────────────────────────────────────────────────────────────────

type MaterializeOutcome =
  | { readonly kind: "created"; readonly contentId: string }
  | { readonly kind: "media_unavailable" }
  | { readonly kind: "unbuildable"; readonly reason: string };

/**
 * Crea la pieza del slot: `BUILDING`, el `buildPayload` de Blitz con la media
 * **viva** (`lockLiveMedia`, retenida hasta el commit), el save registrado y el
 * `content-build` encolado **en la misma transacción** (ADR-005). Es
 * `POST /blitz` sin la sugerencia: mismo `composeBlitzBuildPayload`, mismo
 * schema del contrato, mismo job.
 */
async function materializeSlotContent(
  tx: Transaction,
  args: {
    readonly companyId: string;
    readonly slot: AutomationSlotRow;
    readonly clock: Clock;
    readonly queue: Queue;
    readonly policy: QuotaPolicy;
  },
): Promise<MaterializeOutcome> {
  const { companyId, slot } = args;
  const scope = { companyId };
  if (!isBlitzContentType(slot.contentType))
    return { kind: "unbuildable", reason: "content_type" };
  const parsed = parseSuggestionData(slot.suggestionData, slot.contentType);
  if (!parsed.ok) return { kind: "unbuildable", reason: parsed.reason };
  const plan = parsed.data.buildPlan;
  const ids = [...new Set(selectionMediaIds(plan.media))];
  const live = new Map(
    (await lockLiveMedia(tx, scope, ids)).map((m) => [m.mediaId, m.url]),
  );
  if (ids.some((id) => !live.has(id))) return { kind: "media_unavailable" };

  let payload: unknown;
  try {
    payload = composeBlitzBuildPayload(rebindMediaUrls(plan, live), {
      textStylePresetId: parsed.data.textStylePresetId,
    });
  } catch (error: unknown) {
    return {
      kind: "unbuildable",
      reason: error instanceof Error ? error.message : "compose",
    };
  }
  const checked = contentBuildPayloadSchema.safeParse(payload);
  if (!checked.success) return { kind: "unbuildable", reason: "payload_schema" };

  // Registrar (personal) o cobrar (standard) el save: dentro de la transacción
  // y antes de encolar, como `POST /content`.
  const save = await consumeContentSave(tx, scope, args.clock, args.policy);
  const text = generatedTextOf(plan.texts).slice(0, CONTENT_TEXT_MAX);
  const content = await contentRepository.create(tx, scope, {
    id: randomUUID(),
    type: slot.contentType,
    status: "BUILDING",
    generatedText: text === "" ? null : text,
    revision: 1,
    buildPayload: checked.data,
    saveBucket: save.bucket,
    savePeriod: save.period,
  });
  const job: ContentBuildJob = {
    companyId,
    contentId: content.id,
    contentType: slot.contentType,
    revision: content.revision,
    reason: "blitz",
    ...(parsed.data.influencerId === null
      ? {}
      : { influencerId: parsed.data.influencerId }),
  };
  await args.queue.enqueue<ContentBuildJob>({
    queue: JOB_QUEUES.contentBuild,
    payload: job,
    options: {
      transaction: tx,
      singletonKey: `${JOB_QUEUES.contentBuild}:${content.id}`,
      retryLimit: 2,
      retryBackoff: true,
    },
  });
  await automationStore.updateSlot(tx, scope, slot.id, { contentId: content.id });
  return { kind: "created", contentId: content.id };
}

// ───────────────────────────────────────────────────────────────────────────
// launchValidation
// ───────────────────────────────────────────────────────────────────────────

async function computeLaunchValidation(
  tx: Transaction,
  args: {
    readonly companyId: string;
    readonly row: AutomationRow;
    readonly nowMs: number;
    readonly clock: Clock;
    readonly policy: QuotaPolicy;
  },
): Promise<LaunchValidation> {
  const { companyId, row, nowMs } = args;
  const scope = { companyId };
  const slots = await automationStore.listSlots(tx, scope, row.id);
  const accounts = accountsOf(row);
  const strategy = await loadStrategy(tx, companyId);
  const dailyCaps: Record<string, number> = {};
  for (const n of strategy.networks) dailyCaps[n.network] = n.dailyCap;

  const times = slots
    .map((s) => s.scheduledAtUtc?.getTime())
    .filter((t): t is number => t !== undefined);
  const occupied: { network: string; atMs: number }[] = [];
  if (times.length > 0) {
    const range = {
      fromMs: Math.min(...times) - DAY_MS,
      toMs: Math.max(...times) + DAY_MS,
      limit: 5000,
    };
    const ownSlotIds = new Set(slots.map((s) => s.id));
    for (const p of await plannedSlotRepository.listInRange(tx, scope, range)) {
      if (p.automationSlotId !== null && ownSlotIds.has(p.automationSlotId)) continue;
      occupied.push({ network: p.network, atMs: p.scheduledAtUtc.getTime() });
    }
    const posts = await postCalendar.listInRange(tx, scope, {
      ...range,
      excludeStatuses: [...CALENDAR_IDLE_POST_STATUSES],
    });
    for (const p of posts) {
      if (p.automationSlotId !== null && ownSlotIds.has(p.automationSlotId)) continue;
      occupied.push({
        network: p.platform,
        atMs: (p.postedAt ?? p.scheduledAtUtc).getTime(),
      });
    }
  }

  let saves: { policy: "unlimited" } | { policy: "enforced"; remaining: number | null } =
    {
      policy: "unlimited",
    };
  if (args.policy === "enforced") {
    const locked = await lockLedger(tx, scope, args.clock, "enforced");
    saves = {
      policy: "enforced",
      remaining: savesRemaining({
        plan: locked.plan,
        includedUsed: locked.row.contentSavesUsed,
        purchasedRemaining: locked.row.contentSavesPurchased,
        overageUsed: locked.row.overageUnits,
        overageEnabled: locked.company.apiOverageEnabled,
        resetAt: new Date(nowMs),
      }),
    };
  }

  const validation = evaluateLaunchGates({
    status: row.status,
    slots: slots.flatMap((s) =>
      isBlitzContentType(s.contentType)
        ? [
            {
              id: s.id,
              status: s.status,
              contentType: s.contentType,
              scheduledAtMs: s.scheduledAtUtc?.getTime() ?? null,
            },
          ]
        : [],
    ),
    accounts,
    connections: await connectionFacts(tx, companyId),
    aiContentDisclaimer: row.aiContentDisclaimer,
    nowMs,
    brandTimezone: strategy.timezone,
    dailyCaps,
    occupied,
    saves,
  });
  const out: LaunchValidation = {
    ok: validation.ok,
    checkedAt: validation.checkedAt,
    gates: validation.gates.map((g) => ({ code: g.code, details: { ...g.details } })),
    summary: { ...validation.summary },
  };
  await automationStore.update(tx, scope, row.id, { launchValidation: out });
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Rutas
// ───────────────────────────────────────────────────────────────────────────

export function registerAutomationRoutes(app: ZodApp): void {
  const { clock, queue } = app.deps;
  const mode: FastgramMode = app.deps.mode ?? "standard";
  const policy = quotaPolicyFor(mode);

  const noQueue = () =>
    new ApiRejection(
      503,
      "service_unavailable",
      "Automations are temporarily unavailable.",
    );

  // ── GET /automations ──
  app.get("/automations", async (request) => {
    const companyId = request.auth.companyId;
    const scope = { companyId };
    const out = await request.tx(async (tx) => {
      const rows = await automationStore.list(tx, scope, { limit: AUTOMATION_LIST_MAX });
      const counts = await automationStore.slotCounts(
        tx,
        scope,
        rows.map((r) => r.id),
      );
      return rows.map((r) => toAutomation(r, counts.get(r.id) ?? {}));
    });
    return data(out);
  });

  // ── POST /automations ──
  app.post(
    "/automations",
    { schema: { body: createAutomationRequestSchema } },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const body = request.body;
      const created = await request.tx(async (tx) => {
        const scope = { companyId };
        const timezone =
          body.timezone ?? (await brandStrategyRepository.timezone(tx, scope)) ?? "UTC";
        const postingTimes = body.postingTimes ?? null;
        assertValidSchedulingConfig({
          perAccountPerDay: body.perAccountPerDay,
          durationWeeks: body.durationWeeks,
          timezone,
          postingTimes,
        });
        const accounts = body.accounts as AutomationAccount[];
        await assertAccounts(tx, companyId, accounts);
        // F-212: el snapshot se congela ACÁ. Después, cambiar las preferencias
        // de la marca no toca esta campaña.
        const prefs = buildPrefsSnapshot(
          await brandPreferences(tx, companyId),
          body.prefs ?? {},
        );
        const row = await automationStore.create(tx, scope, {
          name: body.name,
          status: "DRAFT",
          accounts,
          perAccountPerDay: body.perAccountPerDay,
          durationWeeks: body.durationWeeks,
          startDateUtc: startDateUtcOf(body.startDate, timezone),
          timezone,
          postingTimes: postingTimes === null ? null : [...postingTimes],
          // TikTok: al inbox por defecto (el usuario confirma en la app).
          postingMode: body.postingMode ?? "inbox",
          youtubePrivacyStatus: body.youtubePrivacyStatus ?? "public",
          discloseAsAds: body.discloseAsAds ?? false,
          aiContentDisclaimer: body.aiContentDisclaimer ?? false,
          prefsSnapshot: prefs,
        });
        return automationView(tx, companyId, row, false);
      });
      return reply.status(201).send(data(created));
    },
  );

  // ── GET /automations/:automationId ──
  app.get(
    "/automations/:automationId",
    { schema: { params: automationParams } },
    async (request) => {
      const companyId = request.auth.companyId;
      const { automationId } = request.params;
      const view = await request.tx(async (tx) => {
        const row = await automationStore.find(tx, { companyId }, automationId);
        if (row === null) throw crossTenant("automation", automationId, companyId);
        return automationView(tx, companyId, row, true);
      });
      return data(view);
    },
  );

  // ── PATCH /automations/:automationId ──
  app.patch(
    "/automations/:automationId",
    { schema: { params: automationParams, body: updateAutomationRequestSchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const { automationId } = request.params;
      const body = request.body;
      const view = await request.tx(async (tx) => {
        const scope = { companyId };
        const row = await lockOwn(tx, companyId, automationId);
        const { name, ...config } = body;
        const touchesConfig = Object.values(config).some((v) => v !== undefined);
        if (touchesConfig && !isConfigEditable(row.status)) {
          throw conflict(
            "The configuration is locked once generation starts.",
            "config_locked",
            { status: row.status },
          );
        }
        const timezone = config.timezone ?? row.timezone;
        const perAccountPerDay = config.perAccountPerDay ?? row.perAccountPerDay;
        const durationWeeks = config.durationWeeks ?? row.durationWeeks;
        const postingTimes =
          config.postingTimes === undefined
            ? (row.postingTimes ?? null)
            : config.postingTimes;
        if (touchesConfig) {
          assertValidSchedulingConfig({
            perAccountPerDay,
            durationWeeks,
            timezone,
            postingTimes,
          });
        }
        if (config.accounts !== undefined)
          await assertAccounts(tx, companyId, config.accounts as AutomationAccount[]);
        const currentStart = civilKey(
          civilDateOf(row.startDateUtc.getTime(), row.timezone),
        );
        const startDateUtc =
          config.startDate !== undefined || config.timezone !== undefined
            ? startDateUtcOf(config.startDate ?? currentStart, timezone)
            : undefined;
        const updated = await automationStore.update(tx, scope, automationId, {
          ...(name === undefined ? {} : { name }),
          ...(config.accounts === undefined ? {} : { accounts: config.accounts }),
          ...(config.perAccountPerDay === undefined ? {} : { perAccountPerDay }),
          ...(config.durationWeeks === undefined ? {} : { durationWeeks }),
          ...(config.timezone === undefined ? {} : { timezone }),
          ...(startDateUtc === undefined ? {} : { startDateUtc }),
          ...(config.postingTimes === undefined
            ? {}
            : { postingTimes: postingTimes === null ? null : [...postingTimes] }),
          ...(config.postingMode === undefined
            ? {}
            : { postingMode: config.postingMode }),
          ...(config.youtubePrivacyStatus === undefined
            ? {}
            : { youtubePrivacyStatus: config.youtubePrivacyStatus }),
          ...(config.discloseAsAds === undefined
            ? {}
            : { discloseAsAds: config.discloseAsAds }),
          ...(config.aiContentDisclaimer === undefined
            ? {}
            : { aiContentDisclaimer: config.aiContentDisclaimer }),
          ...(config.prefs === undefined
            ? {}
            : { prefsSnapshot: patchPrefsSnapshot(prefsOf(row), config.prefs) }),
        });
        if (updated === null) throw crossTenant("automation", automationId, companyId);
        return automationView(tx, companyId, updated, true);
      });
      return data(view);
    },
  );

  // ── DELETE /automations/:automationId ──
  app.delete(
    "/automations/:automationId",
    { schema: { params: automationParams } },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const { automationId } = request.params;
      await request.tx(async (tx) => {
        const row = await lockOwn(tx, companyId, automationId);
        if (!canDeleteAutomation(row.status)) {
          throw conflict(
            "A campaign that is building or active can't be deleted. Cancel it first.",
            "automation_live",
            { status: row.status },
          );
        }
        await automationStore.delete(tx, { companyId }, automationId);
      });
      return reply.status(204).send();
    },
  );

  // ── POST /automations/:automationId/generate ──
  app.post(
    "/automations/:automationId/generate",
    { schema: { params: automationParams } },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const { automationId } = request.params;
      if (queue === undefined) throw noQueue();
      const view = await request.tx(async (tx) => {
        const scope = { companyId };
        const row = await lockOwn(tx, companyId, automationId);
        if (row.status !== "DRAFT") {
          throw conflict("This campaign was already generated.", "not_draft", {
            status: row.status,
          });
        }
        const prefs = prefsOf(row);
        const accounts = accountsOf(row);
        const bank = await listPlanningMedia(tx, scope);
        try {
          assertGenerationAllowed({
            accounts,
            prefs,
            availableFormats: formatsWithMedia(
              buildMediaBank(bank.media, bank.influencerSets),
            ),
          });
        } catch (error: unknown) {
          if (!(error instanceof AutomationGenerationBlocked)) throw error;
          if (
            error.code === "AUTOMATION_NO_CONTENT_TYPE_SELECTED" ||
            error.code === "AUTOMATION_VIDEO_HOOK_NEEDS_DEMO_VIDEO"
          ) {
            throw new ApiRejection(422, error.code, error.message);
          }
          throw new ApiRejection(400, "bad_request", error.message, {
            reason: error.code,
            ...error.details,
          });
        }
        await assertAccounts(tx, companyId, accounts);

        const strategy = await loadStrategy(tx, companyId);
        const planned = planCampaignSchedule({
          seed: row.id,
          startDate: civilDateOf(row.startDateUtc.getTime(), row.timezone),
          timezone: row.timezone,
          durationWeeks: row.durationWeeks,
          perAccountPerDay: row.perAccountPerDay,
          postingTimes: row.postingTimes ?? null,
          strategyWindows: strategy.windows,
          jitterMinutes: strategy.jitterMinutes,
          nowMs: clock.nowMs(),
        });
        if (planned.length === 0) {
          throw new ApiRejection(
            400,
            "bad_request",
            "Every posting time of this campaign is already in the past. Move the start date.",
            { reason: "schedule_in_past" },
          );
        }
        const types = assignContentTypes(planned.length, contentMixOf(prefs));
        await automationStore.insertSlots(
          tx,
          scope,
          automationId,
          planned.map((p, i) => ({
            slotIndex: p.index,
            status: "PENDING_GEN" as const,
            contentType: types[i] ?? "wall-of-text",
            scheduledAtUtc: new Date(p.atMs),
          })),
        );
        const updated = await automationStore.update(tx, scope, automationId, {
          status: "GENERATING",
          generationQuota: automationGenerationQuota(planned.length),
          failureCode: null,
        });
        await queue.enqueue({
          queue: JOB_QUEUES.automationGeneration,
          payload: { companyId, automationId },
          options: {
            transaction: tx,
            singletonKey: automationCampaignJobKey(
              JOB_QUEUES.automationGeneration,
              automationId,
              randomUUID(),
            ),
          },
        });
        if (updated === null) throw crossTenant("automation", automationId, companyId);
        return automationView(tx, companyId, updated, false);
      });
      return reply.status(202).send(data(view));
    },
  );

  // ── GET /automations/:automationId/slots ──
  app.get(
    "/automations/:automationId/slots",
    { schema: { params: automationParams } },
    async (request) => {
      const companyId = request.auth.companyId;
      const { automationId } = request.params;
      const out = await request.tx(async (tx) => {
        const scope = { companyId };
        const row = await automationStore.find(tx, scope, automationId);
        if (row === null) throw crossTenant("automation", automationId, companyId);
        const slots = await automationStore.listSlots(tx, scope, automationId);
        const posts = await automationStore.postsOfSlots(
          tx,
          scope,
          slots.map((s) => s.id),
        );
        const ids = [...new Set(slots.flatMap((s) => slotMediaIds(s)))];
        const live = new Map(
          (await findLiveMedia(tx, scope, ids)).map((m) => [m.mediaId, m.url]),
        );
        return slots.map((s) => toSlot(s, posts, live));
      });
      return data(out);
    },
  );

  // ── PATCH /automations/:automationId/slots/:slotId ──
  app.patch(
    "/automations/:automationId/slots/:slotId",
    { schema: { params: slotParams, body: updateAutomationSlotRequestSchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const { automationId, slotId } = request.params;
      const body = request.body;
      const view = await request.tx(async (tx) => {
        const scope = { companyId };
        const row = await lockOwn(tx, companyId, automationId);
        const slot = await lockOwnSlot(tx, companyId, automationId, slotId);
        requireReview(row);
        if (slot.status !== "READY") {
          throw conflict("Only a ready post can be edited.", "slot_not_ready", {
            status: slot.status,
          });
        }
        const patch: Parameters<typeof automationStore.updateSlot>[3] = {};
        // (1) textos + generatedText, juntos.
        if (body.texts !== undefined) {
          if (slot.contentId !== null) {
            throw conflict(
              "This post is already open in the editor: edit its text there.",
              "edit_in_editor",
            );
          }
          if (!isBlitzContentType(slot.contentType))
            throw conflict("This post can't be edited.", "invalid_state");
          const parsed = parseSuggestionData(slot.suggestionData, slot.contentType);
          if (!parsed.ok) throw conflict("This post can't be edited.", "invalid_state");
          const edited = applyTextEdit(parsed.data, body.texts);
          patch.suggestionData = edited.data;
          patch.generatedText = edited.generatedText;
        }
        // (2) captions: reemplaza el mapa entero.
        if (body.captionsByPlatform !== undefined) {
          const problems = captionProblems(
            body.captionsByPlatform,
            platformsOf(accountsOf(row)),
          );
          if (problems.length > 0) {
            throw new ApiRejection(400, "bad_request", "Some captions can't be used.", {
              problems,
            });
          }
          patch.captionsByPlatform = body.captionsByPlatform;
        }
        // (3) la hora.
        if (body.scheduledAt !== undefined) {
          if (body.scheduledAt < clock.nowMs() + LAUNCH_MIN_LEAD_MS) {
            throw new ApiRejection(
              400,
              "bad_request",
              "Pick a time at least 10 minutes from now.",
              {
                field: "scheduledAt",
              },
            );
          }
          patch.scheduledAtUtc = new Date(body.scheduledAt);
        }
        const updated = await automationStore.updateSlot(tx, scope, slot.id, patch, [
          "READY",
        ]);
        if (updated === null) throw crossTenant("automation slot", slotId, companyId);
        return slotView(tx, companyId, updated);
      });
      return data(view);
    },
  );

  // ── DELETE /automations/:automationId/slots/:slotId ── («Remove suggestion»)
  app.delete(
    "/automations/:automationId/slots/:slotId",
    { schema: { params: slotParams } },
    async (request) => {
      const companyId = request.auth.companyId;
      const { automationId, slotId } = request.params;
      const view = await request.tx(async (tx) => {
        const row = await lockOwn(tx, companyId, automationId);
        const slot = await lockOwnSlot(tx, companyId, automationId, slotId);
        requireReview(row);
        if (slot.status !== "READY" && slot.status !== "FAILED_GEN") {
          throw conflict("This post can't be removed now.", "slot_not_removable", {
            status: slot.status,
          });
        }
        const updated = await automationStore.updateSlot(
          tx,
          { companyId },
          slot.id,
          { status: "CANCELLED" },
          ["READY", "FAILED_GEN"],
        );
        if (updated === null) throw crossTenant("automation slot", slotId, companyId);
        return slotView(tx, companyId, updated);
      });
      return data(view);
    },
  );

  // ── POST /automations/:automationId/slots/:slotId/reroll ──
  app.post(
    "/automations/:automationId/slots/:slotId/reroll",
    {
      schema: {
        params: slotParams,
        body: rerollAutomationSlotRequestSchema.nullish(),
      },
    },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const { automationId, slotId } = request.params;
      const body = request.body ?? {};
      if (queue === undefined) throw noQueue();
      const view = await request.tx(async (tx) => {
        const scope = { companyId };
        const row = await lockOwn(tx, companyId, automationId);
        const slot = await lockOwnSlot(tx, companyId, automationId, slotId);
        requireReview(row);
        if (slot.status !== "READY" && slot.status !== "FAILED_GEN") {
          throw conflict("This post can't be re-rolled now.", "slot_not_rerollable", {
            status: slot.status,
          });
        }
        const forced = body.contentType;
        if (forced !== undefined) {
          const problem = rerollTypeProblem(forced, prefsOf(row), accountsOf(row));
          if (problem !== null) {
            throw new ApiRejection(
              400,
              "bad_request",
              "That content type isn't allowed here.",
              {
                reason: problem,
              },
            );
          }
        }
        if (policy === "enforced" && row.generationQuotaUsed >= row.generationQuota) {
          throw conflict(
            "This campaign used all its generations.",
            "generation_quota_exhausted",
            {
              used: row.generationQuotaUsed,
              quota: row.generationQuota,
            },
          );
        }
        // Destructivo e irrecuperable (FR-150): la sugerencia se descarta ya.
        const updated = await automationStore.updateSlot(
          tx,
          scope,
          slot.id,
          {
            status: "REROLLING",
            ...(forced === undefined ? {} : { contentType: forced }),
            suggestionData: null,
            generatedText: null,
            captionsByPlatform: {},
            failureReason: null,
            errorCode: null,
            dedupFingerprint: null,
            contentId: null,
          },
          ["READY", "FAILED_GEN"],
        );
        if (updated === null) throw crossTenant("automation slot", slotId, companyId);
        await queue.enqueue({
          queue: JOB_QUEUES.automationGeneration,
          payload: {
            companyId,
            automationId,
            slotId: slot.id,
            ...(forced === undefined ? {} : { contentType: forced }),
          },
          options: {
            transaction: tx,
            singletonKey: automationCampaignJobKey(
              JOB_QUEUES.automationGeneration,
              automationId,
              randomUUID(),
            ),
          },
        });
        return slotView(tx, companyId, updated);
      });
      return reply.status(202).send(data(view));
    },
  );

  // ── POST /automations/:automationId/slots/:slotId/content ── («Edit post» en el editor)
  app.post(
    "/automations/:automationId/slots/:slotId/content",
    { schema: { params: slotParams } },
    async (request) => {
      const companyId = request.auth.companyId;
      const { automationId, slotId } = request.params;
      if (queue === undefined) throw noQueue();
      const contentId = await request.tx(async (tx) => {
        const row = await lockOwn(tx, companyId, automationId);
        const slot = await lockOwnSlot(tx, companyId, automationId, slotId);
        requireReview(row);
        if (slot.status !== "READY") {
          throw conflict(
            "Only a ready post can be opened in the editor.",
            "slot_not_ready",
            {
              status: slot.status,
            },
          );
        }
        if (slot.contentId !== null) return slot.contentId;
        const outcome = await materializeSlotContent(tx, {
          companyId,
          slot,
          clock,
          queue,
          policy,
        });
        if (outcome.kind === "media_unavailable")
          throw conflict(
            "Some media of this post was deleted. Re-roll it.",
            "media_unavailable",
          );
        if (outcome.kind === "unbuildable")
          throw conflict("This post can't be built. Re-roll it.", "unbuildable");
        return outcome.contentId;
      });
      return data({ contentId });
    },
  );

  // ── GET /automations/:automationId/launch-validation ──
  app.get(
    "/automations/:automationId/launch-validation",
    { schema: { params: automationParams } },
    async (request) => {
      const companyId = request.auth.companyId;
      const { automationId } = request.params;
      const validation = await request.tx(async (tx) => {
        const row = await lockOwn(tx, companyId, automationId);
        return computeLaunchValidation(tx, {
          companyId,
          row,
          nowMs: clock.nowMs(),
          clock,
          policy,
        });
      });
      return data(validation);
    },
  );

  // ── POST /automations/:automationId/launch ──
  app.post(
    "/automations/:automationId/launch",
    { schema: { params: automationParams } },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const { automationId } = request.params;
      if (queue === undefined) throw noQueue();
      const outcome = await request.tx(async (tx) => {
        const scope = { companyId };
        const row = await lockOwn(tx, companyId, automationId);
        const nowMs = clock.nowMs();
        const validation = await computeLaunchValidation(tx, {
          companyId,
          row,
          nowMs,
          clock,
          policy,
        });
        // La validación queda guardada (sin `throw`: se confirma la transacción).
        if (!validation.ok) return { kind: "blocked" as const, validation };

        const accounts = accountsOf(row);
        const slots = await automationStore.listSlots(tx, scope, automationId);
        let reserved = 0;
        for (const slot of slots) {
          if (slot.status !== "READY" || slot.scheduledAtUtc === null) continue;
          let contentId = slot.contentId;
          if (contentId === null) {
            const made = await materializeSlotContent(tx, {
              companyId,
              slot,
              clock,
              queue,
              policy,
            });
            if (made.kind !== "created") {
              // Los slots fallidos no producen post (FR-150).
              await automationStore.updateSlot(tx, scope, slot.id, {
                status: "FAILED",
                errorCode:
                  made.kind === "media_unavailable" ? "media_unavailable" : "unbuildable",
              });
              continue;
            }
            contentId = made.contentId;
          }
          for (const account of accounts) {
            await automationStore.reservePlannedSlot(tx, scope, {
              contentId,
              network: account.platform,
              scheduledAtUtc: slot.scheduledAtUtc,
              automationSlotId: slot.id,
              connectionId: account.accountType === "oauth" ? account.connectionId : null,
            });
          }
          await automationStore.updateSlot(tx, scope, slot.id, {
            status: "QUEUED_BUILD",
            contentId,
          });
          reserved += 1;
        }
        const updated = await automationStore.update(tx, scope, automationId, {
          status: "BUILDING",
          launchedAt: new Date(nowMs),
        });
        const at = new Date(nowMs + AUTOMATION_BUILD_RECHECK_MS);
        await queue.enqueue({
          queue: JOB_QUEUES.automationBuildSchedule,
          payload: { companyId, automationId },
          options: {
            transaction: tx,
            startAfter: at,
            singletonKey: automationBuildJobKey(
              JOB_QUEUES.automationBuildSchedule,
              automationId,
              at.getTime(),
            ),
          },
        });
        request.log.info({ automationId, reserved }, "campaña lanzada");
        if (updated === null) throw crossTenant("automation", automationId, companyId);
        return {
          kind: "launched" as const,
          view: await automationView(tx, companyId, updated, true),
        };
      });
      if (outcome.kind === "blocked") {
        return reply.status(409).send({
          error: {
            code: "conflict",
            message: "This campaign can't launch yet.",
            details: { reason: "launch_blocked", gates: outcome.validation.gates },
          },
        });
      }
      return data(outcome.view);
    },
  );

  // ── POST /automations/:automationId/cancel ──
  app.post(
    "/automations/:automationId/cancel",
    { schema: { params: automationParams } },
    async (request) => {
      const companyId = request.auth.companyId;
      const { automationId } = request.params;
      const view = await request.tx(async (tx) => {
        const scope = { companyId };
        const row = await lockOwn(tx, companyId, automationId);
        if (!["GENERATING", "REVIEW", "BUILDING", "ACTIVE"].includes(row.status)) {
          throw conflict("Only a live campaign can be cancelled.", "not_cancellable", {
            status: row.status,
          });
        }
        const slots = await automationStore.listSlots(tx, scope, automationId);
        const slotIds = slots.map((s) => s.id);
        // Revocar lo que todavía no salió; lo publicado sigue vivo (F-219).
        await automationStore.revokePendingPosts(tx, scope, slotIds, [
          ...AUTOMATION_REVOCABLE_POST_STATUSES,
        ]);
        await automationStore.deletePlannedSlotsOf(tx, scope, slotIds);
        const posts = await automationStore.postsOfSlots(tx, scope, slotIds);
        const published = new Set(
          posts
            .filter((p) =>
              ["POSTED", "IN_USER_INBOX", "UPLOADING_TO_TIKTOK"].includes(p.status),
            )
            .map((p) => p.automationSlotId),
        );
        for (const slot of slots) {
          const next = slotStatusOnCancel(slot.status, published.has(slot.id));
          if (next !== slot.status)
            await automationStore.updateSlot(tx, scope, slot.id, {
              status: next,
              generatingSince: null,
            });
        }
        const updated = await automationStore.update(tx, scope, automationId, {
          status: "CANCELLED",
          cancelledAt: new Date(clock.nowMs()),
        });
        if (updated === null) throw crossTenant("automation", automationId, companyId);
        return automationView(tx, companyId, updated, true);
      });
      return data(view);
    },
  );
}
