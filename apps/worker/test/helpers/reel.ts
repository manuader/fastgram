import type { ReelSpec } from "@fastgram/contracts";

/**
 * Un reel mínimo con media bajo `base` (el prefijo del Media Bank del
 * workspace) y música bajo la biblioteca de audio (`audio/…`).
 */
export function reelSpec(base: string): ReelSpec {
  const audio = base.replace("/media/", "/audio/");
  return {
    version: 1,
    durationSec: 10,
    canvas: { width: 1080, height: 1920 },
    fps: 30,
    language: "en",
    theme: {
      background: "#111111",
      primary: "#FFFFFF",
      accent: "#FFE14D",
      text: "#FFFFFF",
    },
    mix: { duckMusic: true, duckLevel: 0.3 },
    layers: [
      {
        id: "bg",
        kind: "background",
        start: 0,
        end: 10,
        z: 0,
        fill: { type: "image", url: `${base}bg.jpg`, motion: "ken-burns" },
        transitionIn: { kind: "cut", durationSec: 0.3 },
      },
      {
        id: "clip",
        kind: "clip",
        start: 1,
        end: 8,
        z: 5,
        url: `${base}gs.mp4`,
        chroma: "green",
        fit: "contain",
        rect: { x: 50, y: 68, width: 100, height: 64 },
        mediaStartSec: 0,
        volume: 1,
        loop: false,
      },
      {
        id: "hook",
        kind: "text",
        start: 0.2,
        end: 3,
        z: 10,
        text: "Stop scrolling",
        font: { family: "anton", weight: 400, size: 44 },
        color: "#FFFFFF",
        stroke: { width: 3, color: "#000000" },
        background: null,
        position: { x: 50, y: 13 },
        widthPercent: 90,
        animation: "kinetic-bounce",
        exit: "fade",
      },
      {
        id: "music",
        kind: "audio",
        role: "music",
        start: 0,
        end: 10,
        url: `${audio}m.mp3`,
        volume: 0.5,
        mediaStartSec: 0,
        fadeInSec: 0.8,
        fadeOutSec: 1.5,
        loop: true,
      },
    ],
  };
}
