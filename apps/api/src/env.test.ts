/**
 * `PU-RUN-002`: el modo y el host de `listen`.
 *
 * Lo que importa fijar es el default: sin `FASTGRAM_MODE` la API tiene que
 * seguir siendo `standard` —si no, cada entorno existente perdería cuotas y rate
 * limit sin pedirlo— y en `personal` sin `API_HOST` tiene que escuchar sólo en
 * loopback.
 */
import { describe, expect, it } from "vitest";

import { apiEnvSchema, resolveListenHost } from "./env.js";

describe("FASTGRAM_MODE", () => {
  it("default standard", () => {
    expect(apiEnvSchema.shape.FASTGRAM_MODE.parse(undefined)).toBe("standard");
  });

  it("acepta personal y rechaza cualquier otra cosa", () => {
    expect(apiEnvSchema.shape.FASTGRAM_MODE.parse("personal")).toBe("personal");
    expect(() => apiEnvSchema.shape.FASTGRAM_MODE.parse("Personal")).toThrow();
    expect(() => apiEnvSchema.shape.FASTGRAM_MODE.parse("")).toThrow();
  });
});

describe("resolveListenHost", () => {
  it("personal sin API_HOST → 127.0.0.1", () => {
    expect(resolveListenHost({ FASTGRAM_MODE: "personal", API_HOST: undefined })).toBe(
      "127.0.0.1",
    );
  });

  it("standard sin API_HOST → 0.0.0.0 (lo de antes)", () => {
    expect(resolveListenHost({ FASTGRAM_MODE: "standard", API_HOST: undefined })).toBe(
      "0.0.0.0",
    );
  });

  it("un API_HOST explícito gana en los dos modos", () => {
    expect(resolveListenHost({ FASTGRAM_MODE: "personal", API_HOST: "0.0.0.0" })).toBe(
      "0.0.0.0",
    );
    expect(resolveListenHost({ FASTGRAM_MODE: "standard", API_HOST: "10.0.0.5" })).toBe(
      "10.0.0.5",
    );
  });
});
