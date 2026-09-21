/** `P2-RENDER-013` / `NFR-014` — MOV→MP4, HDR→SDR, faststart. */
import { describe, expect, it } from "vitest";
import { planNormalization } from "./normalize.js";
import type { MediaInfo } from "./probe.js";
import type { FfmpegCapabilities } from "./capabilities.js";

function caps(overrides: Partial<FfmpegCapabilities> = {}): FfmpegCapabilities {
  return {
    available: true,
    version: "test",
    filters: new Set(["overlay", "scale", "crop", "setsar"]),
    encoders: new Set(["libx264", "aac"]),
    hasDrawtext: false,
    hasOverlay: true,
    hasChromakey: true,
    hasColorkey: true,
    hasZscale: false,
    hasTonemap: true,
    hasColorspace: true,
    ...overrides,
  };
}

function info(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path: "/tmp/x.mp4",
    formatNames: ["mov", "mp4", "m4a"],
    durationSeconds: 5,
    width: 1080,
    height: 1920,
    videoCodec: "h264",
    pixelFormat: "yuv420p",
    colorTransfer: "bt709",
    colorPrimaries: "bt709",
    hasVideo: true,
    hasAudio: true,
    isHdr: false,
    isWideGamutSdr: false,
    ...overrides,
  };
}

describe("plan de normalización", () => {
  it("siempre pide faststart", () => {
    const plan = planNormalization(info(), caps());
    expect(plan.args).toContain("-movflags");
    expect(plan.args).toContain("+faststart");
  });

  it("marca un MOV para conversión a MP4", () => {
    const plan = planNormalization(info({ formatNames: ["mov", "quicktime"] }), caps());
    expect(plan.needsRemux).toBe(true);
  });

  it("un MP4 h264 yuv420p SDR no necesita transcodificar", () => {
    const plan = planNormalization(info({ formatNames: ["mp4"] }), caps());
    expect(plan.needsTranscode).toBe(false);
    expect(plan.args).toContain("copy");
  });

  it("un codec distinto de h264 obliga a transcodificar", () => {
    const plan = planNormalization(info({ formatNames: ["mp4"], videoCodec: "hevc" }), caps());
    expect(plan.needsTranscode).toBe(true);
    expect(plan.args).toContain("libx264");
  });

  it("HDR con zscale: cadena completa de tone mapping", () => {
    const plan = planNormalization(
      info({ isHdr: true, colorTransfer: "smpte2084" }),
      caps({ hasZscale: true, hasTonemap: true }),
    );
    expect(plan.toneMapping).toBe("full");
    expect(plan.videoFilters.join(",")).toContain("tonemap=tonemap=hable");
    expect(plan.videoFilters.join(",")).toContain("zscale=t=linear");
  });

  it("HDR sin zscale: NO se inventa una conversión, se reporta como no disponible", () => {
    const plan = planNormalization(
      info({ isHdr: true, colorTransfer: "smpte2084" }),
      caps({ hasZscale: false }),
    );
    // Esto es lo que pasa en esta máquina: ffmpeg 9.0.1 sin libzimg.
    expect(plan.toneMapping).toBe("unavailable");
    expect(plan.videoFilters.join(",")).not.toContain("tonemap");
  });

  it("BT.2020 SDR sí se convierte con colorspace, y se marca aproximada", () => {
    const plan = planNormalization(
      info({ isWideGamutSdr: true, colorTransfer: "bt2020-10" }),
      caps(),
    );
    expect(plan.toneMapping).toBe("approximate");
    expect(plan.videoFilters.join(",")).toContain("colorspace=all=bt709");
  });

  it("la salida siempre termina en yuv420p", () => {
    for (const variant of [info(), info({ isHdr: true }), info({ isWideGamutSdr: true })]) {
      const plan = planNormalization(variant, caps({ hasZscale: true }));
      expect(plan.videoFilters.at(-1)).toBe("format=yuv420p");
    }
  });

  it("un medio sin audio no mapea audio", () => {
    const plan = planNormalization(info({ hasAudio: false }), caps());
    expect(plan.args).toContain("-an");
    expect(plan.args).not.toContain("aac");
  });
});
