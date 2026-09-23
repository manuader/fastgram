/**
 * El lado servidor del cliente de API: dónde está `apps/api`.
 *
 * ## Por qué el navegador no habla directo con `apps/api`
 *
 * La web es un **BFF**. El navegador habla con route handlers de esta misma
 * app (`/api/fastgram/auth/*` para entrar y salir, `/api/fastgram/v1/*` para
 * todo lo demás); ellos leen el token de sesión de una cookie `httpOnly` y lo
 * reenvían a `apps/api` en `X-Fastgram-Session`. El token no existe para el
 * JavaScript de la página, y la API no tiene que saber nada de cookies ni de
 * CORS.
 *
 * ## La API key del servidor se retiró de la web
 *
 * Hasta P1-AUTH-002 el proxy llamaba a la API con **una** `FASTGRAM_API_KEY`
 * por despliegue: un workspace para todo el que llegara a la app. Con
 * identidad real eso se acabó, y no queda como fallback: una key de workspace
 * detrás de una sesión de usuario son **dos credenciales en el mismo
 * request**, y la API tendría que adivinar cuál manda. La key (FR-180) vuelve
 * a ser lo que el PRD dice que es — una credencial de máquina, para
 * integraciones —, y la web no la lee.
 *
 * **Nunca un secreto acá.** Este módulo lee nombres de variables; los valores
 * viven en el entorno del proceso.
 */

/** Variable de entorno con la base de `apps/api`. */
export const API_URL_ENV = "FASTGRAM_API_URL";

/**
 * Base por defecto de `apps/api` **fuera de producción**.
 *
 * `API_PORT=3001` es lo que declara `.env.example` para `apps/api`, y `/api/v1`
 * es el prefijo de versión que monta `apps/api/src/server/app.ts`.
 */
export const DEFAULT_UPSTREAM_BASE = "http://localhost:3001/api/v1";

/**
 * Techo de espera contra `apps/api`.
 *
 * El PRD no fija un timeout de cliente. Se elige un número **corto** porque
 * lo que cruza por acá son lecturas y escrituras chicas de JSON: un
 * `GET /content` que tarda 10 s ya es un incidente, y dejar la petición
 * colgada sólo convierte un error rápido en una pantalla en blanco larga. Los
 * bytes de video no pasan por el proxy (van directo al storage). Ojo con las
 * escrituras: un timeout **no** dice si la API la aplicó, y el proxy no
 * reintenta (NFR-005) — el cliente reintenta, si quiere, con la misma
 * `Idempotency-Key`. Los trabajos largos (builds) no se esperan,
 * se consultan por polling (ADR-014).
 */
export const UPSTREAM_TIMEOUT_MS = 10_000;

export interface UpstreamConfig {
  /** Sin barra final. */
  readonly base: string;
}

export type UpstreamConfigResult =
  | { readonly ok: true; readonly config: UpstreamConfig }
  | { readonly ok: false; readonly missing: typeof API_URL_ENV };

/**
 * Lee la configuración del entorno.
 *
 * **En producción `FASTGRAM_API_URL` es obligatoria.** Antes la obligatoria
 * era la key, y su ausencia daba un `503` claro; sin key, lo único que queda
 * por configurar es la URL, y caer en silencio a `localhost:3001` en
 * producción sería un "la API no respondió" que no dice qué falta.
 *
 * Recibe el entorno en vez de tocar `process.env` para poder probarlo sin
 * ensuciar el del proceso.
 */
export function readUpstreamConfig(
  env: Readonly<Record<string, string | undefined>>,
): UpstreamConfigResult {
  const raw = env[API_URL_ENV]?.trim() ?? "";
  if (raw === "") {
    if (env["NODE_ENV"] === "production") return { ok: false, missing: API_URL_ENV };
    return { ok: true, config: { base: DEFAULT_UPSTREAM_BASE } };
  }
  return { ok: true, config: { base: raw.replace(/\/+$/, "") } };
}

/**
 * Compone la URL de `apps/api` a partir de los segmentos que capturó el route
 * handler.
 *
 * Devuelve `null` —y el handler responde `400`— ante cualquier segmento que no
 * sea un segmento: vacío, con `/`, o `..`. **Esto no es paranoia de más**: el
 * catch-all de Next entrega los segmentos ya decodificados, así que un
 * `%2E%2E` llega como `..`, y `new URL("../../admin", base)` sale del prefijo
 * `/api/v1` sin que nada más lo note. El reenvío lleva la sesión del usuario:
 * escaparse del prefijo es escaparse con su credencial puesta.
 */
export function resolveUpstreamUrl(
  base: string,
  segments: readonly string[],
  search: string,
): string | null {
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
    if (segment.includes("/") || segment.includes("\\")) return null;
  }
  const prefix = base.endsWith("/") ? base : `${base}/`;
  // `encodeURIComponent` por segmento: un id con `?` o `#` no puede inventar
  // query ni fragmento. Los ids del contrato son uuid, pero el que llega es el
  // que escribió el usuario en la barra de direcciones.
  const path = segments.map((segment) => encodeURIComponent(segment)).join("/");
  return `${prefix}${path}${search}`;
}
