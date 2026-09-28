/**
 * Anuncios pagos con la Marketing API de Meta — sprint 9 (agente R),
 * `PU-S9-012`/`013`, `D-21`. Contrato y lista de rutas en
 * `packages/contracts/src/resources/ads.ts`.
 *
 * La lógica está en `packages/core/src/ads` (topes, confirmación, guardia,
 * A/B, métricas), el I/O en `packages/adapters/src/ads` (Meta y el doble) y
 * `packages/db/src/repositories/ads.ts`. Acá se cablea.
 *
 * ## `D-21`, en el orden en que se hace cumplir
 *
 * 1. **Todo nace pausado**: el puerto no tiene por dónde pedir otra cosa.
 * 2. **Activar exige un preview reciente** (`POST …/activation-preview` →
 *    token de 5 min atado a la campaña, la acción y los topes). Sin token,
 *    vencido, usado o con topes distintos → `409 conflict` con
 *    `details.reason`. Subir un tope de una campaña **activa**, igual.
 * 3. **La guardia** (`core/ads/guard.ts`) corre en el worker cada 30 min y en
 *    `POST /ads/sync`, con el mismo código.
 *
 * ## Orden de las escrituras al activar (el que deja a la guardia mirando)
 *
 * La base pasa a `ACTIVE` **antes** de prender nada en Meta, en su propia
 * transacción. Si Meta falla, se vuelve a `PAUSED`. El orden inverso tiene un
 * hueco: Meta prendida y un commit que falla dejan una campaña gastando que la
 * guardia no mira (sólo evalúa las `ACTIVE`). Con este orden, el peor caso es
 * una fila `ACTIVE` con Meta en pausa, que la guardia evalúa de más sin daño.
 * Pausar es al revés: primero Meta, después la base.
 *
 * ## Decisiones que el PRD no cubre
 *
 * - La conexión de anuncios es **otra** que la de publicar (`ad_accounts`, no
 *   `connections`), con la misma app de Meta (credenciales de `facebook` en
 *   Settings → Integrations) y su propio redirect:
 *   `{FASTGRAM_PUBLIC_URL|localhost:3000}/ads/connect/callback`, que hay que
 *   sumar a *Valid OAuth Redirect URIs* de la app.
 * - **Modo demo** (`POST /ads/connection/demo`): la marca usa el adaptador en
 *   memoria. Todo el circuito anda y ningún gasto es posible. Una conexión
 *   real lo reemplaza.
 * - Desconectar con campañas `ACTIVE` → 409: sin token no se las podría pausar.
 * - Si falla un paso a mitad de la creación en Meta, no se guarda nada: lo
 *   creado queda **pausado** en la cuenta (sin gasto) y el error vuelve.
 * - A/B: una variante (conjunto) por pieza, el diario repartido en partes
 *   iguales; además se intenta un `ad_study` de Meta (reparto de audiencia sin
 *   solapamiento). Si Meta lo rechaza, el A/B corre igual con nuestra regla y
 *   queda anotado. Sin fin programado, el estudio dura 7 días (elección nuestra).
 * - El ganador se calcula al leer (no se persiste todavía).
 */
import { randomBytes } from "node:crypto";

import {
  activateAdCampaignRequestSchema,
  activationPreviewRequestSchema,
  adsCallbackRequestSchema,
  adsDashboardQuerySchema,
  createAdCampaignRequestSchema,
  selectAdAccountRequestSchema,
  updateAdBudgetRequestSchema,
  type ActivationPreview,
  type AdCampaignDetail,
  type AdCampaignSummary,
  type AdConnection,
  type AdConnectionOptions,
  type AdMetrics,
  type AdsDashboard,
  type AdsSyncResult,
  type AdTargetingInput,
} from "@fastgram/contracts";
import {
  ACTIVATION_PREVIEW_TTL_MS,
  ADS_SYNC_INTERVAL_MINUTES,
  AB_MIN_EVENTS,
  AB_MIN_IMPRESSIONS,
  DEFAULT_RESULT_ACTION_TYPE,
  budgetChangeAllowed,
  capsIncrease,
  DEFAULT_NOTIFICATION_SETTINGS,
  checkConfirmation,
  consumeOAuthState,
  dateInZone,
  derivedAdMetrics,
  describeAdCapEvent,
  evaluateAbTest,
  isIntegrationConfigured,
  issueOAuthState,
  maxPossibleSpend,
  parseNotificationSettings,
  resolveRedirectBase,
  shouldPush,
  splitDailyBudget,
  sumAdInsights,
  summarizeAnalytics,
  syncAndGuard,
  validateCaps,
  type AbOutcome,
  type AdsSyncStore,
  type ConfirmableAction,
  type DailyInsight,
  type NotificationSettings,
  type SpendCaps,
} from "@fastgram/core";
import {
  MemoryOAuthStateLedger,
  canonicalObjectUrl,
  createLocalOAuthKit,
  notificationSettingsFile,
  randomNonce,
} from "@fastgram/adapters";
import { publicMediaUrlsFromEnv } from "@fastgram/adapters/public-media";
import {
  FAKE_AD_ACCOUNT,
  FAKE_AD_PAGE,
  FakeAdsPlatform,
  MetaAdsPlatform,
  exchangeMetaAdsCode,
  metaAdsAuthorizeUrl,
} from "@fastgram/adapters/ads";
import {
  adAccountRepository,
  adActionRepository,
  adCampaignRepository,
  adInsightsRepository,
  adsSyncStore,
  companyRepository,
  contentRepository,
  insertNotification,
  metricsStore,
  type AdAccountRow,
  type AdCampaignRow,
  type AdCampaignTree,
  type AdInsightDailyRow,
  type Transaction,
} from "@fastgram/db";
import {
  isAdsPlatformError,
  isPublicMediaUnavailable,
  type AdTargeting,
  type AdsAuth,
  type AdsPlatform,
  type IntegrationStore,
  type OAuthStateLedger,
  type PublicMediaUrls,
  type StateSigner,
  type Storage,
  type TokenCipher,
} from "@fastgram/ports";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import { ApiRejection } from "../../http/errors.js";
import { data } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

/* ------------------------------------------------------------------------ *
 * Dependencias
 * ------------------------------------------------------------------------ */

/** El callback del login de anuncios en la web (ver la cabecera). */
export const ADS_CALLBACK_PATH = "/ads/connect/callback";
/** Sin fin programado, un `ad_study` de Meta dura esto. */
export const AD_STUDY_DEFAULT_DAYS = 7;
/** Tope de bytes de una imagen que se sube a `adimages` (se lee a memoria). */
export const AD_IMAGE_MAX_BYTES = 30 * 1024 * 1024;

export interface NotificationSettingsSource {
  read(): Promise<unknown>;
}

export interface AdsRouteDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly integrations: IntegrationStore;
  readonly cipher: TokenCipher;
  readonly signer: StateSigner;
  readonly ledger: OAuthStateLedger;
  readonly nonce: () => string;
  readonly meta: AdsPlatform;
  /** Una instancia por proceso: el modo demo recuerda lo creado mientras vive. */
  readonly fake: AdsPlatform;
  readonly exchangeCode: typeof exchangeMetaAdsCode;
  readonly publicMedia: PublicMediaUrls;
  readonly notificationSettings: NotificationSettingsSource;
  readonly token: () => string;
}

/**
 * El doble del modo demo, uno por proceso: recuerda lo creado mientras la API
 * vive. Exportado para que la suite de integración le cargue insights.
 */
export const DEMO_ADS_PLATFORM = new FakeAdsPlatform();

export function defaultAdsRouteDeps(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AdsRouteDeps {
  const kit = createLocalOAuthKit(env);
  const version = env["ADS_META_GRAPH_VERSION"]?.trim();
  return {
    env,
    integrations: kit.integrations,
    cipher: kit.cipher,
    signer: kit.signer,
    ledger: new MemoryOAuthStateLedger(),
    nonce: randomNonce,
    meta: new MetaAdsPlatform(
      version === undefined || version === "" ? {} : { graphVersion: version },
    ),
    fake: DEMO_ADS_PLATFORM,
    exchangeCode: exchangeMetaAdsCode,
    publicMedia: publicMediaUrlsFromEnv(env),
    notificationSettings: notificationSettingsFile(env),
    token: () => randomBytes(24).toString("base64url"),
  };
}

/* ------------------------------------------------------------------------ *
 * Helpers puros (probados en `ads.test.ts`)
 * ------------------------------------------------------------------------ */

const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/iu;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/iu;

/** Video o imagen según la extensión del archivo de la pieza. */
export function mediaKindOfUrl(url: string): "video" | "image" | null {
  let path = url;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    // no es una URL absoluta: se mira tal cual
  }
  if (VIDEO_EXT.test(path)) return "video";
  if (IMAGE_EXT.test(path)) return "image";
  return null;
}

/** Un error de Meta → la respuesta HTTP, con el motivo estable en `details`. */
export function adsRejection(error: unknown): ApiRejection | null {
  if (!isAdsPlatformError(error)) return null;
  const details = { reason: error.reason };
  switch (error.reason) {
    case "unauthorized":
      return new ApiRejection(409, "conflict", "Reconnect the ad account.", details);
    case "permission_missing":
      return new ApiRejection(
        409,
        "conflict",
        "The ad account connection is missing a permission. Reconnect it.",
        details,
      );
    case "account_disabled":
      return new ApiRejection(
        409,
        "conflict",
        "The ad account is disabled or restricted.",
        details,
      );
    case "rate_limited":
      return new ApiRejection(
        429,
        "rate_limited",
        "Meta asked to slow down. Try again later.",
        {
          ...details,
          ...(error.retryAfterSeconds === undefined
            ? {}
            : { retryAfterMs: error.retryAfterSeconds * 1000 }),
        },
      );
    case "invalid_parameter":
    case "budget_too_low":
    case "media_rejected":
      return new ApiRejection(400, "bad_request", error.message, details);
    case "not_found":
      return new ApiRejection(
        409,
        "conflict",
        "Meta doesn't know this object anymore.",
        details,
      );
    case "provider_unavailable":
    case "unexpected_response":
      return new ApiRejection(
        503,
        "service_unavailable",
        "Meta didn't answer. Try again.",
        details,
      );
  }
}

const reject = (
  status: number,
  code: "bad_request" | "conflict" | "not_found" | "service_unavailable",
  reason: string,
  message: string,
) => new ApiRejection(status, code, message, { reason });

function toMetrics(totals: ReturnType<typeof sumAdInsights>): AdMetrics {
  const d = derivedAdMetrics(totals);
  return {
    spendMinor: totals.spendMinor,
    impressions: totals.impressions,
    clicks: totals.clicks,
    results: totals.results,
    resultValueMinor: totals.resultValueMinor,
    ...d,
  };
}

function toDaily(row: AdInsightDailyRow): DailyInsight {
  const rec = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (typeof v !== "object" || v === null) return out;
    for (const [k, n] of Object.entries(v as Record<string, unknown>))
      if (typeof n === "number" && Number.isFinite(n)) out[k] = n;
    return out;
  };
  return {
    spendMinor: row.spendMinor,
    impressions: row.impressions,
    clicks: row.clicks,
    actions: rec(row.actions),
    actionValuesMinor: rec(row.actionValuesMinor),
  };
}

function byDay(
  rows: readonly AdInsightDailyRow[],
  resultType: (campaignId: string) => string | null,
) {
  const days = new Map<
    string,
    { spendMinor: number; impressions: number; clicks: number; results: number | null }
  >();
  for (const r of rows) {
    const d = days.get(r.date) ?? {
      spendMinor: 0,
      impressions: 0,
      clicks: 0,
      results: null,
    };
    const type = resultType(r.campaignId);
    d.spendMinor += r.spendMinor;
    d.impressions += r.impressions;
    d.clicks += r.clicks;
    if (type !== null) d.results = (d.results ?? 0) + (toDaily(r).actions[type] ?? 0);
    days.set(r.date, d);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }));
}

function experimentOf(
  tree: AdCampaignTree,
  insights: readonly AdInsightDailyRow[],
): AbOutcome | null {
  if (tree.experiment === null) return null;
  const type = tree.campaign.resultActionType;
  const adSetOfAd = new Map(tree.ads.map((a) => [a.id, a.adSetId]));
  return evaluateAbTest(
    tree.adSets.map((s) => {
      const rows = insights.filter((r) => adSetOfAd.get(r.adId) === s.id).map(toDaily);
      const t = sumAdInsights(rows, type);
      return {
        variantId: s.id,
        impressions: t.impressions,
        clicks: t.clicks,
        results: t.results ?? 0,
        spendMinor: t.spendMinor,
      };
    }),
    tree.experiment.metric,
  );
}

/** El targeting del contrato sin claves `undefined` (`exactOptionalPropertyTypes`). */
export function targetingOf(t: AdTargetingInput): AdTargeting {
  return {
    countries: t.countries,
    ...(t.ageMin === undefined ? {} : { ageMin: t.ageMin }),
    ...(t.ageMax === undefined ? {} : { ageMax: t.ageMax }),
    ...(t.interestIds === undefined ? {} : { interestIds: t.interestIds }),
  };
}

const ms = (d: Date | null): number | null => (d === null ? null : d.getTime());

/* ------------------------------------------------------------------------ *
 * Rutas
 * ------------------------------------------------------------------------ */

const idParams = z.object({ id: z.string().uuid() });

export function registerAdsRoutes(
  app: ZodApp,
  deps: AdsRouteDeps = defaultAdsRouteDeps(),
): void {
  const { clock } = app.deps;
  const storage: Storage = app.deps.storage;
  const now = () => clock.now();
  const redirectUri = () => `${resolveRedirectBase(deps.env).origin}${ADS_CALLBACK_PATH}`;

  const platformFor = (account: AdAccountRow): AdsPlatform =>
    account.provider === "fake" ? deps.fake : deps.meta;

  async function facebookApp() {
    const snapshot = await deps.integrations.read();
    const cfg = snapshot.apps.facebook;
    return isIntegrationConfigured(cfg) && cfg !== undefined ? cfg : null;
  }

  async function loadAccount(request: FastifyRequest): Promise<AdAccountRow | null> {
    const companyId = request.auth.companyId;
    return request.tx((tx) => adAccountRepository.load(tx, { companyId }));
  }

  async function tokenOf(account: AdAccountRow): Promise<string> {
    if (account.provider === "fake") return "demo";
    if (account.accessToken === null)
      throw reject(409, "conflict", "ads_not_connected", "Connect an ad account first.");
    return deps.cipher.decrypt(account.accessToken);
  }

  /** La cuenta activa con su token y su plataforma, o 409. */
  async function activeAccount(request: FastifyRequest) {
    const account = await loadAccount(request);
    if (
      account?.status !== "active" ||
      account.adAccountId === null ||
      account.currency === null
    )
      throw reject(409, "conflict", "ads_not_connected", "Connect an ad account first.");
    const auth: AdsAuth = {
      accessToken: await tokenOf(account),
      adAccountId: account.adAccountId,
    };
    return { account, auth, platform: platformFor(account), currency: account.currency };
  }

  /** Corre `fn` y traduce un error de Meta; un token vencido marca la cuenta. */
  async function viaPlatform<T>(
    request: FastifyRequest,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      if (isPublicMediaUnavailable(error))
        throw reject(409, "conflict", "public_media_unavailable", error.message);
      const rejection = adsRejection(error);
      if (rejection === null) throw error;
      if (isAdsPlatformError(error) && error.reason === "unauthorized") {
        const companyId = request.auth.companyId;
        await request.tx((tx) =>
          adAccountRepository.setStatus(tx, { companyId }, "expired", now()),
        );
      }
      request.log.warn(
        {
          reason: isAdsPlatformError(error) ? error.reason : "unknown",
          companyId: request.auth.companyId,
        },
        "ads platform call failed",
      );
      throw rejection;
    }
  }

  async function connectionView(request: FastifyRequest): Promise<AdConnection> {
    const account = await loadAccount(request);
    const appConfigured = (await facebookApp()) !== null;
    const base = { redirectUri: redirectUri(), appConfigured };
    if (account === null)
      return {
        status: "none",
        demo: false,
        adAccount: null,
        page: null,
        instagram: null,
        tokenExpiresAt: null,
        ...base,
      };
    return {
      status: account.status,
      demo: account.provider === "fake",
      adAccount:
        account.adAccountId === null || account.currency === null
          ? null
          : {
              id: account.adAccountId,
              name: account.adAccountName ?? account.adAccountId,
              currency: account.currency,
              timezoneName: account.timezoneName,
            },
      page:
        account.pageId === null
          ? null
          : { id: account.pageId, name: account.pageName ?? account.pageId },
      instagram:
        account.instagramUserId === null
          ? null
          : { id: account.instagramUserId, username: account.instagramUsername },
      tokenExpiresAt: ms(account.tokenExpiresAt),
      ...base,
    };
  }

  async function spendOf(
    tx: Transaction,
    companyId: string,
    c: AdCampaignRow,
    tz: string | null,
  ) {
    return adInsightsRepository.spendOf(tx, { companyId }, c.id, dateInZone(now(), tz));
  }

  async function summaryOf(
    tx: Transaction,
    companyId: string,
    c: AdCampaignRow,
    tz: string | null,
    hasExperiment: boolean,
  ): Promise<AdCampaignSummary> {
    const spend = await spendOf(tx, companyId, c, tz);
    return {
      id: c.id,
      name: c.name,
      objective: c.objective,
      status: c.status,
      pausedReason: c.pausedReason,
      isTest: c.isTest,
      currency: c.currency,
      dailyCapMinor: c.dailyCapMinor,
      totalCapMinor: c.totalCapMinor,
      spentTodayMinor: spend.todayMinor,
      spentTotalMinor: spend.totalMinor,
      endTime: ms(c.endTime),
      hasExperiment,
      lastSyncedAt: ms(c.lastSyncedAt),
      lastSyncError: c.lastSyncError,
      createdAt: c.createdAt.getTime(),
    };
  }

  async function detailOf(
    request: FastifyRequest,
    id: string,
  ): Promise<AdCampaignDetail> {
    const companyId = request.auth.companyId;
    const scope = { companyId };
    const out = await request.tx(async (tx) => {
      const tree = await adCampaignRepository.load(tx, scope, id);
      if (tree === null) return null;
      const account = await adAccountRepository.load(tx, scope);
      const tz = account?.timezoneName ?? null;
      const insights = await adInsightsRepository.list(tx, scope, { campaignIds: [id] });
      const actions = await adActionRepository.list(tx, scope, id);
      const thumbs = new Map<string, string | null>();
      for (const ad of tree.ads) {
        if (ad.contentId === null || thumbs.has(ad.contentId)) continue;
        const content = await contentRepository.findById(tx, scope, ad.contentId);
        thumbs.set(ad.contentId, content?.thumbnailUrl ?? null);
      }
      const summary = await summaryOf(
        tx,
        companyId,
        tree.campaign,
        tz,
        tree.experiment !== null,
      );
      return { tree, insights, actions, thumbs, summary };
    });
    if (out === null) throw new ApiRejection(404, "not_found", "campaign not found");
    const { tree, insights, actions, thumbs, summary } = out;
    const type = tree.campaign.resultActionType;
    const ab = experimentOf(tree, insights);
    const labelOf = new Map(tree.adSets.map((s) => [s.id, s.variantLabel ?? s.name]));
    return {
      campaign: summary,
      targeting: tree.campaign.targeting as AdTargetingInput,
      destinationUrl: tree.campaign.destinationUrl,
      resultActionType: type,
      adSets: tree.adSets.map((s) => ({
        id: s.id,
        name: s.name,
        variantLabel: s.variantLabel,
        dailyBudgetMinor: s.dailyBudgetMinor,
      })),
      ads: tree.ads.map((a) => ({
        id: a.id,
        name: a.name,
        adSetId: a.adSetId,
        contentId: a.contentId,
        mediaKind: a.mediaKind,
        thumbnailUrl: a.contentId === null ? null : (thumbs.get(a.contentId) ?? null),
        metrics: toMetrics(
          sumAdInsights(insights.filter((r) => r.adId === a.id).map(toDaily), type),
        ),
      })),
      metrics: toMetrics(sumAdInsights(insights.map(toDaily), type)),
      byDay: byDay(insights, () => type),
      experiment:
        ab === null || tree.experiment === null
          ? null
          : {
              metric: ab.metric,
              status: ab.status,
              winnerAdSetId: ab.winnerVariantId,
              leaderAdSetId: ab.leaderVariantId,
              minZ: ab.minZ === null ? null : Math.round(ab.minZ * 1000) / 1000,
              platformStudy: tree.experiment.platformStudyId !== null,
              minImpressions: AB_MIN_IMPRESSIONS,
              minEvents: AB_MIN_EVENTS,
              variants: ab.variants.map((v) => {
                const stats = tree.adSets.find((s) => s.id === v.variantId);
                const rows = insights
                  .filter((r) =>
                    tree.ads.some((a) => a.id === r.adId && a.adSetId === v.variantId),
                  )
                  .map(toDaily);
                const t = sumAdInsights(rows, type);
                return {
                  adSetId: v.variantId,
                  label: labelOf.get(v.variantId) ?? stats?.name ?? "",
                  impressions: t.impressions,
                  clicks: t.clicks,
                  results: t.results ?? 0,
                  spendMinor: t.spendMinor,
                  rate: v.rate,
                  enoughData: v.enoughData,
                };
              }),
            },
      actions: actions
        .filter((a) => a.kind !== "activation_preview" || a.consumedAt !== null)
        .map((a) => {
          const detail = (a.detail ?? {}) as Record<string, unknown>;
          const reason = detail["breach"] ?? detail["reason"] ?? a.previewAction ?? null;
          return {
            kind: a.kind,
            actor: a.actor,
            createdAt: a.createdAt.getTime(),
            maxSpendMinor: a.maxSpendMinor,
            dailyCapMinor: a.dailyCapMinor,
            totalCapMinor: a.totalCapMinor,
            reason: typeof reason === "string" ? reason : null,
          };
        }),
      guardIntervalMinutes: ADS_SYNC_INTERVAL_MINUTES,
    };
  }

  async function loadCampaignOr404(
    request: FastifyRequest,
    id: string,
  ): Promise<AdCampaignTree> {
    const companyId = request.auth.companyId;
    const tree = await request.tx((tx) =>
      adCampaignRepository.load(tx, { companyId }, id),
    );
    if (tree === null) throw new ApiRejection(404, "not_found", "campaign not found");
    return tree;
  }

  // ── GET /ads/connection ──
  app.get("/ads/connection", async (request) => data(await connectionView(request)));

  // ── GET /ads/connection/authorize ──
  app.get("/ads/connection/authorize", async (request) => {
    const cfg = await facebookApp();
    if (cfg === null)
      throw reject(
        409,
        "conflict",
        "integration_not_configured",
        "Add your Meta app credentials in Settings → Integrations → Facebook first.",
      );
    const issuedAt = now();
    const state = await issueOAuthState(
      { signer: deps.signer, ledger: deps.ledger },
      {
        companyId: request.auth.companyId,
        platform: "facebook",
        nonce: deps.nonce(),
        now: issuedAt,
      },
    );
    const uri = redirectUri();
    return data({
      url: metaAdsAuthorizeUrl({ clientId: cfg.clientId, redirectUri: uri, state }),
      redirectUri: uri,
      expiresAt: issuedAt.getTime() + 10 * 60_000,
    });
  });

  // ── POST /ads/connection/callback ──
  app.post(
    "/ads/connection/callback",
    { schema: { body: adsCallbackRequestSchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const verdict = await consumeOAuthState(
        { signer: deps.signer, ledger: deps.ledger },
        { state: request.body.state, companyId, platform: "facebook", now: now() },
      );
      if (!verdict.ok)
        throw reject(
          400,
          "bad_request",
          verdict.reason === "wrong_brand"
            ? "oauth_state_wrong_brand"
            : "oauth_state_invalid",
          "This login link expired or was started from another brand. Try again.",
        );
      if (request.body.error !== undefined || (request.body.code ?? "") === "")
        throw reject(
          400,
          "bad_request",
          "oauth_denied",
          "You declined the ads permissions.",
        );
      const cfg = await facebookApp();
      if (cfg?.clientSecret === undefined)
        throw reject(
          409,
          "conflict",
          "integration_not_configured",
          "Add your Meta app credentials first.",
        );
      let token;
      try {
        token = await deps.exchangeCode({
          credentials: { clientId: cfg.clientId, clientSecret: cfg.clientSecret },
          redirectUri: redirectUri(),
          code: request.body.code ?? "",
          now: now(),
        });
      } catch {
        throw reject(
          400,
          "bad_request",
          "oauth_exchange_failed",
          "Meta didn't accept the login. Try again.",
        );
      }
      const me = await viaPlatform(request, () => deps.meta.whoAmI(token.accessToken));
      const cipherText = await deps.cipher.encrypt(token.accessToken);
      await request.tx((tx) =>
        adAccountRepository.upsertPending(
          tx,
          { companyId },
          {
            provider: "meta",
            accessToken: cipherText,
            tokenExpiresAt: token.expiresAt,
            metaUserId: me.id,
            now: now(),
          },
        ),
      );
      request.log.info({ companyId }, "ads connection pending selection");
      return data(await connectionView(request));
    },
  );

  // ── GET /ads/connection/options ──
  app.get("/ads/connection/options", async (request) => {
    const account = await loadAccount(request);
    if (account === null || account.status === "revoked" || account.status === "expired")
      throw reject(409, "conflict", "ads_not_connected", "Connect an ad account first.");
    const platform = platformFor(account);
    const token = await tokenOf(account);
    const [adAccounts, pages] = await viaPlatform(request, () =>
      Promise.all([platform.listAdAccounts(token), platform.listPages(token)]),
    );
    const out: AdConnectionOptions = {
      adAccounts: adAccounts.map((a) => ({ ...a })),
      pages: pages.map((p) => ({ ...p })),
    };
    return data(out);
  });

  // ── PUT /ads/connection ──
  app.put(
    "/ads/connection",
    { schema: { body: selectAdAccountRequestSchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const account = await loadAccount(request);
      if (
        account === null ||
        account.status === "revoked" ||
        account.status === "expired"
      )
        throw reject(
          409,
          "conflict",
          "ads_not_connected",
          "Connect an ad account first.",
        );
      const platform = platformFor(account);
      const token = await tokenOf(account);
      const [adAccounts, pages] = await viaPlatform(request, () =>
        Promise.all([platform.listAdAccounts(token), platform.listPages(token)]),
      );
      const chosen = adAccounts.find((a) => a.id === request.body.adAccountId);
      const page = pages.find((p) => p.id === request.body.pageId);
      // Sólo lo que Meta dice que el token alcanza: nada elegido a mano.
      if (chosen === undefined || page === undefined)
        throw new ApiRejection(404, "not_found", "ad account or page not found");
      await request.tx((tx) =>
        adAccountRepository.select(
          tx,
          { companyId },
          {
            adAccountId: chosen.id,
            adAccountName: chosen.name,
            currency: chosen.currency,
            timezoneName: chosen.timezoneName,
            pageId: page.id,
            pageName: page.name,
            instagramUserId: page.instagramUserId,
            instagramUsername: page.instagramUsername,
            now: now(),
          },
        ),
      );
      return data(await connectionView(request));
    },
  );

  // ── POST /ads/connection/demo ──
  app.post("/ads/connection/demo", async (request) => {
    const companyId = request.auth.companyId;
    const account = await loadAccount(request);
    if (account !== null && account.provider === "meta" && account.status === "active")
      throw reject(
        409,
        "conflict",
        "ads_connected",
        "This brand already has a real ad account.",
      );
    await request.tx(async (tx) => {
      await adAccountRepository.upsertPending(
        tx,
        { companyId },
        {
          provider: "fake",
          accessToken: null,
          tokenExpiresAt: null,
          metaUserId: null,
          now: now(),
        },
      );
      await adAccountRepository.select(
        tx,
        { companyId },
        {
          adAccountId: FAKE_AD_ACCOUNT.id,
          adAccountName: FAKE_AD_ACCOUNT.name,
          currency: FAKE_AD_ACCOUNT.currency,
          timezoneName: FAKE_AD_ACCOUNT.timezoneName,
          pageId: FAKE_AD_PAGE.id,
          pageName: FAKE_AD_PAGE.name,
          instagramUserId: FAKE_AD_PAGE.instagramUserId,
          instagramUsername: FAKE_AD_PAGE.instagramUsername,
          now: now(),
        },
      );
    });
    return data(await connectionView(request));
  });

  // ── DELETE /ads/connection ──
  app.delete("/ads/connection", async (request, reply) => {
    const companyId = request.auth.companyId;
    const active = await request.tx(async (tx) =>
      (await adCampaignRepository.list(tx, { companyId })).filter(
        (c) => c.status === "ACTIVE",
      ),
    );
    if (active.length > 0)
      throw reject(
        409,
        "conflict",
        "active_campaigns",
        "Pause every active campaign before disconnecting.",
      );
    await request.tx((tx) =>
      adAccountRepository.setStatus(tx, { companyId }, "revoked", now()),
    );
    return reply.status(204).send();
  });

  // ── GET /ads/campaigns ──
  app.get("/ads/campaigns", async (request) => {
    const companyId = request.auth.companyId;
    const list = await request.tx(async (tx) => {
      const account = await adAccountRepository.load(tx, { companyId });
      const rows = await adCampaignRepository.list(tx, { companyId });
      const out: AdCampaignSummary[] = [];
      for (const c of rows) {
        const tree = await adCampaignRepository.load(tx, { companyId }, c.id);
        out.push(
          await summaryOf(
            tx,
            companyId,
            c,
            account?.timezoneName ?? null,
            tree?.experiment != null,
          ),
        );
      }
      return out;
    });
    return data(list);
  });

  // ── POST /ads/campaigns ──
  app.post(
    "/ads/campaigns",
    { schema: { body: createAdCampaignRequestSchema } },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const body = request.body;
      const caps: SpendCaps = {
        dailyCapMinor: body.dailyCapMinor,
        totalCapMinor: body.totalCapMinor,
      };
      const capsCheck = validateCaps(caps);
      if (!capsCheck.ok)
        throw new ApiRejection(400, "bad_request", "Check the spend caps.", {
          reason: capsCheck.problem,
        });
      if (
        body.targeting.ageMin !== undefined &&
        body.targeting.ageMax !== undefined &&
        body.targeting.ageMin > body.targeting.ageMax
      )
        throw new ApiRejection(400, "bad_request", "Minimum age is above maximum age.", {
          reason: "age_range",
        });
      const unique = [...new Set(body.contentIds)];
      if (body.abTest !== undefined && unique.length < 2)
        throw new ApiRejection(
          400,
          "bad_request",
          "An A/B test needs at least two pieces.",
          {
            reason: "ab_needs_two_pieces",
          },
        );
      if (body.objective === "OUTCOME_TRAFFIC" && body.destinationUrl === undefined)
        throw new ApiRejection(
          400,
          "bad_request",
          "Traffic campaigns need a destination URL.",
          {
            reason: "destination_required",
          },
        );
      const at = now();
      if (body.endTime !== undefined && body.endTime <= at.getTime())
        throw new ApiRejection(
          400,
          "bad_request",
          "The end date has to be in the future.",
          {
            reason: "end_in_past",
          },
        );
      const variantCount = body.abTest === undefined ? 1 : unique.length;
      const budgets = splitDailyBudget(caps.dailyCapMinor, variantCount);
      if (budgets === null)
        throw new ApiRejection(
          400,
          "bad_request",
          "The daily cap is too small to split.",
          {
            reason: "daily_too_small_for_variants",
          },
        );

      const { account, auth, platform, currency } = await activeAccount(request);
      const pieces = await request.tx(async (tx) => {
        const out = [];
        for (const id of unique) {
          const c = await contentRepository.findById(tx, { companyId }, id);
          if (c?.status !== "CREATED") return null;
          const file = c.files[0];
          const kind = file === undefined ? null : mediaKindOfUrl(file);
          if (file === undefined || kind === null) return "unsupported" as const;
          out.push({ id: c.id, file, kind, thumbnailUrl: c.thumbnailUrl });
        }
        return out;
      });
      if (pieces === null) throw new ApiRejection(404, "not_found", "content not found");
      if (pieces === "unsupported")
        throw new ApiRejection(
          400,
          "bad_request",
          "This piece has no video or image file.",
          {
            reason: "unsupported_media",
          },
        );
      if (pieces.some((p) => p.kind === "image") && body.destinationUrl === undefined)
        throw new ApiRejection(400, "bad_request", "Image ads need a destination URL.", {
          reason: "destination_required",
        });

      const demo = account.provider === "fake";
      const base = demo ? "" : await bucketBase(storage);
      const publicUrl = async (file: string): Promise<string> => {
        if (demo) return file;
        const key = keyFromCanonical(file, base);
        if (key === null)
          throw new ApiRejection(
            400,
            "bad_request",
            "This media isn't stored in FastGram.",
            {
              reason: "unsupported_media",
            },
          );
        return deps.publicMedia.forObject(key, { ttlSeconds: 6 * 3600 });
      };
      const bytesOf = async (file: string): Promise<Uint8Array> => {
        if (demo) return new Uint8Array();
        const key = keyFromCanonical(file, base);
        if (key === null)
          throw new ApiRejection(
            400,
            "bad_request",
            "This media isn't stored in FastGram.",
            {
              reason: "unsupported_media",
            },
          );
        return readAll(await storage.get(key), AD_IMAGE_MAX_BYTES);
      };

      const resultActionType =
        body.resultActionType === undefined
          ? DEFAULT_RESULT_ACTION_TYPE[body.objective]
          : body.resultActionType;
      const endTime = body.endTime === undefined ? undefined : new Date(body.endTime);
      const labels = ["A", "B", "C", "D", "E"];

      const created = await viaPlatform(request, async () => {
        const campaign = await platform.createCampaign(auth, {
          name: body.name,
          objective: body.objective,
        });
        const sets: {
          key: string;
          name: string;
          variantLabel: string | null;
          dailyBudgetMinor: number;
          platformAdSetId: string;
        }[] = [];
        for (let i = 0; i < variantCount; i++) {
          const label = body.abTest === undefined ? null : (labels[i] ?? String(i + 1));
          const name = label === null ? body.name : `${body.name} · ${label}`;
          const dailyBudgetMinor = budgets[i] ?? 0;
          const set = await platform.createAdSet(auth, {
            campaignId: campaign.id,
            name,
            dailyBudgetMinor,
            objective: body.objective,
            targeting: targetingOf(body.targeting),
            ...(endTime === undefined ? {} : { endTime }),
          });
          sets.push({
            key: String(i),
            name,
            variantLabel: label,
            dailyBudgetMinor,
            platformAdSetId: set.id,
          });
        }
        const adsOut = [];
        for (const [i, piece] of pieces.entries()) {
          const set = body.abTest === undefined ? sets[0] : sets[i];
          if (set === undefined) continue;
          const media =
            piece.kind === "video"
              ? {
                  kind: "video" as const,
                  videoId: (
                    await platform.uploadVideo(auth, {
                      fileUrl: await publicUrl(piece.file),
                      name: body.name,
                    })
                  ).videoId,
                  ...(piece.thumbnailUrl === null
                    ? {}
                    : {
                        thumbnailUrl: await publicUrl(piece.thumbnailUrl).catch(
                          () => piece.thumbnailUrl ?? "",
                        ),
                      }),
                }
              : {
                  kind: "image" as const,
                  imageHash: (
                    await platform.uploadImage(auth, {
                      bytes: await bytesOf(piece.file),
                      filename: `${piece.id}.jpg`,
                    })
                  ).imageHash,
                };
          const adName =
            set.variantLabel === null ? `${body.name} · ${String(i + 1)}` : set.name;
          const creative = await platform.createCreative(auth, {
            name: adName,
            pageId: account.pageId ?? "",
            ...(account.instagramUserId === null
              ? {}
              : { instagramUserId: account.instagramUserId }),
            media,
            message: body.message,
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.destinationUrl === undefined ? {} : { link: body.destinationUrl }),
          });
          const ad = await platform.createAd(auth, {
            adSetId: set.platformAdSetId,
            creativeId: creative.id,
            name: adName,
          });
          adsOut.push({
            adSetKey: set.key,
            contentId: piece.id,
            name: adName,
            mediaKind: piece.kind,
            message: body.message,
            platformAdId: ad.id,
            platformCreativeId: creative.id,
          });
        }
        let study: { id: string | null; error: string | null } = {
          id: null,
          error: null,
        };
        if (body.abTest !== undefined) {
          const ownerId = account.metaUserId ?? (demo ? "10000000000" : null);
          if (ownerId === null) study = { id: null, error: "no_owner" };
          else {
            const pct = Math.floor(100 / sets.length);
            try {
              const s = await platform.createSplitTest(auth, {
                ownerId,
                name: `${body.name} · A/B`,
                startTime: at,
                endTime:
                  endTime ?? new Date(at.getTime() + AD_STUDY_DEFAULT_DAYS * 86_400_000),
                cells: sets.map((s, i) => ({
                  name: s.variantLabel ?? s.name,
                  treatmentPercentage: i === 0 ? 100 - pct * (sets.length - 1) : pct,
                  adSetIds: [s.platformAdSetId],
                })),
              });
              study = { id: s.id, error: null };
            } catch (e: unknown) {
              study = {
                id: null,
                error: isAdsPlatformError(e) ? e.reason : "unexpected_response",
              };
            }
          }
        }
        return { campaign, sets, ads: adsOut, study };
      });

      const tree = await request.tx((tx) =>
        adCampaignRepository.insertTree(
          tx,
          { companyId },
          {
            campaign: {
              adAccountRowId: account.id,
              name: body.name,
              objective: body.objective,
              dailyCapMinor: caps.dailyCapMinor,
              totalCapMinor: caps.totalCapMinor,
              currency,
              isTest: body.isTest ?? false,
              startDate: dateInZone(at, account.timezoneName),
              endTime: endTime ?? null,
              targeting: body.targeting,
              destinationUrl: body.destinationUrl ?? null,
              resultActionType,
              platformCampaignId: created.campaign.id,
            },
            adSets: created.sets,
            ads: created.ads,
            experiment:
              body.abTest === undefined
                ? null
                : {
                    metric: body.abTest.metric,
                    platformStudyId: created.study.id,
                    platformStudyError: created.study.error,
                  },
            now: at,
          },
        ),
      );
      request.log.info(
        { companyId, campaignId: tree.campaign.id, demo },
        "ad campaign created (paused)",
      );
      return reply.status(201).send(data(await detailOf(request, tree.campaign.id)));
    },
  );

  // ── GET /ads/campaigns/:id ──
  app.get("/ads/campaigns/:id", { schema: { params: idParams } }, async (request) =>
    data(await detailOf(request, request.params.id)),
  );

  // ── POST /ads/campaigns/:id/activation-preview ──
  app.post(
    "/ads/campaigns/:id/activation-preview",
    { schema: { params: idParams, body: activationPreviewRequestSchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const tree = await loadCampaignOr404(request, request.params.id);
      const c = tree.campaign;
      const { account } = await activeAccount(request);
      const action: ConfirmableAction = request.body.action;
      const current: SpendCaps = {
        dailyCapMinor: c.dailyCapMinor,
        totalCapMinor: c.totalCapMinor,
      };
      let caps = current;
      if (action === "activate") {
        if (c.status !== "PAUSED")
          throw reject(
            409,
            "conflict",
            "not_paused",
            "Only a paused campaign can be activated.",
          );
      } else {
        const next = {
          dailyCapMinor: request.body.dailyCapMinor ?? c.dailyCapMinor,
          totalCapMinor: request.body.totalCapMinor ?? c.totalCapMinor,
        };
        const check = validateCaps(next);
        if (!check.ok)
          throw new ApiRejection(400, "bad_request", "Check the spend caps.", {
            reason: check.problem,
          });
        if (!capsIncrease(current, next))
          throw reject(
            409,
            "conflict",
            "not_an_increase",
            "Lowering a cap needs no confirmation.",
          );
        caps = next;
      }
      const at = now();
      const spend = await request.tx((tx) =>
        spendOf(tx, companyId, c, account.timezoneName),
      );
      const max = maxPossibleSpend({
        caps,
        spentTotalMinor: spend.totalMinor,
        spentTodayMinor: spend.todayMinor,
        now: at,
        endTime: c.endTime,
      });
      if (max.remainingTotalMinor === 0)
        throw reject(
          409,
          "conflict",
          "total_cap_reached",
          "This campaign already spent its total cap. Raise it first.",
        );
      const token = deps.token();
      const expiresAt = new Date(at.getTime() + ACTIVATION_PREVIEW_TTL_MS);
      await request.tx((tx) =>
        adActionRepository.insertPreview(
          tx,
          { companyId },
          {
            campaignId: c.id,
            previewAction: action,
            token,
            dailyCapMinor: caps.dailyCapMinor,
            totalCapMinor: caps.totalCapMinor,
            maxSpendMinor: max.maxMinor,
            expiresAt,
            detail: { spentTotalMinor: spend.totalMinor, bindingCap: max.bindingCap },
          },
        ),
      );
      const out: ActivationPreview = {
        token,
        action,
        currency: c.currency,
        dailyCapMinor: caps.dailyCapMinor,
        totalCapMinor: caps.totalCapMinor,
        spentTotalMinor: spend.totalMinor,
        maxSpendMinor: max.maxMinor,
        remainingTotalMinor: max.remainingTotalMinor,
        daysLeft: max.daysLeft,
        bindingCap: max.bindingCap,
        expiresAt: expiresAt.getTime(),
        guardIntervalMinutes: ADS_SYNC_INTERVAL_MINUTES,
        demo: account.provider === "fake",
      };
      return data(out);
    },
  );

  /** Valida el token contra la campaña, la acción y los topes; lo consume. */
  async function confirm(
    tx: Transaction,
    companyId: string,
    token: string | undefined,
    check: { campaignId: string; action: ConfirmableAction; caps: SpendCaps },
  ) {
    const row =
      token === undefined
        ? null
        : await adActionRepository.loadPreview(tx, { companyId }, token);
    const verdict = checkConfirmation(
      row === null || row.previewAction === null || row.expiresAt === null
        ? null
        : {
            campaignId: row.campaignId,
            action: row.previewAction as ConfirmableAction,
            caps: {
              dailyCapMinor: row.dailyCapMinor ?? 0,
              totalCapMinor: row.totalCapMinor ?? 0,
            },
            maxSpendMinor: row.maxSpendMinor ?? 0,
            expiresAt: row.expiresAt,
            consumedAt: row.consumedAt,
          },
      { ...check, now: now() },
    );
    if (!verdict.ok || row === null)
      throw reject(
        409,
        "conflict",
        verdict.ok ? "preview_required" : verdict.reason,
        "Confirm the maximum spend first (activation preview).",
      );
    if (!(await adActionRepository.consumePreview(tx, { companyId }, row.id, now())))
      throw reject(
        409,
        "conflict",
        "preview_used",
        "This confirmation was already used.",
      );
    return { previewId: row.id, maxSpendMinor: verdict.maxSpendMinor };
  }

  // ── POST /ads/campaigns/:id/activate ──
  app.post(
    "/ads/campaigns/:id/activate",
    { schema: { params: idParams, body: activateAdCampaignRequestSchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const tree = await loadCampaignOr404(request, request.params.id);
      const c = tree.campaign;
      if (c.status !== "PAUSED")
        throw reject(
          409,
          "conflict",
          "not_paused",
          "Only a paused campaign can be activated.",
        );
      const { auth, platform } = await activeAccount(request);
      const caps = { dailyCapMinor: c.dailyCapMinor, totalCapMinor: c.totalCapMinor };
      // Fase 1 (commit): token consumido y fila ACTIVE — la guardia ya mira.
      const confirmed = await request.tx(async (tx) => {
        const ok = await confirm(tx, companyId, request.body.confirmationToken, {
          campaignId: c.id,
          action: "activate",
          caps,
        });
        await adCampaignRepository.setStatus(
          tx,
          { companyId },
          c.id,
          "ACTIVE",
          null,
          now(),
        );
        await adActionRepository.insert(
          tx,
          { companyId },
          {
            campaignId: c.id,
            kind: "activate",
            actor: "owner",
            previewId: ok.previewId,
            dailyCapMinor: caps.dailyCapMinor,
            totalCapMinor: caps.totalCapMinor,
            maxSpendMinor: ok.maxSpendMinor,
          },
        );
        return ok;
      });
      // Fase 2: Meta, de abajo hacia arriba (la campaña es el interruptor general).
      try {
        await viaPlatform(request, async () => {
          for (const ad of tree.ads)
            await platform.setStatus(auth, ad.platformAdId, "ACTIVE");
          for (const s of tree.adSets)
            await platform.setStatus(auth, s.platformAdSetId, "ACTIVE");
          await platform.setStatus(auth, c.platformCampaignId, "ACTIVE");
        });
      } catch (error: unknown) {
        await platform
          .setStatus(auth, c.platformCampaignId, "PAUSED")
          .catch(() => undefined);
        await request.tx((tx) =>
          adCampaignRepository.setStatus(
            tx,
            { companyId },
            c.id,
            "PAUSED",
            "manual",
            now(),
          ),
        );
        throw error;
      }
      request.log.info(
        { companyId, campaignId: c.id, max: confirmed.maxSpendMinor },
        "ad campaign activated",
      );
      return data(await detailOf(request, c.id));
    },
  );

  // ── POST /ads/campaigns/:id/pause ──
  app.post(
    "/ads/campaigns/:id/pause",
    { schema: { params: idParams } },
    async (request) => {
      const companyId = request.auth.companyId;
      const tree = await loadCampaignOr404(request, request.params.id);
      const c = tree.campaign;
      if (c.status === "ACTIVE") {
        const { auth, platform } = await activeAccount(request);
        await viaPlatform(request, () =>
          platform.setStatus(auth, c.platformCampaignId, "PAUSED"),
        );
        await request.tx(async (tx) => {
          await adCampaignRepository.setStatus(
            tx,
            { companyId },
            c.id,
            "PAUSED",
            "manual",
            now(),
          );
          await adActionRepository.insert(
            tx,
            { companyId },
            { campaignId: c.id, kind: "pause", actor: "owner" },
          );
        });
      }
      return data(await detailOf(request, c.id));
    },
  );

  // ── PATCH /ads/campaigns/:id/budget ──
  app.patch(
    "/ads/campaigns/:id/budget",
    { schema: { params: idParams, body: updateAdBudgetRequestSchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const tree = await loadCampaignOr404(request, request.params.id);
      const c = tree.campaign;
      if (c.status === "ARCHIVED")
        throw reject(409, "conflict", "archived", "This campaign is archived.");
      const next: SpendCaps = {
        dailyCapMinor: request.body.dailyCapMinor,
        totalCapMinor: request.body.totalCapMinor,
      };
      const check = validateCaps(next);
      if (!check.ok)
        throw new ApiRejection(400, "bad_request", "Check the spend caps.", {
          reason: check.problem,
        });
      const budgets = splitDailyBudget(next.dailyCapMinor, tree.adSets.length);
      if (budgets === null)
        throw new ApiRejection(
          400,
          "bad_request",
          "The daily cap is too small to split.",
          {
            reason: "daily_too_small_for_variants",
          },
        );
      const current = { dailyCapMinor: c.dailyCapMinor, totalCapMinor: c.totalCapMinor };
      const needsConfirmation = c.status === "ACTIVE" && capsIncrease(current, next);
      const dailyChanged = next.dailyCapMinor !== c.dailyCapMinor;
      if (dailyChanged) {
        const recent = await request.tx((tx) =>
          adActionRepository.budgetChangesSince(
            tx,
            { companyId },
            c.id,
            new Date(now().getTime() - 3_600_000),
          ),
        );
        if (!budgetChangeAllowed(recent, now()))
          throw new ApiRejection(
            429,
            "rate_limited",
            "Meta allows 4 budget changes per hour.",
            {
              reason: "budget_change_limit",
            },
          );
      }
      const { auth, platform } = await activeAccount(request);
      await request.tx(async (tx) => {
        const ok = needsConfirmation
          ? await confirm(tx, companyId, request.body.confirmationToken, {
              campaignId: c.id,
              action: "budget_increase",
              caps: next,
            })
          : null;
        if (dailyChanged)
          await viaPlatform(request, async () => {
            for (const [i, s] of tree.adSets.entries())
              await platform.updateAdSetDailyBudget(
                auth,
                s.platformAdSetId,
                budgets[i] ?? s.dailyBudgetMinor,
              );
          });
        await adCampaignRepository.updateCaps(
          tx,
          { companyId },
          c.id,
          next,
          tree.adSets.map((s, i) => ({
            adSetId: s.id,
            dailyBudgetMinor: budgets[i] ?? s.dailyBudgetMinor,
          })),
          now(),
        );
        await adActionRepository.insert(
          tx,
          { companyId },
          {
            campaignId: c.id,
            kind: "budget_change",
            actor: "owner",
            previewId: ok?.previewId ?? null,
            dailyCapMinor: next.dailyCapMinor,
            totalCapMinor: next.totalCapMinor,
            maxSpendMinor: ok?.maxSpendMinor ?? null,
            detail: { from: current, confirmed: ok !== null },
          },
        );
      });
      return data(await detailOf(request, c.id));
    },
  );

  // ── POST /ads/sync ──
  app.post("/ads/sync", async (request) => {
    const companyId = request.auth.companyId;
    const { account, auth, platform, currency } = await activeAccount(request);
    const result = await request.tx((tx) => {
      const store: AdsSyncStore = adsSyncStore(tx, { companyId });
      return syncAndGuard({
        store,
        platform,
        auth,
        now: now(),
        timeZone: account.timezoneName,
        currency,
      });
    });
    if (result.stoppedEarly === "unauthorized")
      await request.tx((tx) =>
        adAccountRepository.setStatus(tx, { companyId }, "expired", now()),
      );
    if (result.events.length > 0) {
      const brand = await request.tx((tx) => companyRepository.load(tx, { companyId }));
      let s: NotificationSettings = DEFAULT_NOTIFICATION_SETTINGS;
      try {
        const parsed = parseNotificationSettings(await deps.notificationSettings.read());
        if (parsed.ok) s = parsed.settings;
      } catch {
        // Ilegible: defaults. El aviso del corte no se pierde por eso.
      }
      for (const event of result.events) {
        const draft = describeAdCapEvent(brand?.name ?? "", event, currency);
        const push = shouldPush(s, draft.category);
        await request.tx((tx) =>
          insertNotification(
            tx,
            { companyId },
            {
              category: draft.category,
              severity: draft.severity,
              title: draft.title,
              body: draft.body,
              link: draft.link,
              dedupeKey: draft.dedupeKey,
              // El corte siempre queda en la campana, aunque la categoría esté
              // apagada ahí: es plata, y es lo que se mira al abrir la app.
              inApp: true,
              pushStatus: push ? "pending" : "skipped",
            },
          ),
        );
      }
    }
    const out: AdsSyncResult = {
      synced: result.synced,
      paused: result.events.filter((e) => e.paused).length,
      pauseFailed: result.events.filter((e) => !e.paused).length,
      errors: result.errors.length,
      stoppedEarly: result.stoppedEarly,
    };
    return data(out);
  });

  // ── GET /ads/dashboard ──
  app.get(
    "/ads/dashboard",
    { schema: { querystring: adsDashboardQuerySchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const days = request.query.days;
      const at = now();
      const out = await request.tx(async (tx) => {
        const scope = { companyId };
        const account = await adAccountRepository.load(tx, scope);
        const tz = account?.timezoneName ?? null;
        const to = dateInZone(at, tz);
        const from = dateInZone(new Date(at.getTime() - (days - 1) * 86_400_000), tz);
        const campaigns = await adCampaignRepository.list(tx, scope);
        const typeOf = new Map(campaigns.map((c) => [c.id, c.resultActionType]));
        const insights = await adInsightsRepository.list(tx, scope, { from, to });
        const resultType = (id: string) => typeOf.get(id) ?? null;

        // Resultados sumados con el tipo de cada campaña.
        let results: number | null = null;
        let value: number | null = null;
        for (const r of insights) {
          const t = resultType(r.campaignId);
          if (t === null) continue;
          const d = toDaily(r);
          results = (results ?? 0) + (d.actions[t] ?? 0);
          value = (value ?? 0) + (d.actionValuesMinor[t] ?? 0);
        }
        const plain = sumAdInsights(insights.map(toDaily), null);
        const paid = toMetrics({ ...plain, results, resultValueMinor: value });

        const perCampaign = campaigns.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          metrics: toMetrics(
            sumAdInsights(
              insights.filter((r) => r.campaignId === c.id).map(toDaily),
              c.resultActionType,
            ),
          ),
        }));

        const experiments: AdsDashboard["experiments"] = [];
        for (const c of campaigns) {
          const tree = await adCampaignRepository.load(tx, scope, c.id);
          if (tree?.experiment == null) continue;
          const all = await adInsightsRepository.list(tx, scope, { campaignIds: [c.id] });
          const ab = experimentOf(tree, all);
          if (ab === null) continue;
          const label = (id: string | null) =>
            id === null
              ? null
              : (tree.adSets.find((s) => s.id === id)?.variantLabel ?? null);
          experiments.push({
            campaignId: c.id,
            campaignName: c.name,
            status: ab.status,
            metric: ab.metric,
            winnerLabel: label(ab.winnerVariantId),
            leaderLabel: label(ab.leaderVariantId),
          });
        }

        // Orgánico: lo mismo que `/analytics/summary` para esta marca.
        const posts = await metricsStore.listForAnalytics(tx, scope, {
          from: new Date(at.getTime() - days * 86_400_000),
          to: at,
          limit: 2000,
        });
        const summary = summarizeAnalytics(
          posts.map((p) => ({
            postId: p.id,
            brandId: companyId,
            network: p.platform,
            format: p.contentType,
            postedAtMs: p.postedAt.getTime(),
            syncedAtMs: p.metricsSyncedAt?.getTime() ?? null,
            views: p.metricsMissing.includes("views") ? null : p.views,
            likes: p.metricsMissing.includes("likes") ? null : p.likes,
            comments: p.metricsMissing.includes("comments") ? null : p.comments,
            shares: p.metricsMissing.includes("shares") ? null : p.shares,
            postUrl: p.postUrl,
            caption: p.caption,
          })),
        );
        const dashboard: AdsDashboard = {
          range: { from, to, days },
          connection: account?.status ?? "none",
          demo: account?.provider === "fake",
          currency: account?.currency ?? campaigns[0]?.currency ?? null,
          paid: {
            metrics: paid,
            byDay: byDay(insights, resultType),
            campaigns: perCampaign,
          },
          organic: {
            posts: summary.totals.posts,
            views: summary.totals.views,
            likes: summary.totals.likes,
            comments: summary.totals.comments,
            shares: summary.totals.shares,
            engagementRate: summary.totals.engagementRate,
          },
          experiments,
        };
        return dashboard;
      });
      return data(out);
    },
  );
}

/* ------------------------------------------------------------------------ *
 * Storage: de la URL canónica de la pieza a su clave
 * ------------------------------------------------------------------------ */

const PROBE_KEY = "fastgram-media-probe";

/**
 * La base del bucket: se firma una clave sonda y se queda lo de antes. Mismo
 * truco que `apps/worker/src/publishing/media.ts` (no se puede importar de
 * otra app); ver su cabecera.
 */
async function bucketBase(storage: Storage): Promise<string> {
  const probe = await canonicalObjectUrl(storage, PROBE_KEY);
  const at = probe.lastIndexOf(PROBE_KEY);
  return at < 0 ? "\u0000" : probe.slice(0, at);
}

function keyFromCanonical(url: string, base: string): string | null {
  if (!url.startsWith(base) || url.length === base.length) return null;
  try {
    return decodeURIComponent(url.slice(base.length));
  } catch {
    return null;
  }
}

async function readAll(
  stream: AsyncIterable<Uint8Array>,
  max: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > max)
      throw new ApiRejection(400, "bad_request", "This image is too large for an ad.", {
        reason: "media_too_large",
      });
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
