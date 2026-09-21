import { describe, expect, it } from "vitest";
import {
  describeMediaRendererContract,
  MAX_SLIDES,
  type GreenScreenJob,
  type RenderJob,
  type RenderText,
  type SlideshowJob,
  type VideoHookJob,
  type WallOfTextJob,
} from "@fastgram/ports";
import { MemoryMediaRenderer } from "./memory-media-renderer.js";

/**
 * Primera ejecución de las diez aserciones de contrato de `MediaRenderer`.
 *
 * Las URLs son `memory://` y no `https://`: este adaptador no baja nada, y una
 * URL con esquema http invitaría a creer que sí. Las dimensiones de canvas son
 * las de un vertical 1080×1920 porque los cuatro formatos del producto son
 * verticales; no hay ningún número de proveedor acá.
 */
const TEXT: RenderText = {
  content: "hook",
  x: 80,
  y: 1200,
  width: 920,
  fontSize: 48,
  color: "#FFFFFF",
  textAlign: "center",
};

const SLIDESHOW: SlideshowJob = {
  format: "slideshow",
  num_images: 2,
  images: [
    {
      canvas: { width: 1080, height: 1350, aspectRatio: "4:5" },
      image: {
        url: "memory://media/slide-1.png",
        drawX: 0,
        drawY: 0,
        drawW: 1080,
        drawH: 1350,
      },
      texts: [TEXT],
    },
    {
      canvas: { width: 1080, height: 1350, aspectRatio: "4:5" },
      image: {
        url: "memory://media/slide-2.png",
        drawX: 0,
        drawY: 0,
        drawW: 1080,
        drawH: 1350,
      },
      texts: [{ ...TEXT, content: "segundo" }],
    },
  ],
};

const WALL_OF_TEXT: WallOfTextJob = {
  format: "wall-of-text",
  canvas: { width: 1080, height: 1920 },
  video: { url: "memory://media/bg.mp4", drawX: 0, drawY: 0, drawW: 1080, drawH: 1920 },
  audio: { url: "memory://media/track.mp3" },
  text: TEXT,
};

const GREEN_SCREEN: GreenScreenJob = {
  format: "green-screen",
  canvas: { width: 1080, height: 1920 },
  image: { url: "memory://media/bg.png", drawX: 0, drawY: 0, drawW: 1080, drawH: 1920 },
  video: {
    url: "memory://media/talent.mp4",
    drawX: 0,
    drawY: 400,
    drawW: 1080,
    drawH: 1080,
  },
  text: TEXT,
};

const VIDEO_HOOK: VideoHookJob = {
  format: "video-hook",
  canvas: { width: 1080, height: 1920 },
  hook_video: {
    url: "memory://media/hook.mp4",
    drawX: 0,
    drawY: 0,
    drawW: 1080,
    drawH: 960,
  },
  demo_video: {
    url: "memory://media/demo.mp4",
    drawX: 0,
    drawY: 960,
    drawW: 1080,
    drawH: 960,
  },
  audio: { url: "memory://media/track.mp3" },
  text: TEXT,
};

const SAMPLE_JOBS: readonly RenderJob[] = [
  SLIDESHOW,
  WALL_OF_TEXT,
  GREEN_SCREEN,
  VIDEO_HOOK,
];

const SOURCE_VIDEO = "memory://media/source.mov";

function makeRenderer(): MemoryMediaRenderer {
  return new MemoryMediaRenderer({
    media: {
      [SOURCE_VIDEO]: {
        contentType: "video/quicktime",
        width: 1920,
        height: 1080,
        sizeBytes: 4_096,
        durationSeconds: 12,
        hasAudio: true,
        isHdr: true,
        isFastStart: false,
      },
    },
  });
}

describeMediaRendererContract({ describe, it }, "memory", {
  makeAdapter: makeRenderer,
  sampleJobs: SAMPLE_JOBS,
  videoToNormalize: SOURCE_VIDEO,
});

describe("MemoryMediaRenderer — comportamiento propio del adaptador", () => {
  it("el fingerprint no depende del orden de las claves del job", () => {
    const renderer = makeRenderer();
    // El caso que motiva la serialización canónica: `core` arma el payload con
    // spreads, y dos spreads distintos dan el mismo objeto con distinto
    // `JSON.stringify`. Sin canonicalizar, el cache de IMPL §5 fallaría de
    // forma intermitente y por una razón invisible en el diff.
    const reordenado: WallOfTextJob = {
      text: WALL_OF_TEXT.text,
      audio: WALL_OF_TEXT.audio,
      video: WALL_OF_TEXT.video,
      canvas: WALL_OF_TEXT.canvas,
      format: "wall-of-text",
    };

    expect(renderer.fingerprint(reordenado)).toBe(renderer.fingerprint(WALL_OF_TEXT));
  });

  it("el fingerprint es igual entre dos instancias del mismo motor", () => {
    // La suite de contrato compara dos llamadas sobre **la misma** instancia,
    // así que un adaptador con una sal aleatoria por instancia la pasa entera
    // —verificado— y el cache de IMPL §5 no acertaría nunca: cada proceso
    // worker calcularía una clave distinta para el mismo job. Acá queda
    // cubierto el caso que a la suite se le escapa.
    expect(makeRenderer().fingerprint(SLIDESHOW)).toBe(
      makeRenderer().fingerprint(SLIDESHOW),
    );
  });

  it("un cambio de versión de motor invalida el fingerprint (P2-RENDER-011)", () => {
    const v0 = new MemoryMediaRenderer({ engineVersion: "memory-0" });
    const v1 = new MemoryMediaRenderer({ engineVersion: "memory-1" });

    expect(v1.fingerprint(WALL_OF_TEXT)).not.toBe(v0.fingerprint(WALL_OF_TEXT));
  });

  it("un fontSize fuera de [8, 72] es bad_request", async () => {
    const renderer = makeRenderer();

    await expect(
      renderer.render({ ...WALL_OF_TEXT, text: { ...TEXT, fontSize: 120 } }),
    ).rejects.toMatchObject({ name: "PortError", code: "bad_request" });
  });

  it("un slideshow vacío es bad_request aunque num_images coincida", async () => {
    const renderer = makeRenderer();

    await expect(
      renderer.render({ format: "slideshow", num_images: 0, images: [] }),
    ).rejects.toMatchObject({ name: "PortError", code: "bad_request" });
  });

  it(`${String(MAX_SLIDES)} slides pasan y ${String(MAX_SLIDES + 1)} no`, async () => {
    const renderer = makeRenderer();
    const slide = SLIDESHOW.images[0];
    expect(slide).toBeDefined();
    if (slide === undefined) return;

    const enElTope = Array.from({ length: MAX_SLIDES }, () => slide);
    await expect(
      renderer.render({ format: "slideshow", num_images: MAX_SLIDES, images: enElTope }),
    ).resolves.toMatchObject({ width: 1080 });
  });

  it("el body del artefacto se puede consumir y tiene el tamaño declarado", async () => {
    const renderer = makeRenderer();
    const result = await renderer.render(WALL_OF_TEXT);

    let bytes = 0;
    for await (const chunk of result.body) bytes += chunk.byteLength;
    expect(bytes).toBe(result.sizeBytes);
  });

  it("thumbnail achica pero nunca agranda", async () => {
    const renderer = makeRenderer();

    const chico = await renderer.thumbnail({ url: SOURCE_VIDEO, maxWidth: 320 });
    expect(chico.width).toBe(320);
    expect(chico.height).toBe(180); // 1920×1080 mantiene el aspecto

    const gigante = await renderer.thumbnail({ url: SOURCE_VIDEO, maxWidth: 10_000 });
    expect(gigante.width).toBe(1920);
  });

  it("thumbnail más allá del final del video es bad_request", async () => {
    const renderer = makeRenderer();

    await expect(
      renderer.thumbnail({ url: SOURCE_VIDEO, maxWidth: 320, atSeconds: 99 }),
    ).rejects.toMatchObject({ name: "PortError", code: "bad_request" });
  });

  it("probe devuelve las banderas que gobiernan la normalización de NFR-014", async () => {
    const renderer = makeRenderer();
    const probe = await renderer.probe(SOURCE_VIDEO);

    expect(probe.isHdr).toBe(true);
    expect(probe.isFastStart).toBe(false);
    expect(probe.durationSeconds).toBe(12);
  });

  it("normalize de una URL no sembrada es not_found", async () => {
    const renderer = makeRenderer();

    await expect(
      renderer.normalize({
        url: "memory://media/fantasma.mp4",
        targetContentType: "video/mp4",
      }),
    ).rejects.toMatchObject({ name: "PortError", code: "not_found" });
  });
});
