/**
 * `shouldRetry` · la política de reintento de las lecturas.
 *
 * El caso que justifica el archivo: un `429` puede ser un rate limit (ERR-R01,
 * recuperable esperando) **o** una cuota agotada (ERR-R02/R03, no). Decidir por
 * status reintentaría la cuota dos veces más con la pantalla en blanco.
 */
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "./errors";
import { shouldRetry } from "./query-client";

const fail = (
  code: ConstructorParameters<typeof ApiRequestError>[0]["code"],
  status: number,
) => new ApiRequestError({ code, status });

describe("shouldRetry", () => {
  it("un 429 de rate limit se reintenta", () => {
    expect(shouldRetry(0, fail("rate_limited", 429))).toBe(true);
  });

  it("un 429 de cuota NO se reintenta: se reconoce por el `code`", () => {
    expect(shouldRetry(0, fail("content_quota_exceeded", 429))).toBe(false);
    expect(shouldRetry(0, fail("blitz_quota_exceeded", 429))).toBe(false);
  });

  it("5xx y red sí; 4xx no; y nunca más allá del tope", () => {
    expect(shouldRetry(0, fail("service_unavailable", 503))).toBe(true);
    expect(shouldRetry(0, fail("network_error", 0))).toBe(true);
    expect(shouldRetry(0, fail("bad_request", 400))).toBe(false);
    expect(shouldRetry(2, fail("service_unavailable", 503))).toBe(false);
  });
});
