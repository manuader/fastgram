/**
 * Lo que se prueba acá es lo que el route handler no puede probar sin levantar
 * Next: la lectura del entorno y la composición de la URL de salida.
 *
 * El caso que importa de verdad es el del `..`. El reenvío lleva la API key
 * puesta, así que salirse del prefijo `/api/v1` es salirse **con la credencial
 * del workspace**. Un test de "arma bien la URL" no lo habría encontrado.
 */
import { describe, expect, it } from "vitest";
import {
  API_KEY_ENV,
  API_URL_ENV,
  DEFAULT_UPSTREAM_BASE,
  readUpstreamConfig,
  resolveUpstreamUrl,
  workspaceHeaderFor,
} from "./upstream";
import { WORKSPACE_HEADER } from "@/lib/brands/workspace-cookie";

describe("readUpstreamConfig", () => {
  it("sin key no hay configuración, y dice cuál falta", () => {
    expect(readUpstreamConfig({})).toEqual({ ok: false, missing: API_KEY_ENV });
  });

  it("una key en blanco es una key que falta, no una key vacía", () => {
    // Un `FASTGRAM_API_KEY=` en un `.env` produce `""`, y mandar
    // `Authorization: Bearer ` es un 401 confuso en vez de un 503 claro.
    expect(readUpstreamConfig({ [API_KEY_ENV]: "   " })).toEqual({
      ok: false,
      missing: API_KEY_ENV,
    });
  });

  it("con key y sin URL, apunta a la API de desarrollo", () => {
    expect(readUpstreamConfig({ [API_KEY_ENV]: "fsln_live_x" })).toEqual({
      ok: true,
      config: { base: DEFAULT_UPSTREAM_BASE, apiKey: "fsln_live_x" },
    });
  });

  it("la URL del entorno gana", () => {
    const result = readUpstreamConfig({
      [API_KEY_ENV]: "fsln_live_x",
      [API_URL_ENV]: "https://api.example.test/api/v1",
    });
    expect(result).toMatchObject({
      ok: true,
      config: { base: "https://api.example.test/api/v1" },
    });
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

  it("rechaza `..`: con la key puesta, salir del prefijo es salir con la credencial", () => {
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

describe("workspaceHeaderFor (PU-BRAND-001)", () => {
  const BRAND = "3F2B8C1E-9A4D-4C6B-8E2F-1A2B3C4D5E6F";

  it("un uuid sale como header, normalizado a minúsculas", () => {
    expect(workspaceHeaderFor(BRAND)).toEqual({
      [WORKSPACE_HEADER]: BRAND.toLowerCase(),
    });
  });

  it("sin cookie, o con basura, no hay header", () => {
    expect(workspaceHeaderFor(undefined)).toEqual({});
    expect(workspaceHeaderFor("")).toEqual({});
    expect(workspaceHeaderFor("not-a-uuid")).toEqual({});
    expect(workspaceHeaderFor(`${BRAND}\r\nX-Evil: 1`)).toEqual({});
  });
});
