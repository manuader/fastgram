/**
 * Acceso a Reddit por marca para los jobs de Engagement: credenciales de la
 * app (`$FASTGRAM_HOME/reddit-app.json`), token vigente (refrescado con la
 * fila bloqueada) y el cliente con el User-Agent documentado.
 *
 * Todo lo que no se puede resolver vuelve como un motivo estable, nunca como
 * una excepción: un job sin cuenta no es un job fallido, es una marca que
 * todavía no conectó Reddit (o que no tiene una app aprobada — ver
 * `core/connections/reddit.ts`).
 */
import { RedditApi, RedditOAuth, type RedditAppStore } from "@fastgram/adapters";
import { redditUserAgent, resolveRedditAccessToken } from "@fastgram/core";
import { engagementStore, withCompany, type Database } from "@fastgram/db";
import type { Clock, TokenCipher } from "@fastgram/ports";

export type RedditFetch = (
  input: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export type RedditAccess =
  | { readonly ok: true; readonly api: RedditApi; readonly username: string }
  | {
      readonly ok: false;
      readonly reason: "no_app" | "not_connected" | "reconnect_required" | "unavailable";
    };

export type RedditAccessProvider = (companyId: string) => Promise<RedditAccess>;

export function createRedditAccess(deps: {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly appStore: RedditAppStore;
  readonly cipher: TokenCipher;
  readonly clock: Clock;
  readonly fetch?: RedditFetch;
}): RedditAccessProvider {
  const roleOpt = deps.appRole === undefined ? {} : { role: deps.appRole };
  const fetchOpt = deps.fetch === undefined ? {} : { fetch: deps.fetch };
  return async (companyId) => {
    const config = await deps.appStore.read().catch(() => null);
    if (config === null) return { ok: false, reason: "no_app" };
    const userAgent = redditUserAgent(config.developerUsername);
    const oauth = new RedditOAuth({ ...fetchOpt, userAgent });
    const scope = { companyId };
    const resolved = await withCompany(
      deps.db,
      companyId,
      async (tx) => {
        const row = await engagementStore.findRedditAccount(tx, scope, { lock: true });
        const result = await resolveRedditAccessToken({
          row,
          cipher: deps.cipher,
          now: deps.clock.now(),
          refresh: (refreshToken) =>
            oauth.refresh({
              credentials: {
                clientId: config.clientId,
                clientSecret: config.clientSecret,
              },
              refreshToken,
            }),
          save: (u) => engagementStore.updateRedditTokens(tx, scope, u),
          markExpired: (reason) =>
            engagementStore.markRedditAccount(tx, scope, "expired", reason),
        });
        return { result, username: row?.username ?? null };
      },
      roleOpt,
    );
    if (!resolved.result.ok || resolved.username === null) {
      return {
        ok: false,
        reason: resolved.result.ok ? "not_connected" : resolved.result.reason,
      };
    }
    return {
      ok: true,
      username: resolved.username,
      api: new RedditApi({
        ...fetchOpt,
        userAgent,
        accessToken: resolved.result.accessToken,
      }),
    };
  };
}
