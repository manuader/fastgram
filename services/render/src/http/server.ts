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
import { renderBuild, type RenderEngineConfig } from "../render/engine.js";
import {
  ARTIFACT_PATH_PREFIX,
  artifactHref,
  artifactNotFound,
  parseArtifactName,
} from "./artifacts.js";

export interface ServerDeps {
  readonly engine: RenderEngineConfig;
  readonly logger: boolean;
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
    return {
      ffmpeg: {
        available: caps.available,
        version: caps.version,
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

  return app;
}
