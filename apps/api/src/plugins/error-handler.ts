/**
 * Manejador de errores — PRD §9.3, NFR-022.
 *
 * Punto único de salida de errores. Toda la traducción real vive en
 * `src/http/errors.ts` (`translateError`); acá sólo se la conecta a Fastify y se
 * resuelven las dos cosas que Fastify aporta por su cuenta:
 *
 * 1. **Los errores de validación de Zod.** `fastify-type-provider-zod` los lanza con
 *    `statusCode` ya puesto, pero su cuerpo no tiene la forma del envelope del PRD.
 *    Sin este paso, un body inválido devuelve un JSON con forma distinta a todos los
 *    demás errores de la API — que es exactamente lo que un integrador no puede parsear.
 *
 * 2. **El 404 de ruta inexistente.** El default de Fastify también tiene otra forma.
 *
 * La regla que este archivo hace cumplir: **ningún error crudo sale**. El `logContext`
 * que arma `translateError` (que sí incluye el proveedor y la causa) va al log y nunca
 * al cuerpo. Si "Storage/r2" saliera hacia afuera, cambiar de proveedor sería un
 * breaking change para todo integrador.
 */
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

import { translateError, type ErrorEnvelope } from "../http/errors.js";

/** El envelope del PRD, servido con el content type que fija §9.3. */
function send(
  reply: FastifyReply,
  status: number,
  body: ErrorEnvelope,
  headers: Record<string, string> = {},
): FastifyReply {
  return reply
    .status(status)
    .headers({ "content-type": "application/json; charset=utf-8", ...headers })
    .send(body);
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      // ── 1. Validación de entrada ──
      // Los detalles de Zod SÍ salen: son sobre el cuerpo que mandó el cliente, no
      // sobre nuestro interior, y sin ellos un 400 no es accionable.
      if (hasZodFastifySchemaValidationErrors(error)) {
        request.log.info({ issues: error.validation }, "request validation failed");
        return send(reply, 400, {
          error: {
            code: "bad_request",
            message: "Request validation failed",
            details: {
              issues: error.validation.map((v) => ({
                path: v.instancePath,
                message: v.message ?? "invalid",
              })),
            },
          },
        });
      }

      // ── 2. Cuerpo que ni siquiera es JSON ──
      if (error.statusCode === 400 && error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
        return send(reply, 415, {
          error: {
            code: "bad_request",
            message: "Content-Type must be application/json",
          },
        });
      }

      // ── 3. Todo lo demás: dominio, puertos, y bugs nuestros ──
      const translated = translateError(error);

      // 5xx es un fallo nuestro y va como `error`; 4xx es del cliente y va como `info`.
      // Mezclarlos hace que la alarma de "tasa de errores" se dispare cuando alguien
      // manda un id mal escrito, y entonces se apaga la alarma.
      const level = translated.status >= 500 ? "error" : "info";
      request.log[level](
        { ...translated.logContext, statusCode: translated.status },
        "request failed",
      );

      return send(reply, translated.status, translated.body, translated.headers);
    },
  );

  app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
    // Misma forma y mismo código que un recurso ajeno (§9.2). Que una ruta
    // inexistente y un id de otro workspace se vean igual no es casualidad: es lo
    // que impide usar la API como oráculo de existencia.
    return send(reply, 404, {
      error: { code: "not_found", message: "Not found" },
    });
  });
}
