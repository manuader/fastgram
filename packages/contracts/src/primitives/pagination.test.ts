import { describe, expect, it } from "vitest";
import {
  cursorQuerySchema,
  PAGINATION_LIMIT_DEFAULT,
  PAGINATION_LIMIT_MAX,
  PAGINATION_LIMIT_MIN,
} from "./pagination.js";
import { paginatedEnvelope, paginationSchema } from "./envelope.js";
import { z } from "zod";

describe("paginación por cursor · PRD:2345 §9.10 y PRD:2730 §12", () => {
  it("limit va de 1 a 100 y el default es 20", () => {
    expect(PAGINATION_LIMIT_MIN).toBe(1);
    expect(PAGINATION_LIMIT_MAX).toBe(100);
    expect(PAGINATION_LIMIT_DEFAULT).toBe(20);
  });

  it("sin limit aplica el default 20", () => {
    expect(cursorQuerySchema.parse({}).limit).toBe(20);
  });

  it("acepta los extremos 1 y 100", () => {
    expect(cursorQuerySchema.parse({ limit: 1 }).limit).toBe(1);
    expect(cursorQuerySchema.parse({ limit: 100 }).limit).toBe(100);
  });

  it("rechaza 0 y 101", () => {
    expect(() => cursorQuerySchema.parse({ limit: 0 })).toThrow();
    expect(() => cursorQuerySchema.parse({ limit: 101 })).toThrow();
  });

  it("coerciona el limit que llega como string de query", () => {
    expect(cursorQuerySchema.parse({ limit: "50" }).limit).toBe(50);
  });

  it("el cursor es opaco y puede ser null en la respuesta", () => {
    expect(paginationSchema.parse({ cursor: null, hasMore: false }).cursor).toBeNull();
    expect(paginationSchema.parse({ cursor: "eyJ...", hasMore: true }).hasMore).toBe(
      true,
    );
  });

  it("el sobre paginado lleva data y pagination", () => {
    const schema = paginatedEnvelope(z.object({ _id: z.string() }));
    const parsed = schema.parse({
      data: [{ _id: "a" }],
      pagination: { cursor: null, hasMore: false },
    });
    expect(parsed.data).toHaveLength(1);
  });
});
