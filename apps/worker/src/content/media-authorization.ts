/**
 * De qué workspace es la media que este build va a leer — `NFR-006`,
 * `P2-RENDER-009`, `P2-RENDER-015`.
 *
 * `services/render` no tiene base: no puede saber si `https://…/media/abc.mp4`
 * es del workspace 42. Se lo tiene que decir quien sí sabe, y eso es esto.
 *
 * ## Por qué los prefijos se derivan y no se escriben
 *
 * La dirección de un objeto la produce `canonicalObjectUrl`, que firma una URL
 * y le saca la query. Si acá armáramos la base del bucket a mano —leyendo
 * `S3_PUBLIC_URL`, por ejemplo— habría **dos definiciones de qué es la
 * dirección de un objeto**, y se desincronizarían sin que nadie lo note: las
 * dos seguirían devolviendo una URL plausible, y el síntoma sería un
 * `fuera_del_grant` en producción con las dos URLs pareciendo correctas.
 *
 * Así que los prefijos salen de la **misma función** que las URLs, aplicada a
 * la clave del prefijo en vez de a la del objeto. `assertKey` sólo rechaza la
 * clave vacía, y SigV4 firma una clave que no existe sin problema: lo que se
 * obtiene es exactamente el prefijo bajo el que van a caer esos objetos.
 *
 * ## El reparto de claves, que sí está duplicado
 *
 * Los cuatro prefijos de abajo son la única parte que repite conocimiento que
 * hoy vive en `apps/api`. Cada uno lleva su procedencia. Lo correcto sería que
 * el reparto viviera en un solo lugar que las dos apps importen; está
 * reportado y no se hace acá porque `apps/api` es de otro agente ahora mismo.
 *
 * ## La librería de audio es la de la marca (sprint 7)
 *
 * `FR-070` dice que el audio sólo puede venir de "la librería", y el render lo
 * hace cumplir: para el rol `audio` sólo mira `sharedPrefixes`. Hasta el
 * sprint 7 esa lista iba vacía —no existía ninguna librería— y todo build con
 * música se rechazaba con `audio_fuera_de_libreria`.
 *
 * Ahora la librería existe y es **por marca**: `brand_audio_tracks`, con los
 * objetos bajo `audio/{companyId}/` (`brandAudioKeyPrefix` de
 * `@fastgram/contracts`, el mismo que usan la subida y el import por link).
 * Ese prefijo —y sólo ése— va en `sharedPrefixes`. No abre nada nuevo: es un
 * prefijo del propio workspace, y además la URL exacta tiene que estar en
 * `urls` (ver {@link mediaUrlsOf}). El audio viejo de `media/{id}/imports/`
 * (antes de la tabla) no entra: no tiene fila y no se puede elegir.
 */
import { canonicalObjectUrl } from "@fastgram/adapters";
import { brandAudioKeyPrefix } from "@fastgram/contracts";
import type { MediaAuthorization, RenderJob, Storage } from "@fastgram/ports";

import { usesGlobalLibrary, withGlobalLibrary } from "../library/authorization.js";

/**
 * El reparto de claves por workspace.
 *
 * Cada entrada cita de dónde sale. Si alguien cambia una de esas rutas sin
 * tocar esto, el build empieza a fallar con `fuera_del_grant` — ruidoso, que
 * es lo que se quiere; lo callado sería autorizar de más.
 */
function workspaceKeyPrefixes(companyId: string, objectPrefix: string): string[] {
  return [
    // `apps/api/src/routes/v1/media.ts` — subidas al Media Bank.
    `media/${companyId}/`,
    // `apps/api/src/routes/v1/influencers.ts` — imágenes base del personaje.
    `influencers/${companyId}/`,
    // `apps/api/src/routes/v1/content.ts` — video propio del Studio.
    `content/custom-video/${companyId}/`,
    // Sprint 9 (S): los archivos de fuente del design system
    // (`designSystemFontKey` de `core`, que sube el import de M). El render
    // los autoriza como una imagen (`brandFonts`); la URL exacta además va en
    // `urls` (ver {@link mediaUrlsOf}), así que esto no abre las fuentes de la
    // marca para cualquier build.
    `fonts/${companyId}/`,
    // Los artefactos que este mismo handler sube. Hacen falta porque el
    // thumbnail se pide **sobre la pieza ya subida**: sin este prefijo, el
    // `POST /thumbnail` se rechazaría por no estar autorizada su propia
    // salida.
    `${objectPrefix}/${companyId}/`,
  ];
}

export interface AuthorizationInput {
  readonly companyId: string;
  /** El `objectPrefix` del handler; por defecto `content`. */
  readonly objectPrefix: string;
  /**
   * Las URLs exactas que este job va a leer.
   *
   * Es el cierre más estrecho que el grant admite: además de caer bajo un
   * prefijo del workspace, la URL tiene que estar textualmente acá. Los
   * prefijos solos autorizan *todo* el Media Bank del workspace para cada
   * build; con esto, un build autoriza su propia media y nada más.
   */
  readonly urls: readonly string[];
}

export async function workspaceMediaAuthorization(
  storage: Storage,
  input: AuthorizationInput,
): Promise<MediaAuthorization> {
  const mediaPrefixes = await Promise.all(
    workspaceKeyPrefixes(input.companyId, input.objectPrefix).map((key) =>
      canonicalObjectUrl(storage, key),
    ),
  );
  // Ver el encabezado: la biblioteca de audio de **esta** marca, con la barra
  // final para que `audio/ws-1/` no matchee `audio/ws-10/`.
  const audioLibrary = await canonicalObjectUrl(
    storage,
    `${brandAudioKeyPrefix(input.companyId)}/`,
  );

  const auth: MediaAuthorization = {
    companyId: input.companyId,
    mediaPrefixes,
    sharedPrefixes: [audioLibrary],
    ...(input.urls.length === 0 ? {} : { urls: input.urls }),
  };
  // Sprint 9 (S, con N): una pieza que usa un asset de la biblioteca global
  // (`library/…`, sin copiar a la marca) necesita ese prefijo en
  // `sharedPrefixes`. Sólo si alguna URL del job cae ahí: un build sin
  // biblioteca firma exactamente el grant de antes.
  return (await usesGlobalLibrary(storage, input.urls))
    ? withGlobalLibrary(storage, auth)
    : auth;
}

/**
 * Todas las URLs de media que un job va a leer.
 *
 * El `switch` es exhaustivo por construcción —`RenderJob` es una unión
 * discriminada y el tipo de retorno obliga a cubrir los cuatro formatos—, así
 * que un formato nuevo **no compila** hasta que alguien decida qué media lee.
 * Es a propósito: si cayera a un default vacío, el formato nuevo produciría un
 * grant sin sus URLs y el build fallaría con `url_no_listada_en_grant`, que no
 * dice en ningún lado que falta un caso acá.
 */
export function mediaUrlsOf(job: RenderJob): readonly string[] {
  return [...formatMediaUrlsOf(job), ...brandUrlsOf(job)];
}

/**
 * Sprint 9 (S): las fuentes de marca y las variantes del logo también se leen
 * en el render, y el grant las tiene que listar como cualquier imagen.
 */
function brandUrlsOf(job: RenderJob): readonly string[] {
  const brand = job.brand;
  if (brand === undefined) return [];
  return [
    ...(brand.fonts ?? []).map((f) => f.url),
    ...(brand.logo?.images ?? []).map((i) => i.url),
  ];
}

function formatMediaUrlsOf(job: RenderJob): readonly string[] {
  switch (job.format) {
    case "slideshow":
      return job.images.map((slide) => slide.image.url);
    case "wall-of-text":
      return [job.video.url, ...(job.audio === undefined ? [] : [job.audio.url])];
    case "green-screen":
      return [
        job.image.url,
        job.video.url,
        ...(job.audio === undefined ? [] : [job.audio.url]),
      ];
    case "video-hook":
      return [
        job.hook_video.url,
        job.demo_video.url,
        ...(job.audio === undefined ? [] : [job.audio.url]),
      ];
  }
}
