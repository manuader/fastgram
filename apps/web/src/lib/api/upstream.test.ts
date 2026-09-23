/**
 * Lo que se prueba acá es lo que el route handler no puede probar sin levantar
 * Next: la lectura del entorno y la composición de la URL de salida.
 *
 * El caso que importa de verdad es el del `..`. El reenvío lleva el token de
 * sesión del usuario, así que salirse del prefijo `/api/v1` es salirse **con
 * su credencial**. Un test de "arma bien la URL" no lo habría encontrado.
 */
import { describe, expect, it } from "vitest";
import {
  API_URL_ENV,
  DEFAULT_UPSTREAM_BASE,
  readUpstreamConfig,
  resolveUpstreamUrl,
} from "./upstream";

describe("readUpstreamConfig", () => {
  it("fuera de producción, sin URL apunta a la API de desarrollo", () => {
    expect(readUpstreamConfig({})).toEqual({
      ok: true,
      config: { base: DEFAULT_UPSTREAM_BASE },
    });
  });

  it("en producción la URL es obligatoria: no cae en silencio a localhost", () => {
    expect(readUpstreamConfig({ NODE_ENV: "production" })).toEqual({
      ok: false,
      missing: API_URL_ENV,
    });
    expect(readUpstreamConfig({ NODE_ENV: "production", [API_URL_ENV]: "  " })).toEqual({
      ok: false,
      missing: API_URL_ENV,
    });
  });

  it("la URL del entorno gana, sin barra final", () => {
    expect(
      readUpstreamConfig({
        NODE_ENV: "production",
        [API_URL_ENV]: "https://api.example.test/api/v1/",
      }),
    ).toEqual({ ok: true, config: { base: "https://api.example.test/api/v1" } });
  });

  it("ya no pide ni lee la API key del servidor", () => {
    const result = readUpstreamConfig({ FASTGRAM_API_KEY: "fsln_live_x" });
    expect(JSON.stringify(result)).not.toContain("fsln_live_x");
  });
});

describe("resolveUpstreamUrl", () => {
  const base = "http://localhost:3001/api/v1";

  it("compone la ruta y conserva la query", () => {
    expect(resolveUpstreamUrl(base, ["content"], "?limit=20&status=BUILDING")).toBe(
      "http://localhost:3001/api/v1/content?limit=20&status=BUILDING",
    );
  });

  it("varios segmentos", () => {
    expect(resolveUpstreamUrl(base, ["content", "abc-123"], "")).toBe(
      "http://localhost:3001/api/v1/content/abc-123",
    );
  });

  it("rechaza `..`: con el token puesto, salir del prefijo es salir con la credencial", () => {
    expect(resolveUpstreamUrl(base, ["content", "..", "..", "admin"], "")).toBeNull();
    expect(resolveUpstreamUrl(base, [".."], "")).toBeNull();
  });

  it("rechaza un segmento que trae su propia barra", () => {
    expect(resolveUpstreamUrl(base, ["content/../../admin"], "")).toBeNull();
    expect(resolveUpstreamUrl(base, ["content\\..\\admin"], "")).toBeNull();
  });

  it("rechaza un segmento vacío", () => {
    expect(resolveUpstreamUrl(base, ["content", ""], "")).toBeNull();
    expect(resolveUpstreamUrl(base, [], "")).toBeNull();
  });

  it("un id no puede inventar query ni fragmento", () => {
    const url = resolveUpstreamUrl(base, ["content", "a?b#c"], "?limit=5");
    expect(url).toBe("http://localhost:3001/api/v1/content/a%3Fb%23c?limit=5");
  });
});
