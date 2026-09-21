/**
 * Piezas compartidas por las rutas v1.
 *
 * Lo que vive acá es lo que, repetido en treinta handlers, se desincroniza: la forma
 * del envelope, el 404 del acceso cruzado, y el baile de la idempotencia.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { DomainError } from "@fastgram/core";
import type { Page } from "@fastgram/db";

import { hashRequestBody, type IdempotencyGuard } from "../../http/idempotency.js";

/** §9.3 — envelope de éxito. */
export const data = <T>(value: T): { data: T } => ({ data: value });

/**
 * §9.3 — envelope paginado.
 *
 * El cursor es el de `@fastgram/db`, que es el que los repositorios saben decodificar.
 * Hubo un segundo módulo acá (`src/http/pagination.ts`) que implementaba el mismo
 * contrato con otro payload interno —`{createdAtMs, id}` en JSON contra `"<ISO>|<id>"`—
 * y se borró en `P1-DATA-015`. No estaba en uso, pero seguía siendo un cursor
 * plausible a un import de distancia, y el día que alguien lo usara en una lista, el
 * cliente que guardara ese cursor no podría pasarlo a otra: los repositorios sólo
 * decodifican el suyo. Dos formatos opacos en el mismo wire no se notan hasta que ya
 * hay clientes con cursores guardados.
 */
export function page<TRow, TOut>(
  p: Page<TRow>,
  map: (row: TRow) => TOut,
): { data: TOut[]; pagination: { cursor: string | null; hasMore: boolean } } {
  return {
    data: p.items.map(map),
    pagination: { cursor: p.cursor, hasMore: p.hasMore },
  };
}

/**
 * El 404 de §9.2.
 *
 * **Nunca 403.** Un recurso de otro workspace y un id que no existe devuelven
 * exactamente esto, con el mismo mensaje y sin ninguna pista que los distinga. El
 * detalle de que fue cruzado va al log por `DomainError.details`, que `translateError`
 * manda a `logContext` y nunca al cuerpo.
 */
export function notFound(resource: string): DomainError {
  return new DomainError("not_found", `${resource} not found`, { resource });
}

/** Igual que `notFound` pero deja constancia en el log de que el id existía. */
export function crossTenant(
  resource: string,
  id: string,
  companyId: string,
): DomainError {
  return new DomainError("not_found", `${resource} not found`, {
    resource,
    id,
    attemptedBy: companyId,
    crossTenant: true,
  });
}

/**
 * Ejecuta un efecto bajo `Idempotency-Key` — §9.3.
 *
 * Las tres reglas las aplica `IdempotencyGuard` (en `src/http/`); acá sólo se conecta
 * a la ruta y se respeta la tercera, que es la que se olvida: **si la operación falla,
 * la key se libera** en el `catch`. Sin eso, un 500 transitorio quema la key y el
 * cliente no puede reintentar nunca más — lo contrario de para qué existe el header.
 */
export async function withIdempotency<T>(
  guard: IdempotencyGuard,
  request: FastifyRequest,
  reply: FastifyReply,
  args: {
    readonly key: string;
    readonly route: string;
    readonly body: unknown;
    readonly successStatus: number;
  },
  run: () => Promise<T>,
): Promise<FastifyReply> {
  const companyId = request.auth.companyId;
  const requestHash = hashRequestBody(args.body);

  const outcome = await guard.begin({
    key: args.key,
    companyId,
    route: args.route,
    requestHash,
  });

  if (outcome.kind === "replay") {
    request.log.info({ route: args.route }, "idempotent replay");
    return reply.status(outcome.status).send(outcome.body);
  }

  if (outcome.kind === "conflict") {
    return reply.status(409).send({
      error: {
        code: "conflict",
        message: "This Idempotency-Key was already used with a different request body",
      },
    });
  }

  if (outcome.kind === "in_flight") {
    // El PRD no especifica este caso (misma key, mismo body, original todavía
    // corriendo). Se responde 409 para que el cliente reintente en vez de crear un
    // duplicado. Anotado como abierto en el reporte.
    return reply.status(409).send({
      error: {
        code: "conflict",
        message: "A request with this Idempotency-Key is still in progress",
      },
    });
  }

  try {
    const result = await run();
    const body = data(result);
    await guard.succeed(args.key, companyId, { status: args.successStatus, body });
    return reply.status(args.successStatus).send(body);
  } catch (e) {
    // Regla 3. Va antes del rethrow y fuera del camino feliz a propósito.
    await guard.fail(args.key, companyId);
    throw e;
  }
}

/** Lee el header de idempotencia ya validado por el schema de la ruta. */
export function idempotencyKeyOf(headers: Record<string, unknown>): string {
  const raw = headers["idempotency-key"];
  return typeof raw === "string" ? raw : "";
}
