import { describe, expect, it } from "vitest";
import { FixedClock } from "./index.js";

describe("FixedClock", () => {
  it("no avanza solo", () => {
    const c = new FixedClock("2026-03-01T10:00:00.000Z");
    const first = c.nowMs();
    expect(c.nowMs()).toBe(first);
  });

  it("avanza exactamente lo pedido", () => {
    const c = new FixedClock("2026-03-01T10:00:00.000Z");
    c.advanceHours(14);
    expect(c.now().toISOString()).toBe("2026-03-02T00:00:00.000Z");
  });
});
