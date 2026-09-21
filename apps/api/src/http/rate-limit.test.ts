import { describe, expect, it } from "vitest";
import { FixedClock } from "@fastgram/adapters";
import {
  RATE_LIMITS,
  TokenBucketLimiter,
  rateLimitUnavailable,
  tooManyRequests,
  type BucketState,
  type BucketStore,
} from "./rate-limit.js";

class MemoryStore implements BucketStore {
  readonly data = new Map<string, BucketState>();
  async read(key: string) {
    return this.data.get(key) ?? null;
  }
  async write(key: string, state: BucketState) {
    this.data.set(key, state);
  }
}

class BrokenStore implements BucketStore {
  async read(): Promise<BucketState | null> {
    throw new Error("el contador no responde");
  }
  async write(): Promise<void> {
    throw new Error("el contador no responde");
  }
}

describe("límites del PRD §9.6 — los números son normativos", () => {
  it("son exactamente los de la tabla del PRD", () => {
    expect(RATE_LIMITS.restPerWorkspace).toEqual({ limit: 60, windowMs: 60_000 });
    expect(RATE_LIMITS.blitzPreferencesUpdate.limit).toBe(3);
    expect(RATE_LIMITS.angleGeneration.limit).toBe(5);
    expect(RATE_LIMITS.contentBuilds.limit).toBe(10);
    expect(RATE_LIMITS.mcpPerUser.limit).toBe(30);
    expect(RATE_LIMITS.partnerAggregate.limit).toBe(5_000);
  });
});

describe("TokenBucketLimiter", () => {
  it("deja pasar hasta el límite y corta en el siguiente", async () => {
    const limiter = new TokenBucketLimiter(new MemoryStore(), new FixedClock());
    for (let i = 0; i < 60; i++) {
      expect((await limiter.consume("restPerWorkspace", "co_1")).outcome).toBe("allowed");
    }
    const cortado = await limiter.consume("restPerWorkspace", "co_1");
    expect(cortado.outcome).toBe("limited");
  });

  it("el refill es uniforme, no un salto al cambiar el minuto", async () => {
    // Este es el caso que rompe un limitador con reset por minuto de reloj:
    // gastar todo al final de un minuto y todo de nuevo al empezar el
    // siguiente da 120 peticiones en dos segundos contra un límite de 60.
    const clock = new FixedClock("2026-01-01T10:00:59.000Z");
    const limiter = new TokenBucketLimiter(new MemoryStore(), clock);

    for (let i = 0; i < 60; i++) await limiter.consume("restPerWorkspace", "co_1");
    clock.advanceMs(1000); // cruzamos a las 10:01:00

    // Sólo debería haber recuperado ~1 token (60 por 60 s = 1 por segundo).
    expect((await limiter.consume("restPerWorkspace", "co_1")).outcome).toBe("allowed");
    expect((await limiter.consume("restPerWorkspace", "co_1")).outcome).toBe("limited");
  });

  it("recupera todo el bucket al cabo de la ventana completa", async () => {
    const clock = new FixedClock();
    const limiter = new TokenBucketLimiter(new MemoryStore(), clock);
    for (let i = 0; i < 60; i++) await limiter.consume("restPerWorkspace", "co_1");

    clock.advanceMs(60_000);

    const r = await limiter.consume("restPerWorkspace", "co_1");
    expect(r.outcome).toBe("allowed");
    if (r.outcome === "allowed") expect(r.remaining).toBe(59);
  });

  it("los workspaces no comparten bucket", async () => {
    const limiter = new TokenBucketLimiter(new MemoryStore(), new FixedClock());
    for (let i = 0; i < 3; i++) await limiter.consume("blitzPreferencesUpdate", "co_1");

    expect((await limiter.consume("blitzPreferencesUpdate", "co_1")).outcome).toBe(
      "limited",
    );
    expect((await limiter.consume("blitzPreferencesUpdate", "co_2")).outcome).toBe(
      "allowed",
    );
  });

  it("si NO se puede comprobar el límite, es `unavailable` — nunca `limited`", async () => {
    // PRD §9.6: en ese caso se devuelve 503, y aclara que "esto NO significa
    // cuota agotada". Decirle 429 a un cliente que no gastó nada lo manda a
    // esperar la próxima ventana en vez de reintentar.
    const limiter = new TokenBucketLimiter(new BrokenStore(), new FixedClock());
    const r = await limiter.consume("restPerWorkspace", "co_1");
    expect(r.outcome).toBe("unavailable");
  });

  it("el retryAfterMs alcanza para volver a pasar", async () => {
    const clock = new FixedClock();
    const limiter = new TokenBucketLimiter(new MemoryStore(), clock);
    for (let i = 0; i < 10; i++) await limiter.consume("contentBuilds", "co_1");

    const cortado = await limiter.consume("contentBuilds", "co_1");
    expect(cortado.outcome).toBe("limited");
    if (cortado.outcome !== "limited") return;

    clock.advanceMs(cortado.retryAfterMs);
    expect((await limiter.consume("contentBuilds", "co_1")).outcome).toBe("allowed");
  });
});

describe("respuestas", () => {
  it("el 429 lleva Retry-After y details.retryAfterMs (PRD §9.6)", () => {
    const r = tooManyRequests(2500);
    expect(r.status).toBe(429);
    expect(r.headers["Retry-After"]).toBe("3");
    expect(r.body.error.details.retryAfterMs).toBe(2500);
  });

  it("el 503 dice explícitamente que no es cuota agotada", () => {
    const r = rateLimitUnavailable();
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("service_unavailable");
    expect(r.body.error.message).toMatch(/does not mean your quota/i);
  });
});
