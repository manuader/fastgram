/**
 * Defensa CSRF del proxy `/api/fastgram/v1/*` para las escrituras.
 *
 * ## Qué problema tapa
 *
 * El proxy reenvía **el token de sesión del usuario** (que el navegador manda
 * solo, en la cookie) en cada petición. Con `POST`/`PATCH`/`DELETE` abiertos y
 * sin esto, cualquier página de internet que un usuario con sesión visite
 * podría hacer un `<form method=post action=".../api/fastgram/v1/content/…">`
 * —o un `fetch` con `mode: "no-cors"`— y la escritura saldría hacia
 * `apps/api` como si la hubiera pedido él. `SameSite=Lax` frena la mayoría de
 * esos casos, pero no un subdominio hermano (mismo *site*); eso es CSRF, y
 * esta es la defensa.
 *
 * ## Las tres guardas, y qué cubre cada una
 *
 * Las tres se exigen juntas. No son redundantes: cada una cubre un hueco de
 * las otras.
 *
 * 1. **`Origin` exactamente igual al origen propio.** Los navegadores
 *    modernos mandan `Origin` en toda petición no-`GET`, y un script no lo
 *    puede falsificar. Un `Origin` ausente se **rechaza**: el único caso real
 *    es un cliente que no es un navegador (y ése no es un vector CSRF, pero
 *    tampoco un cliente de este proxy) o un navegador muy viejo. Fallar
 *    cerrado cuesta poco acá.
 * 2. **`Sec-Fetch-Site`, si viene, tiene que ser `same-origin`.** Es un header
 *    prohibido (lo pone el navegador, no el script) y distingue `same-site` de
 *    `same-origin`: un subdominio hermano comprometido comparte *site* pero no
 *    *origin*. Si no viene (navegador sin Fetch Metadata) no se exige — la
 *    guarda 1 ya decide.
 * 3. **Header custom `x-fastgram-csrf`.** No es un secreto: su valor es fijo.
 *    Lo que protege es que **no es un header CORS-safelisted**, así que
 *    cualquier petición cross-origin que lo lleve obliga a un preflight, y este
 *    proxy no responde `OPTIONS` con permisos CORS → el navegador no envía la
 *    escritura. Un `<form>` HTML no puede poner headers en absoluto. Es la
 *    defensa que queda en pie si algún día un navegador o un intermediario
 *    deja pasar un `Origin` raro.
 *
 * ## El origen propio detrás de un proxy — la decisión
 *
 * **No se usa `request.nextUrl.origin`.** Medido en `next@15.5`
 * (`server/lib/router-utils/resolve-routes.js`): Next arma esa URL con el
 * `hostname`/`port` **con los que escucha el proceso** —no con el `Host` que
 * pidió el navegador— y el esquema lo saca de `X-Forwarded-Proto`. Detrás de
 * un proxy eso es la dirección interna, y comparar contra ella rechaza todo
 * (o, peor, acepta lo que no debe si alguien la conoce).
 *
 * **Tampoco se confía en `X-Forwarded-Host` / `X-Forwarded-Proto`.** Quién los
 * pone depende de la infraestructura, y este módulo no sabe si hay un proxy
 * delante que los sobrescribe o si llegan tal cual del cliente.
 *
 * Entonces:
 *
 * - **Con `FASTGRAM_APP_ORIGIN` puesta** (p. ej. `https://app.fastgram.io`),
 *   ése es el origen propio, y es el único aceptado. Es la configuración
 *   explícita, y la **obligatoria en producción**: detrás de un proxy TLS el
 *   proceso no tiene otra forma honesta de saber su esquema público.
 * - **Sin ella, fuera de producción**, el origen propio es `http://<Host>`. El
 *   `Host` lo pone el navegador y un script no lo puede cambiar, así que para
 *   CSRF es un ancla válida. Sólo `http`: `next dev` sirve en claro, y un
 *   `next dev --experimental-https` necesita la variable.
 * - **Sin ella, en producción**, las escrituras fallan cerradas con `503` y un
 *   log que dice qué falta. Adivinar el origen en producción es exactamente
 *   lo que no hay que hacer.
 *
 * ## Qué queda ABIERTO — escrito para que nadie lo dé por cerrado
 *
 * - **DNS rebinding sin `FASTGRAM_APP_ORIGIN`.** Una página en `evil.test` que
 *   re-resuelve a `127.0.0.1` hace que el navegador mande `Host: evil.test` y
 *   `Origin: http://evil.test`: coinciden, y las tres guardas pasan. Con la
 *   variable puesta, no. Sólo afecta al modo sin configurar (desarrollo), y ahí
 *   el `GET` ya estaba igual de expuesto.
 * - **Esto no es autenticación.** Sólo garantiza que la petición salió de una
 *   página de esta app. Quién es el usuario lo dice el token de sesión, que
 *   valida `apps/api` (`lib/auth/session.ts`).
 */
import { errorEnvelope } from "./envelope";

/** Header custom que exige el proxy en escrituras. Lo pone `lib/api/client.ts`. */
export const CSRF_HEADER = "x-fastgram-csrf";

/** Valor fijo. No es un secreto: lo que importa es que el header exista. */
export const CSRF_HEADER_VALUE = "1";

/** Origen público de la app. Sin `NEXT_PUBLIC_`: sólo lo lee el servidor. */
export const APP_ORIGIN_ENV = "FASTGRAM_APP_ORIGIN";

/** Métodos que el proxy reenvía y que escriben. */
export const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
export type WriteMethod = (typeof WRITE_METHODS)[number];

export type CsrfRejection =
  | "missing_origin"
  | "origin_mismatch"
  | "cross_site_fetch"
  | "missing_csrf_header"
  | "missing_host";

export type ExpectedOriginResult =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly reason: "app_origin_invalid" | "app_origin_required" };

/**
 * El origen contra el que se compara `Origin`. Ver la cabecera: con la
 * variable manda la variable; sin ella, `http://<Host>` fuera de producción y
 * nada en producción.
 *
 * Devuelve `origin: ""` si no hay `Host`: la comparación con cualquier
 * `Origin` real falla y la guarda lo reporta como `missing_host`.
 */
export function expectedOrigin(
  env: Readonly<Record<string, string | undefined>>,
  host: string | null,
): ExpectedOriginResult {
  const configured = env[APP_ORIGIN_ENV];
  if (configured !== undefined && configured.trim() !== "") {
    let parsed: URL;
    try {
      parsed = new URL(configured.trim());
    } catch {
      return { ok: false, reason: "app_origin_invalid" };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, reason: "app_origin_invalid" };
    }
    return { ok: true, origin: parsed.origin };
  }
  if (env["NODE_ENV"] === "production") {
    return { ok: false, reason: "app_origin_required" };
  }
  if (host === null || host.trim() === "") return { ok: true, origin: "" };
  return { ok: true, origin: `http://${host.trim().toLowerCase()}` };
}

/** Lo que la guarda necesita del request: sólo headers, para poder probarla sin Next. */
export interface CsrfInput {
  readonly origin: string | null;
  readonly secFetchSite: string | null;
  readonly csrfHeader: string | null;
  /** Salida de `expectedOrigin` cuando fue `ok`. `""` = no había `Host`. */
  readonly expected: string;
}

/**
 * `null` si la escritura pasa las tres guardas; si no, el motivo.
 *
 * El orden de las comprobaciones es el de la cabecera y **no importa para la
 * seguridad** —se exigen las tres—, sólo para qué motivo se reporta primero.
 */
export function checkCsrf(input: CsrfInput): CsrfRejection | null {
  if (input.origin === null || input.origin === "") return "missing_origin";
  if (input.expected === "") return "missing_host";
  if (input.origin !== input.expected) return "origin_mismatch";
  if (input.secFetchSite !== null && input.secFetchSite !== "same-origin") {
    return "cross_site_fetch";
  }
  if (input.csrfHeader !== CSRF_HEADER_VALUE) return "missing_csrf_header";
  return null;
}

/**
 * La guarda completa para un route handler: origen propio + las tres guardas.
 * Devuelve la respuesta de rechazo (`403`, o `503` si en producción falta
 * `FASTGRAM_APP_ORIGIN`), o `null` si la escritura pasa.
 *
 * La usan el proxy (`/api/fastgram/v1/*`) y los handlers de auth
 * (`/api/fastgram/auth/*`). En los de auth protege algo distinto y igual de
 * real: el **login CSRF** — una página ajena que hace `POST` al login con las
 * credenciales **del atacante** deja a la víctima dentro de la cuenta del
 * atacante, y lo que suba ahí (una marca, un video) lo ve el atacante.
 *
 * Corre antes de leer sesión o cuerpo: una petición cross-site no tiene por
 * qué enterarse de nada.
 */
export function rejectCrossSiteWrite(
  headers: Headers,
  env: Readonly<Record<string, string | undefined>>,
  logPrefix: string,
): Response | null {
  const expected = expectedOrigin(env, headers.get("host"));
  if (!expected.ok) {
    console.error(
      expected.reason === "app_origin_required"
        ? `${logPrefix} ${APP_ORIGIN_ENV} no está configurada: en producción las escrituras no se aceptan sin un origen público explícito.`
        : `${logPrefix} ${APP_ORIGIN_ENV} no es una URL http(s) válida.`,
    );
    return errorEnvelope(
      503,
      "service_unavailable",
      "The API is not configured on this server.",
    );
  }
  const rejection = checkCsrf({
    origin: headers.get("origin"),
    secFetchSite: headers.get("sec-fetch-site"),
    csrfHeader: headers.get(CSRF_HEADER),
    expected: expected.origin,
  });
  if (rejection === null) return null;
  return errorEnvelope(403, "forbidden", "Cross-site request rejected.", {
    reason: rejection,
  });
}
