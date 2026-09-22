/** IMPL §5 — el plan del preview: geometría, seek y lo que sale por `-vf`. */
import { describe, expect, it } from "vitest";
import { isRenderError } from "../errors.js";
import type { MediaInfo } from "./probe.js";
import { planThumbnail, thumbnailGeometry } from "./thumbnail.js";

function info(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path: "/tmp/in.mp4",
    formatNames: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
    majorBrand: "isom",
    durationSeconds: 10,
    width: 1920,
    height: 1080,
    videoCodec: "h264",
    pixelFormat: "yuv420p",
    colorTransfer: "bt709",
    colorPrimaries: "bt709",
    hasVideo: true,
    hasAudio: true,
    isHdr: false,
    isWideGamutSdr: false,
    isStillImage: false,
    ...overrides,
  };
}

describe("geometría del preview", () => {
  it("escala al techo preservando la proporción", () => {
    expect(thumbnailGeometry({ width: 1920, height: 1080 }, 480)).toEqual({
      width: 480,
      height: 270,
    });
  });

  it("NO agranda una fuente más chica que el techo", () => {
    expect(thumbnailGeometry({ width: 320, height: 240 }, 1080)).toEqual({
      width: 320,
      height: 240,
    });
  });

  it("las dos dimensiones salen pares, como en el resto del servicio", () => {
    const { width, height } = thumbnailGeometry({ width: 1081, height: 1921 }, 501);
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
  });

  it("una fuente extremadamente apaisada no colapsa el alto a cero", () => {
    // 4000×3: el alto proporcional da 0.15 px. Un 0 haría fallar a libx264 y a
    // mjpeg por igual.
    expect(thumbnailGeometry({ width: 4000, height: 3 }, 200).height).toBe(2);
  });
});

describe("plan del preview", () => {
  it("un video pide el cuadro del segundo pedido, con seek antes de -i", () => {
    const plan = planThumbnail(info(), { maxWidth: 480, atSeconds: 3 }, "/out/t.jpg");
    expect(plan.atSeconds).toBe(3);
    const ss = plan.args.indexOf("-ss");
    const input = plan.args.indexOf("-i");
    expect(ss).toBeGreaterThanOrEqual(0);
    // Seek rápido: `-ss` como opción de ENTRADA, no de salida.
    expect(ss).toBeLessThan(input);
  });

  it("sin atSeconds se toma el primer cuadro y no se hace seek", () => {
    const plan = planThumbnail(info(), { maxWidth: 480 }, "/out/t.jpg");
    expect(plan.atSeconds).toBe(0);
    expect(plan.args).not.toContain("-ss");
  });

  it("un segundo más allá del final se acota al final y se avisa", () => {
    const plan = planThumbnail(
      info({ durationSeconds: 5 }),
      { maxWidth: 480, atSeconds: 99 },
      "/out/t.jpg",
    );
    expect(plan.atSeconds).toBeCloseTo(4.9, 5);
    expect(plan.warnings.join(" ")).toContain("más allá del final");
  });

  it("una imagen fija ignora atSeconds: no tiene línea de tiempo", () => {
    const plan = planThumbnail(
      info({ isStillImage: true, videoCodec: "png", durationSeconds: null }),
      { maxWidth: 200, atSeconds: 7 },
      "/out/t.jpg",
    );
    expect(plan.atSeconds).toBeNull();
    expect(plan.args).not.toContain("-ss");
    expect(plan.warnings).toEqual([]);
  });

  it("sin duración no se hace seek a ciegas: primer cuadro y aviso", () => {
    const plan = planThumbnail(
      info({ durationSeconds: null }),
      { maxWidth: 480, atSeconds: 4 },
      "/out/t.jpg",
    );
    expect(plan.atSeconds).toBeNull();
    expect(plan.warnings.join(" ")).toContain("no declara duración");
  });

  it("el filtro fija la SAR: una fuente de píxeles no cuadrados no se deforma", () => {
    const plan = planThumbnail(info(), { maxWidth: 480 }, "/out/t.jpg");
    expect(plan.args.join(" ")).toContain("scale=480:270,setsar=1");
  });

  it("un medio sin pista visual no tiene preview", () => {
    try {
      planThumbnail(
        info({ hasVideo: false, width: null, height: null }),
        { maxWidth: 480 },
        "/out/t.jpg",
      );
      expect.unreachable("tendría que haber tirado");
    } catch (error) {
      expect(isRenderError(error) && error.code).toBe("unsupported_media_format");
    }
  });
});
