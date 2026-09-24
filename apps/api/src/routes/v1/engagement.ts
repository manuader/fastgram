/**
 * Engagement (Reddit) — `FR-140`, `MOD-014`, `P4-ENGAGE-001…012`, `F-190`.
 * La superficie está listada en `packages/contracts/src/resources/engagement.ts`.
 *
 * La lógica está en `packages/core/src/engagement` (scoring `JV-2`, ban meter
 * `JV-5`/`DP-003`, revisión del borrador) y `core/connections/reddit.ts`; el
 * I/O de Reddit en `packages/adapters/src/reddit`; la base en
 * `packages/db/src/repositories/engagement.ts`. Acá se cablea.
 *
 * ## "Send" (`D-11`): nunca sin el humano
 *
 * - Exige `confirm: true` en el cuerpo (la web lo manda sólo desde el diálogo
 *   de confirmación) **y** `Idempotency-Key`: un doble clic o un reintento del
 *   proxy no comenta dos veces.
 * - Se rechaza con el ban meter en `danger` — recalculado **acá, en código**,
 *   sobre las etiquetas guardadas (nunca un nivel que venga del modelo) — y con
 *   issues bloqueantes del borrador (`brand_without_disclosure`, vacío, largo).
 * - Es **síncrono y sin reintentos**. Si Reddit no responde a tiempo, el
 *   comentario puede o no haber salido: se dice eso, no se reintenta.
 *
 * ## Sin la API de Reddit
 *
 * La Responsible Builder Policy exige aprobación previa para usar la Data API
 * (ver `core/connections/reddit.ts`). Todo lo que no es descubrir ni enviar
 * funciona sin cuenta: agregar un post a mano, generar la respuesta, «Copy &
 * open thread» y `mark-sent` para que el ban meter cuente lo publicado a mano.
 *
 * ## Decisiones que el PRD no cubre
 *
 * - Las credenciales de la app de Reddit son de la instalación (como
 *   `/integrations`), en `$FASTGRAM_HOME/reddit-app.json`; la cuenta
 *   conectada es por marca.
 * - Los `state` pendientes viven en memoria del proceso (10 min), igual que
 *   en `/connections`.
 * - Desconectar revoca el refresh token en Reddit **de mejor esfuerzo** y
 *   borra los tokens de acá pase lo que pase.
 */
import {
  createManualLeadRequestSchema,
  generateReplyRequestSchema,
  idempotencyHeaderSchema,
  leadListQuerySchema,
  markSentRequestSchema,
  optionalIdempotencyHeaderSchema,
  redditCallbackRequestSchema,
  saveReplyDraftRequestSchema,
  sendReplyRequestSchema,
  updateEngagementSettingsRequestSchema,
  updateRedditAppRequestSchema,
  type BanMeter,
  type EngagementErrorReason,
  type EngagementOverview,
  type EngagementSettings,
  type Lead,
  type LeadDetail,
  type RedditApp,
  type SendReplyResult,
  type SentReply,
} from "@fastgram/contracts";
import {
  BAN_METER_THRESHOLDS,
  JOB_QUEUES,
  REDDIT_OAUTH,
  banMeterRecommendation,
  blockingIssues,
  computeBanMeter,
  engagementScoreOf,
  isReplyTone,
  issueRedditState,
  lintReply,
  normalizeDiscoverySettings,
  normalizeRedditUsername,
  parseRedditPostUrl,
  parseStoredLeadAnswers,
  redditRedirectUri,
  redditThreadUrl,
  redditUserAgent,
  resolveRedditAccessToken,
  resolveRedirectBase,
  scoreLead,
  sendBlockedBy,
  verifyRedditState,
  type BanMeterReading,
  type BanRiskJob,
  type LeadDiscoveryJob,
  type ReplyIssue,
  type ReplyToneStyle,
  type ThreadMonitoringJob,
} from "@fastgram/core";
import {
  FileRedditAppStore,
  RedditApi,
  RedditOAuth,
  createLocalOAuthKit,
  randomNonce,
  redditAppPath,
  type RedditAppConfig,
  type RedditAppStore,
} from "@fastgram/adapters";
import {
  companyRepository,
  engagementStore,
  type EngagementReplyRow,
  type EngagementSettingsRow,
  type LeadRow,
  type RedditAccountRow,
  type Transaction,
} from "@fastgram/db";
import {
  isPortError,
  type Queue,
  type StateSigner,
  type TokenCipher,
} from "@fastgram/ports";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import { ApiRejection } from "../../http/errors.js";
import { data, idempotencyKeyOf, withIdempotency } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

/* ------------------------------------------------------------------------ *
 * Dependencias
 * ------------------------------------------------------------------------ */

type RedditFetch = (
  input: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

/** `state` emitidos y todavía no usados, en memoria (ver la cabecera). */
export class RedditNonceLedger {
  readonly #entries = new Map<string, { companyId: string; expiresAt: number }>();

  put(nonce: string, companyId: string, expiresAt: Date): void {
    const now = Date.now();
    for (const [k, v] of this.#entries) if (v.expiresAt <= now) this.#entries.delete(k);
    this.#entries.set(nonce, { companyId, expiresAt: expiresAt.getTime() });
  }

  /** Una sola vez. */
  take(nonce: string, companyId: string, nowMs: number): boolean {
    const e = this.#entries.get(nonce);
    if (e === undefined || e.companyId !== companyId || e.expiresAt <= nowMs)
      return false;
    this.#entries.delete(nonce);
    return true;
  }
}

export interface EngagementRouteDeps {
  /** Se lee en cada pedido (`FASTGRAM_PUBLIC_URL`). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly appStore: RedditAppStore;
  readonly cipher: TokenCipher;
  readonly signer: StateSigner;
  readonly nonces: RedditNonceLedger;
  readonly nonce: () => string;
  /** Tests: un `fetch` que imita a Reddit. Ausente = `globalThis.fetch`. */
  readonly fetch?: RedditFetch;
}

export function defaultEngagementRouteDeps(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EngagementRouteDeps {
  const kit = createLocalOAuthKit(env);
  return {
    env,
    appStore: new FileRedditAppStore({ path: redditAppPath(env) }),
    cipher: kit.cipher,
    signer: kit.signer,
    nonces: new RedditNonceLedger(),
    nonce: randomNonce,
  };
}

/* ------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------ */

const leadParams = z.object({ leadId: z.string().min(1) });

function reject(
  status: number,
  code: "bad_request" | "conflict" | "not_found" | "service_unavailable" | "rate_limited",
  reason: EngagementErrorReason,
  message: string,
): ApiRejection {
  return new ApiRejection(status, code, message, { reason });
}

function leadNotFound(): ApiRejection {
  return new ApiRejection(404, "not_found", "Lead not found");
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const num = (v: string | null): number | null => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const DEFAULT_SETTINGS: EngagementSettings = {
  subreddits: [],
  keywords: [],
  replyTone: "casual",
  customRules: "",
  allowLinks: false,
  discoveryEnabled: true,
};

function toSettings(row: EngagementSettingsRow | null): EngagementSettings {
  if (row === null) return DEFAULT_SETTINGS;
  return {
    subreddits: row.subreddits,
    keywords: row.keywords,
    replyTone: row.replyTone as ReplyToneStyle,
    customRules: row.customRules,
    allowLinks: row.allowLinks,
    discoveryEnabled: row.discoveryEnabled,
  };
}

function toLead(row: LeadRow): Lead {
  const answers = parseStoredLeadAnswers(row.scoreAnswers);
  const components = answers === null ? null : scoreLead(answers).components;
  return {
    id: row.id,
    source: row.source === "manual" ? "manual" : "discovery",
    redditPostId: row.redditPostId,
    subreddit: row.subreddit,
    title: row.title,
    body: row.body,
    author: row.author,
    url: row.permalink === null ? null : redditThreadUrl(row.permalink),
    redditScore: row.score,
    numComments: row.numComments,
    postedAt: iso(row.postCreatedAt),
    matchedKeywords: row.matchedKeywords,
    scoreStatus: row.scoreStatus as Lead["scoreStatus"],
    leadScore: num(row.leadScore),
    tier: (row.leadTier as Lead["tier"]) ?? null,
    scoreComponents: components,
    whyThisLead: row.whyThisLead,
    engagementScore: num(row.engagementScore),
    seen: row.seenAt !== null,
    newActivity: row.newActivity,
    replied: row.repliedAt !== null,
    repliedAt: iso(row.repliedAt),
    threadState: (row.threadState as Lead["threadState"]) ?? null,
    ourComments: row.ourComments,
    repliesToUs: row.repliesToUs,
    lastSyncedAt: iso(row.lastSyncedAt),
    replyStatus: row.replyStatus as Lead["replyStatus"],
    replyDraft: row.generatedReply,
    createdAt: row.createdAt.toISOString(),
  };
}

function toSentReply(row: EngagementReplyRow): SentReply {
  return {
    id: row.id,
    text: row.text,
    channel: row.channel === "api" ? "api" : "manual",
    url: row.permalink === null ? null : redditThreadUrl(row.permalink),
    sentAt: row.sentAt.toISOString(),
    tone: isReplyTone(row.tone) ? row.tone : null,
  };
}

function toBanMeter(reading: BanMeterReading, computedAt: Date | null): BanMeter {
  return {
    level: reading.level,
    promoRatio: reading.promoRatio,
    counts: reading.counts,
    sampleSize: reading.sampleSize,
    smallSample: reading.smallSample,
    windowDays: reading.windowDays,
    sendBlocked: sendBlockedBy(reading.level),
    computedAt: iso(computedAt),
  };
}

/** El medidor, **en código**, sobre las etiquetas guardadas. */
async function readBanMeter(
  tx: Transaction,
  companyId: string,
  now: Date,
): Promise<BanMeterReading> {
  const since = new Date(
    now.getTime() - BAN_METER_THRESHOLDS.windowDays * 24 * 3600 * 1000,
  );
  const rows = await engagementStore.listRepliesForMeter(tx, { companyId }, since);
  return computeBanMeter(
    rows.map((r) => ({ sentAt: r.sentAt, tone: isReplyTone(r.tone) ? r.tone : null })),
    now,
  );
}

/** Cuál es la única URL del comentario que se acepta al marcar a mano: uno de Reddit. */
function commentPermalinkFrom(url: string | undefined): string | null {
  if (url === undefined || url.trim() === "") return null;
  try {
    const u = new URL(url.trim());
    if (!/^(www\.|old\.|new\.)?reddit\.com$/i.test(u.hostname)) return null;
    return u.pathname.startsWith("/r/") ? u.pathname : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ *
 * Rutas
 * ------------------------------------------------------------------------ */

export function registerEngagementRoutes(
  app: ZodApp,
  deps: EngagementRouteDeps = defaultEngagementRouteDeps(),
): void {
  const { clock, idempotency } = app.deps;
  const fetchOpt = deps.fetch === undefined ? {} : { fetch: deps.fetch };

  const queueOr503 = (): Queue => {
    const queue = app.deps.queue;
    if (queue === undefined) {
      throw new ApiRejection(
        503,
        "service_unavailable",
        "The job queue is not available.",
      );
    }
    return queue;
  };

  async function enqueue<T>(
    request: FastifyRequest,
    queueName: string,
    payload: T,
    key: string,
  ): Promise<boolean> {
    const queue = app.deps.queue;
    if (queue === undefined) return false;
    try {
      const r = await queue.enqueue<T>({
        queue: queueName,
        payload,
        options: { singletonKey: key },
      });
      return r.created;
    } catch (error) {
      request.log.warn(
        { queue: queueName, code: isPortError(error) ? error.code : "unknown" },
        "engagement job not enqueued",
      );
      return false;
    }
  }

  const redirectUri = (): string =>
    redditRedirectUri(resolveRedirectBase(deps.env).origin);

  function redditAppView(config: RedditAppConfig | null): RedditApp {
    return {
      configured: config !== null,
      clientId: config?.clientId ?? null,
      hasSecret: config !== null,
      developerUsername: config?.developerUsername ?? null,
      redirectUri: redirectUri(),
      scopes: [...REDDIT_OAUTH.scopes],
      consoleUrl: REDDIT_OAUTH.consoleUrl,
      policyUrl: REDDIT_OAUTH.policyUrl,
    };
  }

  async function appConfigOr409(): Promise<RedditAppConfig> {
    const config = await deps.appStore.read();
    if (config === null) {
      throw reject(
        409,
        "conflict",
        "reddit_app_not_configured",
        "Add your Reddit app credentials first.",
      );
    }
    return config;
  }

  function oauthFor(config: RedditAppConfig): RedditOAuth {
    return new RedditOAuth({
      ...fetchOpt,
      userAgent: redditUserAgent(config.developerUsername),
    });
  }

  /**
   * El token vigente, refrescando si hace falta, con la fila bloqueada.
   * Lanza el 409 que corresponde si no hay cuenta usable.
   */
  async function accessTokenOrReject(
    request: FastifyRequest,
    config: RedditAppConfig,
  ): Promise<{ accessToken: string; account: RedditAccountRow }> {
    const companyId = request.auth.companyId;
    const scope = { companyId };
    const oauth = oauthFor(config);
    const creds = { clientId: config.clientId, clientSecret: config.clientSecret };
    return request.tx(async (tx) => {
      const row = await engagementStore.findRedditAccount(tx, scope, { lock: true });
      const result = await resolveRedditAccessToken({
        row,
        cipher: deps.cipher,
        now: clock.now(),
        refresh: (refreshToken) => oauth.refresh({ credentials: creds, refreshToken }),
        save: (u) => engagementStore.updateRedditTokens(tx, scope, u),
        markExpired: (reason) =>
          engagementStore.markRedditAccount(tx, scope, "expired", reason),
      });
      if (!result.ok || row === null) {
        const reason = result.ok ? "not_connected" : result.reason;
        if (reason === "unavailable") {
          throw reject(
            502,
            "service_unavailable",
            "reddit_unavailable",
            "Reddit is not answering right now. Try again in a minute.",
          );
        }
        throw reject(
          409,
          "conflict",
          reason === "reconnect_required"
            ? "reddit_reconnect_required"
            : "reddit_not_connected",
          reason === "reconnect_required"
            ? "Your Reddit connection expired. Reconnect it and try again."
            : "Connect a Reddit account first.",
        );
      }
      return { accessToken: result.accessToken, account: row };
    });
  }

  async function brandName(tx: Transaction, companyId: string): Promise<string> {
    const company = await companyRepository.load(tx, { companyId });
    return company?.name ?? "";
  }

  async function detailOf(
    tx: Transaction,
    companyId: string,
    lead: LeadRow,
  ): Promise<LeadDetail> {
    const scope = { companyId };
    const [settingsRow, account, replies, name, meter, appConfig] = await Promise.all([
      engagementStore.findSettings(tx, scope),
      engagementStore.findRedditAccount(tx, scope),
      engagementStore.listLeadReplies(tx, scope, lead.id),
      brandName(tx, companyId),
      readBanMeter(tx, companyId, clock.now()),
      deps.appStore.read().catch(() => null),
    ]);
    const settings = toSettings(settingsRow);
    const draft = lead.generatedReply ?? "";
    const issues: ReplyIssue[] = lintReply(draft, {
      brandName: name,
      allowLinks: settings.allowLinks,
    });
    let blocked: EngagementErrorReason | null = null;
    if (appConfig === null) blocked = "reddit_app_not_configured";
    else if (account === null || account.status === "revoked")
      blocked = "reddit_not_connected";
    else if (account.status === "expired") blocked = "reddit_reconnect_required";
    else if (sendBlockedBy(meter.level)) blocked = "ban_meter_danger";
    else if (blockingIssues(issues).length > 0) blocked = "reply_blocked";
    return {
      lead: toLead(lead),
      contextComments: lead.contextComments,
      replies: replies.map(toSentReply),
      draftIssues: issues,
      canSend: blocked === null,
      sendBlockedReason: blocked,
    };
  }

  async function leadOr404(
    tx: Transaction,
    companyId: string,
    leadId: string,
  ): Promise<LeadRow> {
    const lead = await engagementStore.findLead(tx, { companyId }, leadId);
    if (lead === null) throw leadNotFound();
    return lead;
  }

  // ── GET /engagement/overview ──
  app.get("/engagement/overview", async (request) => {
    const companyId = request.auth.companyId;
    const now = clock.now();
    const appConfig = await deps.appStore.read();
    const overview = await request.tx(async (tx): Promise<EngagementOverview> => {
      const scope = { companyId };
      const [settingsRow, account, meter, stored] = await Promise.all([
        engagementStore.findSettings(tx, scope),
        engagementStore.findRedditAccount(tx, scope),
        readBanMeter(tx, companyId, now),
        engagementStore.findBanAssessment(tx, scope),
      ]);
      const settings = toSettings(settingsRow);
      return {
        settings,
        configured: settingsRow !== null,
        redditApp: redditAppView(appConfig),
        account:
          account === null || account.status === "revoked"
            ? null
            : {
                username: account.username,
                status: account.status as "active" | "expired" | "revoked",
                statusReason: account.statusReason,
                scopes: account.scopes,
                connectedAt: account.createdAt.toISOString(),
              },
        discovery: {
          available:
            account?.status === "active" &&
            settings.discoveryEnabled &&
            settings.subreddits.length > 0,
          lastRunAt: iso(settingsRow?.lastDiscoveryAt ?? null),
          lastOutcome: settingsRow?.lastDiscoveryOutcome ?? null,
          pausedUntil: iso(settingsRow?.discoveryPausedUntil ?? null),
        },
        banMeter: toBanMeter(meter, stored?.computedAt ?? null),
      };
    });
    return data(overview);
  });

  // ── PUT /engagement/settings ──
  app.put(
    "/engagement/settings",
    { schema: { body: updateEngagementSettingsRequestSchema } },
    async (request) => {
      const body = request.body;
      const normalized = normalizeDiscoverySettings({
        subreddits: body.subreddits,
        keywords: body.keywords,
      });
      if (!normalized.ok) {
        throw new ApiRejection(
          400,
          "bad_request",
          normalized.field === "subreddits"
            ? "Some subreddits are not valid names, or there are too many."
            : "Some keywords are too short or too long, or there are too many.",
          {
            reason:
              normalized.field === "subreddits"
                ? "invalid_subreddits"
                : "invalid_keywords",
            invalid: normalized.invalid.slice(0, 20),
          },
        );
      }
      const row = await request.tx((tx) =>
        engagementStore.saveSettings(
          tx,
          { companyId: request.auth.companyId },
          {
            subreddits: [...normalized.subreddits],
            keywords: [...normalized.keywords],
            replyTone: body.replyTone,
            customRules: body.customRules.trim(),
            allowLinks: body.allowLinks,
            discoveryEnabled: body.discoveryEnabled,
          },
        ),
      );
      return data(toSettings(row));
    },
  );

  // ── PUT /engagement/reddit-app ──
  app.put(
    "/engagement/reddit-app",
    { schema: { body: updateRedditAppRequestSchema } },
    async (request) => {
      const body = request.body;
      const username = normalizeRedditUsername(body.developerUsername);
      if (username === null) {
        throw new ApiRejection(
          400,
          "bad_request",
          "That is not a valid Reddit username.",
        );
      }
      const current = await deps.appStore.read();
      const secret =
        body.clientSecret ??
        (current?.clientId === body.clientId ? current.clientSecret : undefined);
      if (secret === undefined) {
        throw new ApiRejection(
          400,
          "bad_request",
          "The client secret is required for a new app.",
        );
      }
      const next: RedditAppConfig = {
        clientId: body.clientId,
        clientSecret: secret,
        developerUsername: username,
      };
      await deps.appStore.write(next);
      return data(redditAppView(next));
    },
  );

  // ── DELETE /engagement/reddit-app ──
  app.delete("/engagement/reddit-app", async (_request, reply) => {
    await deps.appStore.write(null);
    return reply.status(204).send();
  });

  // ── GET /engagement/reddit/authorize ──
  app.get("/engagement/reddit/authorize", async (request) => {
    const config = await appConfigOr409();
    const companyId = request.auth.companyId;
    const nonce = deps.nonce();
    const { state, expiresAt } = await issueRedditState(deps.signer, {
      companyId,
      nonce,
      now: clock.now(),
    });
    deps.nonces.put(nonce, companyId, expiresAt);
    const url = oauthFor(config).authorizeUrl({
      clientId: config.clientId,
      redirectUri: redirectUri(),
      state,
      scopes: REDDIT_OAUTH.scopes,
    });
    return data({ url });
  });

  // ── POST /engagement/reddit/callback ──
  app.post(
    "/engagement/reddit/callback",
    { schema: { body: redditCallbackRequestSchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const body = request.body;
      const now = clock.now();
      const verdict = await verifyRedditState(deps.signer, {
        state: body.state,
        companyId,
        now,
      });
      if (!verdict.ok) {
        request.log.info({ why: verdict.reason }, "reddit oauth state rejected");
        throw verdict.reason === "wrong_brand"
          ? reject(
              400,
              "bad_request",
              "oauth_state_wrong_brand",
              "This login was started from another brand. Switch back to it and try again.",
            )
          : reject(
              400,
              "bad_request",
              "oauth_state_invalid",
              "This login link expired or was already used. Try connecting again.",
            );
      }
      if (!deps.nonces.take(verdict.nonce, companyId, now.getTime())) {
        throw reject(
          400,
          "bad_request",
          "oauth_state_invalid",
          "This login link expired or was already used. Try connecting again.",
        );
      }
      if (body.error !== undefined || body.code === undefined) {
        throw reject(400, "bad_request", "oauth_denied", "Reddit did not grant access.");
      }
      const config = await appConfigOr409();
      let granted;
      try {
        granted = await oauthFor(config).exchangeCode({
          credentials: { clientId: config.clientId, clientSecret: config.clientSecret },
          code: body.code,
          redirectUri: redirectUri(),
        });
      } catch (error) {
        request.log.warn(
          { code: isPortError(error) ? error.code : "unknown" },
          "reddit code exchange failed",
        );
        throw reject(
          502,
          "service_unavailable",
          isPortError(error) &&
            (error.code === "unauthorized" || error.code === "bad_request")
            ? "reddit_rejected"
            : "reddit_unavailable",
          "Reddit did not accept the login. Check the app credentials and the redirect URI.",
        );
      }
      const values = {
        redditUserId: granted.identity.id,
        username: granted.identity.username,
        accessToken: await deps.cipher.encrypt(granted.tokens.accessToken),
        refreshToken:
          granted.tokens.refreshToken === null
            ? null
            : await deps.cipher.encrypt(granted.tokens.refreshToken),
        tokenExpiry: granted.tokens.expiresAt,
        scopes: granted.tokens.scopes,
      };
      await request.tx((tx) =>
        engagementStore.saveRedditAccount(tx, { companyId }, values),
      );
      return data({ username: granted.identity.username });
    },
  );

  // ── DELETE /engagement/reddit/account ──
  app.delete("/engagement/reddit/account", async (request, reply) => {
    const companyId = request.auth.companyId;
    const row = await request.tx((tx) =>
      engagementStore.findRedditAccount(tx, { companyId }),
    );
    if (row !== null && row.refreshToken !== null) {
      const config = await deps.appStore.read().catch(() => null);
      if (config !== null) {
        const token = await deps.cipher.decrypt(row.refreshToken).catch(() => null);
        if (token !== null) {
          // De mejor esfuerzo: los tokens se borran de acá igual.
          void oauthFor(config)
            .revoke({
              credentials: {
                clientId: config.clientId,
                clientSecret: config.clientSecret,
              },
              token,
              hint: "refresh_token",
            })
            .catch(() => undefined);
        }
      }
    }
    await request.tx((tx) =>
      engagementStore.markRedditAccount(
        tx,
        { companyId },
        "revoked",
        "disconnected_by_user",
      ),
    );
    return reply.status(204).send();
  });

  // ── POST /engagement/discover ──
  app.post("/engagement/discover", async (request, reply) => {
    const queue = queueOr503();
    const companyId = request.auth.companyId;
    const account = await request.tx((tx) =>
      engagementStore.findRedditAccount(tx, { companyId }),
    );
    if (account === null || account.status !== "active") {
      throw reject(
        409,
        "conflict",
        "reddit_not_connected",
        "Connect a Reddit account to discover leads.",
      );
    }
    const now = clock.now();
    const r = await queue.enqueue<LeadDiscoveryJob>({
      queue: JOB_QUEUES.redditLeadDiscovery,
      payload: { kind: "discover", companyId },
      // Un pedido por minuto como mucho: el botón no puede saltarse el límite de Reddit.
      options: {
        singletonKey: `engagement-discover:${companyId}:${Math.floor(now.getTime() / 60_000)}`,
      },
    });
    return reply.status(202).send(data({ queued: r.created }));
  });

  // ── GET /engagement/leads ──
  app.get(
    "/engagement/leads",
    { schema: { querystring: leadListQuerySchema } },
    async (request) => {
      const q = request.query;
      const result = await request.tx((tx) =>
        engagementStore.listLeads(
          tx,
          { companyId: request.auth.companyId },
          {
            view: q.view,
            unseenOnly: q.unseen === "true",
            q: q.q,
            limit: q.limit,
            offset: q.offset,
          },
        ),
      );
      return data({ items: result.items.map(toLead), hasMore: result.hasMore });
    },
  );

  // ── POST /engagement/leads ── (a mano)
  app.post(
    "/engagement/leads",
    { schema: { body: createManualLeadRequestSchema } },
    async (request, reply) => {
      const body = request.body;
      const parsed = parseRedditPostUrl(body.url);
      if (parsed === null) {
        throw reject(
          400,
          "bad_request",
          "invalid_reddit_url",
          "Paste the link of a Reddit post (reddit.com/r/…/comments/…).",
        );
      }
      const companyId = request.auth.companyId;
      const url = new URL(body.url.trim());
      const { lead, created } = await request.tx((tx) =>
        engagementStore.upsertManualLead(
          tx,
          { companyId },
          {
            source: "manual",
            redditPostId: parsed.postId,
            subreddit: parsed.subreddit,
            title: body.title,
            body: body.body ?? null,
            author: null,
            score: 0,
            permalink: url.pathname,
            engagementScore: String(engagementScoreOf({ score: 0, numComments: 0 })),
          },
        ),
      );
      if (created || lead.scoreStatus !== "scored") {
        await enqueue<LeadDiscoveryJob>(
          request,
          JOB_QUEUES.redditLeadDiscovery,
          { kind: "score", companyId, leadId: lead.id },
          `engagement-score:${lead.id}:${clock.nowMs()}`,
        );
      }
      return reply.status(created ? 201 : 200).send(data(toLead(lead)));
    },
  );

  // ── GET /engagement/leads/:leadId ──
  app.get(
    "/engagement/leads/:leadId",
    { schema: { params: leadParams } },
    async (request) => {
      const companyId = request.auth.companyId;
      const detail = await request.tx(async (tx) =>
        detailOf(tx, companyId, await leadOr404(tx, companyId, request.params.leadId)),
      );
      return data(detail);
    },
  );

  // ── DELETE /engagement/leads/:leadId ──
  app.delete(
    "/engagement/leads/:leadId",
    { schema: { params: leadParams } },
    async (request, reply) => {
      const ok = await request.tx((tx) =>
        engagementStore.softDeleteLead(
          tx,
          { companyId: request.auth.companyId },
          request.params.leadId,
          clock.now(),
        ),
      );
      if (!ok) throw leadNotFound();
      return reply.status(204).send();
    },
  );

  // ── POST /engagement/leads/:leadId/seen ──
  app.post(
    "/engagement/leads/:leadId/seen",
    { schema: { params: leadParams } },
    async (request) => {
      const row = await request.tx((tx) =>
        engagementStore.updateLead(
          tx,
          { companyId: request.auth.companyId },
          request.params.leadId,
          {
            seenAt: clock.now(),
            newActivity: false,
          },
        ),
      );
      if (row === null) throw leadNotFound();
      return data(toLead(row));
    },
  );

  // ── POST /engagement/leads/:leadId/reply/generate ──
  app.post(
    "/engagement/leads/:leadId/reply/generate",
    { schema: { params: leadParams, body: generateReplyRequestSchema } },
    async (request, reply) => {
      const queue = queueOr503();
      const companyId = request.auth.companyId;
      const leadId = request.params.leadId;
      const row = await request.tx(async (tx) => {
        await leadOr404(tx, companyId, leadId);
        return engagementStore.updateLead(tx, { companyId }, leadId, {
          replyStatus: "generating",
          replyError: null,
        });
      });
      if (row === null) throw leadNotFound();
      await queue.enqueue<LeadDiscoveryJob>({
        queue: JOB_QUEUES.redditLeadDiscovery,
        payload: {
          kind: "reply",
          companyId,
          leadId,
          regenerate: request.body.regenerate,
        },
        // El instante en la clave: dos «Regenerate» seguidos son dos pedidos (trampa 45).
        options: { singletonKey: `engagement-reply:${leadId}:${clock.nowMs()}` },
      });
      return reply.status(202).send(data(toLead(row)));
    },
  );

  // ── PUT /engagement/leads/:leadId/reply ──
  app.put(
    "/engagement/leads/:leadId/reply",
    { schema: { params: leadParams, body: saveReplyDraftRequestSchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const detail = await request.tx(async (tx) => {
        await leadOr404(tx, companyId, request.params.leadId);
        const row = await engagementStore.updateLead(
          tx,
          { companyId },
          request.params.leadId,
          {
            generatedReply: request.body.text,
            replyStatus: "ready",
          },
        );
        if (row === null) throw leadNotFound();
        return detailOf(tx, companyId, row);
      });
      return data(detail);
    },
  );

  /** Registra la respuesta enviada y encola lo que sigue (tono → medidor, seguimiento). */
  async function recordSent(
    request: FastifyRequest,
    lead: LeadRow,
    sent: {
      readonly text: string;
      readonly channel: "api" | "manual";
      readonly commentName: string | null;
      readonly permalink: string | null;
    },
  ): Promise<SendReplyResult> {
    const companyId = request.auth.companyId;
    const now = clock.now();
    const result = await request.tx(async (tx) => {
      const replyRow = await engagementStore.insertReply(
        tx,
        { companyId },
        {
          leadId: lead.id,
          text: sent.text,
          channel: sent.channel,
          redditCommentName: sent.commentName,
          permalink: sent.permalink,
          sentAt: now,
        },
      );
      const updated = await engagementStore.updateLead(tx, { companyId }, lead.id, {
        repliedAt: now,
        threadState: "tracking",
        generatedReply: sent.text,
        seenAt: lead.seenAt ?? now,
      });
      return { replyRow, updated: updated ?? lead };
    });
    await enqueue<BanRiskJob>(
      request,
      JOB_QUEUES.banRiskComputation,
      { kind: "compute", companyId },
      `engagement-ban:${companyId}:${now.getTime()}`,
    );
    if (sent.channel === "api") {
      await enqueue<ThreadMonitoringJob>(
        request,
        JOB_QUEUES.redditThreadMonitoring,
        { kind: "sync", companyId, leadId: lead.id },
        `engagement-sync:${lead.id}:${now.getTime()}`,
      );
    }
    return { reply: toSentReply(result.replyRow), lead: toLead(result.updated) };
  }

  // ── POST /engagement/leads/:leadId/send ──
  app.post(
    "/engagement/leads/:leadId/send",
    {
      schema: {
        params: leadParams,
        body: sendReplyRequestSchema,
        headers: idempotencyHeaderSchema,
      },
    },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const leadId = request.params.leadId;
      const text = request.body.text.trim();
      // Todo lo que puede rechazar va **antes** de gastar la Idempotency-Key.
      const { lead, name, settings, meter } = await request.tx(async (tx) => ({
        lead: await leadOr404(tx, companyId, leadId),
        name: await brandName(tx, companyId),
        settings: toSettings(await engagementStore.findSettings(tx, { companyId })),
        meter: await readBanMeter(tx, companyId, clock.now()),
      }));
      if (sendBlockedBy(meter.level)) {
        throw reject(
          409,
          "conflict",
          "ban_meter_danger",
          "Your ban meter is in Danger: stop replying through FastGram and let the account recover.",
        );
      }
      const issues = blockingIssues(
        lintReply(text, { brandName: name, allowLinks: settings.allowLinks }),
      );
      if (issues.length > 0) {
        throw new ApiRejection(409, "conflict", "Fix the reply before sending it.", {
          reason: "reply_blocked",
          issues,
        });
      }
      const config = await appConfigOr409();
      const { accessToken } = await accessTokenOrReject(request, config);

      return withIdempotency(
        idempotency,
        request,
        reply,
        {
          key: idempotencyKeyOf({ ...request.headers }),
          route: "POST /engagement/leads/:leadId/send",
          body: { leadId, text },
          successStatus: 201,
        },
        async () => {
          const api = new RedditApi({
            ...fetchOpt,
            userAgent: redditUserAgent(config.developerUsername),
            accessToken,
          });
          let posted;
          try {
            posted = await api.postComment(`t3_${lead.redditPostId}`, text);
          } catch (error) {
            const code = isPortError(error) ? error.code : "unknown";
            const codes =
              isPortError(error) &&
              typeof error.cause === "object" &&
              error.cause !== null
                ? ((error.cause as { codes?: unknown }).codes ?? [])
                : [];
            request.log.warn({ leadId, code, codes }, "reddit comment not posted");
            if (
              Array.isArray(codes) &&
              codes.some((c) => c === "THREAD_LOCKED" || c === "TOO_OLD")
            ) {
              throw reject(
                409,
                "conflict",
                "lead_locked",
                "This thread no longer accepts comments.",
              );
            }
            if (code === "rate_limited") {
              throw reject(
                429,
                "rate_limited",
                "reddit_rate_limited",
                "Reddit is rate limiting this account. Wait a few minutes.",
              );
            }
            if (code === "unauthorized") {
              await request.tx((tx) =>
                engagementStore.markRedditAccount(
                  tx,
                  { companyId },
                  "expired",
                  "post_unauthorized",
                ),
              );
              throw reject(
                409,
                "conflict",
                "reddit_reconnect_required",
                "Your Reddit connection expired. Reconnect it and try again.",
              );
            }
            if (code === "timeout") {
              throw reject(
                502,
                "service_unavailable",
                "reddit_unavailable",
                "Reddit did not answer in time. The comment may have been posted: check the thread before trying again.",
              );
            }
            throw reject(
              502,
              "service_unavailable",
              code === "bad_request" || code === "forbidden"
                ? "reddit_rejected"
                : "reddit_unavailable",
              "Reddit did not accept the comment.",
            );
          }
          return recordSent(request, lead, {
            text,
            channel: "api",
            commentName: posted.data.name,
            permalink: posted.data.permalink,
          });
        },
      );
    },
  );

  // ── POST /engagement/leads/:leadId/mark-sent ── («Copy & open thread»)
  app.post(
    "/engagement/leads/:leadId/mark-sent",
    {
      schema: {
        params: leadParams,
        body: markSentRequestSchema,
        headers: optionalIdempotencyHeaderSchema,
      },
    },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const lead = await request.tx((tx) =>
        leadOr404(tx, companyId, request.params.leadId),
      );
      const run = () =>
        recordSent(request, lead, {
          text: request.body.text.trim(),
          channel: "manual",
          commentName: null,
          permalink: commentPermalinkFrom(request.body.commentUrl),
        });
      const key = idempotencyKeyOf({ ...request.headers });
      if (key === "") return reply.status(201).send(data(await run()));
      return withIdempotency(
        idempotency,
        request,
        reply,
        {
          key,
          route: "POST /engagement/leads/:leadId/mark-sent",
          body: request.body,
          successStatus: 201,
        },
        run,
      );
    },
  );

  // ── POST /engagement/leads/:leadId/sync ──
  app.post(
    "/engagement/leads/:leadId/sync",
    { schema: { params: leadParams } },
    async (request, reply) => {
      const queue = queueOr503();
      const companyId = request.auth.companyId;
      const leadId = request.params.leadId;
      const account = await request.tx(async (tx) => {
        await leadOr404(tx, companyId, leadId);
        return engagementStore.findRedditAccount(tx, { companyId });
      });
      if (account === null || account.status !== "active") {
        throw reject(
          409,
          "conflict",
          "reddit_not_connected",
          "Connect a Reddit account to sync threads.",
        );
      }
      const r = await queue.enqueue<ThreadMonitoringJob>({
        queue: JOB_QUEUES.redditThreadMonitoring,
        payload: { kind: "sync", companyId, leadId },
        options: {
          singletonKey: `engagement-sync:${leadId}:${Math.floor(clock.nowMs() / 30_000)}`,
        },
      });
      return reply.status(202).send(data({ queued: r.created }));
    },
  );

  // ── POST /engagement/ban-meter/refresh ──
  app.post("/engagement/ban-meter/refresh", async (request) => {
    const companyId = request.auth.companyId;
    const now = clock.now();
    const reading = await request.tx(async (tx) => {
      const r = await readBanMeter(tx, companyId, now);
      await engagementStore.saveBanAssessment(
        tx,
        { companyId },
        {
          level: r.level,
          promoRatio: r.promoRatio === null ? null : String(r.promoRatio),
          recommendation: banMeterRecommendation(r.level),
          computedAt: now,
          sampleSize: r.sampleSize,
          counts: r.counts,
          windowDays: r.windowDays,
          smallSample: r.smallSample,
        },
      );
      return r;
    });
    if (reading.counts.unlabeled > 0) {
      await enqueue<BanRiskJob>(
        request,
        JOB_QUEUES.banRiskComputation,
        { kind: "compute", companyId },
        `engagement-ban:${companyId}:${now.getTime()}`,
      );
    }
    return data(toBanMeter(reading, now));
  });
}
