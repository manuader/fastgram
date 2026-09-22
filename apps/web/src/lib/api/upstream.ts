/**
 * El lado servidor del cliente de API: dónde está `apps/api` y con qué
 * credencial se le habla.
 *
 * ## Por qué existe este módulo — el problema de la credencial
 *
 * La API v1 hoy acepta **una sola** forma de autenticación: `Authorization:
 * Bearer fsln_live_<32>` (FR-180, PRD:1851-1872). Es una **API key de máquina,
 * workspace-scoped**. No hay login de usuario: el único adaptador de identidad
 * del repo es el de memoria, y `apps/api` levanta `deps.sessions` como opcional.
 *
 * Una API key no puede vivir en el navegador. Ni en el bundle, ni en una
 * cookie legible, ni en `NEXT_PUBLIC_*` — cualquiera de las tres la publica, y
 * una key filtrada es el workspace entero, porque no hay scopes por ruta.
 *
 * La salida honesta con lo que hay: **el navegador no habla con `apps/api`**.
 * Habla con un route handler de esta misma app (`/api/fastgram/v1/*`) que corre
 * en el servidor de Next, pone la credencial y reenvía la respuesta tal cual.
 * La key se queda en el proceso de Next y no cruza nunca al cliente.
 *
 * ## Por qué esto es PROVISORIO, y qué lo reemplaza
 *
 * Tres cosas que no están bien y no se pueden arreglar desde `apps/web`:
 *
 * 1. **Una key por despliegue es un workspace para todo el mundo.** Quien
 *    llegue a la app ve el contenido de *ese* workspace. Mientras la sesión sea
 *    la costura de desarrollo de `lib/auth/session.ts` da igual; el día que
 *    haya usuarios de verdad, no. Lo que corresponde es que la API acepte la
 *    sesión del usuario y que el handler reenvíe **esa** identidad — es trabajo
 *    de P1-AUTH, no de una pantalla.
 * 2. **Sólo se reenvía `GET`.** Un proxy same-origin sin token de CSRF que
 *    aceptara `POST`/`PATCH`/`DELETE` dejaría que cualquier página de internet
 *    disparara escrituras con la credencial del servidor. Hasta que haya sesión
 *    de verdad (y con ella un anti-CSRF), esta ventana es de lectura. La regla
 *    está en el handler, no acá, pero se decide acá.
 * 3. **La key no está en `.env.example`.** Esa tarea no puede tocar la raíz del
 *    repo. Queda reportada; mientras tanto el handler responde `503` con un
 *    código estable y un log que dice qué falta, en vez de fallar de una forma
 *    que se confunda con "no hay contenido".
 *
 * **Nunca un secreto acá.** Este módulo lee nombres de variables; los valores
 * viven en el entorno del proceso.
 */

/** Variable de entorno con la API key. **Sin `NEXT_PUBLIC_`**, y a propósito. */
export const API_KEY_ENV = "FASTGRAM_API_KEY";

/** Variable de entorno con la base de `apps/api`, si no es la de desarrollo. */
export const API_URL_ENV = "FASTGRAM_API_URL";

/**
 * Base por defecto de `apps/api`.
 *
 * `API_PORT=3001` es lo que declara `.env.example` para `apps/api`, y `/api/v1`
 * es el prefijo de versión que monta `apps/api/src/server/app.ts`.
 */
export const DEFAULT_UPSTREAM_BASE = "http://localhost:3001/api/v1";

/**
 * Techo de espera contra `apps/api`.
 *
 * El PRD no fija un timeout de cliente. Se elige un número **corto** porque
 * todo lo que cruza por acá son lecturas: un `GET /content` que tarda 10 s ya
 * es un incidente, y dejar la petición colgada sólo convierte un error rápido
 * en una pantalla en blanco larga. Los trabajos largos (builds) no se esperan,
 * se consultan por polling (ADR-014).
 */
export const UPSTREAM_TIMEOUT_MS = 10_000;

export interface UpstreamConfig {
  readonly base: string;
  readonly apiKey: string;
}

export type UpstreamConfigResult =
  | { readonly ok: true; readonly config: UpstreamConfig }
  | { readonly ok: false; readonly missing: typeof API_KEY_ENV };

/**
 * Lee la configuración del entorno.
 *
 * Recibe el entorno en vez de tocar `process.env` directamente para poder
 * probarlo sin ensuciar el del proceso — y porque un módulo que lee globals
 * escondidos es justo lo que después no se puede testear.
 */
export function readUpstreamConfig(
  env: Readonly<Record<string, string | undefined>>,
): UpstreamConfigResult {
  const apiKey = env[API_KEY_ENV];
  if (apiKey === undefined || apiKey.trim() === "") {
    return { ok: false, missing: API_KEY_ENV };
  }
  const base = env[API_URL_ENV];
  return {
    ok: true,
    config: {
      base: base === undefined || base.trim() === "" ? DEFAULT_UPSTREAM_BASE : base,
      apiKey,
    },
  };
}

/**
 * Compone la URL de `apps/api` a partir de los segmentos que capturó el route
 * handler.
 *
 * Devuelve `null` —y el handler responde `400`— ante cualquier segmento que no
 * sea un segmento: vacío, con `/`, o `..`. **Esto no es paranoia de más**: el
 * catch-all de Next entrega los segmentos ya decodificados, así que un
 * `%2E%2E` llega como `..`, y `new URL("../../admin", base)` sale del prefijo
 * `/api/v1` sin que nada más lo note. El reenvío lleva credencial: escaparse
 * del prefijo es escaparse con la key puesta.
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
