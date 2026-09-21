/**
 * Idempotencia · PRD:2288 (§9.3) y NFR-004 (PRD:2954).
 *
 * Obligatoria en `POST /content`, `POST /influencers`, `PATCH /content/:id` y
 * `POST /content/:id/regenerate`. Misma key + mismo body = replay de la
 * respuesta original; misma key + body distinto = `409 conflict`; una petición
 * que falla libera la key (DATA-027, PRD:2167: estado `released`).
 *
 * El PRD **no** fija longitud ni alfabeto de la key, así que el contrato sólo
 * exige que no esté vacía. Ver el reporte: queda anotado como abierto.
 */
import { z } from "zod";

/** Nombre del header, en minúsculas (Node normaliza así los headers entrantes). */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/** Header obligatorio en los endpoints facturables. */
export const idempotencyHeaderSchema = z.object({
  [IDEMPOTENCY_KEY_HEADER]: z.string().min(1),
});
export type IdempotencyHeader = z.infer<typeof idempotencyHeaderSchema>;

/** Header opcional, para endpoints que la aceptan sin exigirla. */
export const optionalIdempotencyHeaderSchema = z.object({
  [IDEMPOTENCY_KEY_HEADER]: z.string().min(1).optional(),
});
export type OptionalIdempotencyHeader = z.infer<typeof optionalIdempotencyHeaderSchema>;

/**
 * Estados de la reserva de idempotencia · DATA-027 (PRD:2167).
 * Vive en el contrato porque `409 conflict` y el replay dependen de él, aunque
 * el registro en sí nunca se devuelve por la API.
 */
export const idempotencyStateSchema = z.enum(["in_flight", "completed", "released"]);
export type IdempotencyState = z.infer<typeof idempotencyStateSchema>;
