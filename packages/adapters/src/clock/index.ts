import type { Clock } from "@fastgram/ports";

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
};

/** Reloj de test. Avanza sólo cuando se le pide. */
export class FixedClock implements Clock {
  #ms: number;
  constructor(start: Date | string | number = "2026-01-01T00:00:00.000Z") {
    this.#ms = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.#ms);
  }
  nowMs(): number {
    return this.#ms;
  }
  advanceMs(ms: number): this {
    this.#ms += ms;
    return this;
  }
  advanceHours(h: number): this {
    return this.advanceMs(h * 3_600_000);
  }
  advanceDays(d: number): this {
    return this.advanceMs(d * 86_400_000);
  }
  set(at: Date | string): this {
    this.#ms = new Date(at).getTime();
    return this;
  }
}
