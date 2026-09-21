/**
 * Idempotencia — PRD §9.3.
 *
 * Tres reglas literales del PRD, y las tres tienen un caso borde que se rompe
 * solo si no se escribe a propósito:
 *
 *   1. misma key + mismo body  → replay de la respuesta original
 *   2. misma key + body distinto → 409 conflict
 *   3. una petición que FALLA **libera** la key
 *
 * La tercera es la que se olvida. Sin ella, un 500 transitorio deja la key
 * quemada y el cliente no puede reintentar la operación nunca más — que es
 * exactamente lo contrario de para qué existe `Idempotency-Key`.
 *
 * Obligatoria en: POST /content, POST /influencers, PATCH /content/:id,
 * POST /content/:id/regenerate.
 */
import type { Clock } from "@fastgram/ports";

export const IDEMPOTENT_ROUTES = [
  "POST /content",
  "POST /influencers",
  "PATCH /content/:id",
  "POST /content/:id/regenerate",
] as const;

export interface IdempotencyRecord {
  key: string;
  companyId: string;
  route: string;
  /** Hash del body de la petición original. No el body: podría ser enorme. */
  requestHash: string;
  status: "in_flight" | "completed";
  /** La respuesta a reproducir. Sólo existe si `status === "completed"`. */
  response?: { status: number; body: unknown };
  createdAtMs: number;
}

export interface IdempotencyStore {
  /**
   * Inserta si no existe y devuelve null; si ya existe, devuelve el registro.
   * Tiene que ser ATÓMICO (un `INSERT ... ON CONFLICT DO NOTHING RETURNING`).
   * Con read-then-write, dos reintentos simultáneos del mismo cliente crean
   * dos veces el mismo contenido y cobran dos veces.
   */
  claim(record: IdempotencyRecord): Promise<IdempotencyRecord | null>;
  complete(
    key: string,
    companyId: string,
    response: { status: number; body: unknown },
  ): Promise<void>;
  /** Regla 3: liberar para que el cliente pueda reintentar. */
  release(key: string, companyId: string): Promise<void>;
}

export type IdempotencyOutcome =
  /** Primera vez: seguí adelante y después llamá a `complete` o `release`. */
  | { kind: "proceed" }
  /** Regla 1. */
  | { kind: "replay"; status: number; body: unknown }
  /** Regla 2. */
  | { kind: "conflict" }
  /**
   * Misma key, mismo body, pero la original sigue corriendo. No es un replay
   * (todavía no hay respuesta) ni un conflicto (el body coincide). El PRD no
   * especifica este caso; devolvemos 409 con un código propio para que el
   * cliente reintente en vez de crear un duplicado. Anotado como abierto.
   */
  | { kind: "in_flight" };

export class IdempotencyGuard {
  constructor(
    private readonly store: IdempotencyStore,
    private readonly clock: Clock,
  ) {}

  async begin(args: {
    key: string;
    companyId: string;
    route: string;
    requestHash: string;
  }): Promise<IdempotencyOutcome> {
    const existing = await this.store.claim({
      ...args,
      status: "in_flight",
      createdAtMs: this.clock.nowMs(),
    });

    if (existing === null) return { kind: "proceed" };

    // Regla 2: la key se reutilizó con otro cuerpo.
    if (existing.requestHash !== args.requestHash) return { kind: "conflict" };

    if (existing.status === "in_flight") return { kind: "in_flight" };

    const response = existing.response;
    if (response === undefined) {
      // Completada sin respuesta guardada: es un bug nuestro, no del cliente.
      // Tratarlo como in_flight es lo seguro: no inventamos una respuesta.
      return { kind: "in_flight" };
    }
    // Regla 1.
    return { kind: "replay", status: response.status, body: response.body };
  }

  async succeed(
    key: string,
    companyId: string,
    response: { status: number; body: unknown },
  ): Promise<void> {
    await this.store.complete(key, companyId, response);
  }

  /** Regla 3. Llamalo en el `catch`, siempre. */
  async fail(key: string, companyId: string): Promise<void> {
    await this.store.release(key, companyId);
  }
}

/**
 * Hash estable del body. Las claves se ordenan: `{a:1,b:2}` y `{b:2,a:1}` son
 * el mismo cuerpo, y un cliente que serializa en otro orden no debería comerse
 * un 409.
 */
export function hashRequestBody(body: unknown): string {
  const canonical = JSON.stringify(sortDeep(body));
  // FNV-1a de 32 bits. Suficiente para comparar dos cuerpos de la misma key.
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortDeep(v)]));
  }
  return value;
}
