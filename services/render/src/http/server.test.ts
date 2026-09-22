/**
 * Superficie HTTP. Lo que importa acá es que ningún error crudo llegue al
 * cliente y que el código estable viaje con el status correcto.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCacheStore, NullCacheStore } from "../cache/store.js";
import { parsePrefixList, type MediaPolicyConfig } from "../media/urlPolicy.js";
import { artifactHref, parseArtifactName } from "./artifacts.js";
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

// ── `GET /artifact/…` (`P2-RENDER-015`) ──────────────────────────────────────

/** Clave con la forma que emite el motor: sha256 hex. */
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/**
 * Cache real sembrada a mano, y un archivo señuelo FUERA del root. El señuelo es
 * lo que hace útil el test de traversal: sin él, "404" no distingue entre
 * "rechazado" y "no lo encontró de casualidad".
 */
async function seededServer(): Promise<{
  app: ReturnType<typeof buildServer>;
  bait: string;
  baitContent: string;
}> {
  const parent = await mkdtemp(path.join(tmpdir(), "fastgram-artifact-test-"));
  temporaryDirs.push(parent);
  const cacheDir = path.join(parent, "cache");
  const baitContent = "SECRETO-FUERA-DE-LA-CACHE";
  const bait = path.join(parent, "bait.txt");
  await writeFile(bait, baitContent);

  const cache = new FileCacheStore(cacheDir);
  await cache.putBuffer(KEY_A, "mp4", Buffer.from("mp4-bytes-de-prueba"));
  await cache.putBuffer(`${KEY_B}-3`, "jpg", Buffer.from("jpeg-bytes-de-prueba"));
  // Un 0 bytes es basura de una corrida interrumpida: la cache ya lo ignora.
  await cache.putBuffer(`${KEY_B}-4`, "jpg", Buffer.alloc(0));

  const app = buildServer({
    logger: false,
    engine: {
      cache,
      policy: policy(),
      fonts: { fontDir: null, strict: false },
      resolveMedia: async () => {
        throw new Error("no debería resolver media en estos tests");
      },
      normalizeInputs: false,
      allowUntonemappedHdr: false,
    },
  });
  return { app, bait, baitContent };
}

describe("GET /artifact — recuperar los bytes", () => {
  it("devuelve 200 con los bytes, el content-type y el content-length", async () => {
    const { app } = await seededServer();
    const response = await app.inject({
      method: "GET",
      url: artifactHref(KEY_A, "mp4"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("video/mp4");
    expect(response.headers["content-length"]).toBe(String("mp4-bytes-de-prueba".length));
    expect(response.rawPayload.equals(Buffer.from("mp4-bytes-de-prueba"))).toBe(true);
    await app.close();
  });

  it("un slide del slideshow sale como image/jpeg", async () => {
    const { app } = await seededServer();
    const response = await app.inject({
      method: "GET",
      url: artifactHref(`${KEY_B}-3`, "jpg"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.rawPayload.toString()).toBe("jpeg-bytes-de-prueba");
    await app.close();
  });

  it("una clave bien formada que no está en cache devuelve 404 con el error del servicio", async () => {
    const { app } = await seededServer();
    const response = await app.inject({
      method: "GET",
      url: artifactHref("c".repeat(64), "mp4"),
    });
    expect(response.statusCode).toBe(404);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("artifact_not_found");
    expect(typeof body.error.message).toBe("string");
    await app.close();
  });

  it("un artefacto de 0 bytes es basura, no un artefacto: 404", async () => {
    const { app } = await seededServer();
    const response = await app.inject({
      method: "GET",
      url: artifactHref(`${KEY_B}-4`, "jpg"),
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  /**
   * El `href` lo genera el servidor pero el `GET` lo recibe de la red. Lo que se
   * mide no es sólo el status: es que el contenido del señuelo NO aparezca en
   * ninguna respuesta.
   */
  it("ningún intento de traversal sirve un archivo de fuera de la cache", async () => {
    const { app, baitContent } = await seededServer();
    const attempts = [
      "/artifact/../bait.txt",
      "/artifact/../../bait.txt",
      "/artifact/%2e%2e%2fbait.txt",
      "/artifact/%2e%2e%2f%2e%2e%2fbait.txt",
      `/artifact/${"a".repeat(64)}%2f..%2f..%2fbait.txt`,
      "/artifact/....//bait.txt",
      "/artifact/%252e%252e%252fbait.txt",
      "/artifact/a/b/../../bait.txt",
      "/artifact/bait.txt",
      "/artifact//etc/passwd",
      "/artifact/%00",
      `/artifact/${"a".repeat(64)}.mp4/../../bait.txt`,
    ];
    for (const url of attempts) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).not.toBe(200);
      expect(response.body, url).not.toContain(baitContent);
    }
    await app.close();
  });

  /**
   * Mide la premisa sobre la que se apoya toda la defensa de `artifacts.ts`:
   * que Fastify **decodifica** el parámetro antes de que la validación lo vea.
   * Si no lo hiciera, validar post-decodificación no probaría nada y habría que
   * validar la forma cruda. `%61` es `a`: con la clave `aaa…` sembrada, este
   * `GET` sólo puede dar 200 si la decodificación pasó primero.
   *
   * No es una puerta trasera: lo que se valida es exactamente lo que después se
   * usa para tocar el disco.
   */
  it("la validación corre sobre el parámetro YA decodificado", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "fastgram-artifact-decode-"));
    temporaryDirs.push(parent);
    const cache = new FileCacheStore(path.join(parent, "cache"));
    const key = "a".repeat(64);
    await cache.putBuffer(key, "mp4", Buffer.from("x"));
    const app = buildServer({
      logger: false,
      engine: {
        cache,
        policy: policy(),
        fonts: { fontDir: null, strict: false },
        resolveMedia: async () => {
          throw new Error("no debería resolver media en estos tests");
        },
        normalizeInputs: false,
        allowUntonemappedHdr: false,
      },
    });
    const encoded = await app.inject({
      method: "GET",
      url: `/artifact/%61${"a".repeat(63)}.mp4`,
    });
    expect(encoded.statusCode).toBe(200);
    expect(encoded.headers["content-type"]).toBe("video/mp4");
    await app.close();
  });

  it("rechaza extensiones y formas de clave que el motor no emite", async () => {
    const { app } = await seededServer();
    const rejected = [
      `/artifact/${"a".repeat(64)}.txt`,
      `/artifact/${"a".repeat(64)}.MP4`,
      `/artifact/${"A".repeat(64)}.mp4`, // hex en mayúsculas: no es lo que emitimos
      `/artifact/${"a".repeat(63)}.mp4`,
      `/artifact/${"a".repeat(65)}.mp4`,
      `/artifact/${"a".repeat(64)}-999999.jpg`,
      `/artifact/${"a".repeat(64)}-.jpg`,
      `/artifact/${"a".repeat(64)}`,
      "/artifact/",
    ];
    for (const url of rejected) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
    }
    await app.close();
  });

  it("el href que se emite es el que se puede parsear de vuelta", () => {
    const parsed = parseArtifactName(
      artifactHref(KEY_A, "mp4").slice("/artifact/".length),
    );
    expect(parsed).toEqual({ key: KEY_A, extension: "mp4", mediaType: "video/mp4" });
    const slide = parseArtifactName(
      artifactHref(`${KEY_B}-19`, "jpg").slice("/artifact/".length),
    );
    expect(slide?.key).toBe(`${KEY_B}-19`);
    expect(slide?.mediaType).toBe("image/jpeg");
  });
});
