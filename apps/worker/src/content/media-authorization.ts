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
 * ## Lo que NO está, y hace fallar un build con audio
 *
 * `sharedPrefixes` va **vacío**. `FR-070` dice que el audio sólo puede venir de
 * la librería compartida, y **en todo el repo no hay una sola pista de dónde
 * vive esa librería**: ni una clave, ni una variable de entorno, ni un
 * endpoint. Inventar un prefijo acá sería peor que dejarlo vacío: autorizaría
 * un origen que nadie eligió.
 *
 * Consecuencia concreta, para que no sorprenda: con el adaptador HTTP montado,
 * un `wall-of-text` o un `video-hook` **con** pista de audio va a ser rechazado
 * por el servicio con `audio_fuera_de_libreria`. Sin audio funcionan (por eso
 * `P2-RENDER-014` hizo el bloque opcional). Está reportado.
 */
import { canonicalObjectUrl } from "@fastgram/adapters";
import type { MediaAuthorization, RenderJob, Storage } from "@fastgram/ports";

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

  return {
    companyId: input.companyId,
    mediaPrefixes,
    // Ver el encabezado: vacío a propósito, no por olvido.
    sharedPrefixes: [],
    ...(input.urls.length === 0 ? {} : { urls: input.urls }),
  };
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
  switch (job.format) {
    case "slideshow":
      return job.images.map((slide) => slide.image.url);
    case "wall-of-text":
      return [job.video.url, ...(job.audio === undefined ? [] : [job.audio.url])];
    case "green-screen":
      return [job.image.url, job.video.url];
    case "video-hook":
      return [
        job.hook_video.url,
        job.demo_video.url,
        ...(job.audio === undefined ? [] : [job.audio.url]),
      ];
  }
}
