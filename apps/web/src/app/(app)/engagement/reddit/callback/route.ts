/**
 * Redirect URI del OAuth de Reddit — `F-190`.
 *
 *     GET /engagement/reddit/callback?code=…&state=…
 *
 * Es la URL que se carga en reddit.com/prefs/apps (Engagement la muestra).
 * Reenvía `code` + `state` a la API desde el servidor y redirige a
 * `/engagement/actions` con el resultado. Las reglas (qué marca, por qué el
 * `code` no pasa por la página) están en `lib/engagement/callback.ts` y
 * `lib/connections/callback.ts`, cuyas piezas se reusan.
 */
import { type NextRequest } from "next/server";
import { WORKSPACE_COOKIE, WORKSPACE_HEADER } from "@/lib/brands/workspace-cookie";
import { API_KEY_ENV, readUpstreamConfig } from "@/lib/api/upstream";
import {
  callbackBodyFrom,
  returnOrigin,
  workspaceForCallback,
} from "@/lib/connections/callback";
import {
  redditOutcomeFromApi,
  redditReturnPath,
  type RedditCallbackOutcome,
} from "@/lib/engagement/callback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** El intercambio encadena dos llamadas a Reddit (token + identidad), 10 s cada una en la API. */
const CALLBACK_TIMEOUT_MS = 30_000;

function redirectTo(origin: string, outcome: RedditCallbackOutcome): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL(redditReturnPath(outcome), origin).toString(),
      "cache-control": "no-store",
      // La URL de Reddit lleva el `code`: que no viaje como Referer.
      "referrer-policy": "no-referrer",
    },
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  const origin = returnOrigin(request.nextUrl.origin, process.env);
  const fail = (reason: string) => redirectTo(origin, { kind: "error", reason });

  const body = callbackBodyFrom(request.nextUrl.searchParams);
  if (body === null) return fail("oauth_state_invalid");

  const env = readUpstreamConfig(process.env);
  if (!env.ok) {
    console.error(`[reddit-callback] ${API_KEY_ENV} no está configurada.`);
    return fail("service_unavailable");
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.config.apiKey}`,
  };
  const workspace = workspaceForCallback(
    request.cookies.get(WORKSPACE_COOKIE)?.value,
    body.state,
  );
  if (workspace !== null) headers[WORKSPACE_HEADER] = workspace;

  const base = env.config.base.endsWith("/") ? env.config.base : `${env.config.base}/`;
  let status: number;
  let parsed: unknown;
  try {
    const res = await fetch(`${base}engagement/reddit/callback`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    status = res.status;
    parsed = await res.json().catch(() => undefined);
  } catch {
    // Sin el error: puede llevar la URL interna de la API.
    console.error("[reddit-callback] la API no respondió");
    return fail("reddit_unavailable");
  }
  return redirectTo(origin, redditOutcomeFromApi(status, parsed));
}
