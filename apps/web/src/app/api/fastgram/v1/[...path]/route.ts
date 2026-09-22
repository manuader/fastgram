/**
 * El puente entre el navegador y `apps/api` · `P1-UI-012`.
 *
 * Existe por una razón y sólo una: **la credencial**. El porqué completo —y por
 * qué esto es provisorio— está en la cabecera de `lib/api/upstream.ts`. Acá van
 * las reglas de reenvío, que son cuatro y cada una tapa un agujero concreto:
 *
 * 1. **Sólo `GET`.** No hay anti-CSRF; con escrituras abiertas, cualquier
 *    página podría disparar un `DELETE /content/:id` contra el workspace del
 *    servidor. Next no exporta `POST`/`PATCH`/`DELETE` acá, así que responde
 *    405 por su cuenta.
 * 2. **Exige la sesión de la shell.** Es la misma costura que usan las guards
 *    (`lib/auth/session.ts`), no una autenticación de verdad — pero sin ella el
 *    handler sería una ventana abierta al workspace para cualquiera que alcance
 *    el puerto de Next.
 * 3. **Los headers que salen son una lista blanca.** Nada de reenviar lo que
 *    entra: un `Authorization` del cliente llegaría a `apps/api` como si fuera
 *    una key válida —dejándole elegir credencial a quien llama— y una `Cookie`
 *    nuestra no tiene ningún sentido ahí.
 * 4. **El cuerpo se reenvía tal cual, con su status.** El `402` de cuota tiene
 *    copy distinta del `500` (§19), y el cliente distingue por el `code` del
 *    sobre. Reempaquetar la respuesta acá sería perder justo eso.
 */
import { type NextRequest } from "next/server";
import { readSession } from "@/lib/auth/server-session";
import {
  API_KEY_ENV,
  readUpstreamConfig,
  resolveUpstreamUrl,
  UPSTREAM_TIMEOUT_MS,
} from "@/lib/api/upstream";

/**
 * Node, no Edge: `readSession` usa `next/headers` y el reenvío usa `fetch` con
 * `AbortSignal.timeout`. Y sobre todo, la key se lee de `process.env`.
 */
export const runtime = "nodejs";

/**
 * Nunca cacheado. Una respuesta de `/content` cacheada en el borde sería el
 * contenido de un workspace servido a otro — exactamente el fallo que §9.2
 * evita devolviendo 404 en vez de 403.
 */
export const dynamic = "force-dynamic";

/** `x-request-id`: lo propaga `apps/api` (`plugins/observability.ts`). */
const REQUEST_ID_HEADER = "x-request-id";

/** §9.3 — el mismo sobre de error que emite `apps/api`, para que el cliente no note la diferencia. */
function errorEnvelope(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

interface RouteContext {
  /** Next 15: los params de una ruta dinámica son asíncronos. */
  readonly params: Promise<{ readonly path: string[] }>;
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const session = await readSession();
  if (session === null) {
    return errorEnvelope(401, "unauthorized", "Sign in to continue.");
  }

  const { path } = await context.params;
  const env = readUpstreamConfig(process.env);
  if (!env.ok) {
    // Un log, no un throw: el desarrollador tiene que leer qué falta, y el
    // usuario tiene que ver "el servicio no responde" y no una pantalla vacía
    // que se confunde con "no hay contenido".
    console.error(
      `[api-proxy] ${API_KEY_ENV} no está configurada: no hay credencial con la que llamar a la API.`,
    );
    return errorEnvelope(
      503,
      "service_unavailable",
      "The API is not configured on this server.",
    );
  }

  const target = resolveUpstreamUrl(env.config.base, path, request.nextUrl.search);
  if (target === null) {
    return errorEnvelope(400, "bad_request", "That path is not valid.");
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${env.config.apiKey}`,
  };
  // Si el navegador trae un id de traza, que la traza cruce el puente.
  const requestId = request.headers.get(REQUEST_ID_HEADER);
  if (requestId !== null) headers[REQUEST_ID_HEADER] = requestId;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (cause) {
    // Que `apps/api` no esté levantada es el caso más común en desarrollo y no
    // debe salir como un 500 opaco. El mensaje del error no se reenvía: puede
    // llevar hostnames internos.
    console.error("[api-proxy] la API no respondió", cause);
    return errorEnvelope(
      502,
      "service_unavailable",
      "The API did not respond. Try again shortly.",
    );
  }

  const body = await upstream.text();
  const contentType = upstream.headers.get("content-type");
  return new Response(body, {
    status: upstream.status,
    headers: {
      "content-type": contentType ?? "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
