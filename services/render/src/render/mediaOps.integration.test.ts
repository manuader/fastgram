/**
 * `P2-RENDER-016` — `normalize`, `probe` y `thumbnail` contra ffmpeg de verdad,
 * por la superficie HTTP, sobre archivos generados con lavfi.
 *
 * Lo que este archivo prueba y ningún unitario puede:
 *
 *  · que `NFR-014` de verdad convierte un MOV en un MP4 **y que la salida tiene
 *    el `moov` adelante**. `P2-RENDER-013` estaba marcada parcial justamente
 *    porque MOV→MP4 y faststart estaban escritos y nunca habían corrido sobre
 *    un archivo;
 *  · que `isFastStart` distingue un archivo con `+faststart` de uno sin él —con
 *    los dos archivos al lado, que es lo único que hace útil la medición—;
 *  · que el HDR **falla cerrado** en un build sin `zscale`, que es el de esta
 *    máquina;
 *  · que el `href` de los endpoints nuevos se baja por el mismo `GET /artifact`
 *    y que los bytes son un archivo que ffprobe y sharp aceptan.
 *
 * Sin ffmpeg el bloque se saltea: es integración, no unidad.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileCacheStore } from "../cache/store.js";
import { FFMPEG_BIN, probeCapabilities } from "../ffmpeg/capabilities.js";
import { readTopLevelAtoms } from "../ffmpeg/faststart.js";
import { probeMedia } from "../ffmpeg/probe.js";
import { buildServer } from "../http/server.js";
import { parseArtifactName } from "../http/artifacts.js";
import { parsePrefixList, type MediaPolicyConfig } from "../media/urlPolicy.js";

const execFileAsync = promisify(execFile);
const caps = await probeCapabilities();
const suite = caps.available ? describe : describe.skip;

const MEDIA_PREFIX = "https://cdn.test.local/media/ws-1/";
const LIBRARY_PREFIX = "https://library.test.local/audio/";

let workDir = "";
const files = new Map<string, string>();

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync(FFMPEG_BIN, [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...args,
  ]);
}

beforeAll(async () => {
  if (!caps.available) return;
  workDir = await mkdtemp(path.join(tmpdir(), "fastgram-mediaops-it-"));

  // Un MOV de verdad: mismo demuxer que un MP4, `major_brand` "qt  ", y sin
  // faststart (ftyp, wide, mdat, moov).
  const mov = path.join(workDir, "real.mov");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=25:duration=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    "-f",
    "mov",
    mov,
  ]);

  // MP4 sin faststart (ftyp, free, mdat, moov) y sin audio.
  const plain = path.join(workDir, "plain.mp4");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=25:duration=3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    plain,
  ]);

  // El MISMO contenido con el moov adelante. Es el par que hace medible a
  // `isFastStart`: sin este archivo, un `false` constante también "pasaría".
  const fast = path.join(workDir, "fast.mp4");
  await ffmpeg(["-i", plain, "-c", "copy", "-movflags", "+faststart", fast]);

  // PQ de verdad. Las banderas `-color_trc`/`-color_primaries` NO se pegan al
  // stream con libx264 en ffmpeg 9.0.1 (verificado: ffprobe devuelve null);
  // `-x264opts` sí.
  const hdr = path.join(workDir, "hdr.mp4");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=25:duration=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p10le",
    "-x264opts",
    "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
    hdr,
  ]);

  const png = path.join(workDir, "shot.png");
  await writeFile(
    png,
    await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: { r: 10, g: 120, b: 60 },
      },
    })
      .png()
      .toBuffer(),
  );

  // El JPEG es el caso que motiva `isStillImage`: ffprobe le da
  // `format_name: image2` y `duration: 0.040000`, o sea que se ve como un video
  // de 40 ms. Con un PNG solo, el test no distinguiría —un PNG no declara
  // duración— y la regla podría borrarse sin que nada se ponga rojo.
  const jpeg = path.join(workDir, "shot.jpg");
  await ffmpeg(["-i", png, "-frames:v", "1", jpeg]);

  files.set(`${MEDIA_PREFIX}real.mov`, mov);
  files.set(`${MEDIA_PREFIX}shot.jpg`, jpeg);
  files.set(`${MEDIA_PREFIX}plain.mp4`, plain);
  files.set(`${MEDIA_PREFIX}fast.mp4`, fast);
  files.set(`${MEDIA_PREFIX}hdr.mp4`, hdr);
  files.set(`${MEDIA_PREFIX}shot.png`, png);
}, 180_000);

afterAll(async () => {
  if (workDir !== "") await rm(workDir, { recursive: true, force: true });
});

function policy(): MediaPolicyConfig {
  return {
    mediaPrefixes: parsePrefixList(MEDIA_PREFIX),
    sharedPrefixes: parsePrefixList(LIBRARY_PREFIX),
    grantSecret: null,
    requireGrant: false,
    now: Date.now,
  };
}

let cacheCounter = 0;

function server() {
  cacheCounter += 1;
  return buildServer({
    logger: false,
    engine: {
      cache: new FileCacheStore(path.join(workDir, `cache-${String(cacheCounter)}`)),
      policy: policy(),
      fonts: { fontDir: null, strict: false },
      resolveMedia: async (url) => {
        const local = files.get(url);
        if (local === undefined) throw new Error(`url no mapeada en el test: ${url}`);
        return local;
      },
      normalizeInputs: true,
      allowUntonemappedHdr: false,
    },
  });
}

interface ErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> };
}

suite("POST /probe — ERR-P11", () => {
  it("un MOV se reporta como video/quicktime, con duración y audio", async () => {
    const app = server();
    const response = await app.inject({
      method: "POST",
      url: "/probe",
      payload: { url: `${MEDIA_PREFIX}real.mov` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    // El discriminador es el `major_brand`: el `format_name` es idéntico al de
    // un MP4.
    expect(body["contentType"]).toBe("video/quicktime");
    expect(body["width"]).toBe(320);
    expect(body["height"]).toBe(240);
    expect(body["hasAudio"]).toBe(true);
    expect(body["isHdr"]).toBe(false);
    expect(body["durationSeconds"]).toBeCloseTo(2, 1);
    await app.close();
  }, 120_000);

  /**
   * El par que hace medible el campo. Los dos archivos tienen el mismo
   * contenido y sólo se diferencian en dónde quedó el `moov`.
   */
  it("distingue un MP4 con faststart de uno sin faststart", async () => {
    const app = server();
    const slow = await app.inject({
      method: "POST",
      url: "/probe",
      payload: { url: `${MEDIA_PREFIX}plain.mp4` },
    });
    const fast = await app.inject({
      method: "POST",
      url: "/probe",
      payload: { url: `${MEDIA_PREFIX}fast.mp4` },
    });
    expect((slow.json() as Record<string, unknown>)["isFastStart"]).toBe(false);
    expect((fast.json() as Record<string, unknown>)["isFastStart"]).toBe(true);
    expect((slow.json() as Record<string, unknown>)["contentType"]).toBe("video/mp4");
    expect((slow.json() as Record<string, unknown>)["hasAudio"]).toBe(false);
    await app.close();
  }, 120_000);

  /**
   * Un JPEG declara `duration: 0.04` y un PNG no declara ninguna: la duración
   * de una imagen no significa nada y por eso se omite en vez de inventarla.
   */
  it("una imagen no reporta duración, ni siquiera la que ffprobe le inventa", async () => {
    const app = server();
    const png = (
      await app.inject({
        method: "POST",
        url: "/probe",
        payload: { url: `${MEDIA_PREFIX}shot.png` },
      })
    ).json() as Record<string, unknown>;
    expect(png["contentType"]).toBe("image/png");
    expect(png["width"]).toBe(800);
    expect(png["height"]).toBe(600);
    expect(png["hasAudio"]).toBe(false);
    expect(png).not.toHaveProperty("durationSeconds");

    // El caso que de verdad separa una imagen de un video: ffprobe le asigna
    // al JPEG `duration: 0.040000`. Reportarla como duración del medio sería
    // decir que una foto dura 40 ms.
    const source = await probeMedia(files.get(`${MEDIA_PREFIX}shot.jpg`) ?? "");
    expect(source.durationSeconds).not.toBeNull();

    const jpeg = (
      await app.inject({
        method: "POST",
        url: "/probe",
        payload: { url: `${MEDIA_PREFIX}shot.jpg` },
      })
    ).json() as Record<string, unknown>;
    expect(jpeg["contentType"]).toBe("image/jpeg");
    expect(jpeg).not.toHaveProperty("durationSeconds");
    await app.close();
  }, 120_000);

  it("un medio PQ se reporta como HDR", async () => {
    const app = server();
    const response = await app.inject({
      method: "POST",
      url: "/probe",
      payload: { url: `${MEDIA_PREFIX}hdr.mp4` },
    });
    expect((response.json() as Record<string, unknown>)["isHdr"]).toBe(true);
    await app.close();
  }, 120_000);

  it("un medio ilegible es media_probe_failed, sin una línea de ffprobe afuera", async () => {
    const broken = path.join(workDir, "broken.mp4");
    await writeFile(broken, Buffer.from("esto no es un mp4"));
    files.set(`${MEDIA_PREFIX}broken.mp4`, broken);

    const app = server();
    const response = await app.inject({
      method: "POST",
      url: "/probe",
      payload: { url: `${MEDIA_PREFIX}broken.mp4` },
    });
    // `ERR-P11` sale de acá: «We couldn't read this video's details».
    expect(response.statusCode).toBe(502);
    const body = response.json() as ErrorBody;
    expect(body.error.code).toBe("media_probe_failed");
    // Regla del repo: nada del stderr crudo, ni la ruta local del contenedor.
    expect(response.body).not.toContain("Invalid data found");
    expect(response.body).not.toContain(workDir);
    await app.close();
  }, 120_000);
});

suite("POST /normalize — NFR-014 / P2-RENDER-013", () => {
  /**
   * **Esto es lo que `P2-RENDER-013` tenía escrito y nunca había corrido.**
   */
  it("un MOV sale MP4, con el moov adelante, y se baja por el href", async () => {
    const app = server();
    const source = await readTopLevelAtoms(files.get(`${MEDIA_PREFIX}real.mov`) ?? "");
    // La entrada NO tiene faststart: si lo tuviera, el test no probaría nada.
    expect(source.indexOf("mdat")).toBeLessThan(source.indexOf("moov"));

    const response = await app.inject({
      method: "POST",
      url: "/normalize",
      payload: { url: `${MEDIA_PREFIX}real.mov`, targetContentType: "video/mp4" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown> & {
      href: string;
      normalization: Record<string, unknown>;
    };

    expect(body["contentType"]).toBe("video/mp4");
    expect(body["width"]).toBe(320);
    expect(body["height"]).toBe(240);
    expect(body["sizeBytes"]).toBeGreaterThan(0);
    expect(body["durationSeconds"]).toBeCloseTo(2, 1);
    expect(body.normalization["needsRemux"]).toBe(true);
    expect(body.normalization["toneMapping"]).toBe("not-needed");
    // El esquema de claves no cambió: el href de un endpoint nuevo pasa por la
    // misma validación que el de `/render`.
    expect(parseArtifactName(body.href.slice("/artifact/".length))).not.toBeNull();

    const download = await app.inject({ method: "GET", url: body.href });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("video/mp4");
    expect(download.rawPayload.byteLength).toBe(body["sizeBytes"]);

    const saved = path.join(workDir, "normalized-download.mp4");
    await writeFile(saved, download.rawPayload);
    const info = await probeMedia(saved);
    // Ya no es QuickTime.
    expect(info.majorBrand).not.toBe("qt  ");
    expect(info.videoCodec).toBe("h264");
    // `+faststart` literal de `NFR-014`, medido sobre el archivo que salió.
    const atoms = await readTopLevelAtoms(saved);
    expect(atoms.indexOf("moov")).toBeLessThan(atoms.indexOf("mdat"));
    await app.close();
  }, 180_000);

  it("el segundo pedido acierta la cache y devuelve el mismo href", async () => {
    const app = server();
    const payload = {
      url: `${MEDIA_PREFIX}plain.mp4`,
      targetContentType: "video/mp4",
    };
    const first = (
      await app.inject({ method: "POST", url: "/normalize", payload })
    ).json() as Record<string, unknown>;
    const second = (
      await app.inject({ method: "POST", url: "/normalize", payload })
    ).json() as Record<string, unknown>;
    expect(first["cache"]).toBe("miss");
    expect(second["cache"]).toBe("hit");
    expect(second["href"]).toBe(first["href"]);
    expect(second["sizeBytes"]).toBe(first["sizeBytes"]);
    // En un hit no hubo corrida: el servicio no inventa qué se hizo la primera
    // vez. `cache: "hit"` es todo lo que sabe.
    expect(first).toHaveProperty("normalization");
    expect(second).not.toHaveProperty("normalization");
    await app.close();
  }, 180_000);

  it("un destino que este servicio no produce es bad_request, no un MP4 igual", async () => {
    const app = server();
    const response = await app.inject({
      method: "POST",
      url: "/normalize",
      payload: { url: `${MEDIA_PREFIX}plain.mp4`, targetContentType: "video/webm" },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as ErrorBody;
    expect(body.error.code).toBe("bad_request");
    expect(body.error.details["supported"]).toEqual(["video/mp4"]);
    await app.close();
  }, 120_000);

  it("acepta el content type con parámetros, que es como viaja en un header", async () => {
    const app = server();
    const response = await app.inject({
      method: "POST",
      url: "/normalize",
      payload: {
        url: `${MEDIA_PREFIX}plain.mp4`,
        targetContentType: 'VIDEO/MP4; codecs="avc1.640028"',
      },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  }, 180_000);

  /**
   * En un build sin `zscale` no hay tone mapping posible. El servicio falla
   * cerrado en vez de aplicar una conversión que arruina los colores y decir que
   * normalizó. En un build que sí lo traiga, el mismo pedido tiene que salir
   * bien: la condición es de la máquina, no del test.
   */
  it("HDR sin zscale falla cerrado y dice qué falta", async () => {
    const app = server();
    const response = await app.inject({
      method: "POST",
      url: "/normalize",
      payload: { url: `${MEDIA_PREFIX}hdr.mp4`, targetContentType: "video/mp4" },
    });
    if (caps.hasZscale && caps.hasTonemap) {
      expect(response.statusCode).toBe(200);
      expect((response.json() as Record<string, unknown>)["warnings"]).toEqual([]);
      await app.close();
      return;
    }
    expect(response.statusCode).toBe(500);
    const body = response.json() as ErrorBody;
    expect(body.error.code).toBe("render_capability_missing");
    expect(body.error.details["missing"]).toEqual(["zscale"]);
    expect(body.error.details["colorTransfer"]).toBe("smpte2084");
    // Regla del repo: ni una línea de stderr de ffmpeg hacia afuera.
    expect(response.body).not.toContain("libx264");
    expect(response.body).not.toContain("cause");
    await app.close();
  }, 180_000);
});

suite("POST /thumbnail — IMPL §5", () => {
  it("devuelve un JPEG del tamaño pedido, que sharp puede abrir", async () => {
    const app = server();
    const response = await app.inject({
      method: "POST",
      url: "/thumbnail",
      payload: { url: `${MEDIA_PREFIX}plain.mp4`, maxWidth: 160, atSeconds: 1 },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown> & { href: string };
    expect(body["contentType"]).toBe("image/jpeg");
    expect(body["width"]).toBe(160);
    expect(body["height"]).toBe(90);

    const download = await app.inject({ method: "GET", url: body.href });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("image/jpeg");
    // Lo que se declara es lo que salió: se mide el archivo, no se confía.
    const meta = await sharp(download.rawPayload).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(160);
    expect(meta.height).toBe(90);
    expect(download.rawPayload.byteLength).toBe(body["sizeBytes"]);
    // «Nunca servir el master para un preview»: el preview pesa una fracción.
    const master = await stat(files.get(`${MEDIA_PREFIX}plain.mp4`) ?? "");
    expect(download.rawPayload.byteLength).toBeLessThan(master.size);
    await app.close();
  }, 180_000);

  it("una imagen también tiene preview, y no se agranda", async () => {
    const app = server();
    const response = await app.inject({
      method: "POST",
      url: "/thumbnail",
      payload: { url: `${MEDIA_PREFIX}shot.png`, maxWidth: 4000 },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    // `maxWidth` es techo: la fuente de 800 px no se estira a 4000.
    expect(body["width"]).toBe(800);
    expect(body["height"]).toBe(600);
    await app.close();
  }, 180_000);

  it("un segundo más allá del final devuelve un cuadro igual, con aviso", async () => {
    const app = server();
    const response = await app.inject({
      method: "POST",
      url: "/thumbnail",
      payload: { url: `${MEDIA_PREFIX}plain.mp4`, maxWidth: 120, atSeconds: 999 },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown> & { warnings: string[] };
    expect(body.warnings.join(" ")).toContain("más allá del final");
    expect(body["sizeBytes"]).toBeGreaterThan(0);
    await app.close();
  }, 180_000);

  it("el segundo pedido acierta la cache", async () => {
    const app = server();
    const payload = { url: `${MEDIA_PREFIX}plain.mp4`, maxWidth: 200 };
    const first = (
      await app.inject({ method: "POST", url: "/thumbnail", payload })
    ).json() as Record<string, unknown>;
    const second = (
      await app.inject({ method: "POST", url: "/thumbnail", payload })
    ).json() as Record<string, unknown>;
    expect(first["cache"]).toBe("miss");
    expect(second["cache"]).toBe("hit");
    expect(second["href"]).toBe(first["href"]);
    await app.close();
  }, 180_000);

  it("el href no expone la clave ni la extensión como campos propios", async () => {
    const app = server();
    const response = await app.inject({
      method: "POST",
      url: "/thumbnail",
      payload: { url: `${MEDIA_PREFIX}plain.mp4`, maxWidth: 100 },
    });
    const body = response.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty("cacheKey");
    expect(body).not.toHaveProperty("extension");
    expect(body).not.toHaveProperty("path");
    await app.close();
  }, 180_000);
});

/**
 * Una por ruta, no una sola de muestra: son tres puertas nuevas por las que
 * entra una URL, y que una esté cerrada no dice nada de las otras dos.
 * `RENDER_REQUIRE_GRANT=true` es el default del producto y tiene que valer para
 * las cuatro operaciones, no sólo para `/render`.
 */
suite("la política de URLs vale para las tres rutas nuevas", () => {
  const foreign = "https://evil.test.local/v.mp4";
  const cases: readonly {
    readonly route: string;
    readonly payload: Record<string, unknown>;
  }[] = [
    { route: "/probe", payload: { url: foreign } },
    {
      route: "/normalize",
      payload: { url: foreign, targetContentType: "video/mp4" },
    },
    { route: "/thumbnail", payload: { url: foreign, maxWidth: 200 } },
  ];

  for (const testCase of cases) {
    it(`${testCase.route} rechaza una URL ajena al workspace`, async () => {
      const app = server();
      const response = await app.inject({
        method: "POST",
        url: testCase.route,
        payload: testCase.payload,
      });
      expect(response.statusCode).toBe(400);
      expect((response.json() as ErrorBody).error.code).toBe("media_url_not_allowed");
      await app.close();
    }, 120_000);
  }

  it("el audio de la librería compartida NO es una fuente válida de preview", async () => {
    // El rol con el que estas rutas consultan la política es `video`, así que
    // un prefijo de librería compartida las acepta igual que `/render` acepta
    // una imagen de ahí. Lo que se mide es que la política corre: una URL
    // fuera de TODO prefijo no entra por ninguna de las tres.
    const app = server();
    const response = await app.inject({
      method: "POST",
      url: "/thumbnail",
      payload: { url: "https://otra.test.local/audio/a.m4a", maxWidth: 100 },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  }, 120_000);
});

suite("POST /render — el canvas impar", () => {
  /**
   * Lo medido por el adaptador: `1081×1921` moría adentro de ffmpeg con exit
   * 187 después de descargar y escalar. Ahora se rechaza en la validación, sin
   * tocar red ni disco, y con un 400 que el adaptador NO reintenta.
   */
  it("1081×1921 es 400 bad_request y no llega a resolver media", async () => {
    let resolved = 0;
    const app = buildServer({
      logger: false,
      engine: {
        cache: new FileCacheStore(path.join(workDir, "cache-odd")),
        policy: policy(),
        fonts: { fontDir: null, strict: false },
        resolveMedia: async (url) => {
          resolved += 1;
          return files.get(url) ?? "";
        },
        normalizeInputs: false,
        allowUntonemappedHdr: false,
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/render",
      payload: {
        payload: {
          type: "wall-of-text",
          canvas: { width: 1081, height: 1921 },
          video: { url: `${MEDIA_PREFIX}plain.mp4` },
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
      error: { code: string; details: { issues: { path: string }[] } };
    };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.details.issues.map((issue) => issue.path)).toEqual([
      "payload.canvas.width",
      "payload.canvas.height",
    ]);
    // Lo caro: antes esto descargaba y encodeaba tres veces.
    expect(resolved).toBe(0);
    await app.close();
  }, 120_000);
});

suite("GET /capabilities — la versión del motor", () => {
  it("publica una versión hex, sin espacios, distinta del banner de ffmpeg", async () => {
    const app = server();
    const response = await app.inject({ method: "GET", url: "/capabilities" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      engine: { version: string; components: Record<string, string> };
      ffmpeg: { version: string; versionTag: string };
    };
    expect(body.engine.version).toMatch(/^[0-9a-f]{64}$/);
    // El problema original: la línea entera del banner adentro de una clave.
    expect(body.ffmpeg.version).toContain(" ");
    expect(body.engine.version).not.toContain(" ");
    expect(body.ffmpeg.versionTag).not.toContain(" ");
    expect(body.ffmpeg.versionTag).not.toContain("Copyright");
    expect(body.engine.components["code"]).toMatch(/^[0-9a-f]{64}$/);
    await app.close();
  }, 60_000);
});
