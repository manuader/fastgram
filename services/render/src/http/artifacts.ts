/**
 * `P2-RENDER-015` — El esquema de claves del artefacto descargable.
 *
 * Hasta acá `POST /render` devolvía metadatos y los bytes se quedaban en la
 * cache local: el cliente no tenía forma de obtener el archivo y el pipeline no
 * cerraba. Ahora cada artefacto viaja con un `href`, y `GET <href>` devuelve los
 * bytes.
 *
 * ── El `href` es OPACO para el cliente ───────────────────────────────────────
 * Acordado con el adaptador `MediaRenderer` (`packages/adapters`): concatena el
 * `href` al base URL y lo pide tal cual. No parsea nada de él. Por eso el
 * esquema de claves vive entero en este archivo y puede cambiar sin tocar al
 * cliente. **No** se documenta como parte del contrato público.
 *
 * ── Path traversal: el `href` lo genera el servidor, el `GET` lo recibe la red ─
 * Un `..` que llegue hasta `path.join` sirve cualquier archivo de la máquina, y
 * el shard de `FileCacheStore` (`key.slice(0,2)/key.slice(2,4)`) no protege
 * nada: con `key = "../../etc/passwd"` los dos primeros caracteres son `..`.
 * Entonces la defensa NO es sanear, es **aceptar sólo la forma exacta**:
 * sha256 hex + sufijo de índice opcional + extensión de una lista cerrada.
 * Todo lo demás se rechaza sin tocar el disco.
 *
 * Fastify decodifica el parámetro de ruta, así que `%2e%2e%2f` llega como
 * `../`: la validación corre DESPUÉS de la decodificación, sobre lo que de
 * verdad se va a usar.
 */
import { RenderError } from "../errors.js";
import type { ArtifactExtension } from "../render/engine.js";

/** Prefijo del path. El cliente no lo interpreta; ver el encabezado. */
export const ARTIFACT_PATH_PREFIX = "/artifact/";

/**
 * `content-type` de cada extensión. Lista cerrada, y `Record<ArtifactExtension,
 * string>` obliga a completarla si el motor aprende a emitir otro formato.
 */
export const ARTIFACT_MEDIA_TYPES: Record<ArtifactExtension, string> = {
  mp4: "video/mp4",
  jpg: "image/jpeg",
};

/**
 * `<clave>.<ext>`, donde la clave es la de la cache: un sha256 hex de
 * `domain/hash.ts`, con sufijo `-<índice>` para los slides del slideshow
 * (`engine.ts` usa `${buildKey}-${index}`).
 *
 * El índice se acota a dos dígitos porque `FR-070` topea el slideshow en 20
 * slides: un `-999999` no es una clave que este servicio pueda haber emitido.
 *
 * La alternancia de extensiones sale de las claves del mapa y no de un literal
 * aparte: si estuvieran escritas dos veces, agregar un formato dejaría el regex
 * viejo y el `GET` devolvería 404 para un artefacto que sí existe. Las claves
 * son literales nuestros (`mp4`, `jpg`), sin metacaracteres, y el regex se
 * compila una vez al cargar el módulo: nada de esto viene de la red.
 */
const ARTIFACT_NAME = new RegExp(
  `^([0-9a-f]{64}(?:-(?:0|[1-9][0-9]?))?)\\.(${Object.keys(ARTIFACT_MEDIA_TYPES).join("|")})$`,
);

export interface ArtifactRef {
  readonly key: string;
  readonly extension: ArtifactExtension;
  readonly mediaType: string;
}

export function isArtifactExtension(value: string): value is ArtifactExtension {
  return Object.prototype.hasOwnProperty.call(ARTIFACT_MEDIA_TYPES, value);
}

/** El `href` que viaja en la respuesta de `POST /render`. */
export function artifactHref(key: string, extension: ArtifactExtension): string {
  return `${ARTIFACT_PATH_PREFIX}${key}.${extension}`;
}

/**
 * Valida el nombre que llegó por la red. `null` = no es una clave que este
 * servicio pueda haber emitido, y por lo tanto no hay nada que buscar en disco.
 */
export function parseArtifactName(raw: string): ArtifactRef | null {
  const match = ARTIFACT_NAME.exec(raw);
  if (match === null) return null;
  const key = match[1];
  const extension = match[2];
  // `noUncheckedIndexedAccess`: los grupos existen si hubo match, pero el tipo
  // no lo sabe.
  if (key === undefined || extension === undefined) return null;
  if (!isArtifactExtension(extension)) return null;
  return { key, extension, mediaType: ARTIFACT_MEDIA_TYPES[extension] };
}

/**
 * El mismo cuerpo de error que el resto del servicio. `artifact_not_found` no
 * distingue "clave mal formada" de "clave que no está en cache": decirlo sería
 * confirmarle a quien sondea que la forma de la clave era correcta.
 */
export function artifactNotFound(): RenderError {
  return new RenderError("artifact_not_found", "el artefacto no está disponible");
}
