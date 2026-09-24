/**
 * Los tres consumidores de Engagement — `P4-ENGAGE-003/004/007/008/009/011`.
 *
 * - `reddit-lead-discovery`: barrido (cron), descubrimiento por marca, juicio
 *   de un lead (`JV-2`) y borrador de respuesta (`F-195`). Ver
 *   `core/engagement/jobs.ts` por qué la respuesta viaja por esta cola.
 * - `reddit-thread-monitoring`: seguimiento de los hilos respondidos (F-198/199).
 * - `ban-risk-computation`: etiqueta el tono de cada respuesta enviada
 *   (`JV-5`) y recalcula el medidor **en código** (`computeBanMeter`).
 *
 * ## Límite de tasa (F-191)
 *
 * Entre llamadas se espera `RATE_LIMIT_PLAN.minIntervalMs` (core) y después de
 * cada una se miran los headers `X-Ratelimit-*`: con pocas restantes, la
 * corrida se corta, se anota `discovery_paused_until` y se encola la
 * continuación para después del reset. Un 429 hace lo mismo. Nunca se
 * reintenta en caliente contra Reddit.
 *
 * ## Qué nunca hace
 *
 * Publicar. Ningún handler de acá llama a `postComment`: eso es sólo "Send",
 * en la API, con confirmación humana (`D-11`).
 */
import {
  BAN_METER_THRESHOLDS,
  DISCOVERY_LIMITS,
  JOB_QUEUES,
  LEAD_SCORING_QUESTIONS,
  LEAD_SCORING_VERSION,
  REPLY_TONE_QUESTION,
  REPLY_TONE_VERSION,
  THREAD_MONITORING,
  banMeterRecommendation,
  buildLeadScoringState,
  buildReplyPrompt,
  buildReplyToneState,
  buildWhyThisLeadPrompt,
  cleanGeneratedReply,
  computeBanMeter,
  engagementScoreOf,
  isReplyTone,
  isVisibleTier,
  parseBanRiskJob,
  parseLeadDiscoveryJob,
  parseThreadMonitoringJob,
  planAfterResponse,
  scoreLead,
  selectCandidates,
  summarizeThread,
  toneFromAnswer,
  type LeadScoringAnswers,
  type RateLimitSnapshot,
  type RedditPostCandidate,
  type ReplyToneStyle,
} from "@fastgram/core";
import {
  companyProfileRepository,
  companyRepository,
  engagementStore,
  withCompany,
  withoutCompany,
  type Database,
  type LeadRow,
  type NewLead,
  type Transaction,
} from "@fastgram/db";
import {
  isPortError,
  type Clock,
  type JobContext,
  type JobHandler,
  type Queue,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import type { LlmSource } from "../llm/registry-llm.js";
import type { EngagementJudgmentProvider } from "./judgment.js";
import type { RedditAccessProvider } from "./reddit.js";

export interface EngagementDeps {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly clock: Clock;
  readonly queue: Queue;
  readonly llmSource: LlmSource;
  readonly judgment: EngagementJudgmentProvider;
  readonly reddit: RedditAccessProvider;
  /** Espera entre llamadas a Reddit. Tests: `() => Promise.resolve()`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Timeout del juicio (batch, no síncrono): generoso. */
  readonly judgmentTimeoutMs?: number;
}

const DAY_MS = 86_400_000;
const WHY_MAX_CHARS = 600;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Un corte por límite de tasa: hasta cuándo, y por qué. */
class RatePause extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("reddit rate limit");
  }
}

interface BrandContext {
  readonly name: string;
  readonly profile: {
    readonly coreIdentity: string | null;
    readonly productOffering: string | null;
    readonly targetAudience: string | null;
  };
  readonly settings: Awaited<ReturnType<typeof engagementStore.findSettings>>;
}

export function createEngagementHandlers(deps: EngagementDeps): {
  readonly discovery: JobHandler<unknown>;
  readonly monitoring: JobHandler<unknown>;
  readonly banRisk: JobHandler<unknown>;
} {
  const roleOpt = deps.appRole === undefined ? {} : { role: deps.appRole };
  const inCompany = <T>(companyId: string, fn: (tx: Transaction) => Promise<T>) =>
    withCompany(deps.db, companyId, fn, roleOpt);
  const sleep = deps.sleep ?? defaultSleep;
  const judgmentTimeoutMs = deps.judgmentTimeoutMs ?? 60_000;

  async function brandContext(companyId: string): Promise<BrandContext> {
    const scope = { companyId };
    return inCompany(companyId, async (tx) => {
      const [company, profiles, settings] = await Promise.all([
        companyRepository.load(tx, scope),
        companyProfileRepository.list(tx, scope, { limit: 1 }),
        engagementStore.findSettings(tx, scope),
      ]);
      const p = profiles.items[0];
      return {
        name: company?.name ?? "",
        profile: {
          coreIdentity: p?.coreIdentity ?? null,
          productOffering: p?.productOffering ?? null,
          targetAudience: p?.targetAudience ?? null,
        },
        settings,
      };
    });
  }

  /** Pausa mínima y corte por headers. Lanza {@link RatePause} si hay que parar. */
  async function pace(rateLimit: RateLimitSnapshot): Promise<void> {
    const plan = planAfterResponse(rateLimit);
    if (plan.kind === "pause") throw new RatePause(plan.retryAfterSeconds);
    await sleep(plan.waitMs);
  }

  /** Un `rate_limited` de Reddit → {@link RatePause}. El resto se relanza. */
  function asPause(error: unknown): never {
    if (isPortError(error) && error.code === "rate_limited") {
      throw new RatePause(error.retryAfterSeconds ?? 60);
    }
    throw error;
  }

  /* ---------------------------------------------------------------------- *
   * Juicio JV-2 y `Why this lead?`
   * ---------------------------------------------------------------------- */

  async function scoreOne(
    companyId: string,
    lead: LeadRow,
    brand: BrandContext,
  ): Promise<LeadRow> {
    const scope = { companyId };
    const judgment = await deps.judgment({
      companyId,
      subjectType: "lead",
      subjectId: lead.id,
    });
    if (judgment === null) {
      return (
        (await inCompany(companyId, (tx) =>
          engagementStore.updateLead(tx, scope, lead.id, { scoreStatus: "no_judgment" }),
        )) ?? lead
      );
    }
    let answers: LeadScoringAnswers;
    try {
      const out = await judgment.ask({
        decisionPoint: "DP-002",
        state: buildLeadScoringState({
          post: {
            title: lead.title,
            body: lead.body,
            subreddit: lead.subreddit,
            score: lead.score,
            numComments: lead.numComments,
            topComments: lead.contextComments,
          },
          subredditRules: lead.subredditRules,
          brand: brand.profile,
        }),
        questions: LEAD_SCORING_QUESTIONS,
        timeoutMs: judgmentTimeoutMs,
      });
      answers = out.answers as LeadScoringAnswers;
    } catch (error) {
      deps.logger.warn(
        {
          companyId,
          leadId: lead.id,
          code: isPortError(error) ? error.code : "unexpected",
        },
        "juicio JV-2 falló: el lead queda `failed` y se muestra sin score",
      );
      return (
        (await inCompany(companyId, (tx) =>
          engagementStore.updateLead(tx, scope, lead.id, { scoreStatus: "failed" }),
        )) ?? lead
      );
    }
    // La composición es de core; acá se guardan las respuestas crudas **y** el resultado.
    const composed = scoreLead(answers);
    const updated =
      (await inCompany(companyId, (tx) =>
        engagementStore.updateLead(tx, scope, lead.id, {
          scoreStatus: "scored",
          scoreAnswers: JSON.parse(JSON.stringify(answers)) as Record<string, unknown>,
          scoreVersion: LEAD_SCORING_VERSION,
          leadScore: composed.score.toFixed(4),
          leadTier: composed.tier,
          scoredAt: deps.clock.now(),
        }),
      )) ?? lead;
    // `Why this lead?` sólo para los que se muestran: el juicio decide cuáles
    // merecen el gasto del LLM (JV-2, *"Qué hace el LLM"*).
    if (isVisibleTier(composed.tier) || lead.source === "manual") {
      await explain(companyId, updated, brand, composed.components);
    }
    return updated;
  }

  async function explain(
    companyId: string,
    lead: LeadRow,
    brand: BrandContext,
    components: Record<string, number>,
  ): Promise<void> {
    const found = await deps.llmSource.current("text");
    if (found === null) return;
    const signals = Object.entries(components)
      .filter(([k, v]) => k !== "alreadyAnswered" && v >= 0.6)
      .map(([k]) => k);
    try {
      const prompt = buildWhyThisLeadPrompt({
        brand: { name: brand.name, productOffering: brand.profile.productOffering },
        thread: {
          subreddit: lead.subreddit,
          title: lead.title,
          body: lead.body,
          topComments: [],
        },
        signals,
      });
      const out = await found.llm.complete({
        messages: prompt.messages,
        untrusted: prompt.untrusted,
        maxOutputTokens: 160,
        timeoutMs: 45_000,
      });
      const why = out.text.trim().slice(0, WHY_MAX_CHARS);
      if (why.length > 0) {
        await inCompany(companyId, (tx) =>
          engagementStore.updateLead(tx, { companyId }, lead.id, { whyThisLead: why }),
        );
      }
    } catch (error) {
      deps.logger.warn(
        {
          companyId,
          leadId: lead.id,
          code: isPortError(error) ? error.code : "unexpected",
        },
        "`Why this lead?` no se generó (el lead sigue igual)",
      );
    }
  }

  /* ---------------------------------------------------------------------- *
   * Descubrimiento
   * ---------------------------------------------------------------------- */

  async function sweepDiscovery(jobId: string): Promise<void> {
    const brands = await withoutCompany(
      deps.db,
      (tx) => engagementStore.listBrands(tx),
      roleOpt,
    );
    const hour = Math.floor(deps.clock.nowMs() / 3_600_000);
    let enqueued = 0;
    for (const b of brands) {
      if (!b.discoveryEnabled || !b.hasRedditAccount) continue;
      const r = await deps.queue.enqueue({
        queue: JOB_QUEUES.redditLeadDiscovery,
        payload: { kind: "discover", companyId: b.companyId },
        // Una por marca y por hora: el cron no se apila sobre sí mismo.
        options: { singletonKey: `engagement-discover:${b.companyId}:h${hour}` },
      });
      if (r.created) enqueued += 1;
    }
    deps.logger.info(
      { jobId, brands: brands.length, enqueued },
      "barrido de descubrimiento de leads",
    );
  }

  async function record(
    companyId: string,
    outcome: string,
    pausedUntil: Date | null,
  ): Promise<void> {
    await inCompany(companyId, (tx) =>
      engagementStore.recordDiscoveryRun(
        tx,
        { companyId },
        { at: deps.clock.now(), outcome, pausedUntil },
      ),
    );
  }

  async function discover(jobId: string, companyId: string): Promise<void> {
    const now = deps.clock.now();
    const brand = await brandContext(companyId);
    const settings = brand.settings;
    if (
      settings === null ||
      !settings.discoveryEnabled ||
      settings.subreddits.length === 0
    ) {
      deps.logger.info(
        { jobId, companyId },
        "descubrimiento: la marca no tiene subreddits configurados",
      );
      return;
    }
    if (settings.discoveryPausedUntil !== null && settings.discoveryPausedUntil > now) {
      deps.logger.info(
        { jobId, companyId },
        "descubrimiento en pausa por límite de tasa",
      );
      return;
    }
    const access = await deps.reddit(companyId);
    if (!access.ok) {
      await record(companyId, access.reason, null);
      return;
    }
    const posts: RedditPostCandidate[] = [];
    let inserted = 0;
    try {
      for (const sr of settings.subreddits) {
        try {
          const r = await access.api.listNew(sr, DISCOVERY_LIMITS.listingLimit);
          posts.push(...r.data);
          await pace(r.rateLimit);
        } catch (error) {
          if (error instanceof RatePause) throw error;
          if (
            isPortError(error) &&
            (error.code === "forbidden" || error.code === "not_found")
          ) {
            // Subreddit privado, baneado o inexistente: se sigue con el resto.
            deps.logger.warn(
              { jobId, companyId, code: error.code },
              "subreddit no legible, se saltea",
            );
            continue;
          }
          asPause(error);
        }
      }
      const known = await inCompany(companyId, (tx) =>
        engagementStore.knownRedditPostIds(
          tx,
          { companyId },
          posts.map((p) => p.id),
        ),
      );
      const { selected, skipped } = selectCandidates({
        posts,
        keywords: settings.keywords,
        knownIds: known,
        ownUsername: access.username,
        now,
      });
      const chosen = selected.slice(0, DISCOVERY_LIMITS.maxScoredPerRun);

      // Contexto: reglas (una vez por subreddit) y los comentarios de arriba.
      const rulesBySub = new Map<string, string[]>();
      const values: NewLead[] = [];
      for (const { post, matched } of chosen) {
        let rules = rulesBySub.get(post.subreddit.toLowerCase());
        if (rules === undefined) {
          try {
            const r = await access.api.getRules(post.subreddit);
            rules = r.data;
            await pace(r.rateLimit);
          } catch (error) {
            if (error instanceof RatePause) throw error;
            if (isPortError(error) && error.code === "rate_limited") asPause(error);
            rules = [];
          }
          rulesBySub.set(post.subreddit.toLowerCase(), rules);
        }
        let comments: string[] = [];
        let numComments = post.numComments;
        if (post.numComments > 0) {
          try {
            const t = await access.api.getThread(post.id, { limit: 5, depth: 1 });
            comments = t.data.comments
              .filter((c) => c.parentId === `t3_${post.id}`)
              .map((c) => c.body)
              .filter((b) => b.length > 0)
              .slice(0, 5);
            numComments = t.data.post.numComments;
            await pace(t.rateLimit);
          } catch (error) {
            if (error instanceof RatePause) throw error;
            if (isPortError(error) && error.code === "rate_limited") asPause(error);
          }
        }
        values.push({
          source: "discovery",
          redditPostId: post.id,
          subreddit: post.subreddit,
          title: post.title,
          body: post.selftext.length > 0 ? post.selftext : null,
          author: post.author,
          score: post.score,
          numComments,
          permalink: post.permalink,
          postCreatedAt: new Date(post.createdUtc * 1000),
          matchedKeywords: matched,
          contextComments: comments,
          subredditRules: rules,
          engagementScore: String(engagementScoreOf({ score: post.score, numComments })),
        });
      }
      const rows = await inCompany(companyId, (tx) =>
        engagementStore.insertLeads(tx, { companyId }, values),
      );
      inserted = rows.length;
      for (const row of rows) await scoreOne(companyId, row, brand);
      await record(companyId, `ran:${String(inserted)}`, null);
      deps.logger.info(
        { jobId, companyId, fetched: posts.length, inserted, skipped },
        "descubrimiento de leads",
      );
    } catch (error) {
      if (isPortError(error) && error.code === "unauthorized") {
        // El token dejó de valer a mitad de corrida: reconectar, no reintentar.
        await inCompany(companyId, (tx) =>
          engagementStore.markRedditAccount(
            tx,
            { companyId },
            "expired",
            "discovery_unauthorized",
          ),
        );
        await record(companyId, "reconnect_required", null);
        return;
      }
      if (!(error instanceof RatePause)) throw error;
      const until = new Date(deps.clock.nowMs() + error.retryAfterSeconds * 1000);
      await record(companyId, "rate_limited", until);
      // «Rate limited - will retry …» (FR-140): la continuación, después del reset.
      await deps.queue.enqueue({
        queue: JOB_QUEUES.redditLeadDiscovery,
        payload: { kind: "discover", companyId },
        options: {
          startAfter: until,
          singletonKey: `engagement-discover:${companyId}:resume:${until.getTime()}`,
        },
      });
      deps.logger.warn(
        { jobId, companyId, until: until.toISOString() },
        "límite de tasa de Reddit: se reanuda después del reset",
      );
    }
  }

  /** Un lead a mano (o re-juicio). Con cuenta, completa el contexto desde Reddit. */
  async function scoreJob(companyId: string, leadId: string): Promise<void> {
    const brand = await brandContext(companyId);
    let lead = await inCompany(companyId, (tx) =>
      engagementStore.findLead(tx, { companyId }, leadId),
    );
    if (lead === null) return;
    if (lead.source === "manual" && lead.contextComments.length === 0) {
      const access = await deps.reddit(companyId);
      if (access.ok) {
        try {
          const t = await access.api.getThread(lead.redditPostId, { limit: 5, depth: 1 });
          const rules = await access.api
            .getRules(lead.subreddit)
            .then((r) => r.data)
            .catch(() => []);
          const post = t.data.post;
          lead =
            (await inCompany(companyId, (tx) =>
              engagementStore.updateLead(tx, { companyId }, leadId, {
                score: post.score,
                numComments: post.numComments,
                engagementScore: String(engagementScoreOf(post)),
                contextComments: t.data.comments
                  .filter((c) => c.parentId === `t3_${post.id}`)
                  .map((c) => c.body)
                  .slice(0, 5),
                subredditRules: rules,
              }),
            )) ?? lead;
        } catch (error) {
          deps.logger.warn(
            { companyId, leadId, code: isPortError(error) ? error.code : "unexpected" },
            "no se pudo leer el hilo del lead manual: se juzga con lo que pegó el usuario",
          );
        }
      }
    }
    await scoreOne(companyId, lead, brand);
  }

  /* ---------------------------------------------------------------------- *
   * Borrador de respuesta (F-195/F-196)
   * ---------------------------------------------------------------------- */

  async function replyJob(
    ctx: JobContext<unknown>,
    companyId: string,
    leadId: string,
    regenerate: boolean,
  ): Promise<void> {
    const scope = { companyId };
    const fail = (code: string) =>
      inCompany(companyId, (tx) =>
        engagementStore.updateLead(tx, scope, leadId, {
          replyStatus: "failed",
          replyError: code,
        }),
      );
    const lead = await inCompany(companyId, (tx) =>
      engagementStore.findLead(tx, scope, leadId),
    );
    if (lead === null) return;
    const found = await deps.llmSource.current("text");
    if (found === null) {
      await fail("no_llm");
      return;
    }
    const brand = await brandContext(companyId);
    const s = brand.settings;
    const prompt = buildReplyPrompt({
      brand: {
        name: brand.name,
        productOffering: brand.profile.productOffering,
        targetAudience: brand.profile.targetAudience,
      },
      settings: {
        tone: (s?.replyTone ?? "casual") as ReplyToneStyle,
        customRules: s?.customRules ?? "",
        allowLinks: s?.allowLinks ?? false,
      },
      thread: {
        subreddit: lead.subreddit,
        title: lead.title,
        body: lead.body,
        topComments: lead.contextComments,
      },
      previousDraft: regenerate ? lead.generatedReply : null,
    });
    try {
      const out = await found.llm.complete({
        messages: prompt.messages,
        untrusted: prompt.untrusted,
        maxOutputTokens: 500,
        temperature: regenerate ? 0.9 : 0.6,
        timeoutMs: 90_000,
      });
      const text = cleanGeneratedReply(out.text);
      if (text.length === 0) {
        await fail("empty_output");
        return;
      }
      await inCompany(companyId, (tx) =>
        engagementStore.updateLead(tx, scope, leadId, {
          generatedReply: text,
          replyStatus: "ready",
          replyError: null,
          replyGeneratedAt: deps.clock.now(),
        }),
      );
    } catch (error) {
      const code = isPortError(error) ? error.code : "unexpected";
      const transient =
        code === "timeout" || code === "provider_unavailable" || code === "rate_limited";
      if (transient && ctx.attempt < ctx.maxAttempts) throw error;
      await fail(code);
    }
  }

  const discovery: JobHandler<unknown> = async (ctx) => {
    const job = parseLeadDiscoveryJob(ctx.payload);
    if (job === null) {
      deps.logger.warn(
        { jobId: ctx.jobId },
        "reddit-lead-discovery: payload inválido, se descarta",
      );
      return;
    }
    switch (job.kind) {
      case "sweep":
        return sweepDiscovery(ctx.jobId);
      case "discover":
        return discover(ctx.jobId, job.companyId);
      case "score":
        return scoreJob(job.companyId, job.leadId);
      case "reply":
        return replyJob(ctx, job.companyId, job.leadId, job.regenerate);
    }
  };

  /* ---------------------------------------------------------------------- *
   * Seguimiento del hilo (F-198/F-199)
   * ---------------------------------------------------------------------- */

  async function syncBrand(
    jobId: string,
    companyId: string,
    leadId?: string,
  ): Promise<void> {
    const scope = { companyId };
    const access = await deps.reddit(companyId);
    if (!access.ok) {
      deps.logger.info(
        { jobId, companyId, reason: access.reason },
        "seguimiento: sin acceso a Reddit",
      );
      return;
    }
    const since = new Date(deps.clock.nowMs() - THREAD_MONITORING.followDays * DAY_MS);
    const leads = await inCompany(companyId, async (tx) => {
      if (leadId !== undefined) {
        const one = await engagementStore.findLead(tx, scope, leadId);
        return one === null ? [] : [one];
      }
      return engagementStore.listLeadsToMonitor(tx, scope, {
        since,
        limit: THREAD_MONITORING.maxThreadsPerRun,
      });
    });
    for (const lead of leads) {
      let thread;
      try {
        thread = await access.api.getThread(lead.redditPostId, { limit: 100, depth: 5 });
      } catch (error) {
        if (isPortError(error) && error.code === "rate_limited") {
          deps.logger.warn(
            { jobId, companyId },
            "seguimiento cortado por límite de tasa",
          );
          return;
        }
        deps.logger.warn(
          {
            jobId,
            companyId,
            leadId: lead.id,
            code: isPortError(error) ? error.code : "unexpected",
          },
          "no se pudo leer el hilo",
        );
        continue;
      }
      const replies = await inCompany(companyId, (tx) =>
        engagementStore.listLeadReplies(tx, scope, lead.id),
      );
      const summary = summarizeThread({
        snapshot: {
          postId: lead.redditPostId,
          locked: thread.data.post.locked,
          numComments: thread.data.post.numComments,
          score: thread.data.post.score,
          comments: thread.data.comments,
        },
        ownUsername: access.username,
        sentCommentNames: replies
          .map((r) => r.redditCommentName)
          .filter((n): n is string => n !== null),
        replied: lead.repliedAt !== null,
        previousNumComments: lead.lastSyncedAt === null ? null : lead.numComments,
      });
      await inCompany(companyId, (tx) =>
        engagementStore.updateLead(tx, scope, lead.id, {
          threadState: summary.threadState,
          ourComments: summary.ourComments,
          repliesToUs: summary.repliesToUs,
          numComments: summary.numComments,
          score: summary.score,
          engagementScore: String(engagementScoreOf(summary)),
          // Pegajoso: se apaga cuando el usuario abre el lead (`/seen`).
          newActivity: lead.newActivity || summary.newActivity,
          lastSyncedAt: deps.clock.now(),
        }),
      );
      try {
        await pace(thread.rateLimit);
      } catch (error) {
        if (error instanceof RatePause) return;
        throw error;
      }
    }
  }

  const monitoring: JobHandler<unknown> = async (ctx) => {
    const job = parseThreadMonitoringJob(ctx.payload);
    if (job === null) {
      deps.logger.warn(
        { jobId: ctx.jobId },
        "reddit-thread-monitoring: payload inválido, se descarta",
      );
      return;
    }
    if (job.kind === "sweep") {
      const brands = await withoutCompany(
        deps.db,
        (tx) => engagementStore.listBrands(tx),
        roleOpt,
      );
      const window = Math.floor(deps.clock.nowMs() / (2 * 3_600_000));
      for (const b of brands) {
        if (!b.hasRedditAccount) continue;
        await deps.queue.enqueue({
          queue: JOB_QUEUES.redditThreadMonitoring,
          payload: { kind: "sync", companyId: b.companyId },
          options: { singletonKey: `engagement-sync:${b.companyId}:w${window}` },
        });
      }
      return;
    }
    await syncBrand(ctx.jobId, job.companyId, job.leadId);
  };

  /* ---------------------------------------------------------------------- *
   * Ban meter: JV-5 etiqueta, el código cuenta (DP-003)
   * ---------------------------------------------------------------------- */

  async function computeBrand(jobId: string, companyId: string): Promise<void> {
    const scope = { companyId };
    const now = deps.clock.now();
    const since = new Date(now.getTime() - BAN_METER_THRESHOLDS.windowDays * DAY_MS);
    const brand = await brandContext(companyId);
    const unlabeled = await inCompany(companyId, (tx) =>
      engagementStore.listUnlabeledReplies(tx, scope, { since, limit: 20 }),
    );
    for (const u of unlabeled) {
      const judgment = await deps.judgment({
        companyId,
        subjectType: "engagement_reply",
        subjectId: u.reply.id,
      });
      if (judgment === null) break;
      try {
        const out = await judgment.choice({
          decisionPoint: "DP-003",
          state: buildReplyToneState({
            replyText: u.reply.text,
            threadContext: `${u.leadTitle}\n\n${u.leadBody ?? ""}`,
            brandName: brand.name,
          }),
          question: REPLY_TONE_QUESTION,
          timeoutMs: judgmentTimeoutMs,
        });
        const tone = toneFromAnswer(out.answer);
        await inCompany(companyId, (tx) =>
          engagementStore.setReplyTone(tx, scope, u.reply.id, {
            tone,
            answers: { promoLevel: JSON.parse(JSON.stringify(out.answer)) as unknown },
            version: REPLY_TONE_VERSION,
            at: deps.clock.now(),
          }),
        );
      } catch (error) {
        deps.logger.warn(
          {
            jobId,
            companyId,
            replyId: u.reply.id,
            code: isPortError(error) ? error.code : "unexpected",
          },
          "juicio JV-5 falló: la respuesta queda sin etiqueta (no entra al ratio)",
        );
      }
    }
    // El nivel: **código**, sobre lo guardado.
    await inCompany(companyId, async (tx) => {
      const rows = await engagementStore.listRepliesForMeter(tx, scope, since);
      const reading = computeBanMeter(
        rows.map((r) => ({
          sentAt: r.sentAt,
          tone: isReplyTone(r.tone) ? r.tone : null,
        })),
        now,
      );
      await engagementStore.saveBanAssessment(tx, scope, {
        level: reading.level,
        promoRatio: reading.promoRatio === null ? null : String(reading.promoRatio),
        recommendation: banMeterRecommendation(reading.level),
        computedAt: now,
        sampleSize: reading.sampleSize,
        counts: reading.counts,
        windowDays: reading.windowDays,
        smallSample: reading.smallSample,
      });
    });
  }

  const banRisk: JobHandler<unknown> = async (ctx) => {
    const job = parseBanRiskJob(ctx.payload);
    if (job === null) {
      deps.logger.warn(
        { jobId: ctx.jobId },
        "ban-risk-computation: payload inválido, se descarta",
      );
      return;
    }
    if (job.kind === "sweep") {
      const brands = await withoutCompany(
        deps.db,
        (tx) => engagementStore.listBrands(tx),
        roleOpt,
      );
      const day = Math.floor(deps.clock.nowMs() / DAY_MS);
      for (const b of brands) {
        await deps.queue.enqueue({
          queue: JOB_QUEUES.banRiskComputation,
          payload: { kind: "compute", companyId: b.companyId },
          options: { singletonKey: `engagement-ban:${b.companyId}:d${day}` },
        });
      }
      return;
    }
    await computeBrand(ctx.jobId, job.companyId);
  };

  return { discovery, monitoring, banRisk };
}
