import { describe, expect, it } from "vitest";
import type {
  GreenScreenJob,
  SlideshowJob,
  VideoHookJob,
  WallOfTextJob,
} from "@fastgram/ports";
import { DEFAULT_MAPPING, toWirePayload } from "./render-wire.js";
import {
  GREEN_SCREEN,
  SLIDESHOW,
  TEXT,
  VIDEO_HOOK,
  WALL_OF_TEXT,
} from "./__tests__/jobs.js";

/**
 * El mapeo puerto → `services/render`, fijado campo por campo.
 *
 * **Éste es el test que evita la trampa 19.** El puerto y el servicio tienen
 * dos schemas distintos que se parecen: `format`/`type`,
 * `num_images`/`numImages`, `hook_video`/`hookVideo`, texto plano en píxeles
 * contra texto estructurado en unidades de editor. Si alguno de los dos lados
 * cambia un nombre, el síntoma es un `bad_request` en producción sobre un
 * payload válido — no un error de compilación, porque el espejo de tipos de
 * `render-wire.ts` está escrito a mano. Lo único que puede detectarlo temprano
 * es un test que afirme el JSON **exacto** que sale por el cable.
 *
 * Los números de conversión están calculados a mano en cada caso: si alguien
 * cambia la fórmula, tiene que cambiar el número y ver por qué.
 */

const SOURCE = "test";

describe("toWirePayload — nombres de campo (la divergencia que ya mordió)", () => {
  it("wall-of-text: format→type, text singular→texts lista", () => {
    const payload = toWirePayload(WALL_OF_TEXT, DEFAULT_MAPPING, SOURCE);

    expect(payload).toEqual({
      type: "wall-of-text",
      canvas: { width: 1080, height: 1920 },
      video: {
        url: "https://media.test/bg.mp4",
        draw: { x: 0, y: 0, width: 1080, height: 1920 },
      },
      audio: { url: "https://library.test/track.mp3" },
      texts: [
        {
          id: "t0",
          text: "hook",
          // 80/1080 y 1200/1920, a seis decimales.
          position: { x: 7.407407, y: 62.5 },
          // 920/1080.
          widthPercent: 85.185185,
          align: "center",
          font: { family: "inter", weight: 400, size: 48 },
          color: "#FFFFFF",
        },
      ],
    });
  });

  it("slideshow: num_images→numImages, images→slides", () => {
    const payload = toWirePayload(SLIDESHOW, DEFAULT_MAPPING, SOURCE);

    expect(payload).toEqual({
      type: "slideshow",
      numImages: 2,
      slides: [
        {
          canvas: { width: 1080, height: 1350, aspectRatio: "4:5" },
          image: {
            url: "https://media.test/slide-1.png",
            draw: { x: 0, y: 0, width: 1080, height: 1350 },
          },
          texts: [
            {
              id: "t0",
              text: "hook",
              // 1200/1350: el mismo texto sobre otro canvas da otra posición,
              // que es justamente el punto de las unidades de editor.
              position: { x: 7.407407, y: 88.888889 },
              widthPercent: 85.185185,
              align: "center",
              font: { family: "inter", weight: 400, size: 48 },
              color: "#FFFFFF",
            },
          ],
        },
        {
          canvas: { width: 1080, height: 1350, aspectRatio: "4:5" },
          image: {
            url: "https://media.test/slide-2.png",
            draw: { x: 0, y: 0, width: 1080, height: 1350 },
          },
          texts: [expect.objectContaining({ id: "t0", text: "segundo" })],
        },
      ],
    });
  });

  it("video-hook: hook_video→hookVideo, demo_video→demoVideo", () => {
    const payload = toWirePayload(VIDEO_HOOK, DEFAULT_MAPPING, SOURCE);

    expect(payload).toMatchObject({
      type: "video-hook",
      hookVideo: { url: "https://media.test/hook.mp4" },
      demoVideo: { url: "https://media.test/demo.mp4" },
    });
    // `hookHeightRatio` no se manda: el rectángulo de cada video es más
    // específico y el default del servicio sólo gobierna lo que no se le dio.
    expect(payload).not.toHaveProperty("hookHeightRatio");
  });

  it("green-screen no manda chromaKey: sus defaults son decisión del servicio", () => {
    const payload = toWirePayload(GREEN_SCREEN, DEFAULT_MAPPING, SOURCE);

    expect(payload).toMatchObject({ type: "green-screen" });
    expect(payload).not.toHaveProperty("chromaKey");
  });

  it("drawX/drawY/drawW/drawH → draw{x,y,width,height}", () => {
    const payload = toWirePayload(GREEN_SCREEN, DEFAULT_MAPPING, SOURCE);
    if (payload.type !== "green-screen") throw new Error("otro tipo");

    expect(payload.video.draw).toEqual({ x: 0, y: 400, width: 1080, height: 1080 });
  });
});

describe("toWirePayload — píxeles de canvas a unidades de editor (FR-051)", () => {
  it("un texto al borde derecho del canvas es exactamente 100, no 100.000001", () => {
    const job: WallOfTextJob = {
      ...WALL_OF_TEXT,
      text: { ...TEXT, x: 1080, y: 1920, width: 1080 },
    };

    const payload = toWirePayload(job, DEFAULT_MAPPING, SOURCE);
    if (payload.type !== "wall-of-text") throw new Error("otro tipo");
    const text = payload.texts[0];

    expect(text?.position).toEqual({ x: 100, y: 100 });
    expect(text?.widthPercent).toBe(100);
  });

  it("absorbe el redondeo a píxeles de core en el piso de widthPercent", () => {
    // El caso medido: 25 % de 1081 px son 270,25 px. `core` guarda porcentajes
    // y manda píxeles enteros, así que llegan 270 px, que vuelven como
    // 24,9769 % — debajo del piso de 25 de `FR-051`. Sin la tolerancia, esta
    // pieza —perfectamente válida— falla con `bad_request`.
    const job: WallOfTextJob = {
      ...WALL_OF_TEXT,
      canvas: { width: 1081, height: 1920 },
      text: { ...TEXT, x: 0, y: 0, width: 270 },
    };

    const payload = toWirePayload(job, DEFAULT_MAPPING, SOURCE);
    if (payload.type !== "wall-of-text") throw new Error("otro tipo");

    expect(payload.texts[0]?.widthPercent).toBe(25);
  });

  it("una caja realmente angosta NO se estira hasta el piso: falla", () => {
    // La otra mitad de la tolerancia. 200/1080 = 18,5 %: eso no es redondeo,
    // es un layout que el editor no puede haber producido. Pegarlo a 25
    // cambiaría el ancho —y con él el corte de líneas— en silencio.
    const job: WallOfTextJob = {
      ...WALL_OF_TEXT,
      text: { ...TEXT, width: 200 },
    };

    expect(() => toWirePayload(job, DEFAULT_MAPPING, SOURCE)).toThrowError(
      /18\.518519.*\[25, 100\]/,
    );
  });

  it("un texto fuera del canvas falla nombrando el píxel y el canvas", () => {
    // El mensaje es el punto: un `bad_request` del servicio diría
    // «position.x debe ser ≤ 100» y quien lo lea va a mirar el job, donde dice
    // `x: 1200`, sin ninguna pista de que hubo una conversión en el medio.
    const job: WallOfTextJob = { ...WALL_OF_TEXT, text: { ...TEXT, x: 1200 } };

    expect(() => toWirePayload(job, DEFAULT_MAPPING, SOURCE)).toThrowError(
      /1200 px maps to 111\.111111% of a 1080 px canvas/,
    );

    // Y es un `PortError` con código estable, no un `Error` cualquiera: si
    // fuera un error crudo, `build-handler` lo clasificaría como reintentable
    // y una pieza imposible daría tres vueltas antes del reembolso.
    let thrown: unknown;
    try {
      toWirePayload(job, DEFAULT_MAPPING, SOURCE);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ name: "PortError", code: "bad_request" });
  });

  it("fontSize se hace entero porque el schema del servicio pide int", () => {
    const job: WallOfTextJob = { ...WALL_OF_TEXT, text: { ...TEXT, fontSize: 48.6 } };

    const payload = toWirePayload(job, DEFAULT_MAPPING, SOURCE);
    if (payload.type !== "wall-of-text") throw new Error("otro tipo");

    expect(payload.texts[0]?.font.size).toBe(49);
  });
});

describe("toWirePayload — lo que el PRD no define", () => {
  it("sin fontFamily usa la familia configurada, no una de licencia sin resolver", () => {
    const payload = toWirePayload(WALL_OF_TEXT, DEFAULT_MAPPING, SOURCE);
    if (payload.type !== "wall-of-text") throw new Error("otro tipo");

    // `tiktok` y `snapchat` están en `FONT_REGISTRY` con `licence:
    // "unresolved"` y sin archivo: como default romperían todos los builds.
    expect(payload.texts[0]?.font.family).toBe("inter");
    expect(["tiktok", "snapchat"]).not.toContain(payload.texts[0]?.font.family);
  });

  it("con fontFamily lo pasa tal cual: las 12 familias las valida core", () => {
    const job: WallOfTextJob = {
      ...WALL_OF_TEXT,
      text: { ...TEXT, fontFamily: "bebas", fontWeight: 400 },
    };

    const payload = toWirePayload(job, DEFAULT_MAPPING, SOURCE);
    if (payload.type !== "wall-of-text") throw new Error("otro tipo");

    expect(payload.texts[0]?.font).toEqual({ family: "bebas", weight: 400, size: 48 });
  });

  it("el peso por defecto es 400: el único que aceptan las 12 familias", () => {
    const payload = toWirePayload(WALL_OF_TEXT, DEFAULT_MAPPING, SOURCE);
    if (payload.type !== "wall-of-text") throw new Error("otro tipo");

    expect(payload.texts[0]?.font.weight).toBe(400);
  });

  it("backgroundColor plano → {color, opacity, style} con el estilo configurado", () => {
    const job: WallOfTextJob = {
      ...WALL_OF_TEXT,
      text: { ...TEXT, backgroundColor: "#101010" },
    };

    const payload = toWirePayload(job, DEFAULT_MAPPING, SOURCE);
    if (payload.type !== "wall-of-text") throw new Error("otro tipo");

    expect(payload.texts[0]?.background).toEqual({
      color: "#101010",
      opacity: 1,
      style: "pill",
    });
  });

  it("el estilo de fondo es configurable", () => {
    const job: WallOfTextJob = {
      ...WALL_OF_TEXT,
      text: { ...TEXT, backgroundColor: "#101010" },
    };

    const payload = toWirePayload(
      job,
      { ...DEFAULT_MAPPING, textBackgroundStyle: "full-width" },
      SOURCE,
    );
    if (payload.type !== "wall-of-text") throw new Error("otro tipo");

    expect(payload.texts[0]?.background?.style).toBe("full-width");
  });
});

describe("toWirePayload — stroke: opcional y suelto acá, junto o nada allá", () => {
  it("sin stroke omite la clave para que el default de FR-051 viva en un lugar", () => {
    const payload = toWirePayload(WALL_OF_TEXT, DEFAULT_MAPPING, SOURCE);
    if (payload.type !== "wall-of-text") throw new Error("otro tipo");

    // Ni `stroke: undefined` ni `{width: 0}`: la clave no está, así que el
    // servicio aplica su default normativo (3 px, `#000000`).
    expect(payload.texts[0]).not.toHaveProperty("stroke");
  });

  it("con los dos campos los manda tal cual", () => {
    const job: WallOfTextJob = {
      ...WALL_OF_TEXT,
      text: { ...TEXT, strokeWidth: 6, strokeColor: "#FF0000" },
    };

    const payload = toWirePayload(job, DEFAULT_MAPPING, SOURCE);
    if (payload.type !== "wall-of-text") throw new Error("otro tipo");

    expect(payload.texts[0]?.stroke).toEqual({ width: 6, color: "#FF0000" });
  });

  it("con uno solo completa el que falta con el default de FR-051", () => {
    const soloAncho: WallOfTextJob = {
      ...WALL_OF_TEXT,
      text: { ...TEXT, strokeWidth: 0 },
    };
    const soloColor: WallOfTextJob = {
      ...WALL_OF_TEXT,
      text: { ...TEXT, strokeColor: "#00FF00" },
    };

    const a = toWirePayload(soloAncho, DEFAULT_MAPPING, SOURCE);
    const b = toWirePayload(soloColor, DEFAULT_MAPPING, SOURCE);
    if (a.type !== "wall-of-text" || b.type !== "wall-of-text") {
      throw new Error("otro tipo");
    }

    expect(a.texts[0]?.stroke).toEqual({ width: 0, color: "#000000" });
    expect(b.texts[0]?.stroke).toEqual({ width: 3, color: "#00FF00" });
  });
});

describe("toWirePayload — audio: la divergencia que NO se resuelve acá", () => {
  it("sin audio no manda la clave, y deja que el servicio decida", () => {
    // `FR-053.1`: elegir *No audio* omite el bloque entero, así que un job sin
    // audio es válido. `wallOfTextPayloadSchema` lo pide obligatorio, así que
    // hoy el servicio va a contestar `bad_request`. Se mapea honesto igual: si
    // se rechazara acá, la pieza seguiría fallando incluso después de que el
    // servicio lo arregle, y un audio inventado saldría publicado.
    const job: WallOfTextJob = { ...WALL_OF_TEXT, audio: undefined };

    const payload = toWirePayload(job, DEFAULT_MAPPING, SOURCE);

    expect(payload).not.toHaveProperty("audio");
  });

  it("video-hook sin audio tampoco inventa nada", () => {
    const job: VideoHookJob = { ...VIDEO_HOOK, audio: undefined };

    expect(toWirePayload(job, DEFAULT_MAPPING, SOURCE)).not.toHaveProperty("audio");
  });
});

describe("toWirePayload — determinismo (la cache del servicio depende de esto)", () => {
  it("dos llamadas producen el mismo JSON byte a byte", () => {
    // El `id` de cada caja de texto entra en el `overlayKey` del servicio
    // (`domain/hash.ts` hashea `texts` completo). Un `randomUUID()` acá no
    // rompería nada visible: haría que la cache de overlay nunca acierte, que
    // es CPU pagada que no aparece en ningún log.
    const jobs = [SLIDESHOW, WALL_OF_TEXT, GREEN_SCREEN, VIDEO_HOOK];

    for (const job of jobs) {
      expect(JSON.stringify(toWirePayload(job, DEFAULT_MAPPING, SOURCE))).toBe(
        JSON.stringify(toWirePayload(job, DEFAULT_MAPPING, SOURCE)),
      );
    }
  });

  it("los ids de texto son posicionales y únicos dentro de su capa", () => {
    // `textObjectListSchema` rechaza ids duplicados sin aplicar ningún cambio.
    const job: SlideshowJob = {
      format: "slideshow",
      num_images: 1,
      images: [
        {
          canvas: { width: 1080, height: 1350, aspectRatio: "4:5" },
          image: {
            url: "https://media.test/slide-1.png",
            drawX: 0,
            drawY: 0,
            drawW: 1080,
            drawH: 1350,
          },
          texts: [TEXT, { ...TEXT, content: "dos" }, { ...TEXT, content: "tres" }],
        },
      ],
    };

    const payload = toWirePayload(job, DEFAULT_MAPPING, SOURCE);
    if (payload.type !== "slideshow") throw new Error("otro tipo");
    const ids = payload.slides[0]?.texts.map((t) => t.id);

    expect(ids).toEqual(["t0", "t1", "t2"]);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("toWirePayload — enteros donde el schema pide enteros", () => {
  it("redondea el canvas y el rectángulo, pero no los recorta al rango", () => {
    // Redondear es una coerción de tipo; recortar al `[16, 4096]` del servicio
    // sería cambiar la pieza en silencio. Un canvas fuera de rango tiene que
    // fallar, y falla allá.
    const job: GreenScreenJob = {
      ...GREEN_SCREEN,
      canvas: { width: 1080.4, height: 1920.6 },
      image: { ...GREEN_SCREEN.image, drawW: 1080.5, drawH: 1920.2 },
    };

    const payload = toWirePayload(job, DEFAULT_MAPPING, SOURCE);
    if (payload.type !== "green-screen") throw new Error("otro tipo");

    expect(payload.canvas).toEqual({ width: 1080, height: 1921 });
    expect(payload.image.draw).toMatchObject({ width: 1081, height: 1920 });
  });

  it("un canvas gigante no se recorta: se manda y lo rechaza el servicio", () => {
    // El texto se escala con el canvas: si no, salta primero la validación de
    // `widthPercent` y el caso no probaría lo que dice probar.
    const job: GreenScreenJob = {
      ...GREEN_SCREEN,
      canvas: { width: 9000, height: 9000 },
      text: { ...TEXT, x: 0, y: 0, width: 4500 },
    };

    const payload = toWirePayload(job, DEFAULT_MAPPING, SOURCE);
    if (payload.type !== "green-screen") throw new Error("otro tipo");

    expect(payload.canvas).toEqual({ width: 9000, height: 9000 });
  });
});
