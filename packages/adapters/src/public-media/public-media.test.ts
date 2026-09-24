import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PortError,
  PublicMediaUnavailableError,
  isPublicMediaKey,
} from "@fastgram/ports";
import { loadOrCreateSecretKey } from "./secret-key.js";
import {
  deriveSigningKey,
  signPublicMediaToken,
  verifyPublicMediaToken,
} from "./token.js";
import {
  TunnelPublicMediaUrls,
  normalizePublicBaseUrl,
} from "./tunnel-public-media-urls.js";

const SECRET = Buffer.alloc(32, 7);
const OTHER = Buffer.alloc(32, 9);
const NOW = 1_800_000_000;

describe("token de media pública", () => {
  const key = deriveSigningKey(SECRET);

  it("firma y verifica ida y vuelta", () => {
    const token = signPublicMediaToken(key, {
      objectKey: "media/c1/a.jpg",
      expiresAt: NOW + 60,
    });
    expect(verifyPublicMediaToken(key, token, NOW)).toEqual({
      ok: true,
      objectKey: "media/c1/a.jpg",
      expiresAt: NOW + 60,
    });
  });

  it("vencido ⇒ expired (también justo en el borde)", () => {
    const token = signPublicMediaToken(key, { objectKey: "media/a", expiresAt: NOW });
    expect(verifyPublicMediaToken(key, token, NOW)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("firmado con otra clave ⇒ bad_signature", () => {
    const token = signPublicMediaToken(deriveSigningKey(OTHER), {
      objectKey: "media/a",
      expiresAt: NOW + 60,
    });
    expect(verifyPublicMediaToken(key, token, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("payload alterado ⇒ bad_signature", () => {
    const token = signPublicMediaToken(key, {
      objectKey: "media/a",
      expiresAt: NOW + 60,
    });
    const [, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ k: "media/b", e: NOW + 60 })).toString(
      "base64url",
    );
    expect(verifyPublicMediaToken(key, `${forged}.${sig}`, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("firmado pero fuera de media/ y content/ ⇒ forbidden_key", () => {
    for (const objectKey of [
      "brand-snapshots/c1/raw.html",
      "media/../secrets",
      "media//x",
      "mediaX/a",
      "",
    ]) {
      const token = signPublicMediaToken(key, { objectKey, expiresAt: NOW + 60 });
      expect(verifyPublicMediaToken(key, token, NOW)).toEqual({
        ok: false,
        reason: "forbidden_key",
      });
    }
  });

  it("basura ⇒ malformed", () => {
    for (const token of ["", "abc", "a.b.c", "a!.b", "x".repeat(3000)]) {
      expect(verifyPublicMediaToken(key, token, NOW)).toMatchObject({ ok: false });
    }
    expect(verifyPublicMediaToken(key, "a.b.c", NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("la subclave no es la clave cruda (separación de dominio)", () => {
    expect(Buffer.compare(key, SECRET)).not.toBe(0);
    expect(() => deriveSigningKey(Buffer.alloc(16))).toThrow();
  });

  it("isPublicMediaKey acepta las claves reales del worker y la API", () => {
    expect(isPublicMediaKey("content/c1/k1/3/0")).toBe(true);
    expect(isPublicMediaKey("media/c1/normalized/m1/u.mp4")).toBe(true);
    expect(isPublicMediaKey("content/custom-video/c1/u.mp4")).toBe(true);
  });
});

describe("TunnelPublicMediaUrls", () => {
  it("sin FASTGRAM_PUBLIC_URL ⇒ public_media_unavailable", async () => {
    const urls = new TunnelPublicMediaUrls({
      publicBaseUrl: undefined,
      secretKey: SECRET,
    });
    const error = await urls.forObject("media/a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublicMediaUnavailableError);
    expect((error as PublicMediaUnavailableError).code).toBe("public_media_unavailable");
  });

  it("una base http no sirve (IG/TikTok exigen https)", () => {
    expect(normalizePublicBaseUrl("http://x.trycloudflare.com")).toBeNull();
    expect(normalizePublicBaseUrl("https://x.trycloudflare.com/")).toBe(
      "https://x.trycloudflare.com",
    );
    expect(normalizePublicBaseUrl("https://x.example.com/fg/?a=1")).toBeNull();
  });

  it("devuelve https://<túnel>/public-media/<token> que verifica con la misma clave", async () => {
    const urls = new TunnelPublicMediaUrls({
      publicBaseUrl: "https://abc.trycloudflare.com/",
      secretKey: SECRET,
      now: () => NOW * 1000,
    });
    const url = await urls.forObject("content/c1/k/1/0", { ttlSeconds: 120 });
    const prefix = "https://abc.trycloudflare.com/public-media/";
    expect(url.startsWith(prefix)).toBe(true);
    const result = verifyPublicMediaToken(
      deriveSigningKey(SECRET),
      url.slice(prefix.length),
      NOW,
    );
    expect(result).toEqual({
      ok: true,
      objectKey: "content/c1/k/1/0",
      expiresAt: NOW + 120,
    });
  });

  it("default 1 h; ttl fuera de rango y claves fuera de prefijo ⇒ bad_request", async () => {
    const urls = new TunnelPublicMediaUrls({
      publicBaseUrl: "https://abc.trycloudflare.com",
      secretKey: SECRET,
      now: () => NOW * 1000,
    });
    const url = await urls.forObject("media/a");
    const token = url.split("/public-media/")[1] ?? "";
    expect(verifyPublicMediaToken(deriveSigningKey(SECRET), token, NOW)).toMatchObject({
      expiresAt: NOW + 3600,
    });
    for (const call of [
      () => urls.forObject("media/a", { ttlSeconds: 0 }),
      () => urls.forObject("media/a", { ttlSeconds: 7 * 3600 }),
      () => urls.forObject("brand/a"),
    ]) {
      const e = await call().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(PortError);
      expect((e as PortError).code).toBe("bad_request");
    }
  });
});

describe("secret.key", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fg-secret-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("la crea con 32 bytes y 0600, y la segunda vez la lee igual", async () => {
    const env = { FASTGRAM_HOME: join(home, "nested") };
    const a = await loadOrCreateSecretKey(env);
    expect(a.byteLength).toBe(32);
    const st = await stat(join(home, "nested", "secret.key"));
    expect(st.mode & 0o777).toBe(0o600);
    const b = await loadOrCreateSecretKey(env);
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it("dos creaciones concurrentes terminan con la misma clave", async () => {
    const env = { FASTGRAM_HOME: home };
    const [a, b] = await Promise.all([
      loadOrCreateSecretKey(env),
      loadOrCreateSecretKey(env),
    ]);
    expect(Buffer.compare(a, b)).toBe(0);
    expect(Buffer.compare(a, await readFile(join(home, "secret.key")))).toBe(0);
  });

  it("reusa una existente en otro formato (texto base64) sin reescribirla", async () => {
    const text = Buffer.from(Buffer.alloc(32, 3).toString("base64") + "\n");
    await writeFile(join(home, "secret.key"), text, { mode: 0o600 });
    const k = await loadOrCreateSecretKey({ FASTGRAM_HOME: home });
    expect(Buffer.compare(k, text)).toBe(0);
  });

  it("una clave corta es un error, no se pisa", async () => {
    await writeFile(join(home, "secret.key"), "short", { mode: 0o600 });
    await expect(loadOrCreateSecretKey({ FASTGRAM_HOME: home })).rejects.toThrow();
  });
});
