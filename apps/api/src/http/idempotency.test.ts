import { describe, expect, it } from "vitest";
import { FixedClock } from "@fastgram/adapters";
import {
  IdempotencyGuard,
  hashRequestBody,
  type IdempotencyRecord,
  type IdempotencyStore,
} from "./idempotency.js";

/** Store en memoria con `claim` atómico, como exige el contrato. */
class MemoryStore implements IdempotencyStore {
  readonly rows = new Map<string, IdempotencyRecord>();
  #k(key: string, companyId: string) {
    return `${companyId}:${key}`;
  }
  async claim(record: IdempotencyRecord) {
    const k = this.#k(record.key, record.companyId);
    const existing = this.rows.get(k);
    if (existing) return existing;
    this.rows.set(k, record);
    return null;
  }
  async complete(
    key: string,
    companyId: string,
    response: { status: number; body: unknown },
  ) {
    const k = this.#k(key, companyId);
    const row = this.rows.get(k);
    if (row) this.rows.set(k, { ...row, status: "completed", response });
  }
  async release(key: string, companyId: string) {
    this.rows.delete(this.#k(key, companyId));
  }
}

const base = { key: "idem_1", companyId: "co_1", route: "POST /content" };

describe("IdempotencyGuard — las tres reglas del PRD §9.3", () => {
  it("regla 1: misma key + mismo body reproduce la respuesta original", async () => {
    const guard = new IdempotencyGuard(new MemoryStore(), new FixedClock());
    const hash = hashRequestBody({ contentType: "slideshow" });

    expect(await guard.begin({ ...base, requestHash: hash })).toEqual({
      kind: "proceed",
    });
    await guard.succeed(base.key, base.companyId, { status: 201, body: { id: "ct_1" } });

    const segunda = await guard.begin({ ...base, requestHash: hash });
    expect(segunda).toEqual({ kind: "replay", status: 201, body: { id: "ct_1" } });
  });

  it("regla 2: misma key + body distinto es conflict", async () => {
    const guard = new IdempotencyGuard(new MemoryStore(), new FixedClock());
    await guard.begin({ ...base, requestHash: hashRequestBody({ a: 1 }) });
    await guard.succeed(base.key, base.companyId, { status: 201, body: {} });

    const otro = await guard.begin({ ...base, requestHash: hashRequestBody({ a: 2 }) });
    expect(otro).toEqual({ kind: "conflict" });
  });

  it("regla 3: una petición que falla LIBERA la key", async () => {
    // La regla que se olvida. Sin ella, un 500 transitorio quema la key y el
    // cliente no puede reintentar nunca más — lo contrario de para qué existe.
    const guard = new IdempotencyGuard(new MemoryStore(), new FixedClock());
    const hash = hashRequestBody({ a: 1 });

    await guard.begin({ ...base, requestHash: hash });
    await guard.fail(base.key, base.companyId);

    expect(await guard.begin({ ...base, requestHash: hash })).toEqual({
      kind: "proceed",
    });
  });

  it("dos reintentos simultáneos: sólo uno procede", async () => {
    const guard = new IdempotencyGuard(new MemoryStore(), new FixedClock());
    const hash = hashRequestBody({ a: 1 });

    const [a, b] = await Promise.all([
      guard.begin({ ...base, requestHash: hash }),
      guard.begin({ ...base, requestHash: hash }),
    ]);

    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["in_flight", "proceed"]);
  });

  it("la key es por workspace: dos tenants pueden usar la misma", async () => {
    const guard = new IdempotencyGuard(new MemoryStore(), new FixedClock());
    const hash = hashRequestBody({ a: 1 });

    await guard.begin({ ...base, requestHash: hash });
    const otroTenant = await guard.begin({
      ...base,
      companyId: "co_2",
      requestHash: hash,
    });
    expect(otroTenant).toEqual({ kind: "proceed" });
  });
});

describe("hashRequestBody", () => {
  it("el orden de las claves no cambia el hash", () => {
    // Un cliente que serializa en otro orden no debería comerse un 409.
    expect(hashRequestBody({ a: 1, b: { c: 2, d: 3 } })).toBe(
      hashRequestBody({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("un valor distinto sí cambia el hash", () => {
    expect(hashRequestBody({ a: 1 })).not.toBe(hashRequestBody({ a: 2 }));
  });

  it("el orden de un array SÍ importa", () => {
    // En un slideshow el orden de las slides es el contenido, no un detalle.
    expect(hashRequestBody([1, 2])).not.toBe(hashRequestBody([2, 1]));
  });
});
