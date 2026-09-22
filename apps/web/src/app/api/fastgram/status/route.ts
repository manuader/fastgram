/**
 * El estado del servicio, redactado, para la página pública · `P1-OBS-004`.
 *
 * Es el **segundo** route handler de esta app y el único **sin sesión**. Las
 * tres diferencias con el puente de `/api/fastgram/v1` no son casuales:
 *
 * 1. **No exige sesión.** `/status` es pública (`route-policy.ts`) porque una
 *    página de estado que pide login no sirve el día que el login es lo que
 *    está caído.
 * 2. **No lleva credencial.** `apps/api` monta `/health` fuera de `/api/v1` y
 *    fuera del plugin de auth, así que no hace falta — y mandar la API key del
 *    workspace a un endpoint que cualquiera puede llamar sería regalar
 *    superficie a cambio de nada.
 * 3. **No reenvía el cuerpo tal cual.** El puente v1 sí lo hace, y es lo
 *    correcto ahí. Acá sería publicar `checks` —qué dependencia interna está
 *    caída— a cualquiera con la URL. La redacción pasa **en este proceso**:
 *    `redactHealth` construye un objeto nuevo con una sola clave. El porqué
 *    completo está en `lib/status/health.ts`.
 *
 * ## La trampa: el status HTTP no es el estado del servicio
 *
 * `apps/api` responde **200 con `status: "degraded"`** (storage o cola caídos
 * no sacan la réplica de rotación) y **503 con `status: "unavailable"`**. Las
 * dos respuestas traen un informe válido. Por eso acá el cuerpo se lee
 * **siempre**, pase lo que pase con `response.ok`:
 *
 * · Tratar 200 como "todo bien" diría que no pasa nada con el storage caído.
 * · Tratar `!ok` como "no se pudo contactar" convertiría el informe más
 *   importante de los tres —"la API no puede servir nada"— en "no hubo
 *   respuesta", que es un mensaje distinto y peor.
 *
 * El status HTTP sólo decide qué se contesta cuando el **cuerpo** no se
 * entiende.
 */
import {
  HEALTH_TIMEOUT_MS,
  HEALTH_URL_ENV,
  redactHealth,
  resolveHealthUrl,
  STATUS_MAX_AGE_S,
} from "@/lib/status/health";

/** Node, no Edge: la URL del health check se lee de `process.env`. */
export const runtime = "nodejs";

/**
 * Sin cache de Next. La frescura se controla con `cache-control` en la
 * respuesta, que es el que también ve un CDN por delante; dejar que Next
 * cachee la ruta en build serviría un "ok" congelado para siempre.
 */
export const dynamic = "force-dynamic";

function json(status: number, body: unknown, maxAgeS: number | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control":
        maxAgeS === null ? "no-store" : `public, max-age=${String(maxAgeS)}`,
    },
  });
}

/** §9.3 — el mismo sobre de error que el resto de la shell sabe traducir. */
function errorEnvelope(status: number, code: string, message: string): Response {
  // Un fallo **no se cachea**: es el estado que más rápido cambia y el que menos
  // conviene congelar delante de un CDN.
  return json(status, { error: { code, message } }, null);
}

export async function GET(): Promise<Response> {
  const url = resolveHealthUrl(process.env);
  if (url === null) {
    // Un log y un 503, no un `ok`. Una página de estado que dice "todo bien"
    // porque no supo a quién preguntar es peor que una que no carga.
    console.error(
      `[status] no hay una URL de health válida: revisá ${HEALTH_URL_ENV} o FASTGRAM_API_URL.`,
    );
    return errorEnvelope(
      503,
      "service_unavailable",
      "The status endpoint is not configured on this server.",
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
  } catch (cause) {
    // El mensaje del error no se reenvía: lleva el host y el puerto internos.
    console.error("[status] el health check no respondió", cause);
    return errorEnvelope(
      502,
      "service_unavailable",
      "The status check did not respond. Try again shortly.",
    );
  }

  // Ojo con el orden: el cuerpo primero. Un 503 de `apps/api` trae el informe
  // `unavailable`, que es exactamente lo que esta página tiene que enseñar.
  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    body = undefined;
  }

  const redacted = redactHealth(body);
  if (redacted === null) {
    console.error(
      `[status] el health check contestó algo que no es un informe (HTTP ${String(upstream.status)}).`,
    );
    return errorEnvelope(
      502,
      "service_unavailable",
      "The status check answered something unexpected.",
    );
  }

  return json(200, redacted, STATUS_MAX_AGE_S);
}
