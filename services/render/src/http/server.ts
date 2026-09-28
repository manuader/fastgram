/**
 * Superficie HTTP del servicio. Sin estado: no hay sesión, no hay base, cada
 * request trae todo lo que necesita.
 *
 * El manejador de errores es el único lugar donde un error se convierte en
 * respuesta, y sólo emite `code` / `message` / `details`. `cause` —que puede
 * traer stderr crudo de ffmpeg o rutas locales— se loguea y se descarta.
 */
import { createReadStream } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { isRenderError, RenderError } from "../errors.js";
import { probeCapabilities, TEXT_STRATEGY } from "../ffmpeg/capabilities.js";
import { FONT_FAMILIES, FONT_REGISTRY, requiredFontFiles } from "../domain/fonts.js";
import {
  renderBuild,
  type ArtifactExtension,
  type RenderEngineConfig,
} from "../render/engine.js";
import { engineVersionFrom } from "../render/engineVersion.js";
import type { FontActivation } from "../render/fontActivation.js";
import type { FontStatus } from "../render/fontLoader.js";
import { brandBackgroundOperation } from "../render/brandBackground.js";
import { rasterizeOperation } from "../render/designSystemAssets.js";
import {
  normalizeOperation,
  probeOperation,
  thumbnailOperation,
} from "../render/mediaOps.js";
import {
  ARTIFACT_PATH_PREFIX,
  artifactHref,
  artifactNotFound,
  parseArtifactName,
} from "./artifacts.js";
import { reelConfigFromEnv, type ReelConfig } from "../reels/config.js";
import { registerReelRoutes } from "../reels/routes.js";

export interface ServerDeps {
  readonly engine: RenderEngineConfig;
  readonly logger: boolean;
  /**
   * Lo que se activó y verificó al arrancar (`main.ts`). Opcional para los
   * tests que montan el server sin pasar por el arranque.
   */
  readonly fontReport?: {
    readonly activation: FontActivation;
    readonly status: readonly FontStatus[];
  };
  /** Sprint 9: motor de reels (HyperFrames). Sin él, se lee del entorno. */
  readonly reel?: ReelConfig;
}

/**
 * Cambia la clave de cache por el `href` opaco y se queda con el resto.
 *
 * `cacheKey` y `extension` NO salen: son el esquema de claves, que
 * `http/artifacts.ts` deja escrito que puede cambiar sin avisarle al cliente.
 * Publicarlos convertiría un detalle interno en contrato de hecho.
 */
function withHref<T extends { cacheKey: string; extension: ArtifactExtension }>(
  result: T,
): Omit<T, "cacheKey" | "extension"> & { href: string } {
  const { cacheKey, extension, ...rest } = result;
  return { ...rest, href: artifactHref(cacheKey, extension) };
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger });

  app.setErrorHandler((error, _request, reply) => {
    if (isRenderError(error)) {
      if (error.status >= 500)
        app.log.error({ err: error, cause: error.cause }, error.code);
      else app.log.warn({ code: error.code, details: error.details }, error.message);
      void reply.status(error.status).send({ error: error.toWire() });
      return;
    }
    app.log.error({ err: error }, "error no clasificado en el motor de render");
    const fallback = new RenderError("render_failed", "el render falló");
    void reply.status(fallback.status).send({ error: fallback.toWire() });
  });

  app.get("/health", async () => ({ status: "ok", service: "render" }));

  /**
   * Diagnóstico. Responde la pregunta que cuesta una tarde averiguar a mano:
   * qué trae el ffmpeg de esta máquina y qué fuentes faltan.
   */
  app.get("/capabilities", async () => {
    const caps = await probeCapabilities();
    const engine = engineVersionFrom(caps);
    return {
      /**
       * `P2-RENDER-016` — **Ésta es la etiqueta de motor para claves de cache.**
       *
       * `ffmpeg.version` no servía para eso por dos razones medidas: es la línea
       * entera del banner (con espacios y un copyright adentro de la clave), y
       * no cubre lo que de verdad decide el frame —un cambio nuestro en el
       * filtergraph o en el overlay no la movía—.
       *
       * `engine.version` es un sha256 hex de `engine.components`. Los
       * componentes viajan al lado para que se pueda contestar «¿por qué cambió?»
       * sin adivinar; lo que se concatena a una clave es `version`.
       */
      engine,
      ffmpeg: {
        available: caps.available,
        /** La línea del banner, tal cual. Diagnóstico humano, NO clave de cache. */
        version: caps.version,
        /** El token solo (`9.0.1`). El mismo que entra en `engine.components`. */
        versionTag: engine.components.ffmpeg,
        hasDrawtext: caps.hasDrawtext,
        hasChromakey: caps.hasChromakey,
        hasColorkey: caps.hasColorkey,
        hasZscale: caps.hasZscale,
        hasTonemap: caps.hasTonemap,
      },
      /** Siempre `sharp-overlay`: nunca se usa `drawtext`. Ver capabilities.ts. */
      textStrategy: TEXT_STRATEGY,
      fonts: {
        families: FONT_FAMILIES.map((family) => ({
          key: family,
          weights: FONT_REGISTRY[family].weights,
          licence: FONT_REGISTRY[family].licence,
        })),
        requiredFiles: requiredFontFiles(),
        fontDir: deps.engine.fonts.fontDir,
        strict: deps.engine.fonts.strict,
        /**
         * Qué resuelve DE VERDAD el motor de texto, medido con la sonda al
         * arrancar — no «qué archivo existe». Ver `render/fontActivation.ts`.
         */
        ...(deps.fontReport === undefined
          ? {}
          : {
              activation: {
                backend: deps.fontReport.activation.backend,
                applied: deps.fontReport.activation.applied,
                fontFiles: deps.fontReport.activation.fontFiles,
                registered: deps.fontReport.activation.registered,
                reason: deps.fontReport.activation.reason,
              },
              verified: deps.fontReport.status
                .filter((s) => s.verified)
                .map((s) => `${s.family}-${String(s.weight)}`),
              unverified: deps.fontReport.status
                .filter((s) => !s.verified)
                .map((s) => `${s.family}-${String(s.weight)}`),
            }),
      },
    };
  });

  /**
   * Los campos existentes NO cambian de forma ni de nombre: sólo se agrega
   * `href` por artefacto (`P2-RENDER-015`). `path` sigue sin salir: es una ruta
   * local del contenedor y no le sirve a nadie de afuera.
   */
  app.post("/render", async (request, reply) => {
    const result = await renderBuild(request.body, deps.engine);
    return reply.status(200).send({
      type: result.type,
      keys: result.keys,
      cache: result.cache,
      warnings: result.warnings,
      artifacts: result.artifacts.map((artifact) => ({
        kind: artifact.kind,
        index: artifact.index,
        bytes: artifact.bytes,
        href: artifactHref(artifact.cacheKey, artifact.extension),
      })),
    });
  });

  /**
   * `POST /probe` — `ERR-P11`, metadatos antes de aceptar un upload.
   *
   * ── Por qué POST y no `GET /probe?url=…` ─────────────────────────────────
   * La URL del medio es firmada y de vida corta (`NFR-008`): lleva el token en
   * la query. Una query string va al access log del balanceador, al de Fastify,
   * al del proxy y al historial de cualquier cliente. El cuerpo no. Es el mismo
   * criterio con el que `POST /render` ya manda las URLs en el cuerpo, y la
   * forma del puerto no pide otra cosa: `probe(url)` es una llamada, no un
   * recurso direccionable.
   *
   * No devuelve bytes: el puerto devuelve `MediaProbe`, que es puro metadato.
   */
  app.post("/probe", async (request, reply) => {
    const result = await probeOperation(request.body, deps.engine);
    return reply.status(200).send(result);
  });

  /**
   * `POST /normalize` — `NFR-014` / `P2-RENDER-013`: MOV→MP4, HDR→SDR,
   * faststart.
   *
   * El artefacto NO viaja en esta respuesta: viaja su `href`, y los bytes se
   * bajan con el `GET /artifact/…` que ya existe. Devolver el MP4 acá obligaría
   * a elegir entre materializarlo en memoria —50 MB por worker, `NFR-013`— y
   * duplicar la ruta que sirve bytes, que es la única con defensa contra path
   * traversal. El resto de la respuesta es exactamente lo que
   * `RenderedMedia` pide menos `body`.
   */
  app.post("/normalize", async (request, reply) => {
    const result = await normalizeOperation(request.body, deps.engine);
    return reply.status(200).send(withHref(result));
  });

  /**
   * `POST /thumbnail` — IMPL §5: «nunca servir el master para un preview».
   * Mismo trato que `/normalize`: metadatos acá, bytes por el `href`.
   */
  app.post("/thumbnail", async (request, reply) => {
    const result = await thumbnailOperation(request.body, deps.engine);
    return reply.status(200).send(withHref(result));
  });

  /**
   * `POST /brand-backgrounds` — `PU-MEDIA-002`: un fondo de marca (imagen o
   * loop de video) generado acá, sin proveedor. Mismo trato que `/thumbnail`:
   * metadatos en la respuesta, bytes por el `href`. Ver
   * `render/brandBackground.ts`.
   */
  app.post("/brand-backgrounds", async (request, reply) => {
    const result = await brandBackgroundOperation(request.body, deps.engine);
    return reply.status(200).send(withHref(result));
  });

  // Sprint 9 (M): motivos SVG de un design system → PNG teñido.
  app.post("/design-system/rasterize", async (request, reply) => {
    return reply.status(200).send(await rasterizeOperation(request.body));
  });

  /**
   * `GET /artifact/<clave>.<ext>` — los bytes del artefacto.
   *
   * ── RESTRICCIÓN DE DESPLIEGUE, no un detalle ─────────────────────────────────
   * La cache es LOCAL (`cache/store.ts`: "un acelerador local, no una fuente de
   * verdad"). Este endpoint la usa como almacén de lectura, y eso le pone una
   * condición al despliegue que antes no tenía:
   *
   *   con varias réplicas detrás de un balanceador y SIN volumen compartido, el
   *   `POST /render` puede resolverse en la réplica A y el `GET` del `href`
   *   caer en la B, que no tiene el archivo. El 404 es CORRECTO: el servicio no
   *   está mintiendo, el archivo no está ahí.
   *
   * O sea: o `RENDER_CACHE_DIR` apunta a un volumen compartido por todas las
   * réplicas, o el balanceador pega el cliente a la réplica que rindió, o hay
   * una sola réplica. Y como `FileCacheStore` no tiene TTL ni desalojo, el
   * `href` vive lo que viva el volumen: quien necesite el archivo tiene que
   * bajarlo, no guardarse el link.
   *
   * La ruta es comodín (`*`) y no `:name` para que cualquier cosa bajo
   * `/artifact/` caiga en este manejador y salga con el cuerpo de error del
   * servicio, en vez del 404 propio de Fastify con otra forma.
   */
  app.get(`${ARTIFACT_PATH_PREFIX}*`, async (request, reply) => {
    const raw = (request.params as Record<string, string | undefined>)["*"] ?? "";
    const ref = parseArtifactName(raw);
    // Nada de disco hasta que la clave tenga la forma exacta. Ver `artifacts.ts`.
    if (ref === null) throw artifactNotFound();

    const entry = await deps.engine.cache.get(ref.key, ref.extension);
    if (entry === null) throw artifactNotFound();

    // `content-length` sale del `stat` de la cache, no del stream. No hay
    // carrera: la clave es un hash del contenido y la escritura es un `rename`
    // atómico, así que el archivo de una clave dada nunca cambia de tamaño.
    return (
      reply
        .status(200)
        .header("content-type", ref.mediaType)
        .header("content-length", String(entry.bytes))
        // Direccionado por contenido: la respuesta para una clave no cambia nunca.
        .header("cache-control", "private, max-age=31536000, immutable")
        .send(createReadStream(entry.path))
    );
  });

  // Sprint 9 (`PU-S9-009`): `POST /reels/render` y `POST /reels/preview-html`.
  registerReelRoutes(app, {
    cache: deps.engine.cache,
    policy: deps.engine.policy,
    resolveMedia: deps.engine.resolveMedia,
    fontDir: deps.engine.fonts.fontDir,
    reel: deps.reel ?? reelConfigFromEnv(),
    ...(deps.engine.capabilities === undefined
      ? {}
      : { capabilities: deps.engine.capabilities }),
  });

  return app;
}
