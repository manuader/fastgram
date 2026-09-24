/**
 * Conexiones sociales por marca y credenciales de las apps — `PU-PUB-001`,
 * `PU-PUB-002`, `P3-OAUTH-002`, `P3-OAUTH-008`. `docs/PLAN-USO-PERSONAL.md`
 * §5 y §9, `D-09`, `D-10`.
 *
 *   GET    /integrations                          apps de desarrollador (sin secrets)
 *   PUT    /integrations/:platform                client id / secret
 *   DELETE /integrations/:platform
 *   GET    /connections/accounts                  cuentas de la marca (sin tokens)
 *   GET    /connections/:platform/authorize       → URL de la plataforma con `state` firmado
 *   POST   /connections/:platform/callback        lo llama la web con `code` + `state`
 *   GET    /connections/facebook/pages/:selectionId   Páginas para elegir
 *   POST   /connections/facebook/pages            conecta la Página elegida
 *   POST   /connections/accounts/:connectionId/refresh   refresca ya (o marca `expired`)
 *   DELETE /connections/accounts/:connectionId           desconectar (`revoked`, sin tokens)
 *
 * La lógica está en `packages/core/src/connections` y el I/O en
 * `packages/adapters/src/{oauth,crypto,integrations}` y
 * `packages/db/src/repositories/connections.ts`. Acá se cablea.
 *
 * ## Lo que esta ruta no hace, a propósito
 *
 * - **No devuelve un token ni un secret.** `connectionAccountSchema` e
 *   `integrationAppSchema` no tienen dónde ponerlos, y lo que se loguea son
 *   plataforma, marca y códigos estables.
 * - **No acepta un callback de otra marca.** El `state` va firmado con la
 *   marca que pidió la autorización y el callback tiene que llegar con esa
 *   misma marca en el scope (`X-Fastgram-Workspace`). Si no, `400
 *   oauth_state_wrong_brand` y el nonce **no** se gasta.
 *
 * ## Decisiones que el PRD no cubre
 *
 * - Las credenciales de las apps son de la instalación (como `/models`): sin
 *   `companyId`, cualquier credencial válida las lee y las cambia. Correcto
 *   para uso personal (D-06); con terceros sería de un rol administrador.
 * - Desconectar **no borra** la fila: los posts la referencian y
 *   `posts_account_exclusive` no deja un post sin cuenta. Queda `revoked`, sin
 *   tokens; reconectar la misma cuenta la reactiva.
 * - No se llama al endpoint de revocación de la plataforma al desconectar
 *   (TikTok y X lo tienen): borrar los tokens de acá alcanza para que la app
 *   no pueda usarlos; revocar allá queda para cuando haga falta.
 * - El `state` pendiente y la elección de Página viven **en memoria** del
 *   proceso de la API (10 min). Un reinicio en medio de un login lo corta y
 *   el usuario vuelve a tocar «Connect».
 * - **Barrido al conectar** (`PU-PUB-008`): conectar, reconectar, elegir la
 *   Página de Facebook o refrescar con éxito encola `publishing-sweep` con
 *   `{ companyId }`, que reanuda los posts en `AWAITING_RECONNECT` y convierte
 *   los slots planificados de la red en posts. Va **después** del commit y es
 *   de mejor esfuerzo: si la cola falla, la conexión queda guardada igual (el
 *   `code` de OAuth ya se gastó; fallar acá obligaría a repetir el login
 *   entero) y se loguea. La clave lleva el instante (trampas 39 y 45): dos
 *   conexiones seguidas no se deduplican contra un barrido viejo.
 */
import {
  authorizeConnectionResponseSchema,
  connectionCallbackRequestSchema,
  selectFacebookPageRequestSchema,
  updateIntegrationRequestSchema,
  type AuthorizeConnectionResponse,
  type ConnectionAccount,
  type ConnectionCallbackResult,
  type ConnectionErrorReason,
  type FacebookPageOption,
  type IntegrationApp,
  type IntegrationsOverview,
} from "@fastgram/contracts";
import {
  JOB_QUEUES,
  OAUTH_PLATFORM_SPECS,
  publishScopesOf,
  OAUTH_STATE_TTL_MS,
  applyIntegrationUpdate,
  consumeOAuthState,
  isConnectionTokenError,
  isIntegrationConfigured,
  issueOAuthState,
  redirectAllowed,
  redirectUriFor,
  resolveAccessToken,
  resolveRedirectBase,
  toPublicIntegrationApp,
  toPublicIntegrations,
  type ConnectionTokenError,
} from "@fastgram/core";
import {
  MemoryOAuthStateLedger,
  createLocalOAuthKit,
  createPkcePair,
  randomNonce,
  type PkcePair,
} from "@fastgram/adapters";
import {
  connectionAccountRepository,
  connectionTokenStore,
  type ConnectionRow,
} from "@fastgram/db";
import {
  isOAuthPlatform,
  isPortError,
  type IntegrationStore,
  type OAuthAccountIdentity,
  type OAuthClient,
  type OAuthGrantedAccount,
  type OAuthPlatform,
  type OAuthStateLedger,
  type StateSigner,
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

/** Una Página de Facebook ofrecida para elegir, con su token **ya cifrado**. */
interface PendingPage {
  readonly identity: OAuthAccountIdentity;
  readonly accessTokenCipher: string;
}

interface PendingSelection {
  readonly companyId: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  readonly pages: readonly PendingPage[];
}

/** La elección de Página pendiente, en memoria (ver la cabecera). */
export class PageSelectionStore {
  readonly #entries = new Map<string, PendingSelection>();

  put(id: string, entry: PendingSelection): void {
    for (const [k, v] of this.#entries)
      if (v.expiresAt <= Date.now()) this.#entries.delete(k);
    this.#entries.set(id, entry);
  }

  /** Sin consumir. `null` si no existe, venció o es de otra marca. */
  peek(id: string, companyId: string, nowMs: number): PendingSelection | null {
    const e = this.#entries.get(id);
    if (e === undefined || e.companyId !== companyId || e.expiresAt <= nowMs) return null;
    return e;
  }

  delete(id: string): void {
    this.#entries.delete(id);
  }
}

export interface ConnectionRoutesDeps {
  /** Se lee en cada pedido (`FASTGRAM_PUBLIC_URL`): un objeto vivo como `process.env`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly integrations: IntegrationStore;
  readonly cipher: TokenCipher;
  readonly signer: StateSigner;
  readonly ledger: OAuthStateLedger;
  readonly clients: Readonly<Record<OAuthPlatform, OAuthClient>>;
  readonly selections: PageSelectionStore;
  readonly nonce: () => string;
  readonly pkce: () => PkcePair;
}

/**
 * Sin deps, se arman de `process.env` (`FASTGRAM_HOME`, `FASTGRAM_PUBLIC_URL`)
 * y los clientes usan `globalThis.fetch` resuelto en cada llamada. Mismo
 * criterio que `models.ts`: `server/types.ts` y `main.ts` no son de esta tarea.
 */
export function defaultConnectionRoutesDeps(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConnectionRoutesDeps {
  const kit = createLocalOAuthKit(env);
  return {
    env,
    integrations: kit.integrations,
    cipher: kit.cipher,
    signer: kit.signer,
    ledger: new MemoryOAuthStateLedger(),
    clients: kit.clients,
    selections: new PageSelectionStore(),
    nonce: randomNonce,
    pkce: createPkcePair,
  };
}

/* ------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------ */

const platformParams = z.object({ platform: z.string().min(1) });
const connectionParams = z.object({ connectionId: z.string().min(1) });
const selectionParams = z.object({ selectionId: z.string().min(1) });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reject(
  status: number,
  code: "bad_request" | "conflict" | "not_found" | "service_unavailable",
  reason: ConnectionErrorReason,
  message: string,
  extra: Record<string, unknown> = {},
): ApiRejection {
  return new ApiRejection(status, code, message, { reason, ...extra });
}

function platformOr404(raw: string): OAuthPlatform {
  if (!isOAuthPlatform(raw))
    throw new ApiRejection(404, "not_found", "platform not found");
  return raw;
}

function connectionNotFound(): ApiRejection {
  return new ApiRejection(404, "not_found", "connection not found");
}

/** La fila → lo que ve la pantalla. **Sin** `accessToken` ni `refreshToken`. */
export function toConnectionAccount(row: ConnectionRow): ConnectionAccount {
  return {
    _id: row.id as ConnectionAccount["_id"],
    platform: row.platform,
    platformUserId: row.platformUserId,
    username: row.platformUsername,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    status: row.status,
    statusReason: row.statusReason,
    scopes: [...row.scopes],
    publishable: row.publishable,
    tokenExpiresAt: row.tokenExpiry === null ? null : row.tokenExpiry.getTime(),
    createdAt: row.createdAt.getTime() as ConnectionAccount["createdAt"],
    updatedAt: row.updatedAt.getTime() as ConnectionAccount["updatedAt"],
  };
}

/**
 * `publishable`: la cuenta concedió todos los scopes que se pidieron. Si la
 * plataforma no dice qué concedió, se asume lo pedido (Threads, Facebook).
 * Un `false` es ERR-D03 (`Permissions Missing`) en la pantalla.
 */
function grantedScopes(platform: OAuthPlatform, account: OAuthGrantedAccount) {
  const requested = OAUTH_PLATFORM_SPECS[platform].scopes;
  const granted = account.tokens.scopes ?? requested;
  // Sólo los de publicación: una cuenta que rechaza los de métricas (insights)
  // publica igual; sus posts quedan `metrics_permission_missing` (PU-AUTO-004).
  const needed = publishScopesOf(platform);
  return { granted, publishable: needed.every((s) => granted.includes(s)) };
}

function exchangeRejection(error: unknown): ApiRejection {
  if (
    isPortError(error) &&
    (error.code === "timeout" ||
      error.code === "provider_unavailable" ||
      error.code === "rate_limited")
  ) {
    return reject(
      503,
      "service_unavailable",
      "oauth_provider_unavailable",
      "The platform did not answer. Try connecting again.",
    );
  }
  return reject(
    400,
    "bad_request",
    "oauth_exchange_failed",
    "The platform did not accept the connection. Try connecting again.",
    isPortError(error) ? { platformError: error.code } : {},
  );
}

function tokenErrorRejection(error: ConnectionTokenError): ApiRejection {
  switch (error.reason) {
    case "not_found":
      return connectionNotFound();
    case "inactive":
      return reject(409, "conflict", "connection_inactive", "Reconnect this account.");
    case "expired":
      return reject(409, "conflict", "connection_expired", "Connection Expired");
    case "integration_not_configured":
      return reject(
        409,
        "conflict",
        "integration_not_configured",
        "Add this platform's app credentials in Settings → Integrations.",
      );
    case "refresh_failed":
      return reject(
        503,
        "service_unavailable",
        "oauth_provider_unavailable",
        "The platform did not answer. Try again shortly.",
      );
    case "unsupported_platform":
      return new ApiRejection(404, "not_found", "platform not found");
  }
}

/* ------------------------------------------------------------------------ *
 * Rutas
 * ------------------------------------------------------------------------ */

export function registerConnectionRoutes(
  app: ZodApp,
  deps: ConnectionRoutesDeps = defaultConnectionRoutesDeps(),
): void {
  const { integrations, cipher, signer, ledger, clients, selections } = deps;
  const now = () => app.deps.clock.now();

  async function integrationView(platform: OAuthPlatform): Promise<IntegrationApp> {
    const snapshot = await integrations.read();
    const view = toPublicIntegrationApp(
      platform,
      snapshot.apps[platform],
      resolveRedirectBase(deps.env),
    );
    return { ...view, scopes: [...view.scopes] };
  }

  async function saveAccount(
    request: FastifyRequest,
    platform: OAuthPlatform,
    account: OAuthGrantedAccount,
    accessTokenCipher?: string,
  ): Promise<ConnectionRow> {
    const companyId = request.auth.companyId;
    const { granted, publishable } = grantedScopes(platform, account);
    const encryptedAccess =
      accessTokenCipher ?? (await cipher.encrypt(account.tokens.accessToken));
    const encryptedRefresh =
      account.tokens.refreshToken === undefined
        ? null
        : await cipher.encrypt(account.tokens.refreshToken);
    const row = await request.tx((tx) =>
      connectionAccountRepository.upsertAccount(
        tx,
        { companyId },
        {
          platform,
          platformUserId: account.identity.platformUserId,
          platformUsername: account.identity.username,
          displayName: account.identity.displayName ?? null,
          avatarUrl: account.identity.avatarUrl ?? null,
          scopes: granted,
          publishable,
          accessToken: encryptedAccess,
          refreshToken: encryptedRefresh,
          tokenExpiry: account.tokens.expiresAt,
          refreshTokenExpiry: account.tokens.refreshExpiresAt ?? null,
          tokenIssuedAt: now(),
        },
      ),
    );
    // Qué se conectó, nunca con qué: marca, plataforma e id de la fila.
    request.log.info({ platform, connectionId: row.id, companyId }, "connection saved");
    return row;
  }

  /**
   * Encola el barrido de publicación de la marca. Ver la cabecera: después del
   * commit, de mejor esfuerzo, con el instante en la clave.
   */
  async function armPublishingSweep(
    request: FastifyRequest,
    row: ConnectionRow,
  ): Promise<void> {
    if (row.status !== "active") return;
    const companyId = request.auth.companyId;
    const queue = app.deps.queue;
    if (queue === undefined) {
      request.log.warn({ companyId, connectionId: row.id }, "publishing sweep: no queue");
      return;
    }
    const at = now().getTime();
    try {
      const job = await queue.enqueue({
        queue: JOB_QUEUES.publishingSweep,
        payload: { companyId },
        options: {
          singletonKey: `${JOB_QUEUES.publishingSweep}:connect:${companyId}:${row.id}:${String(at)}`,
        },
      });
      if (!job.created) {
        request.log.warn(
          { companyId, connectionId: row.id },
          "publishing sweep deduplicated",
        );
      }
    } catch (error) {
      request.log.warn(
        {
          companyId,
          connectionId: row.id,
          code: isPortError(error) ? error.code : "unknown",
        },
        "publishing sweep not enqueued",
      );
    }
  }

  // ── GET /integrations ──
  app.get("/integrations", async () => {
    const snapshot = await integrations.read();
    const base = resolveRedirectBase(deps.env);
    const overview: IntegrationsOverview = {
      apps: toPublicIntegrations(snapshot, base).map((a) => ({
        ...a,
        scopes: [...a.scopes],
      })),
      redirectBase: base.origin,
      redirectSource: base.source,
      publicUrlInvalid: base.publicUrlInvalid,
    };
    return data(overview);
  });

  // ── PUT /integrations/:platform ──
  app.put(
    "/integrations/:platform",
    { schema: { params: platformParams, body: updateIntegrationRequestSchema } },
    async (request) => {
      const platform = platformOr404(request.params.platform);
      const snapshot = await integrations.read();
      const result = applyIntegrationUpdate(
        snapshot.apps[platform],
        { clientId: request.body.clientId, clientSecret: request.body.clientSecret },
        now().toISOString(),
      );
      if (!result.ok) {
        throw new ApiRejection(400, "bad_request", result.message, {
          field: result.field,
        });
      }
      await integrations.write(platform, result.config);
      request.log.info({ platform }, "integration updated");
      return data(await integrationView(platform));
    },
  );

  // ── DELETE /integrations/:platform ──
  app.delete(
    "/integrations/:platform",
    { schema: { params: platformParams } },
    async (request, reply) => {
      const platform = platformOr404(request.params.platform);
      await integrations.write(platform, null);
      request.log.info({ platform }, "integration removed");
      return reply.status(204).send();
    },
  );

  // ── GET /connections/accounts ──
  app.get("/connections/accounts", async (request) => {
    const companyId = request.auth.companyId;
    const rows = await request.tx((tx) =>
      connectionAccountRepository.list(tx, { companyId }),
    );
    return data(rows.map(toConnectionAccount));
  });

  // ── GET /connections/:platform/authorize ──
  app.get(
    "/connections/:platform/authorize",
    { schema: { params: platformParams } },
    async (request) => {
      const platform = platformOr404(request.params.platform);
      const snapshot = await integrations.read();
      const appConfig = snapshot.apps[platform];
      if (!isIntegrationConfigured(appConfig) || appConfig === undefined) {
        throw reject(
          409,
          "conflict",
          "integration_not_configured",
          "Add this platform's app credentials in Settings → Integrations first.",
        );
      }
      const spec = OAUTH_PLATFORM_SPECS[platform];
      const base = resolveRedirectBase(deps.env);
      if (!redirectAllowed(spec, base)) {
        throw reject(
          409,
          "conflict",
          "https_redirect_required",
          `${spec.label} only accepts https redirect URIs. Set FASTGRAM_PUBLIC_URL to your tunnel.`,
        );
      }
      const client = clients[platform];
      const pkce = client.usesPkce ? deps.pkce() : undefined;
      const issuedAt = now();
      const state = await issueOAuthState(
        { signer, ledger },
        {
          companyId: request.auth.companyId,
          platform,
          nonce: deps.nonce(),
          now: issuedAt,
          ...(pkce === undefined ? {} : { codeVerifier: pkce.codeVerifier }),
        },
      );
      const redirectUri = redirectUriFor(platform, base);
      const response: AuthorizeConnectionResponse =
        authorizeConnectionResponseSchema.parse({
          url: client.authorizeUrl({
            credentials: { clientId: appConfig.clientId },
            redirectUri,
            state,
            scopes: spec.scopes,
            ...(pkce === undefined ? {} : { codeChallenge: pkce.codeChallenge }),
          }),
          redirectUri,
          expiresAt: issuedAt.getTime() + OAUTH_STATE_TTL_MS,
        });
      return data(response);
    },
  );

  // ── POST /connections/:platform/callback ──
  app.post(
    "/connections/:platform/callback",
    { schema: { params: platformParams, body: connectionCallbackRequestSchema } },
    async (request) => {
      const platform = platformOr404(request.params.platform);
      const companyId = request.auth.companyId;
      const body = request.body;

      const verdict = await consumeOAuthState(
        { signer, ledger },
        { state: body.state, companyId, platform, now: now() },
      );
      if (!verdict.ok) {
        request.log.info({ platform, why: verdict.reason }, "oauth state rejected");
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
              { why: verdict.reason },
            );
      }
      if (body.error !== undefined || body.code === undefined || body.code === "") {
        // ERR-D04. `error` es un código OAuth estándar (`access_denied`…); la
        // descripción del proveedor no se repite.
        throw reject(
          400,
          "bad_request",
          "oauth_denied",
          "You declined a permission FastGram needs. Please try again and approve all requested permissions.",
        );
      }

      const snapshot = await integrations.read();
      const appConfig = snapshot.apps[platform];
      if (
        !isIntegrationConfigured(appConfig) ||
        appConfig === undefined ||
        appConfig.clientSecret === undefined
      ) {
        throw reject(
          409,
          "conflict",
          "integration_not_configured",
          "Add this platform's app credentials in Settings → Integrations first.",
        );
      }

      let accounts: readonly OAuthGrantedAccount[];
      try {
        accounts = await clients[platform].exchangeCode({
          credentials: {
            clientId: appConfig.clientId,
            clientSecret: appConfig.clientSecret,
          },
          redirectUri: redirectUriFor(platform, resolveRedirectBase(deps.env)),
          code: body.code,
          ...(verdict.codeVerifier === undefined
            ? {}
            : { codeVerifier: verdict.codeVerifier }),
        });
      } catch (error) {
        request.log.info(
          { platform, code: isPortError(error) ? error.code : "unknown" },
          "oauth code exchange failed",
        );
        throw exchangeRejection(error);
      }

      const first = accounts[0];
      if (first === undefined) {
        throw reject(
          400,
          "bad_request",
          "no_pages",
          platform === "facebook"
            ? "This Facebook account does not manage any Page."
            : "The platform returned no account.",
        );
      }

      if (platform === "facebook" && accounts.length > 1) {
        const selectionId = deps.nonce();
        const expiresAt = now().getTime() + OAUTH_STATE_TTL_MS;
        const pages: PendingPage[] = [];
        for (const a of accounts) {
          pages.push({
            identity: a.identity,
            accessTokenCipher: await cipher.encrypt(a.tokens.accessToken),
          });
        }
        selections.put(selectionId, {
          companyId,
          expiresAt,
          scopes: grantedScopes(platform, first).granted,
          pages,
        });
        const result: ConnectionCallbackResult = {
          kind: "choose_page",
          selectionId,
          pages: pages.map((p) => pageOption(p.identity)),
          expiresAt,
        };
        return data(result);
      }

      const row = await saveAccount(request, platform, first);
      await armPublishingSweep(request, row);
      const result: ConnectionCallbackResult = {
        kind: "connected",
        connection: toConnectionAccount(row),
      };
      return data(result);
    },
  );

  function pageOption(identity: OAuthAccountIdentity): FacebookPageOption {
    return {
      id: identity.platformUserId,
      name: identity.displayName ?? identity.username,
      avatarUrl: identity.avatarUrl ?? null,
    };
  }

  // ── GET /connections/facebook/pages/:selectionId ──
  app.get(
    "/connections/facebook/pages/:selectionId",
    { schema: { params: selectionParams } },
    async (request) => {
      const entry = selections.peek(
        request.params.selectionId,
        request.auth.companyId,
        now().getTime(),
      );
      if (entry === null) {
        throw reject(404, "not_found", "selection_expired", "Page selection not found");
      }
      return data({
        selectionId: request.params.selectionId,
        pages: entry.pages.map((p) => pageOption(p.identity)),
        expiresAt: entry.expiresAt,
      });
    },
  );

  // ── POST /connections/facebook/pages ──
  app.post(
    "/connections/facebook/pages",
    { schema: { body: selectFacebookPageRequestSchema } },
    async (request) => {
      const { selectionId, pageId } = request.body;
      const entry = selections.peek(selectionId, request.auth.companyId, now().getTime());
      if (entry === null) {
        throw reject(404, "not_found", "selection_expired", "Page selection not found");
      }
      const page = entry.pages.find((p) => p.identity.platformUserId === pageId);
      if (page === undefined) throw new ApiRejection(404, "not_found", "page not found");
      selections.delete(selectionId);
      const row = await saveAccount(
        request,
        "facebook",
        {
          identity: page.identity,
          // El token real va cifrado en `accessTokenCipher`; éste no se usa.
          tokens: { accessToken: "", expiresAt: null, scopes: entry.scopes },
        },
        page.accessTokenCipher,
      );
      await armPublishingSweep(request, row);
      return data(toConnectionAccount(row));
    },
  );

  // ── POST /connections/accounts/:connectionId/refresh ──
  app.post(
    "/connections/accounts/:connectionId/refresh",
    { schema: { params: connectionParams } },
    async (request) => {
      const { connectionId } = request.params;
      if (!UUID.test(connectionId)) throw connectionNotFound();
      const companyId = request.auth.companyId;
      // El error se devuelve desde la transacción y se lanza afuera: si se
      // lanzara adentro, el rollback se llevaría el `markExpired`.
      const outcome = await request.tx(async (tx) => {
        try {
          await resolveAccessToken(
            {
              store: connectionTokenStore(tx),
              cipher,
              clients,
              integrations,
              now,
            },
            { companyId, connectionId, force: true },
          );
          const row = await connectionAccountRepository.find(
            tx,
            { companyId },
            connectionId,
          );
          return { ok: true as const, row };
        } catch (error) {
          if (isConnectionTokenError(error)) return { ok: false as const, error };
          throw error;
        }
      });
      if (!outcome.ok) throw tokenErrorRejection(outcome.error);
      if (outcome.row === null) throw connectionNotFound();
      // `resolveAccessToken` sólo refresca filas `active` (una `expired` sale
      // como `inactive` y se reconecta por el callback), así que un refresco
      // exitoso deja la cuenta `active` y es la señal de "volvió a andar".
      await armPublishingSweep(request, outcome.row);
      return data(toConnectionAccount(outcome.row));
    },
  );

  // ── DELETE /connections/accounts/:connectionId ──
  app.delete(
    "/connections/accounts/:connectionId",
    { schema: { params: connectionParams } },
    async (request, reply) => {
      const { connectionId } = request.params;
      if (!UUID.test(connectionId)) throw connectionNotFound();
      const companyId = request.auth.companyId;
      const row = await request.tx((tx) =>
        connectionAccountRepository.revoke(tx, { companyId }, connectionId),
      );
      if (row === null) throw connectionNotFound();
      request.log.info({ platform: row.platform, connectionId }, "connection revoked");
      return reply.status(204).send();
    },
  );
}
