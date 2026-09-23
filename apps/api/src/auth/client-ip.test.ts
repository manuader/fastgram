import { describe, expect, it } from "vitest";

import { normalizeIp, resolveClientIp } from "./client-ip.js";

const BFF = new Set(["10.0.0.5"]);

describe("resolveClientIp", () => {
  it("sin proxies configurados: la IP del socket, marcada como NO confiable", () => {
    expect(resolveClientIp("10.0.0.5", "1.2.3.4", new Set())).toEqual({
      ip: "10.0.0.5",
      trusted: false,
    });
  });

  it("socket que no es un proxy: su IP, y el X-Forwarded-For se ignora", () => {
    expect(resolveClientIp("198.51.100.9", "1.2.3.4", BFF)).toEqual({
      ip: "198.51.100.9",
      trusted: true,
    });
  });

  it("desde el proxy: el salto de más a la derecha que no es de confianza", () => {
    expect(resolveClientIp("10.0.0.5", "203.0.113.7", BFF)).toEqual({
      ip: "203.0.113.7",
      trusted: true,
    });
    // Lo de la izquierda lo escribió el cliente: no se mira.
    expect(resolveClientIp("10.0.0.5", "192.0.2.1, 203.0.113.7", BFF).ip).toBe(
      "203.0.113.7",
    );
    // Proxies propios encadenados se saltean.
    expect(resolveClientIp("10.0.0.5", "203.0.113.7, 10.0.0.5", BFF).ip).toBe(
      "203.0.113.7",
    );
    expect(resolveClientIp("10.0.0.5", ["192.0.2.1", "203.0.113.7"], BFF).ip).toBe(
      "203.0.113.7",
    );
  });

  it("desde el proxy sin X-Forwarded-For, o con basura: no confiable", () => {
    expect(resolveClientIp("10.0.0.5", undefined, BFF)).toEqual({
      ip: "10.0.0.5",
      trusted: false,
    });
    expect(resolveClientIp("10.0.0.5", "no-es-ip", BFF)).toEqual({
      ip: "10.0.0.5",
      trusted: false,
    });
  });

  it("normaliza IPv4 mapeada en IPv6", () => {
    expect(normalizeIp("::ffff:10.0.0.5")).toBe("10.0.0.5");
    expect(resolveClientIp("::ffff:10.0.0.5", "203.0.113.7", BFF).ip).toBe("203.0.113.7");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
  });
});
