/**
 * Logging estructurado — P1-OBS-001.
 *
 * Requisito: `companyId` y `requestId` en **todo** log. No "en los logs de request":
 * en todos, incluido el `console.log` perdido de un handler, porque el valor de esto
 * aparece cuando hay que reconstruir qué le pasó a un workspace concreto a una hora
 * concreta, y ahí la línea que falta es siempre la que importaba.
 *
 * Cómo se consigue: `request.log` es un logger hijo. Apenas se resuelve el scope se lo
 * reemplaza por otro hijo con `companyId` atado. Todo lo que loguee el handler a través
 * de `request.log` lo lleva, sin que el handler tenga que acordarse.
 *
 * `requestId` sale de `genReqId` (ver `server/app.ts`), que respeta el `x-request-id`
 * entrante: así una traza cruza el borde entre `apps/web` y `apps/api` sin cortarse.
 *
 * ## Qué NO se loguea
 *
 * - El header `authorization` completo ni `x-fastgram-session` (`redact` en la
 *   config de pino). Ojo: el serializador de request por defecto de Fastify no
 *   loguea headers; esto es la red para el día que alguien loguee `request`
 *   entero. Las rutas de `/auth/*` además no loguean cuerpos ni emails.
 * - Las URLs firmadas de storage: NFR-008 dice literalmente *"no persistir, no loguear"*.
 *   Son capacidades bearer; una URL de playback en un log es acceso al objeto para
 *   quien lea el log durante la hora siguiente.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";

/** Campos que pino tacha. Ver "Qué NO se loguea". */
export const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  // `P1-AUTH-002`: la sesión del BFF es una credencial bearer igual que la key.
  'req.headers["x-fastgram-session"]',
  "res.headers['set-cookie']",
] as const;

/** Header de correlación. Si viene, se respeta; si no, se genera. */
export const REQUEST_ID_HEADER = "x-request-id";

export function generateRequestId(headerValue: unknown): string {
  if (typeof headerValue === "string" && headerValue.trim() !== "") {
    // Se acota: un `x-request-id` de 8 KB inyectado por un cliente termina en
    // cada línea de log de esa request.
    return headerValue.trim().slice(0, 128);
  }
  return randomUUID();
}

/**
 * Ata `companyId` al logger de la request.
 *
 * Se llama desde el hook de scope, justo después de resolverlo — antes no se puede:
 * el `companyId` sale de la credencial.
 */
export function bindCompanyToLogger(
  request: FastifyRequest,
  companyId: string,
  extra: Readonly<Record<string, unknown>> = {},
): void {
  request.log = request.log.child({ companyId, ...extra });
}

/**
 * Registra el par de hooks de acceso.
 *
 * El log de respuesta lleva `durationMs` porque sin eso la única forma de saber si una
 * ruta se degradó es comparar timestamps entre dos líneas, y eso no se hace nunca.
 */
export function registerAccessLogging(app: FastifyInstance): void {
  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    request.log.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      "request completed",
    );
  });
}
