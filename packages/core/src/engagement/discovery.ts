/**
 * Descubrimiento de leads — `F-191`, `F-192`, `P4-ENGAGE-002/003`. Lógica
 * pura: el I/O está en `packages/adapters/src/reddit/` y el job en
 * `apps/worker/src/engagement/`.
 *
 * ## Cómo se descubre, y por qué así
 *
 * Por subreddit configurado, **una** llamada a `GET /r/{sr}/new` (listing
 * documentado en https://www.reddit.com/dev/api/ — scope `read`, `limit`
 * máximo 100) y el filtro por palabras clave se hace **acá**, en código. No
 * se usa `/search`: su sintaxis de consulta (operadores, comillas) no está
 * documentada en esa página y armar una consulta con `OR` sería inventar. Y
 * el costo es el mismo: una llamada por subreddit.
 *
 * ## Límite de tasa (verificado el 2026-09-24)
 *
 * La wiki archivada de la API dice *"Clients connecting via OAuth2 may make
 * up to 60 requests per minute"* y que se miren `X-Ratelimit-Used`,
 * `X-Ratelimit-Remaining` y `X-Ratelimit-Reset`
 * (https://github.com/reddit-archive/reddit/wiki/API). La Data API Wiki
 * actual (support.reddithelp.com, 403 para clientes sin JavaScript; citada
 * por terceros) habla de 100 QPM por client id promediadas en 10 minutos. Se
 * planifica con **60/min**, el menor de los dos, y los headers mandan
 * ({@link planAfterResponse}).
 */

/* ------------------------------------------------------------------------ *
 * Configuración por marca (F-192)
 * ------------------------------------------------------------------------ */

/** Topes de la configuración. Nuestros, para acotar llamadas y costo de juicio. */
export const DISCOVERY_LIMITS = {
  maxSubreddits: 10,
  maxKeywords: 20,
  keywordMaxChars: 64,
  /** `limit` de `/r/{sr}/new` (máximo documentado: 100). */
  listingLimit: 100,
  /** Leads nuevos que se juzgan por corrida, en total (cada uno = 1 juicio + 1 lectura del hilo). */
  maxScoredPerRun: 15,
  /** Posts más viejos que esto no son leads (un hilo de hace un mes ya se resolvió). */
  maxPostAgeHours: 72,
} as const;

/**
 * Nombre de subreddit, **sanity check nuestro** (letras, números y `_`, hasta
 * 21): no es una regla de Reddit citada, es para no armar una URL con basura.
 * Acepta `r/foo`, `/r/foo` y la URL entera.
 */
export function normalizeSubreddit(input: string): string | null {
  let s = input.trim();
  const url = /^https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\/([^/?#]+)/i.exec(s);
  if (url) s = url[1] ?? "";
  s = s.replace(/^\/?r\//i, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/.test(s) ? s : null;
}

export function normalizeKeyword(input: string): string | null {
  const k = input.trim().replace(/\s+/g, " ").toLowerCase();
  if (k.length < 2 || k.length > DISCOVERY_LIMITS.keywordMaxChars) return null;
  return k;
}

export interface DiscoverySettingsInput {
  readonly subreddits: readonly string[];
  readonly keywords: readonly string[];
}

export type DiscoverySettingsResult =
  | {
      readonly ok: true;
      readonly subreddits: readonly string[];
      readonly keywords: readonly string[];
    }
  | {
      readonly ok: false;
      readonly invalid: readonly string[];
      readonly field: "subreddits" | "keywords";
    };

/** Normaliza, deduplica (sin distinguir mayúsculas) y valida. */
export function normalizeDiscoverySettings(
  input: DiscoverySettingsInput,
): DiscoverySettingsResult {
  const subs: string[] = [];
  const seen = new Set<string>();
  const badSubs: string[] = [];
  for (const raw of input.subreddits) {
    const s = normalizeSubreddit(raw);
    if (s === null) {
      badSubs.push(raw);
      continue;
    }
    if (seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    subs.push(s);
  }
  if (badSubs.length > 0) return { ok: false, invalid: badSubs, field: "subreddits" };
  if (subs.length > DISCOVERY_LIMITS.maxSubreddits) {
    return {
      ok: false,
      invalid: subs.slice(DISCOVERY_LIMITS.maxSubreddits),
      field: "subreddits",
    };
  }
  const kws: string[] = [];
  const badKws: string[] = [];
  for (const raw of input.keywords) {
    const k = normalizeKeyword(raw);
    if (k === null) {
      badKws.push(raw);
      continue;
    }
    if (!kws.includes(k)) kws.push(k);
  }
  if (badKws.length > 0) return { ok: false, invalid: badKws, field: "keywords" };
  if (kws.length > DISCOVERY_LIMITS.maxKeywords) {
    return {
      ok: false,
      invalid: kws.slice(DISCOVERY_LIMITS.maxKeywords),
      field: "keywords",
    };
  }
  return { ok: true, subreddits: subs, keywords: kws };
}

/* ------------------------------------------------------------------------ *
 * Candidatos
 * ------------------------------------------------------------------------ */

/** Un post tal como lo necesita el descubrimiento (campos de la wiki JSON de Reddit). */
export interface RedditPostCandidate {
  /** ID36 del link (sin `t3_`). */
  readonly id: string;
  readonly subreddit: string;
  readonly title: string;
  readonly selftext: string;
  readonly author: string | null;
  readonly score: number;
  readonly numComments: number;
  readonly createdUtc: number;
  /** Relativo, como lo da Reddit (`/r/x/comments/…`). */
  readonly permalink: string;
  readonly over18: boolean;
  readonly locked: boolean;
  readonly stickied: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Las palabras clave que aparecen en título o cuerpo, como palabra (no
 * dentro de otra: "app" no matchea "apple"). Sin palabras clave, todo post
 * del subreddit es candidato (el juicio filtra).
 */
export function matchKeywords(text: string, keywords: readonly string[]): string[] {
  const hay = text.toLowerCase();
  return keywords.filter((k) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(k)}($|[^\\p{L}\\p{N}])`, "u").test(hay),
  );
}

export type CandidateSkip =
  "known" | "nsfw" | "locked" | "stickied" | "too_old" | "own_post" | "no_keyword";

/**
 * Filtra el listing. Dedupe por `id` contra lo ya guardado (`known`): la
 * base además tiene `UNIQUE (company_id, reddit_post_id)`, que es la guarda
 * real; esto sólo evita juzgar dos veces.
 */
export function selectCandidates(input: {
  readonly posts: readonly RedditPostCandidate[];
  readonly keywords: readonly string[];
  readonly knownIds: ReadonlySet<string>;
  readonly ownUsername: string | null;
  readonly now: Date;
}): {
  readonly selected: ReadonlyArray<{ post: RedditPostCandidate; matched: string[] }>;
  readonly skipped: Readonly<Partial<Record<CandidateSkip, number>>>;
} {
  const skipped: Partial<Record<CandidateSkip, number>> = {};
  const skip = (why: CandidateSkip) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };
  const oldest = input.now.getTime() / 1000 - DISCOVERY_LIMITS.maxPostAgeHours * 3600;
  const selected: Array<{ post: RedditPostCandidate; matched: string[] }> = [];
  const seen = new Set<string>();
  for (const post of input.posts) {
    if (input.knownIds.has(post.id) || seen.has(post.id)) {
      skip("known");
      continue;
    }
    seen.add(post.id);
    if (post.over18) {
      skip("nsfw");
      continue;
    }
    if (post.locked) {
      skip("locked");
      continue;
    }
    if (post.stickied) {
      skip("stickied");
      continue;
    }
    if (post.createdUtc < oldest) {
      skip("too_old");
      continue;
    }
    if (
      input.ownUsername !== null &&
      post.author !== null &&
      post.author.toLowerCase() === input.ownUsername.toLowerCase()
    ) {
      skip("own_post");
      continue;
    }
    const matched =
      input.keywords.length === 0
        ? []
        : matchKeywords(`${post.title}\n${post.selftext}`, input.keywords);
    if (input.keywords.length > 0 && matched.length === 0) {
      skip("no_keyword");
      continue;
    }
    selected.push({ post, matched });
  }
  // Más nuevos primero: con el tope de juicios por corrida, lo reciente gana.
  selected.sort((a, b) => b.post.createdUtc - a.post.createdUtc);
  return { selected, skipped };
}

/**
 * «Most Engaged Leads» (F-193) ordena por esto. **Decisión nuestra**: la
 * actividad del hilo es comentarios + votos netos, con los comentarios
 * pesando el doble (una conversación viva es la oportunidad; un post votado
 * y sin comentarios, no tanto).
 */
export function engagementScoreOf(post: {
  readonly score: number;
  readonly numComments: number;
}): number {
  return Math.max(0, post.numComments) * 2 + Math.max(0, post.score);
}

/* ------------------------------------------------------------------------ *
 * Límite de tasa
 * ------------------------------------------------------------------------ */

export interface RateLimitSnapshot {
  readonly used: number | null;
  readonly remaining: number | null;
  /** Segundos hasta que se renueva el período. */
  readonly resetSeconds: number | null;
}

/** Lo que planificamos si los headers no vienen: 60/min (ver la cabecera). */
export const RATE_LIMIT_PLAN = {
  requestsPerMinute: 60,
  /** Con esto o menos restantes, se corta la corrida y se reintenta después del reset. */
  reserve: 5,
  /** Espera mínima entre llamadas de una corrida (60/min → 1 s). */
  minIntervalMs: 1_000,
} as const;

/** Headers → números. Reddit los manda como texto, a veces con decimales. */
export function parseRateLimitHeaders(
  get: (name: string) => string | null,
): RateLimitSnapshot {
  const n = (name: string): number | null => {
    const raw = get(name);
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

export type RatePlan =
  | { readonly kind: "continue"; readonly waitMs: number }
  | { readonly kind: "pause"; readonly retryAfterSeconds: number };

/** Después de cada respuesta: seguir (con pausa mínima) o cortar hasta el reset. */
export function planAfterResponse(snapshot: RateLimitSnapshot): RatePlan {
  if (snapshot.remaining !== null && snapshot.remaining <= RATE_LIMIT_PLAN.reserve) {
    return {
      kind: "pause",
      retryAfterSeconds: Math.max(1, Math.ceil(snapshot.resetSeconds ?? 60)),
    };
  }
  return { kind: "continue", waitMs: RATE_LIMIT_PLAN.minIntervalMs };
}

/**
 * Backoff para reintentos de la corrida entera tras un `rate_limited` sin
 * reset conocido: 1, 2, 4, 8… minutos, tope 1 h.
 */
export function discoveryBackoffSeconds(attempt: number): number {
  const a = Math.max(0, Math.floor(attempt));
  return Math.min(3600, 60 * 2 ** a);
}

/* ------------------------------------------------------------------------ *
 * URLs
 * ------------------------------------------------------------------------ */

/** `https://www.reddit.com` + permalink relativo. */
export function redditThreadUrl(permalink: string): string {
  const p = permalink.startsWith("/") ? permalink : `/${permalink}`;
  return `https://www.reddit.com${p}`;
}

/**
 * Una URL de un post de Reddit → `{subreddit, postId}`, o `null`. Para
 * agregar un lead a mano (modo sin API) y validar que un permalink sea de
 * Reddit antes de abrirlo.
 */
export function parseRedditPostUrl(
  input: string,
): { readonly subreddit: string; readonly postId: string } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!/^(www\.|old\.|new\.)?reddit\.com$/i.test(url.hostname)) return null;
  const m = /^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]{2,12})(\/|$)/i.exec(
    url.pathname,
  );
  if (!m) return null;
  return { subreddit: m[1] ?? "", postId: (m[2] ?? "").toLowerCase() };
}
