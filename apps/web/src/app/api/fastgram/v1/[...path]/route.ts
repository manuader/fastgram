/**
 * El puente entre el navegador y `apps/api` · `P1-UI-012`, `P1-AUTH-002`.
 *
 * Existe por una razón: **la credencial no vive en el navegador**. El token de
 * sesión está en una cookie `httpOnly` (`lib/auth/session.ts`); este handler
 * la lee y la reenvía en `X-Fastgram-Session`. El porqué completo está en la
 * cabecera de `lib/api/upstream.ts`. Acá van las reglas de reenvío; cada una
 * tapa un agujero concreto:
 *
 * 1. **Escrituras (`POST`/`PUT`/`PATCH`/`DELETE`) sólo desde esta misma app.**
 *    Cada escritura pasa por `lib/api/csrf.ts` **antes** de leer la sesión o
 *    el cuerpo: `Origin` idéntico al origen propio, `Sec-Fetch-Site`
 *    `same-origin` si viene, y el header `x-fastgram-csrf` que fuerza
 *    preflight. Fallar cualquiera es `403 forbidden` con `details.reason`.
 *    `GET` no pasa por la guarda: no escribe, y el navegador no deja a una
 *    página ajena **leer** la respuesta cross-origin.
 * 2. **Una credencial, la del usuario.** Sin cookie de sesión → `401` acá, sin
 *    llamar a la API. Con cookie → `X-Fastgram-Session: <token>` y **nada
 *    más**: la API key del servidor (`FASTGRAM_API_KEY`) se retiró de la web.
 *    El proxy **no** verifica el token antes de reenviarlo — la API lo valida
 *    en la misma llamada, y un `401` suyo sube tal cual. Verificar acá sería
 *    una segunda ida a la API por cada petición para saber lo mismo.
 * 3. **`/auth/*` no se reenvía.** Los endpoints de identidad de la API
 *    devuelven `sessionToken` en el cuerpo, y este proxy devuelve el cuerpo tal
 *    cual (regla 5): un `POST /api/fastgram/v1/auth/login` le entregaría el
 *    token al JavaScript de la página, que es justo lo que la cookie `httpOnly`
 *    evita. Entrar y salir va por `/api/fastgram/auth/*`, que no lo devuelve.
 * 4. **Los headers que salen son una lista blanca.** Nada de reenviar lo que
 *    entra: un `Authorization` o un `X-Fastgram-Session` del cliente llegaría a
 *    `apps/api` como credencial —dejándole elegir identidad a quien llama— y
 *    una `Cookie` nuestra no tiene ningún sentido ahí. En escrituras se suman
 *    sólo `Content-Type` e `Idempotency-Key` (NFR-004; el nombre es el que lee
 *    `apps/api/src/routes/v1/shared.ts`). **El token no se loguea nunca.**
 * 5. **El cuerpo se reenvía tal cual, en los dos sentidos, con su status.** El
 *    `402` de cuota tiene copy distinta del `500` (§19), y el cliente distingue
 *    por el `code` del sobre. El proxy **no pone límite de tamaño**: el techo es
 *    el `bodyLimit` de `apps/api` (1 MiB), y los bytes de video no pasan por
 *    acá (van directo al storage con la URL firmada).
 * 6. **Nunca reintenta** (NFR-005). Un timeout en una escritura no dice si la
 *    API la aplicó; reintentar acá la duplicaría en los endpoints sin
 *    `Idempotency-Key`. El `502` sube al cliente, que decide — y si reintenta,
 *    lo hace con la misma key.
 */
import { type NextRequest } from "next/server";
import { SESSION_COOKIE, SESSION_HEADER } from "@/lib/auth/session";
import { rejectCrossSiteWrite, type WriteMethod } from "@/lib/api/csrf";
import { errorEnvelope } from "@/lib/api/envelope";
import {
  API_URL_ENV,
  readUpstreamConfig,
  resolveUpstreamUrl,
  UPSTREAM_TIMEOUT_MS,
} from "@/lib/api/upstream";

/** Node, no Edge: el reenvío usa `fetch` con `AbortSignal.timeout` y lee `process.env`. */
export const runtime = "nodejs";

/**
 * Nunca cacheado. Una respuesta de `/content` cacheada en el borde sería el
 * contenido de un workspace servido a otro — exactamente el fallo que §9.2
 * evita devolviendo 404 en vez de 403.
 */
export const dynamic = "force-dynamic";

/** `x-request-id`: lo propaga `apps/api` (`plugins/observability.ts`). */
const REQUEST_ID_HEADER = "x-request-id";

/** NFR-004. El nombre exacto es el que lee `apps/api` (`routes/v1/shared.ts`). */
const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/** Regla 3: el primer segmento que este proxy no reenvía nunca. */
const AUTH_SEGMENT = "auth";

interface RouteContext {
  /** Next 15: los params de una ruta dinámica son asíncronos. */
  readonly params: Promise<{ readonly path: string[] }>;
}

type ForwardMethod = "GET" | WriteMethod;

async function forward(
  method: ForwardMethod,
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  if (method !== "GET") {
    const rejected = rejectCrossSiteWrite(request.headers, process.env, "[api-proxy]");
    if (rejected !== null) return rejected;
  }

  const { path } = await context.params;
  if (path[0]?.toLowerCase() === AUTH_SEGMENT) {
    return errorEnvelope(404, "not_found", "Not found.");
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token === undefined || token === "") {
    return errorEnvelope(401, "unauthorized", "Sign in to continue.");
  }

  const env = readUpstreamConfig(process.env);
  if (!env.ok) {
    // Un log, no un throw: el desarrollador tiene que leer qué falta, y el
    // usuario tiene que ver "el servicio no responde" y no una pantalla vacía
    // que se confunde con "no hay contenido".
    console.error(`[api-proxy] ${API_URL_ENV} no está configurada.`);
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
    [SESSION_HEADER]: token,
  };
  // Si el navegador trae un id de traza, que la traza cruce el puente.
  const requestId = request.headers.get(REQUEST_ID_HEADER);
  if (requestId !== null) headers[REQUEST_ID_HEADER] = requestId;

  const init: RequestInit = {
    method,
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  };

  if (method !== "GET") {
    // Regla 4: sólo lo que la API necesita para escribir.
    const contentType = request.headers.get("content-type");
    if (contentType !== null) headers["Content-Type"] = contentType;
    const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER);
    if (idempotencyKey !== null) headers[IDEMPOTENCY_KEY_HEADER] = idempotencyKey;

    // Regla 5: los bytes tal cual. Se bufferiza en vez de reenviar el stream
    // porque un cuerpo de `ReadableStream` exige `duplex: "half"` en `fetch`
    // de Node y lo que cruza por acá es JSON chico (el video va al storage).
    const body = await request.arrayBuffer();
    if (body.byteLength > 0) init.body = body;
  }

  let upstream: Response;
  try {
    // Regla 6: un intento, sin reintento.
    upstream = await fetch(target, init);
  } catch {
    // Que `apps/api` no esté levantada es el caso más común en desarrollo y no
    // debe salir como un 500 opaco. El error **no** se imprime: su `cause`
    // puede arrastrar el request —con el token— o hostnames internos.
    console.error(`[api-proxy] la API no respondió (${method} /${path.join("/")})`);
    return errorEnvelope(
      502,
      "service_unavailable",
      "The API did not respond. Try again shortly.",
    );
  }

  // 204 (p. ej. un `DELETE`) no puede llevar cuerpo: `new Response("", {status: 204})`
  // lanza, así que se pasa `null`.
  const body =
    upstream.status === 204 || upstream.status === 304 ? null : await upstream.text();
  const responseHeaders: Record<string, string> = {
    "content-type":
      upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  // ERR-R01: sin `Retry-After` el cliente no sabe cuándo volver a intentar.
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter !== null) responseHeaders["retry-after"] = retryAfter;
  return new Response(body, { status: upstream.status, headers: responseHeaders });
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  return forward("GET", request, context);
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  return forward("POST", request, context);
}

export async function PUT(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  return forward("PUT", request, context);
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  return forward("PATCH", request, context);
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  return forward("DELETE", request, context);
}
