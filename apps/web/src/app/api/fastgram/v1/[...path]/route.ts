/**
 * El puente entre el navegador y `apps/api` · `P1-UI-012`.
 *
 * Existe por una razón y sólo una: **la credencial**. El porqué completo —y por
 * qué esto es provisorio— está en la cabecera de `lib/api/upstream.ts`. Acá van
 * las reglas de reenvío; cada una tapa un agujero concreto:
 *
 * 1. **Escrituras (`POST`/`PUT`/`PATCH`/`DELETE`) sólo desde esta misma app.**
 *    Antes esta regla era "sólo `GET`", porque sin anti-CSRF cualquier página
 *    de internet podría haber disparado un `DELETE /content/:id` con la key del
 *    servidor. Ahora cada escritura pasa por `lib/api/csrf.ts` **antes** de
 *    leer la sesión o el cuerpo: `Origin` idéntico al origen propio, `Sec-Fetch-Site`
 *    `same-origin` si viene, y el header `x-fastgram-csrf` que fuerza preflight.
 *    Fallar cualquiera es `403 forbidden` con `details.reason`. Qué protege cada
 *    guarda, cómo se decide el origen propio detrás de un proxy y **qué queda
 *    abierto** (DNS rebinding sin `FASTGRAM_APP_ORIGIN`) está en ese módulo.
 *    `GET` no pasa por la guarda: no escribe, y el navegador no deja a una
 *    página ajena **leer** la respuesta cross-origin.
 * 2. **Exige la sesión de la shell**, en lectura y en escritura por igual. Es
 *    la misma costura que usan las guards (`lib/auth/session.ts`), **no** una
 *    autenticación de verdad: hoy la cookie no está firmada y fuera de
 *    producción hay una sesión de desarrollo por defecto. La autenticación real
 *    es P1-AUTH-002. La guarda CSRF de la regla 1 dice "esto salió de nuestra
 *    página", no "esto lo pidió quien dice ser".
 * 3. **Los headers que salen son una lista blanca.** Nada de reenviar lo que
 *    entra: un `Authorization` del cliente llegaría a `apps/api` como si fuera
 *    una key válida —dejándole elegir credencial a quien llama— y una `Cookie`
 *    nuestra no tiene ningún sentido ahí. En escrituras se suman sólo
 *    `Content-Type` (la API parsea por él) e `Idempotency-Key` (NFR-004; el
 *    nombre es el que lee `apps/api/src/routes/v1/shared.ts`).
 * 4. **El cuerpo se reenvía tal cual, en los dos sentidos, con su status.** El
 *    `429` de cuota tiene copy distinta del `500` (§19), y el cliente distingue
 *    por el `code` del sobre. Reempaquetar la respuesta acá sería perder justo
 *    eso. El proxy **no pone límite de tamaño**: el techo es el `bodyLimit` de
 *    `apps/api` (1 MiB), y los bytes de video no pasan por acá (van directo al
 *    storage con la URL firmada).
 * 5. **Nunca reintenta** (NFR-005). Un timeout en una escritura no dice si la
 *    API la aplicó; reintentar acá la duplicaría en los endpoints sin
 *    `Idempotency-Key`. El `502` sube al cliente, que decide — y si reintenta,
 *    lo hace con la misma key.
 */
import { type NextRequest } from "next/server";
import { readSession } from "@/lib/auth/server-session";
import {
  APP_ORIGIN_ENV,
  checkCsrf,
  CSRF_HEADER,
  expectedOrigin,
  type WriteMethod,
} from "@/lib/api/csrf";
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

/** NFR-004. El nombre exacto es el que lee `apps/api` (`routes/v1/shared.ts`). */
const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/** §9.3 — el mismo sobre de error que emite `apps/api`, para que el cliente no note la diferencia. */
function errorEnvelope(
  status: number,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): Response {
  const error = details === undefined ? { code, message } : { code, message, details };
  return new Response(JSON.stringify({ error }), {
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

type ForwardMethod = "GET" | WriteMethod;

/**
 * Regla 1. Devuelve la respuesta de rechazo, o `null` si la escritura pasa.
 *
 * Corre antes de la sesión a propósito: una petición cross-site no tiene por
 * qué enterarse de si el navegador de la víctima tenía sesión.
 */
function rejectCrossSiteWrite(request: NextRequest): Response | null {
  const expected = expectedOrigin(process.env, request.headers.get("host"));
  if (!expected.ok) {
    console.error(
      expected.reason === "app_origin_required"
        ? `[api-proxy] ${APP_ORIGIN_ENV} no está configurada: en producción las escrituras no se aceptan sin un origen público explícito.`
        : `[api-proxy] ${APP_ORIGIN_ENV} no es una URL http(s) válida.`,
    );
    return errorEnvelope(
      503,
      "service_unavailable",
      "The API is not configured on this server.",
    );
  }
  const rejection = checkCsrf({
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    csrfHeader: request.headers.get(CSRF_HEADER),
    expected: expected.origin,
  });
  if (rejection === null) return null;
  return errorEnvelope(403, "forbidden", "Cross-site request rejected.", {
    reason: rejection,
  });
}

async function forward(
  method: ForwardMethod,
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  if (method !== "GET") {
    const rejected = rejectCrossSiteWrite(request);
    if (rejected !== null) return rejected;
  }

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

  const init: RequestInit = {
    method,
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  };

  if (method !== "GET") {
    // Regla 3: sólo lo que la API necesita para escribir.
    const contentType = request.headers.get("content-type");
    if (contentType !== null) headers["Content-Type"] = contentType;
    const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER);
    if (idempotencyKey !== null) headers[IDEMPOTENCY_KEY_HEADER] = idempotencyKey;

    // Regla 4: los bytes tal cual. Se bufferiza en vez de reenviar el stream
    // porque un cuerpo de `ReadableStream` exige `duplex: "half"` en `fetch`
    // de Node y lo que cruza por acá es JSON chico (el video va al storage).
    const body = await request.arrayBuffer();
    if (body.byteLength > 0) init.body = body;
  }

  let upstream: Response;
  try {
    // Regla 5: un intento, sin reintento.
    upstream = await fetch(target, init);
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

  // 204 (p. ej. un `DELETE`) no puede llevar cuerpo: `new Response("", {status: 204})`
  // lanza, así que se pasa `null`.
  const body =
    upstream.status === 204 || upstream.status === 304 ? null : await upstream.text();
  const contentType = upstream.headers.get("content-type");
  return new Response(body, {
    status: upstream.status,
    headers: {
      "content-type": contentType ?? "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
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
