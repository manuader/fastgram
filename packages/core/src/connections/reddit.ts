/**
 * OAuth de Reddit para Engagement — `F-190`, `P3-OAUTH-006` (`INT-005`).
 *
 * ## Por qué no está en `OAUTH_PLATFORM_SPECS`
 *
 * Reddit no publica contenido en FastGram (`D-11`: sólo responde a leads, y
 * sólo cuando el humano aprieta "Send"), así que no es una red de
 * `OAUTH_PLATFORMS` (`packages/ports/src/oauth.ts`): sumarla ahí la haría
 * aparecer en Connections, en la estrategia y en el barrido de publicación.
 * Tiene su propio flujo, acotado a Engagement, que reusa las mismas piezas
 * (`StateSigner`, `TokenCipher`) y el mismo formato de `state`.
 *
 * ## Lo verificado (2026-09-24)
 *
 * - Autorización: `https://www.reddit.com/api/v1/authorize` con
 *   `response_type=code`, `state`, `redirect_uri`, `duration=permanent` (para
 *   tener refresh token) y `scope` separado por espacios. Token:
 *   `POST https://www.reddit.com/api/v1/access_token` con HTTP Basic
 *   (`client_id:client_secret`). *"All bearer tokens expire after 1 hour."*
 *   Llamadas con el token a `https://oauth.reddit.com`, no a www. —
 *   https://github.com/reddit-archive/reddit/wiki/OAuth2
 * - Scopes mínimos, de https://www.reddit.com/dev/api/ :
 *   `identity` (`GET /api/v1/me`), `read` (`/r/{sr}/new`,
 *   `/comments/{article}`, `/r/{sr}/about/rules`, `/api/info`) y `submit`
 *   (`POST /api/comment` sobre un link o un comentario: *"requires submit
 *   scope"*).
 * - User-Agent obligatorio y único:
 *   `<platform>:<app ID>:<version string> (by /u/<reddit username>)` — *"NEVER
 *   lie about your user-agent"* — https://github.com/reddit-archive/reddit/wiki/API
 *
 * ## Lo que condiciona todo (Responsible Builder Policy, 2026-09-24)
 *
 * https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy
 * - *"Approval is required: You must request access and get explicit
 *   approval before accessing any Reddit data through our API"*.
 * - *"If you'd like to use Reddit data for commercial purposes, you'll need
 *   to get explicit written approval."* Buscar leads para una marca es, con
 *   toda probabilidad, uso comercial.
 * - *"Apps must not engage in spamming activity through automated posts,
 *   comments, or direct messages."*
 *
 * Por eso el módulo funciona **sin** la API (modo manual: pegar un post,
 * copiar la respuesta y abrir el hilo) y la conexión es opcional: sólo sirve
 * a quien ya tiene una app aprobada por Reddit.
 */
import type { StateSigner } from "@fastgram/ports";

export const REDDIT_OAUTH = {
  scopes: ["identity", "read", "submit"] as const,
  duration: "permanent",
  /** Los tokens duran 1 h; se refresca 5 min antes. */
  refreshMarginMs: 5 * 60 * 1000,
  callbackPath: "/engagement/reddit/callback",
  consoleUrl: "https://www.reddit.com/prefs/apps",
  policyUrl:
    "https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy",
  docsUrl: "https://github.com/reddit-archive/reddit/wiki/OAuth2",
  /** Nuestro identificador en el User-Agent. */
  appSlug: "fastgram-engagement",
  version: "0.1.0",
} as const;

/** Usuario de Reddit (el de la wiki: letras, números, `_` y `-`, hasta 20). Sanity check nuestro. */
export function normalizeRedditUsername(input: string): string | null {
  const u = input.trim().replace(/^\/?u\//i, "");
  return /^[A-Za-z0-9_-]{3,20}$/.test(u) ? u : null;
}

/** El User-Agent del formato documentado. `username` = el dueño de la app. */
export function redditUserAgent(username: string): string {
  return `web:${REDDIT_OAUTH.appSlug}:${REDDIT_OAUTH.version} (by /u/${username})`;
}

export function redditRedirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${REDDIT_OAUTH.callbackPath}`;
}

/** Hay que refrescar si vence dentro del margen (o ya venció). `null` = no se sabe → refrescar. */
export function redditTokenNeedsRefresh(expiresAt: Date | null, now: Date): boolean {
  if (expiresAt === null) return true;
  return expiresAt.getTime() - now.getTime() <= REDDIT_OAUTH.refreshMarginMs;
}

/* ------------------------------------------------------------------------ *
 * `state`
 * ------------------------------------------------------------------------ */

/**
 * Mismo formato que `connections/state.ts` (`v1.<base64url(json)>.<mac>`, con
 * `c` = marca), para que la web pueda leer la marca del `state` con la misma
 * función cuando el callback llega sin cookie. `p` es siempre `reddit`.
 */
const VERSION = "v1";
export const REDDIT_STATE_TTL_MS = 10 * 60 * 1000;

interface Payload {
  readonly c: string;
  readonly p: "reddit";
  readonly n: string;
  readonly e: number;
}

const b64url = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
const unb64url = (s: string): string => Buffer.from(s, "base64url").toString("utf8");

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function issueRedditState(
  signer: StateSigner,
  input: { readonly companyId: string; readonly nonce: string; readonly now: Date },
): Promise<{ readonly state: string; readonly expiresAt: Date }> {
  const expiresAt = new Date(input.now.getTime() + REDDIT_STATE_TTL_MS);
  const payload: Payload = {
    c: input.companyId,
    p: "reddit",
    n: input.nonce,
    e: expiresAt.getTime(),
  };
  const body = `${VERSION}.${b64url(JSON.stringify(payload))}`;
  return { state: `${body}.${await signer.sign(body)}`, expiresAt };
}

export type RedditStateCheck =
  | { readonly ok: true; readonly nonce: string }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "bad_signature" | "expired" | "wrong_brand";
    };

/**
 * Verifica firma, vencimiento y marca. **No** gasta el nonce: eso lo hace
 * quien llama, con su registro de un solo uso.
 */
export async function verifyRedditState(
  signer: StateSigner,
  input: { readonly state: string; readonly companyId: string; readonly now: Date },
): Promise<RedditStateCheck> {
  const parts = input.state.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION)
    return { ok: false, reason: "malformed" };
  const [, encoded, mac] = parts as [string, string, string];
  const body = `${VERSION}.${encoded}`;
  if (!constantTimeEqual(await signer.sign(body), mac)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(unb64url(encoded));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload !== "object" || payload === null)
    return { ok: false, reason: "malformed" };
  const p = payload as Record<string, unknown>;
  if (
    typeof p["c"] !== "string" ||
    p["p"] !== "reddit" ||
    typeof p["n"] !== "string" ||
    typeof p["e"] !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (p["e"] <= input.now.getTime()) return { ok: false, reason: "expired" };
  if (p["c"] !== input.companyId) return { ok: false, reason: "wrong_brand" };
  return { ok: true, nonce: p["n"] };
}
