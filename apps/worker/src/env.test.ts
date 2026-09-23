/**
 * `RENDER_SERVICE_URL` + `RENDER_MEDIA_GRANT_SECRET`: todas o ninguna.
 *
 * Los valores son de juguete y se ven: ningún secreto real entra en un test.
 */
import { EnvError } from "@fastgram/config/env";
import { describe, expect, it } from "vitest";

import { loadWorkerEnv, renderServiceFromEnv } from "./env.js";

const BASE = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "b",
  S3_ACCESS_KEY_ID: "k",
  S3_SECRET_ACCESS_KEY: "s",
  S3_PUBLIC_URL: "http://localhost:9000/b",
} as const;

const URL_DE_PRUEBA = "http://render.test:3002";
const SECRETO_DE_PRUEBA = "x".repeat(32);

function issuesOf(source: Record<string, string>): { path: string; message: string }[] {
  try {
    loadWorkerEnv(source);
  } catch (e) {
    expect(e).toBeInstanceOf(EnvError);
    return [...(e as EnvError).issues];
  }
  return expect.unreachable("tenía que lanzar");
}

describe("servicio de render en el entorno del worker", () => {
  it("ninguna: arranca, y la normalización queda sin configurar", () => {
    const env = loadWorkerEnv({ ...BASE });
    expect(renderServiceFromEnv(env)).toBeNull();
  });

  it("ninguna, escritas vacías como en .env.example: igual que ausentes", () => {
    const env = loadWorkerEnv({
      ...BASE,
      RENDER_SERVICE_URL: "",
      RENDER_MEDIA_GRANT_SECRET: "",
    });
    expect(renderServiceFromEnv(env)).toBeNull();
  });

  it("todas: devuelve la configuración", () => {
    const env = loadWorkerEnv({
      ...BASE,
      RENDER_SERVICE_URL: URL_DE_PRUEBA,
      RENDER_MEDIA_GRANT_SECRET: SECRETO_DE_PRUEBA,
    });
    expect(renderServiceFromEnv(env)).toEqual({
      baseUrl: URL_DE_PRUEBA,
      grantSecret: SECRETO_DE_PRUEBA,
    });
  });

  it("parcial, sólo URL: no arranca y nombra la que falta", () => {
    const issues = issuesOf({ ...BASE, RENDER_SERVICE_URL: URL_DE_PRUEBA });
    expect(issues.map((i) => i.path)).toEqual(["RENDER_MEDIA_GRANT_SECRET"]);
    expect(issues[0]?.message).toContain("RENDER_SERVICE_URL");
    expect(issues[0]?.message).toContain("juntas");
  });

  it("parcial, sólo secreto: no arranca y nombra la que falta", () => {
    const issues = issuesOf({ ...BASE, RENDER_MEDIA_GRANT_SECRET: SECRETO_DE_PRUEBA });
    expect(issues.map((i) => i.path)).toEqual(["RENDER_SERVICE_URL"]);
  });

  it("parcial con la otra vacía: vacío cuenta como ausente, así que también es parcial", () => {
    const issues = issuesOf({
      ...BASE,
      RENDER_SERVICE_URL: URL_DE_PRUEBA,
      RENDER_MEDIA_GRANT_SECRET: "",
    });
    expect(issues.map((i) => i.path)).toEqual(["RENDER_MEDIA_GRANT_SECRET"]);
  });

  it("el mensaje del error nunca incluye el secreto", () => {
    let error: unknown;
    try {
      loadWorkerEnv({ ...BASE, RENDER_MEDIA_GRANT_SECRET: SECRETO_DE_PRUEBA });
    } catch (e) {
      error = e;
    }
    // Afuera del `try`: adentro, un `unreachable` se atraparía a sí mismo y el
    // test pasaría sin que nada lanzara (pasó, rompiendo la validación).
    expect(error).toBeInstanceOf(EnvError);
    expect((error as Error).message).not.toContain(SECRETO_DE_PRUEBA);
  });

  it("un secreto más corto que el que acepta services/render se rechaza acá", () => {
    const issues = issuesOf({
      ...BASE,
      RENDER_SERVICE_URL: URL_DE_PRUEBA,
      RENDER_MEDIA_GRANT_SECRET: "x".repeat(31),
    });
    expect(issues.map((i) => i.path)).toContain("RENDER_MEDIA_GRANT_SECRET");
  });

  it.each([["no-es-url"], ["ftp://render.test"]])(
    "una URL inválida (%s) se rechaza",
    (url) => {
      const issues = issuesOf({
        ...BASE,
        RENDER_SERVICE_URL: url,
        RENDER_MEDIA_GRANT_SECRET: SECRETO_DE_PRUEBA,
      });
      expect(issues.map((i) => i.path)).toContain("RENDER_SERVICE_URL");
    },
  );
});
