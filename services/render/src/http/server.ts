/**
 * Superficie HTTP del servicio. Sin estado: no hay sesión, no hay base, cada
 * request trae todo lo que necesita.
 *
 * El manejador de errores es el único lugar donde un error se convierte en
 * respuesta, y sólo emite `code` / `message` / `details`. `cause` —que puede
 * traer stderr crudo de ffmpeg o rutas locales— se loguea y se descarta.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { isRenderError, RenderError } from "../errors.js";
import { probeCapabilities, TEXT_STRATEGY } from "../ffmpeg/capabilities.js";
import { FONT_FAMILIES, FONT_REGISTRY, requiredFontFiles } from "../domain/fonts.js";
import { renderBuild, type RenderEngineConfig } from "../render/engine.js";

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
      })),
    });
  });

  return app;
}
