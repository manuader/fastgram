/**
 * Cliente de Reddit para Engagement — `F-190`, `F-191`, `F-198`, `F-199`,
 * `P3-OAUTH-006`, `P4-ENGAGE-003/011`.
 *
 * Todo con `fetch` inyectable: los tests imitan las respuestas documentadas y
 * **nunca** se llama a Reddit de verdad desde un test.
 *
 * ## Qué está documentado y qué no (consultado el 2026-09-24)
 *
 * Endpoints, scopes y parámetros: https://www.reddit.com/dev/api/ y
 * https://github.com/reddit-archive/reddit/wiki/OAuth2 . Campos de los
 * objetos (`t3` link, `t1` comment, `Listing`): la wiki JSON,
 * https://github.com/reddit-archive/reddit/wiki/JSON . Límite y headers
 * `X-Ratelimit-*`: https://github.com/reddit-archive/reddit/wiki/API .
 *
 * **NO VERIFICADO** (se lee a la defensiva y lo raro es
 * `provider_contract_violation`, nunca un dato inventado):
 * - la forma exacta de la respuesta de `POST /api/comment` con
 *   `api_type=json` (se asume `{json: {errors: [], data: {things: [...]}}}`,
 *   que es lo que devuelve en la práctica; si no trae el comentario, el envío
 *   vale igual y el id queda `null` — el seguimiento lo encuentra por autor);
 * - la forma de `GET /r/{sr}/about/rules` (`rules[].short_name` y
 *   `description`): si no está, se sigue sin reglas;
 * - que `GET /comments/{article}` devuelva un array de dos listings (link y
 *   comentarios);
 * - `expires_in`: la wiki lo describe como *"Unix Epoch Seconds"* y en el
 *   texto dice que los tokens duran una hora. Se aceptan las dos lecturas
 *   (≥ 10⁹ = instante; si no, duración).
 *
 * ## Errores (`PortError`)
 *
 * 401 → `unauthorized` (token vencido o revocado), 403 → `forbidden`
 * (subreddit privado, cuenta suspendida o baneada ahí), 404 → `not_found`,
 * 429 → `rate_limited` con `retryAfterSeconds` de `X-Ratelimit-Reset`, 5xx →
 * `provider_unavailable`, corte → `timeout`. El `cause` lleva sólo status y
 * códigos: nunca el cuerpo ni la URL (el token viaja en un header, pero un
 * cuerpo de token trae secretos).
 */
import { PortError, type PortErrorCode } from "@fastgram/ports";

import { OAuthHttp, num, str, type OAuthFetch } from "../oauth/http.js";

export const REDDIT_AUTHORIZE_URL = "https://www.reddit.com/api/v1/authorize";
export const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
export const REDDIT_REVOKE_URL = "https://www.reddit.com/api/v1/revoke_token";
/** *"API requests with a bearer token should be made to https://oauth.reddit.com, NOT www.reddit.com."* */
export const REDDIT_API_BASE = "https://oauth.reddit.com";

const SOURCE = "Reddit";

export interface RedditAppCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface RedditTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: Date | null;
  readonly scopes: readonly string[];
}

export interface RedditIdentity {
  readonly id: string;
  readonly username: string;
}

export interface RedditRateLimit {
  readonly used: number | null;
  readonly remaining: number | null;
  readonly resetSeconds: number | null;
}

export interface RedditResult<T> {
  readonly data: T;
  readonly rateLimit: RedditRateLimit;
}

/** Un `t3` con los campos que usamos (wiki JSON). */
export interface RedditPost {
  readonly id: string;
  readonly name: string;
  readonly subreddit: string;
  readonly title: string;
  readonly selftext: string;
  readonly author: string | null;
  readonly score: number;
  readonly numComments: number;
  readonly createdUtc: number;
  readonly permalink: string;
  readonly over18: boolean;
  readonly locked: boolean;
  readonly stickied: boolean;
}

export interface RedditComment {
  readonly name: string;
  readonly author: string | null;
  readonly parentId: string;
  readonly body: string;
  readonly score: number;
  readonly createdUtc: number;
}

export interface RedditThread {
  readonly post: RedditPost;
  /** Aplanado en preorden. Los stubs `more` se ignoran. */
  readonly comments: readonly RedditComment[];
}

export interface PostedComment {
  /** Fullname `t1_…`, o `null` si la respuesta no lo trajo (ver cabecera). */
  readonly name: string | null;
  readonly permalink: string | null;
}

export interface RedditClientConfig {
  readonly fetch?: OAuthFetch;
  readonly timeoutMs?: number;
  /** El User-Agent del formato documentado (`redditUserAgent` de core). Obligatorio. */
  readonly userAgent: string;
  readonly now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/* ------------------------------------------------------------------------ *
 * Lectura defensiva
 * ------------------------------------------------------------------------ */

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** *"< , > , and & are escaped"* (wiki JSON, `selftext`). */
export function unescapeRedditText(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function bool(o: Record<string, unknown>, k: string): boolean {
  return o[k] === true;
}

function author(o: Record<string, unknown>): string | null {
  const a = str(o, "author");
  // `[deleted]` es la convención de la UI para cuentas borradas: no es un usuario.
  return a === undefined || a === "[deleted]" ? null : a;
}

export function parsePost(thing: unknown): RedditPost | null {
  const t = rec(thing);
  if (t === null || t["kind"] !== "t3") return null;
  const d = rec(t["data"]);
  if (d === null) return null;
  const id = str(d, "id");
  const title = str(d, "title");
  const subreddit = str(d, "subreddit");
  const permalink = str(d, "permalink");
  const createdUtc = num(d, "created_utc");
  if (!id || !title || !subreddit || !permalink || createdUtc === undefined) return null;
  return {
    id,
    name: str(d, "name") ?? `t3_${id}`,
    subreddit,
    title: unescapeRedditText(title),
    selftext: unescapeRedditText(typeof d["selftext"] === "string" ? d["selftext"] : ""),
    author: author(d),
    score: num(d, "score") ?? 0,
    numComments: num(d, "num_comments") ?? 0,
    createdUtc,
    permalink,
    over18: bool(d, "over_18"),
    locked: bool(d, "locked"),
    stickied: bool(d, "stickied"),
  };
}

function listingChildren(v: unknown): unknown[] | null {
  const l = rec(v);
  if (l === null || l["kind"] !== "Listing") return null;
  const d = rec(l["data"]);
  const children = d?.["children"];
  return Array.isArray(children) ? children : null;
}

function flattenComments(children: readonly unknown[], out: RedditComment[]): void {
  for (const child of children) {
    const t = rec(child);
    if (t === null || t["kind"] !== "t1") continue;
    const d = rec(t["data"]);
    if (d === null) continue;
    const name = str(d, "name");
    const parentId = str(d, "parent_id");
    if (!name || !parentId) continue;
    out.push({
      name,
      parentId,
      author: author(d),
      body: unescapeRedditText(typeof d["body"] === "string" ? d["body"] : ""),
      score: num(d, "score") ?? 0,
      createdUtc: num(d, "created_utc") ?? 0,
    });
    // `replies` es un Listing, o `""` sin respuestas.
    const nested = listingChildren(d["replies"]);
    if (nested !== null) flattenComments(nested, out);
  }
}

/* ------------------------------------------------------------------------ *
 * HTTP con headers de tasa
 * ------------------------------------------------------------------------ */

function codeForStatus(status: number): PortErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "bad_request";
}

function rateLimitOf(headers: Headers): RedditRateLimit {
  const n = (k: string): number | null => {
    const raw = headers.get(k);
    if (raw === null) return null;
    const v = Number.parseFloat(raw);
    return Number.isFinite(v) && v >= 0 ? v : null;
  };
  return {
    used: n("x-ratelimit-used"),
    remaining: n("x-ratelimit-remaining"),
    resetSeconds: n("x-ratelimit-reset"),
  };
}

const globalFetch: OAuthFetch = (input, init) => globalThis.fetch(input, init);

/* ------------------------------------------------------------------------ *
 * OAuth
 * ------------------------------------------------------------------------ */

export class RedditOAuth {
  readonly #http: OAuthHttp;
  readonly #fetch: OAuthFetch;
  readonly #timeoutMs: number;
  readonly #ua: string;
  readonly #now: () => Date;

  constructor(config: RedditClientConfig) {
    const httpConfig = {
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    this.#http = new OAuthHttp("OAuth/reddit", httpConfig);
    this.#fetch = config.fetch ?? globalFetch;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#ua = config.userAgent;
    this.#now = config.now ?? (() => new Date());
  }

  /** `duration=permanent`: sin eso no hay refresh token y a la hora hay que reconectar. */
  authorizeUrl(req: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly scopes: readonly string[];
  }): string {
    const q = new URLSearchParams({
      client_id: req.clientId,
      response_type: "code",
      state: req.state,
      redirect_uri: req.redirectUri,
      duration: "permanent",
      scope: req.scopes.join(" "),
    });
    return `${REDDIT_AUTHORIZE_URL}?${q.toString()}`;
  }

  #basic(c: RedditAppCredentials): Record<string, string> {
    const raw = `${c.clientId}:${c.clientSecret}`;
    return {
      Authorization: `Basic ${Buffer.from(raw, "utf8").toString("base64")}`,
      "User-Agent": this.#ua,
    };
  }

  #tokens(body: Record<string, unknown>, previousRefresh: string | null): RedditTokens {
    const accessToken = str(body, "access_token");
    if (!accessToken) throw this.#http.contract("reddit token without access_token");
    const expiresIn = num(body, "expires_in");
    let expiresAt: Date | null = null;
    if (expiresIn !== undefined) {
      expiresAt =
        expiresIn >= 1e9
          ? new Date(expiresIn * 1000)
          : new Date(this.#now().getTime() + expiresIn * 1000);
    }
    const scope = str(body, "scope");
    return {
      accessToken,
      refreshToken: str(body, "refresh_token") ?? previousRefresh,
      expiresAt,
      scopes:
        scope === undefined ? [] : scope.split(/[\s,]+/).filter((s) => s.length > 0),
    };
  }

  async exchangeCode(req: {
    readonly credentials: RedditAppCredentials;
    readonly code: string;
    readonly redirectUri: string;
  }): Promise<{ readonly tokens: RedditTokens; readonly identity: RedditIdentity }> {
    const body = await this.#http.form(
      REDDIT_TOKEN_URL,
      { grant_type: "authorization_code", code: req.code, redirect_uri: req.redirectUri },
      this.#basic(req.credentials),
    );
    // La wiki: un 200 puede traer `error` (p. ej. `invalid_grant`).
    this.#http.rejectIfError(body);
    const tokens = this.#tokens(body, null);
    const identity = await this.identity(tokens.accessToken);
    return { tokens, identity };
  }

  async refresh(req: {
    readonly credentials: RedditAppCredentials;
    readonly refreshToken: string;
  }): Promise<RedditTokens> {
    const body = await this.#http.form(
      REDDIT_TOKEN_URL,
      { grant_type: "refresh_token", refresh_token: req.refreshToken },
      this.#basic(req.credentials),
    );
    this.#http.rejectIfError(body);
    // La respuesta del refresh no trae `refresh_token` (wiki): se conserva el anterior.
    return this.#tokens(body, req.refreshToken);
  }

  /** `GET /api/v1/me` (scope `identity`). Campos `id` y `name` de la wiki JSON (`account`). */
  async identity(accessToken: string): Promise<RedditIdentity> {
    const body = await this.#http.get(
      `${REDDIT_API_BASE}/api/v1/me`,
      {},
      {
        Authorization: `bearer ${accessToken}`,
        "User-Agent": this.#ua,
      },
    );
    const id = str(body, "id");
    const username = str(body, "name");
    if (!id || !username) throw this.#http.contract("reddit /api/v1/me without id/name");
    return { id, username };
  }

  /** `POST /api/v1/revoke_token`. De mejor esfuerzo: quien llama no espera el resultado. */
  async revoke(req: {
    readonly credentials: RedditAppCredentials;
    readonly token: string;
    readonly hint: "refresh_token" | "access_token";
  }): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const res = await this.#fetch(REDDIT_REVOKE_URL, {
        method: "POST",
        headers: {
          ...this.#basic(req.credentials),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          token: req.token,
          token_type_hint: req.hint,
        }).toString(),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new PortError(codeForStatus(res.status), "Reddit rejected the revocation", {
          source: `${SOURCE}/oauth`,
          cause: { status: res.status },
        });
      }
    } catch (e) {
      if (e instanceof PortError) throw e;
      throw new PortError("provider_unavailable", "Could not reach Reddit", {
        source: `${SOURCE}/oauth`,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ------------------------------------------------------------------------ *
 * API con token
 * ------------------------------------------------------------------------ */

export class RedditApi {
  readonly #fetch: OAuthFetch;
  readonly #timeoutMs: number;
  readonly #ua: string;
  readonly #token: string;

  constructor(config: RedditClientConfig & { readonly accessToken: string }) {
    this.#fetch = config.fetch ?? globalFetch;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#ua = config.userAgent;
    this.#token = config.accessToken;
  }

  async #call(
    method: "GET" | "POST",
    path: string,
    params: Readonly<Record<string, string>>,
  ): Promise<RedditResult<unknown>> {
    const q = new URLSearchParams(params).toString();
    const url =
      method === "GET" && q !== ""
        ? `${REDDIT_API_BASE}${path}?${q}`
        : `${REDDIT_API_BASE}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `bearer ${this.#token}`,
          "User-Agent": this.#ua,
          ...(method === "POST"
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
        },
        ...(method === "POST" ? { body: q } : {}),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new PortError("timeout", "Reddit did not answer in time", {
          source: SOURCE,
        });
      }
      throw new PortError("provider_unavailable", "Could not reach Reddit", {
        source: SOURCE,
      });
    }
    try {
      const rateLimit = rateLimitOf(res.headers);
      if (!res.ok) {
        const retry =
          res.status === 429 && rateLimit.resetSeconds !== null
            ? { retryAfterSeconds: Math.max(1, Math.ceil(rateLimit.resetSeconds)) }
            : {};
        throw new PortError(codeForStatus(res.status), "Reddit rejected the request", {
          source: SOURCE,
          cause: { status: res.status, path: path.replace(/\/r\/[^/]+/, "/r/{sr}") },
          ...retry,
        });
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new PortError(
          "provider_contract_violation",
          "Reddit answered with invalid JSON",
          {
            source: SOURCE,
            cause: { status: res.status },
          },
        );
      }
      return { data: body, rateLimit };
    } finally {
      clearTimeout(timer);
    }
  }

  #contract(why: string): PortError {
    return new PortError(
      "provider_contract_violation",
      "Reddit answered with an unexpected shape",
      {
        source: SOURCE,
        cause: why,
      },
    );
  }

  /** `GET /r/{subreddit}/new` (scope `read`, listing, `limit` ≤ 100). */
  async listNew(subreddit: string, limit: number): Promise<RedditResult<RedditPost[]>> {
    const r = await this.#call("GET", `/r/${encodeURIComponent(subreddit)}/new`, {
      limit: String(Math.max(1, Math.min(100, Math.floor(limit)))),
    });
    const children = listingChildren(r.data);
    if (children === null) throw this.#contract("/new is not a Listing");
    const posts = children.map(parsePost).filter((p): p is RedditPost => p !== null);
    return { data: posts, rateLimit: r.rateLimit };
  }

  /** `GET /comments/{article}` (scope `read`). Ver la cabecera: forma no verificada. */
  async getThread(
    postId: string,
    opts: { readonly limit: number; readonly depth: number },
  ): Promise<RedditResult<RedditThread>> {
    const r = await this.#call("GET", `/comments/${encodeURIComponent(postId)}`, {
      limit: String(opts.limit),
      depth: String(opts.depth),
      sort: "top",
    });
    if (!Array.isArray(r.data) || r.data.length < 2) {
      throw this.#contract("/comments is not [link, comments]");
    }
    const linkChildren = listingChildren(r.data[0]);
    const post = linkChildren?.[0] === undefined ? null : parsePost(linkChildren[0]);
    if (post === null) throw this.#contract("/comments without the link");
    const commentChildren = listingChildren(r.data[1]) ?? [];
    const comments: RedditComment[] = [];
    flattenComments(commentChildren, comments);
    return { data: { post, comments }, rateLimit: r.rateLimit };
  }

  /** `GET /api/info?id=t3_…` (scope `read`): un post por id, para agregarlo a mano. */
  async getPost(postId: string): Promise<RedditResult<RedditPost | null>> {
    const r = await this.#call("GET", "/api/info", { id: `t3_${postId}` });
    const children = listingChildren(r.data);
    if (children === null) throw this.#contract("/api/info is not a Listing");
    return {
      data: children[0] === undefined ? null : parsePost(children[0]),
      rateLimit: r.rateLimit,
    };
  }

  /** `GET /r/{sr}/about/rules` (scope `read`). Forma no verificada: sin reglas si no se entiende. */
  async getRules(subreddit: string): Promise<RedditResult<string[]>> {
    const r = await this.#call(
      "GET",
      `/r/${encodeURIComponent(subreddit)}/about/rules`,
      {},
    );
    const rules = rec(r.data)?.["rules"];
    const out: string[] = [];
    if (Array.isArray(rules)) {
      for (const rule of rules) {
        const o = rec(rule);
        if (o === null) continue;
        const name = str(o, "short_name");
        const desc = typeof o["description"] === "string" ? o["description"] : "";
        if (name) out.push(desc ? `${name}: ${unescapeRedditText(desc)}` : name);
      }
    }
    return { data: out, rateLimit: r.rateLimit };
  }

  /**
   * `POST /api/comment` (scope `submit`): `thing_id` = fullname del padre
   * (`t3_…` para un comentario de primer nivel), `text` = markdown crudo,
   * `api_type=json`. **No se reintenta nunca** desde acá.
   */
  async postComment(
    parentFullname: string,
    text: string,
  ): Promise<RedditResult<PostedComment>> {
    const r = await this.#call("POST", "/api/comment", {
      api_type: "json",
      thing_id: parentFullname,
      text,
    });
    const json = rec(rec(r.data)?.["json"]);
    const errors = json?.["errors"];
    if (Array.isArray(errors) && errors.length > 0) {
      // Cada error es `[CODE, message, field]` en la práctica; sólo el código sale al cause.
      const codes = errors
        .map((e) => (Array.isArray(e) && typeof e[0] === "string" ? e[0] : "unknown"))
        .slice(0, 5);
      throw new PortError(
        codes.includes("RATELIMIT") ? "rate_limited" : "bad_request",
        "Reddit did not accept the comment",
        { source: SOURCE, cause: { codes } },
      );
    }
    const things = rec(json?.["data"])?.["things"];
    const first = Array.isArray(things) ? rec(rec(things[0])?.["data"]) : null;
    return {
      data: {
        name: first === null ? null : (str(first, "name") ?? null),
        permalink: first === null ? null : (str(first, "permalink") ?? null),
      },
      rateLimit: r.rateLimit,
    };
  }
}
