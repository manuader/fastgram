/**
 * `RENDER_SERVICE_URL` + `RENDER_MEDIA_GRANT_SECRET`: todas o ninguna.
 *
 * Los valores son de juguete y se ven: ningún secreto real entra en un test.
 */
import { EnvError } from "@fastgram/config/env";
import { describe, expect, it } from "vitest";

import { brandAnalysisFromEnv, loadWorkerEnv, renderServiceFromEnv } from "./env.js";

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

describe("brand-source-analysis en el entorno del worker", () => {
  const LLM = {
    LLM_BASE_URL: "http://llm.test",
    LLM_API_KEY: "clave-de-juguete",
    LLM_MODEL: "modelo-de-juguete",
    LLM_CONTEXT_WINDOW_TOKENS: "8000",
  } as const;
  const WEB = {
    BRAND_WEBSITE_TIMEOUT_MS: "1000",
    BRAND_WEBSITE_MAX_BODY_BYTES: "2000",
    BRAND_WEBSITE_MAX_REDIRECTS: "0",
    BRAND_WEBSITE_MAX_SECONDARY_PAGES: "3",
    BRAND_WEBSITE_MAX_TEXT_CHARS: "500",
    BRAND_WEBSITE_USER_AGENT: "bot-de-juguete",
    BRAND_WEBSITE_ALLOWED_PORTS: "80, 443",
  } as const;

  it("sin nada: arranca, y dice los tres grupos que faltan", () => {
    const r = brandAnalysisFromEnv(loadWorkerEnv({ ...BASE }));
    expect(r.kind).toBe("missing");
    if (r.kind === "missing") {
      expect(r.missing).toHaveLength(3);
      expect(r.missing.join(" ")).toContain("LLM_CONTEXT_WINDOW_TOKENS");
      expect(r.missing.join(" ")).toContain("BRAND_WEBSITE_USER_AGENT");
      expect(r.missing).toContain("BRAND_SNAPSHOT_RAW_RETENTION_DAYS");
    }
  });

  it("vacías como en .env.example: igual que ausentes", () => {
    const vacias = Object.fromEntries(
      [...Object.keys(LLM), ...Object.keys(WEB), "BRAND_SNAPSHOT_RAW_RETENTION_DAYS"].map(
        (k) => [k, ""],
      ),
    );
    expect(brandAnalysisFromEnv(loadWorkerEnv({ ...BASE, ...vacias })).kind).toBe(
      "missing",
    );
  });

  it("todo: devuelve la configuración, puertos parseados y hosts bloqueados vacíos", () => {
    const r = brandAnalysisFromEnv(
      loadWorkerEnv({ ...BASE, ...LLM, ...WEB, BRAND_SNAPSHOT_RAW_RETENTION_DAYS: "30" }),
    );
    expect(r).toEqual({
      kind: "configured",
      llm: {
        baseUrl: "http://llm.test",
        apiKey: "clave-de-juguete",
        model: "modelo-de-juguete",
        contextWindowTokens: 8000,
      },
      website: {
        timeoutMs: 1000,
        maxBodyBytes: 2000,
        maxRedirects: 0,
        maxSecondaryPages: 3,
        maxTextChars: 500,
        userAgent: "bot-de-juguete",
        allowedPorts: [80, 443],
        blockedHosts: [],
      },
      rawRetentionDays: 30,
    });
  });

  it("sin retención no se monta aunque LLM y extractor estén", () => {
    const r = brandAnalysisFromEnv(loadWorkerEnv({ ...BASE, ...LLM, ...WEB }));
    expect(r).toEqual({
      kind: "missing",
      missing: ["BRAND_SNAPSHOT_RAW_RETENTION_DAYS"],
    });
  });

  it("LLM a medias: no arranca y nombra la que falta", () => {
    const issues = issuesOf({ ...BASE, LLM_BASE_URL: "http://llm.test" });
    expect(issues.map((i) => i.path).sort()).toEqual(
      ["LLM_API_KEY", "LLM_CONTEXT_WINDOW_TOKENS", "LLM_MODEL"].sort(),
    );
  });

  it("extractor a medias: no arranca", () => {
    const { BRAND_WEBSITE_USER_AGENT: _, ...sinAgente } = WEB;
    const issues = issuesOf({ ...BASE, ...sinAgente });
    expect(issues.map((i) => i.path)).toEqual(["BRAND_WEBSITE_USER_AGENT"]);
  });

  it("más de 5 páginas secundarias es el techo de §9.14: no arranca", () => {
    const issues = issuesOf({ ...BASE, ...WEB, BRAND_WEBSITE_MAX_SECONDARY_PAGES: "6" });
    expect(issues.map((i) => i.path)).toContain("BRAND_WEBSITE_MAX_SECONDARY_PAGES");
  });

  it("puertos mal escritos: no arranca", () => {
    const issues = issuesOf({
      ...BASE,
      ...WEB,
      BRAND_WEBSITE_ALLOWED_PORTS: "80,,70000",
    });
    expect(issues.map((i) => i.path)).toContain("BRAND_WEBSITE_ALLOWED_PORTS");
  });
});
