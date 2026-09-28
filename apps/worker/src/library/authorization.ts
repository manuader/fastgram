/**
 * Abrir la biblioteca global en el grant del render — sprint 9 (agente N).
 *
 * **Todavía no está cableado en el build**: lo hace la segunda tanda (el
 * decisor/editor que pone un asset global en una pieza). Esto deja la pieza
 * lista y documentada.
 *
 * ## Cómo se usa
 *
 * ```ts
 * const base = await workspaceMediaAuthorization(storage, { companyId, objectPrefix, urls });
 * const auth = usesGlobalLibrary(urls) ? await withGlobalLibrary(storage, base) : base;
 * ```
 *
 * ## Por qué `sharedPrefixes` y no `mediaPrefixes`
 *
 * `services/render` (`media/urlPolicy.ts`, `assertMediaReferenceAllowed`)
 * acepta para video e imagen **cualquiera** de los dos, pero para el rol
 * `audio` sólo mira `sharedPrefixes` (`FR-070`: el audio viene de «la
 * librería»). Un asset de audio de la biblioteca global tiene que entrar por
 * ahí, y los clips van por el mismo lado para que haya una sola regla. El
 * cierre sigue siendo `urls`: además del prefijo, la URL exacta tiene que
 * estar listada, así que abrir `library/` no autoriza la biblioteca entera
 * para cada build.
 *
 * El prefijo se deriva con `canonicalObjectUrl` —la misma función que da la
 * URL de cada objeto— por la razón que explica `media-authorization.ts`.
 *
 * Ojo al configurar el render: si tiene `RENDER_ALLOWED_MEDIA_PREFIXES` o
 * `RENDER_SHARED_LIBRARY_PREFIXES` puestos (config además del grant), la
 * base de `library/` tiene que estar en `RENDER_SHARED_LIBRARY_PREFIXES`.
 */
import { canonicalObjectUrl } from "@fastgram/adapters";
import { LIBRARY_KEY_PREFIX } from "@fastgram/contracts";
import type { MediaAuthorization, Storage } from "@fastgram/ports";

/** La URL base de la biblioteca, con la barra final (`…/library/`). */
export async function globalLibraryPrefix(storage: Storage): Promise<string> {
  return canonicalObjectUrl(storage, `${LIBRARY_KEY_PREFIX}/`);
}

/** El mismo grant, con la biblioteca global en `sharedPrefixes` (sin duplicar). */
export async function withGlobalLibrary(
  storage: Storage,
  auth: MediaAuthorization,
): Promise<MediaAuthorization> {
  const prefix = await globalLibraryPrefix(storage);
  if (auth.sharedPrefixes.includes(prefix)) return auth;
  return { ...auth, sharedPrefixes: [...auth.sharedPrefixes, prefix] };
}

/** ¿Alguna de estas URLs es de la biblioteca global? */
export async function usesGlobalLibrary(
  storage: Storage,
  urls: readonly string[],
): Promise<boolean> {
  const prefix = await globalLibraryPrefix(storage);
  return urls.some((u) => u.startsWith(prefix));
}
