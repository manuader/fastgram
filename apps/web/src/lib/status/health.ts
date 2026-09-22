/**
 * El estado del servicio, tal y como puede verlo **cualquiera** · F-255
 * (PRD:721), `P1-OBS-004`.
 *
 * `apps/api` gana health checks que de verdad sondean sus dependencias
 * (`apps/api/src/server/health.ts`). El cuerpo que devuelven tiene tres claves:
 * `status` (`ok | degraded | unavailable`), `service` y `checks`, con un
 * `"up"`/`"down"` **por dependencia**. Este módulo es la frontera entre ese
 * cuerpo y `/status`, que es una página pública.
 *
 * ## Decisión 1 — qué se enseña: el estado, y nada más
 *
 * `/status` vive bajo `(public)` y `route-policy.ts` la deja **sin sesión** a
 * propósito: una página de estado que exige login no sirve el día que el login
 * es justo lo que está caído. O sea que su lector no es un operador: es
 * cualquiera con la URL.
 *
 * Un `checks` publicado le dice a ese cualquiera **qué subsistema concreto está
 * débil en este momento**. Durante un incidente eso es una invitación: quien
 * quiera hacer daño no tiene que adivinar dónde empujar, se lo estamos
 * diciendo. Así que lo que cruza hacia el navegador es **una sola palabra** —
 * `ok`, `degraded` o `unavailable`— y jamás el nombre de una dependencia.
 *
 * La contrapartida es real y se asume: la página no puede decir *"el storage
 * está caído"*. A cambio contesta la única pregunta que su lector trae —*"¿es
 * cosa mía o vuestra?"*— y las tres respuestas la contestan. Quien necesita
 * saber **cuál** es un operador, y el operador tiene `checks` donde ya estaba:
 * en `GET /health/ready` de `apps/api`, que no está publicado en internet.
 *
 * **Y la redacción pasa acá, en el servidor.** Es el punto que no es opcional:
 * si la página se limitara a *no dibujar* `checks`, el JSON entero seguiría en
 * la pestaña de red del navegador de cualquier visitante. No renderizar no es
 * no publicar. Por eso {@link redactHealth} devuelve un objeto **nuevo** con un
 * solo campo, y no el de entrada con una propiedad menos.
 *
 * ## Decisión 2 — `degraded` responde 200, y el cuerpo es el que manda
 *
 * `apps/api` devuelve **200** con `status: "degraded"` a propósito: storage o
 * cola caídos no sacan la réplica de rotación, porque un 503 en todas las
 * réplicas convierte *"las rutas de media fallan"* en *"la API no existe"*.
 *
 * Para esta página eso significa una cosa: **`response.ok` no es una respuesta**.
 * Leer el estado del código HTTP diría "todo bien" con el storage caído. Y el
 * error simétrico es igual de fácil y menos obvio: `unavailable` llega con
 * **503**, así que un `if (!response.ok) throw` convertiría el informe más
 * importante de los tres —"la API no puede servir nada"— en "no se pudo
 * contactar al servidor", que es un mensaje distinto y peor.
 *
 * Por eso {@link redactHealth} se aplica al cuerpo **sea cual sea el status
 * HTTP**, y el status sólo se mira cuando el cuerpo no se entiende.
 */
import { z } from "zod";
import { ApiRequestError } from "../api/errors";

/** Ruta del route handler de esta app que sirve la versión redactada. */
export const STATUS_ENDPOINT = "/api/fastgram/status";

/**
 * Variable de entorno con la URL **completa** del health check de `apps/api`.
 *
 * Existe porque derivar la URL del origen de `FASTGRAM_API_URL` es correcto
 * hoy y frágil mañana: `apps/api` monta `/health` en la **raíz** del servidor,
 * fuera de `/api/v1`, así que detrás de un proxy que sirva la API bajo un
 * prefijo (`https://example.test/fastgram/api/v1`) el origen a secas apunta a
 * `https://example.test/health`, que no es. Sin una palanca, eso se descubre en
 * producción con una página de estado que dice que el servicio está caído
 * cuando está perfecto.
 */
export const HEALTH_URL_ENV = "FASTGRAM_HEALTH_URL";

/** Misma variable que usa el puente de `/api/fastgram/v1`. */
export const API_URL_ENV = "FASTGRAM_API_URL";

/** Igual que `DEFAULT_UPSTREAM_BASE`, pero de la raíz: `/health` no va bajo `/api/v1`. */
export const DEFAULT_HEALTH_URL = "http://localhost:3001/health";

/**
 * Techo de espera contra el health check.
 *
 * Más corto que el de las lecturas de datos (10 s) porque del otro lado hay un
 * número conocido: `apps/api` corta **cada sonda a 2 s** y las corre en
 * paralelo (`HEALTH_PROBE_TIMEOUT_MS`), así que un chequeo sano no puede tardar
 * mucho más que eso. Lo que exceda es red, y una página de estado que gira diez
 * segundos antes de decir algo es, ella misma, una caída que nadie va a esperar
 * a leer.
 */
export const HEALTH_TIMEOUT_MS = 5_000;

/**
 * Cuánto puede quedarse vieja una respuesta de `/api/fastgram/status`.
 *
 * Una página de estado pública es un amplificador: es la URL que todo el mundo
 * abre **justo cuando algo va mal**, y cada visita sería una petición al health
 * check de la API — que a su vez sondea Postgres, R2 y la cola. `apps/api` ya
 * se defiende con su propio cache de 3 s y single-flight; estos 5 s son la capa
 * de este lado, y valen también para un CDN por delante (`public`).
 *
 * 5 s contra un refresco de {@link STATUS_POLL_INTERVAL_MS} significa que el
 * dato que se ve nunca tiene más de un par de segundos de retraso frente a lo
 * que el propio orquestador tarda en reaccionar (≥ 10 s en cualquier
 * configuración sensata). No esconde ninguna transición que importe.
 */
export const STATUS_MAX_AGE_S = 5;

/** Cada cuánto se vuelve a preguntar mientras la página está abierta. */
export const STATUS_POLL_INTERVAL_MS = 30_000;

export const SERVICE_STATES = ["ok", "degraded", "unavailable"] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

/**
 * Lo único que cruza hacia el navegador.
 *
 * `.strict()`: si alguien añade un campo al handler sin pensarlo, este schema
 * lo rechaza en el cliente y el test lo caza, en vez de que el campo viaje
 * calladito. Es la clase de regresión —un `checks` que vuelve— que no se nota
 * mirando la pantalla, porque la pantalla no lo dibuja.
 */
export const serviceStatusSchema = z.object({ state: z.enum(SERVICE_STATES) }).strict();
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

/**
 * El cuerpo de `apps/api`, leído **de fuera**.
 *
 * `z.object` sin `.passthrough()` descarta las claves que no están declaradas,
 * así que `checks` ni siquiera sobrevive al parseo. `service` se declara para
 * documentar la forma real y se tira igual: decir `"api"` en una página pública
 * es nombrar una pieza de la arquitectura sin que nadie gane nada.
 */
const upstreamHealthSchema = z.object({
  status: z.enum(SERVICE_STATES),
  service: z.string().optional(),
});

/**
 * De lo que contesta `apps/api` a lo que puede ver el mundo.
 *
 * Devuelve `null` cuando el cuerpo no es un informe reconocible — y ahí `null`
 * **no** quiere decir "sano": quiere decir "no se sabe", que es un caso que el
 * llamador tiene que tratar como fallo. Devolver `ok` ante un cuerpo raro sería
 * la mentira original de `/health` (una constante con forma de URL) reinventada
 * un nivel más arriba.
 */
export function redactHealth(body: unknown): ServiceStatus | null {
  const parsed = upstreamHealthSchema.safeParse(body);
  if (!parsed.success) return null;
  // Objeto nuevo, no el de entrada recortado: así no hay forma de que una
  // propiedad del upstream se cuele por descuido.
  return { state: parsed.data.status };
}

/**
 * Dónde está el health check de `apps/api`.
 *
 * Tres escalones, y el primero es la palanca: {@link HEALTH_URL_ENV} tal cual
 * si está puesta, el origen de {@link API_URL_ENV} + `/health` si no, y el
 * default de desarrollo al final. `null` cuando lo configurado no es una URL
 * absoluta — y entonces el handler responde un fallo, no un `ok`: una página de
 * estado que dice "todo bien" porque no supo a quién preguntar es peor que una
 * que no carga.
 */
export function resolveHealthUrl(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const explicit = env[HEALTH_URL_ENV];
  if (explicit !== undefined && explicit.trim() !== "") {
    return absoluteOrNull(explicit.trim());
  }

  const apiUrl = env[API_URL_ENV];
  if (apiUrl === undefined || apiUrl.trim() === "") return DEFAULT_HEALTH_URL;

  const origin = originOf(apiUrl.trim());
  return origin === null ? null : `${origin}/health`;
}

function absoluteOrNull(value: string): string | null {
  return originOf(value) === null ? null : value;
}

function originOf(value: string): string | null {
  // `new URL` acepta cosas como `mailto:` o `data:`, que tienen origen `null`
  // como cadena. Se exige http(s) explícitamente.
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Pide el estado al route handler de esta app.
 *
 * Vive acá y no en `lib/api/client.ts` porque **no es una llamada a la API v1**:
 * no lleva el sobre `{data}`, no lleva credencial y no exige sesión. Meterla en
 * el cliente tipado obligaría a que ese cliente conociera una segunda forma de
 * respuesta, y el precio de esa generalidad lo pagarían las treinta rutas que
 * sí son v1.
 *
 * Lanza `ApiRequestError` —el mismo que el resto de la shell— para que
 * `ApiErrorState` pueda dibujar el fallo con la salida que le corresponde
 * (§19.8) sin un componente de error propio para esta pantalla.
 */
export async function fetchServiceStatus(signal?: AbortSignal): Promise<ServiceStatus> {
  let response: Response;
  try {
    response = await fetch(STATUS_ENDPOINT, {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiRequestError({ code: "network_error", status: 0 });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiRequestError({
      code: "invalid_response",
      status: response.status,
      serverMessage: "Status response was not JSON",
    });
  }

  const parsed = serviceStatusSchema.safeParse(body);
  if (parsed.success) return parsed.data;

  // Sólo acá se mira el status HTTP, y sólo para elegir el copy del fallo: el
  // estado del servicio ya vendría en el cuerpo si el cuerpo fuera legible.
  throw new ApiRequestError({
    code: response.status >= 500 ? "service_unavailable" : "invalid_response",
    status: response.status,
    serverMessage: "Status response did not describe a service state",
  });
}
