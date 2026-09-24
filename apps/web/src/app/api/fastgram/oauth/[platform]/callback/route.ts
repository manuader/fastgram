/**
 * Redirect URI del OAuth de cada plataforma — `PU-PUB-002`.
 *
 *     GET /api/fastgram/oauth/{platform}/callback?code=…&state=…
 *
 * Es la URL que se carga en la consola de cada plataforma (Settings →
 * Integrations la muestra). Reenvía `code` + `state` a la API desde el
 * servidor y redirige a `/settings/connections` con el resultado. Las reglas
 * (qué marca, por qué no pide la sesión) están en `lib/connections/callback.ts`.
 *
 * Un timeout propio y más largo que el del proxy: el intercambio encadena
 * hasta cuatro llamadas a la plataforma (Instagram: code → token corto →
 * token largo → perfil), cada una con 8 s de tope en la API.
 */
import { type NextRequest } from "next/server";
import { WORKSPACE_COOKIE, WORKSPACE_HEADER } from "@/lib/brands/workspace-cookie";
import {
  callbackBodyFrom,
  isOAuthPlatformId,
  outcomeFromApi,
  returnOrigin,
  returnPath,
  workspaceForCallback,
  type CallbackOutcome,
  type OAuthPlatformId,
} from "@/lib/connections/callback";
import { API_KEY_ENV, readUpstreamConfig } from "@/lib/api/upstream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CALLBACK_TIMEOUT_MS = 40_000;

interface RouteContext {
  readonly params: Promise<{ readonly platform: string }>;
}

function redirectTo(origin: string, outcome: CallbackOutcome): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL(returnPath(outcome), origin).toString(),
      "cache-control": "no-store",
      // La URL de la plataforma lleva el `code`: que no viaje como Referer.
      "referrer-policy": "no-referrer",
    },
  });
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const { platform: raw } = await context.params;
  const origin = returnOrigin(request.nextUrl.origin, process.env);
  if (!isOAuthPlatformId(raw)) {
    return new Response("Not found", { status: 404 });
  }
  const platform: OAuthPlatformId = raw;
  const fail = (reason: string) =>
    redirectTo(origin, { kind: "error", platform, reason });

  const body = callbackBodyFrom(request.nextUrl.searchParams);
  if (body === null) return fail("oauth_state_invalid");

  const env = readUpstreamConfig(process.env);
  if (!env.ok) {
    console.error(`[oauth-callback] ${API_KEY_ENV} no está configurada.`);
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
    const res = await fetch(`${base}connections/${platform}/callback`, {
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
    console.error("[oauth-callback] la API no respondió");
    return fail("oauth_provider_unavailable");
  }
  return redirectTo(origin, outcomeFromApi(platform, status, parsed));
}
