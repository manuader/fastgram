/**
 * Superficie HTTP. Lo que importa acá es que ningún error crudo llegue al
 * cliente y que el código estable viaje con el status correcto.
 */
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NullCacheStore } from "../cache/store.js";
import { parsePrefixList, type MediaPolicyConfig } from "../media/urlPolicy.js";
import { buildServer } from "./server.js";

function policy(): MediaPolicyConfig {
  return {
    mediaPrefixes: parsePrefixList("https://cdn.test.local/media/ws-1/"),
    sharedPrefixes: parsePrefixList("https://library.test.local/audio/"),
    grantSecret: null,
    requireGrant: false,
    now: Date.now,
  };
}

function server() {
  return buildServer({
    logger: false,
    engine: {
      cache: new NullCacheStore(path.join(tmpdir(), "fastgram-server-test")),
      policy: policy(),
      fonts: { fontDir: null, strict: false },
      resolveMedia: async () => {
        throw new Error("no debería llegar a resolver media en estos tests");
      },
      normalizeInputs: false,
      allowUntonemappedHdr: false,
    },
  });
}

describe("rutas", () => {
  it("/health responde ok", async () => {
    const app = server();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "render" });
    await app.close();
  });

  it("/capabilities reporta la estrategia de texto y las fuentes que faltan", async () => {
    const app = server();
    const response = await app.inject({ method: "GET", url: "/capabilities" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      textStrategy: string;
      fonts: { families: unknown[]; requiredFiles: string[] };
      ffmpeg: { hasDrawtext: boolean };
    };
    expect(body.textStrategy).toBe("sharp-overlay");
    expect(body.fonts.families).toHaveLength(12);
    expect(body.fonts.requiredFiles).toHaveLength(42);
    expect(typeof body.ffmpeg.hasDrawtext).toBe("boolean");
    await app.close();
  }, 30_000);

  it("un payload inválido devuelve 400 bad_request con las rutas de los errores", async () => {
    const app = server();
    const response = await app.inject({
      method: "POST",
      url: "/render",
      payload: { payload: { type: "wall-of-text" } },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as {
      error: { code: string; details: { issues: unknown[] } };
    };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.details.issues.length).toBeGreaterThan(0);
    await app.close();
  });

  it("una URL ajena al workspace devuelve 400 media_url_not_allowed", async () => {
    const app = server();
    const response = await app.inject({
      method: "POST",
      url: "/render",
      payload: {
        payload: {
          type: "wall-of-text",
          canvas: { width: 540, height: 960 },
          video: { url: "https://evil.test.local/v.mp4" },
          audio: { url: "https://library.test.local/audio/a.m4a" },
          texts: [
            {
              id: "t1",
              text: "x",
              position: { x: 50, y: 50 },
              widthPercent: 50,
              font: { family: "inter", weight: 400, size: 20 },
            },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      "media_url_not_allowed",
    );
    await app.close();
  });

  it("el audio fuera de la librería compartida se rechaza", async () => {
    const app = server();
    const response = await app.inject({
      method: "POST",
      url: "/render",
      payload: {
        payload: {
          type: "wall-of-text",
          canvas: { width: 540, height: 960 },
          video: { url: "https://cdn.test.local/media/ws-1/v.mp4" },
          audio: { url: "https://cdn.test.local/media/ws-1/a.m4a" },
          texts: [
            {
              id: "t1",
              text: "x",
              position: { x: 50, y: 50 },
              widthPercent: 50,
              font: { family: "inter", weight: 400, size: 20 },
            },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as {
      error: { code: string; details: { reason: string } };
    };
    expect(body.error.code).toBe("media_url_not_allowed");
    expect(body.error.details.reason).toBe("audio_fuera_de_libreria");
    await app.close();
  });

  it("la respuesta de error nunca trae stack ni cause", async () => {
    const app = server();
    const response = await app.inject({
      method: "POST",
      url: "/render",
      payload: { payload: { type: "desconocido" } },
    });
    const raw = response.body;
    expect(raw).not.toContain("stack");
    expect(raw).not.toContain("cause");
    await app.close();
  });
});
