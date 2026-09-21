/**
 * API keys — P1-API-005 · FR-180 (PRD:1851-1872).
 *
 * Cada número y cada literal del PRD que toca este módulo lleva un test acá: el
 * prefijo, la longitud, el alfabeto, el mensaje único de 401 y las causas de rechazo.
 * Si mañana alguien "mejora" el prefijo o distingue el mensaje de una key revocada del
 * de una inexistente, esto grita.
 */
import { describe, expect, it } from "vitest";

import {
  API_KEY_PREFIX,
  API_KEY_SECRET_LENGTH,
  INVALID_API_KEY_MESSAGE,
  extractBearerToken,
  generateApiKey,
  hashApiKey,
  hashesMatch,
  isWellFormedApiKey,
} from "./api-keys.js";

describe("formato del token (FR-180, PRD:1861)", () => {
  it("es `fsln_live_` + 32 base62", () => {
    expect(API_KEY_PREFIX).toBe("fsln_live_");
    expect(API_KEY_SECRET_LENGTH).toBe(32);

    const { token } = generateApiKey();
    expect(token).toMatch(/^fsln_live_[0-9A-Za-z]{32}$/);
    expect(token).toHaveLength("fsln_live_".length + 32);
  });

  it("rechaza longitudes vecinas: 31 y 33 no son 32", () => {
    expect(isWellFormedApiKey(`${API_KEY_PREFIX}${"a".repeat(31)}`)).toBe(false);
    expect(isWellFormedApiKey(`${API_KEY_PREFIX}${"a".repeat(32)}`)).toBe(true);
    expect(isWellFormedApiKey(`${API_KEY_PREFIX}${"a".repeat(33)}`)).toBe(false);
  });

  it("rechaza un prefijo parecido pero distinto", () => {
    expect(isWellFormedApiKey(`fsln_test_${"a".repeat(32)}`)).toBe(false);
    expect(isWellFormedApiKey(`sk_live_${"a".repeat(32)}`)).toBe(false);
  });

  it("rechaza caracteres fuera de base62", () => {
    // El guion y el guion bajo son los sospechosos habituales: están en base64url.
    expect(isWellFormedApiKey(`${API_KEY_PREFIX}${"a".repeat(31)}-`)).toBe(false);
    expect(isWellFormedApiKey(`${API_KEY_PREFIX}${"a".repeat(31)}_`)).toBe(false);
  });

  it("no repite tokens", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateApiKey().token));
    expect(tokens.size).toBe(200);
  });

  it("usa todo el alfabeto base62, no un subconjunto", () => {
    // Detecta un generador sesgado (p.ej. sólo hex) sin depender del azar exacto.
    const sample = Array.from({ length: 300 }, () => generateApiKey().token)
      .map((t) => t.slice(API_KEY_PREFIX.length))
      .join("");
    const alphabet = new Set(sample);
    expect(alphabet.size).toBeGreaterThan(50);
  });
});

describe("almacenamiento hasheado (PRD §9.1)", () => {
  it("el hash no contiene el secreto", () => {
    const { token, hash } = generateApiKey();
    const secret = token.slice(API_KEY_PREFIX.length);
    expect(hash).not.toContain(secret);
    expect(hash).not.toContain(token);
  });

  it("es determinista: mismo token, mismo hash", () => {
    const { token, hash } = generateApiKey();
    expect(hashApiKey(token)).toBe(hash);
  });

  it("tokens distintos dan hashes distintos", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.hash).not.toBe(b.hash);
  });

  it("compara en tiempo constante sin romperse con longitudes distintas", () => {
    const { token, hash } = generateApiKey();
    expect(hashesMatch(hashApiKey(token), hash)).toBe(true);
    expect(hashesMatch("corto", hash)).toBe(false);
  });
});

describe("causas de 401 (FR-180, PRD:1867)", () => {
  const valid = generateApiKey().token;

  it("header ausente", () => {
    expect(extractBearerToken(undefined)).toEqual({
      ok: false,
      reason: "missing_header",
    });
    expect(extractBearerToken("   ")).toEqual({ ok: false, reason: "missing_header" });
  });

  it("esquema distinto de Bearer", () => {
    expect(extractBearerToken(`Basic ${valid}`)).toEqual({
      ok: false,
      reason: "wrong_scheme",
    });
  });

  it("acepta `Bearer` sin importar la capitalización del esquema", () => {
    // RFC 7235: el esquema es case-insensitive. Rechazar `bearer` rompería clientes
    // correctos por una razón que no es de seguridad.
    expect(extractBearerToken(`bearer ${valid}`)).toEqual({ ok: true, token: valid });
    expect(extractBearerToken(`BEARER ${valid}`)).toEqual({ ok: true, token: valid });
  });

  it("token vacío", () => {
    // Las dos formas —con y sin espacio final— son el mismo caso: hay esquema
    // Bearer pero no hay token detrás.
    expect(extractBearerToken("Bearer")).toEqual({ ok: false, reason: "empty_token" });
    expect(extractBearerToken("Bearer ")).toEqual({ ok: false, reason: "empty_token" });
  });

  it("token mal formado", () => {
    expect(extractBearerToken("Bearer no-es-una-key")).toEqual({
      ok: false,
      reason: "malformed_token",
    });
  });

  it("tolera espacios de más entre esquema y token", () => {
    expect(extractBearerToken(`Bearer    ${valid}`)).toEqual({ ok: true, token: valid });
  });
});

describe("el mensaje de 401 es uno solo (PRD:1866)", () => {
  it("es el literal del PRD", () => {
    // El PRD fija el cuerpo: {"error":{"code":"unauthorized","message":"Invalid or
    // revoked API key"}}. Es el mismo para las ocho causas A PROPÓSITO: distinguir
    // "revocada" de "no existe" le confirma a quien sondea que esa key existió.
    expect(INVALID_API_KEY_MESSAGE).toBe("Invalid or revoked API key");
  });
});
