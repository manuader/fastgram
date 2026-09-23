/**
 * Lo que `P1-AUTH-002` agregó al entorno: la identidad va **entera o no va**,
 * y `AUTH_TRUSTED_PROXIES` sólo acepta IPs.
 */
import { describe, expect, it } from "vitest";

import { apiEnvSchema, identityConfigOf } from "./env.js";

const BASE = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "auto",
  S3_BUCKET: "b",
  S3_ACCESS_KEY_ID: "k",
  S3_SECRET_ACCESS_KEY: "s",
  S3_PUBLIC_URL: "http://localhost:9000/b",
};

const SECRET = "x".repeat(40);

describe("identidad: las dos o ninguna", () => {
  it("sin ninguna, arranca y la identidad queda sin configurar", () => {
    const parsed = apiEnvSchema.safeParse(BASE);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (parsed.success) expect(identityConfigOf(parsed.data)).toBeNull();
  });

  it("vacías (como en .env.example) cuentan como ausentes", () => {
    const parsed = apiEnvSchema.safeParse({
      ...BASE,
      BETTER_AUTH_SECRET: "",
      BETTER_AUTH_URL: "",
    });
    expect(parsed.success).toBe(true);
  });

  it("con las dos, la configuración sale entera", () => {
    const parsed = apiEnvSchema.safeParse({
      ...BASE,
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: "http://localhost:3001",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(identityConfigOf(parsed.data)).toEqual({
        secret: SECRET,
        baseUrl: "http://localhost:3001",
      });
    }
  });

  it("con una sola, no arranca — y el error nombra la que falta, no el valor de la otra", () => {
    const onlySecret = apiEnvSchema.safeParse({ ...BASE, BETTER_AUTH_SECRET: SECRET });
    expect(onlySecret.success).toBe(false);
    const issues = JSON.stringify(onlySecret.error?.issues);
    expect(issues).toContain("BETTER_AUTH_URL");
    expect(issues).not.toContain(SECRET);

    const onlyUrl = apiEnvSchema.safeParse({
      ...BASE,
      BETTER_AUTH_URL: "http://localhost:3001",
    });
    expect(onlyUrl.success).toBe(false);
    expect(JSON.stringify(onlyUrl.error?.issues)).toContain("BETTER_AUTH_SECRET");
  });
});

describe("AUTH_TRUSTED_PROXIES", () => {
  it("default vacío", () => {
    const parsed = apiEnvSchema.parse(BASE);
    expect(parsed.AUTH_TRUSTED_PROXIES).toEqual([]);
  });

  it("lista de IPs separadas por coma", () => {
    const parsed = apiEnvSchema.parse({
      ...BASE,
      AUTH_TRUSTED_PROXIES: " 10.0.0.5, ::1 ,",
    });
    expect(parsed.AUTH_TRUSTED_PROXIES).toEqual(["10.0.0.5", "::1"]);
  });

  it("un rango o un nombre no se aceptan: no arranca", () => {
    for (const bad of ["10.0.0.0/8", "web.internal"]) {
      expect(apiEnvSchema.safeParse({ ...BASE, AUTH_TRUSTED_PROXIES: bad }).success).toBe(
        false,
      );
    }
  });
});
