/**
 * `P2-RENDER-009` — `FR-070`: toda URL de media debe pertenecer al Media Bank
 * del workspace o a la librería compartida; el audio SÓLO a la librería
 * compartida; lo demás se rechaza antes de iniciar el build.
 */
import { describe, expect, it } from "vitest";
import { RenderError } from "../errors.js";
import type { MediaReference } from "../domain/payload.js";
import {
  assertMediaReferenceAllowed,
  matchesPrefix,
  parsePrefix,
  parsePrefixList,
  signGrantBody,
  verifyGrant,
  type MediaPolicyConfig,
} from "./urlPolicy.js";

const SECRET = "un-secreto-de-al-menos-32-caracteres-x";
const NOW = 1_700_000_000_000;

function config(overrides: Partial<MediaPolicyConfig> = {}): MediaPolicyConfig {
  return {
    mediaPrefixes: parsePrefixList("https://cdn.example.com/media/ws-1/"),
    sharedPrefixes: parsePrefixList("https://library.example.com/audio/"),
    grantSecret: SECRET,
    requireGrant: false,
    now: () => NOW,
    ...overrides,
  };
}

function ref(url: string, role: MediaReference["role"] = "image"): MediaReference {
  return { url, role, path: ["x"] };
}

function expectRejected(fn: () => void, reason?: string): void {
  try {
    fn();
    throw new Error("se esperaba un rechazo");
  } catch (error) {
    expect(error).toBeInstanceOf(RenderError);
    const rendered = error as RenderError;
    expect(rendered.code).toBe("media_url_not_allowed");
    expect(rendered.status).toBe(400);
    if (reason !== undefined) expect(rendered.details["reason"]).toBe(reason);
  }
}

describe("denegación por defecto", () => {
  it("sin configuración y sin grant no entra ninguna URL", () => {
    const empty = config({ mediaPrefixes: [], sharedPrefixes: [], grantSecret: null });
    expectRejected(
      () =>
        assertMediaReferenceAllowed(
          ref("https://cdn.example.com/media/ws-1/a.jpg"),
          empty,
          null,
        ),
      "sin_politica_configurada",
    );
  });

  it("con requireGrant, un payload sin grant se rechaza aunque la config permita la URL", () => {
    expectRejected(
      () =>
        assertMediaReferenceAllowed(
          ref("https://cdn.example.com/media/ws-1/a.jpg"),
          config({ requireGrant: true }),
          null,
        ),
      "grant_requerido",
    );
  });
});

describe("prefijos", () => {
  it("acepta lo que está bajo el prefijo configurado", () => {
    expect(() =>
      assertMediaReferenceAllowed(
        ref("https://cdn.example.com/media/ws-1/nested/a.jpg"),
        config(),
        null,
      ),
    ).not.toThrow();
  });

  it("rechaza una URL arbitraria", () => {
    expectRejected(
      () =>
        assertMediaReferenceAllowed(
          ref("https://evil.example.net/a.jpg"),
          config(),
          null,
        ),
      "fuera_de_config",
    );
  });

  it("rechaza otro workspace del mismo CDN", () => {
    expectRejected(
      () =>
        assertMediaReferenceAllowed(
          ref("https://cdn.example.com/media/ws-2/a.jpg"),
          config(),
          null,
        ),
      "fuera_de_config",
    );
  });

  it("no confunde ws-1 con ws-10 (el match respeta el límite de segmento)", () => {
    const prefix = parsePrefix("https://cdn.example.com/media/ws-1");
    expect(
      matchesPrefix(new URL("https://cdn.example.com/media/ws-1/a.jpg"), prefix),
    ).toBe(true);
    expect(
      matchesPrefix(new URL("https://cdn.example.com/media/ws-10/a.jpg"), prefix),
    ).toBe(false);
  });

  it("el protocolo forma parte del prefijo: http no pasa por https", () => {
    expectRejected(
      () =>
        assertMediaReferenceAllowed(
          ref("http://cdn.example.com/media/ws-1/a.jpg"),
          config(),
          null,
        ),
      "fuera_de_config",
    );
  });

  it("rechaza URLs con credenciales", () => {
    expectRejected(
      () =>
        assertMediaReferenceAllowed(
          ref("https://user:pass@cdn.example.com/media/ws-1/a.jpg"),
          config(),
          null,
        ),
      "credenciales_en_url",
    );
  });
});

describe("audio: sólo librería compartida (FR-070, explícito)", () => {
  it("acepta audio de la librería compartida", () => {
    expect(() =>
      assertMediaReferenceAllowed(
        ref("https://library.example.com/audio/track.m4a", "audio"),
        config(),
        null,
      ),
    ).not.toThrow();
  });

  it("rechaza audio del Media Bank del workspace", () => {
    expectRejected(
      () =>
        assertMediaReferenceAllowed(
          ref("https://cdn.example.com/media/ws-1/track.m4a", "audio"),
          config(),
          null,
        ),
      "audio_fuera_de_libreria",
    );
  });

  it("una imagen SÍ puede venir de la librería compartida (Theme Images, FR-071)", () => {
    expect(() =>
      assertMediaReferenceAllowed(
        ref("https://library.example.com/audio/theme.jpg", "image"),
        config(),
        null,
      ),
    ).not.toThrow();
  });
});

describe("grant firmado", () => {
  const body = {
    companyId: "ws-1",
    issuedAt: NOW - 1000,
    expiresAt: NOW + 60_000,
    mediaPrefixes: ["https://cdn.example.com/media/ws-1/"],
    sharedPrefixes: ["https://library.example.com/audio/"],
  };

  it("verifica una firma válida", () => {
    const grant = verifyGrant({ body, signature: signGrantBody(body, SECRET) }, config());
    expect(grant.companyId).toBe("ws-1");
  });

  it("rechaza una firma inválida", () => {
    expect(() => verifyGrant({ body, signature: "0".repeat(64) }, config())).toThrowError(
      RenderError,
    );
  });

  it("rechaza un grant vencido", () => {
    const expired = { ...body, expiresAt: NOW - 1 };
    try {
      verifyGrant({ body: expired, signature: signGrantBody(expired, SECRET) }, config());
      throw new Error("se esperaba un rechazo");
    } catch (error) {
      expect((error as RenderError).code).toBe("media_grant_invalid");
    }
  });

  it("la firma no depende del orden de los arrays", () => {
    const a = {
      ...body,
      mediaPrefixes: ["https://a.example.com/", "https://b.example.com/"],
    };
    const b = {
      ...body,
      mediaPrefixes: ["https://b.example.com/", "https://a.example.com/"],
    };
    expect(signGrantBody(a, SECRET)).toBe(signGrantBody(b, SECRET));
  });

  it("config y grant se aplican como intersección, no como unión", () => {
    const grantBody = { ...body, mediaPrefixes: ["https://otro-cdn.example.com/media/"] };
    const grant = verifyGrant(
      { body: grantBody, signature: signGrantBody(grantBody, SECRET) },
      config(),
    );
    // Permitida por el grant pero fuera de la configuración del despliegue.
    expectRejected(
      () =>
        assertMediaReferenceAllowed(
          ref("https://otro-cdn.example.com/media/a.jpg"),
          config(),
          grant,
        ),
      "fuera_de_config",
    );
    // Permitida por la configuración pero fuera del grant del workspace.
    expectRejected(
      () =>
        assertMediaReferenceAllowed(
          ref("https://cdn.example.com/media/ws-1/a.jpg"),
          config(),
          grant,
        ),
      "fuera_del_grant",
    );
  });

  it("si el grant trae lista explícita de URLs, una URL no listada se rechaza", () => {
    const withUrls = { ...body, urls: ["https://cdn.example.com/media/ws-1/a.jpg"] };
    const grant = verifyGrant(
      { body: withUrls, signature: signGrantBody(withUrls, SECRET) },
      config(),
    );
    expect(() =>
      assertMediaReferenceAllowed(
        ref("https://cdn.example.com/media/ws-1/a.jpg"),
        config(),
        grant,
      ),
    ).not.toThrow();
    expectRejected(
      () =>
        assertMediaReferenceAllowed(
          ref("https://cdn.example.com/media/ws-1/b.jpg"),
          config(),
          grant,
        ),
      "url_no_listada_en_grant",
    );
  });

  it("un despliegue sin secreto no acepta grants", () => {
    expect(() =>
      verifyGrant(
        { body, signature: signGrantBody(body, SECRET) },
        config({ grantSecret: null }),
      ),
    ).toThrowError(RenderError);
  });
});
