/**
 * Redirect URI del login de anuncios de Meta — sprint 9 (R), `D-21`.
 *
 *     GET /ads/connect/callback?code=…&state=…
 *
 * Es la URL que hay que sumar a *Valid OAuth Redirect URIs* de la app de Meta
 * (la pantalla de Ads la muestra). Reenvía `code` + `state` a la API desde el
 * servidor (`POST /ads/connection/callback`) y redirige a `/ads` con el
 * resultado. Mismo patrón que `/engagement/reddit/callback`: las piezas
 * (qué marca, por qué el `code` no pasa por la página) son las de
 * `lib/connections/callback.ts`.
 */
import { type NextRequest } from "next/server";
import { WORKSPACE_COOKIE, WORKSPACE_HEADER } from "@/lib/brands/workspace-cookie";
import { API_KEY_ENV, readUpstreamConfig } from "@/lib/api/upstream";
import {
  callbackBodyFrom,
  returnOrigin,
  workspaceForCallback,
} from "@/lib/connections/callback";
import { adsReturnPath, adsOutcomeFromApi } from "@/components/ads/callback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** code → token corto → token largo → `/me`: tres llamadas a Meta en la API. */
const CALLBACK_TIMEOUT_MS = 30_000;

function redirectTo(origin: string, path: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL(path, origin).toString(),
      "cache-control": "no-store",
      // La URL de Meta lleva el `code`: que no viaje como Referer.
      "referrer-policy": "no-referrer",
    },
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  const origin = returnOrigin(request.nextUrl.origin, process.env);
  const fail = (reason: string) =>
    redirectTo(origin, adsReturnPath({ kind: "error", reason }));

  const body = callbackBodyFrom(request.nextUrl.searchParams);
  if (body === null) return fail("oauth_state_invalid");

  const env = readUpstreamConfig(process.env);
  if (!env.ok) {
    console.error(`[ads-callback] ${API_KEY_ENV} no está configurada.`);
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
    const res = await fetch(`${base}ads/connection/callback`, {
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
    console.error("[ads-callback] la API no respondió");
    return fail("service_unavailable");
  }
  return redirectTo(origin, adsReturnPath(adsOutcomeFromApi(status, parsed)));
}
