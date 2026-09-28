/**
 * El spec del reel visto desde `core`. Es la misma forma que `ReelSpec` de
 * `@fastgram/contracts` (`resources/reel.ts`), escrita a mano porque `core` no
 * depende de `contracts` ni de zod (`core-no-npm`). La API valida con el
 * esquema del contrato lo que sale de acá: si divergen, el test de integración
 * de la ruta se pone rojo, no un reel en producción.
 */

export type ReelTextAnimation =
  | "none"
  | "fade-up"
  | "pop"
  | "typewriter"
  | "word-by-word"
  | "slide-left"
  | "highlight-sweep"
  | "kinetic-bounce"
  | "zoom-blur"
  | "wipe-reveal";

export type ReelTransition =
  "cut" | "crossfade" | "slide-up" | "slide-left" | "zoom-in" | "flash" | "whip" | "blur";

export type ReelFontFamily =
  | "tiktok"
  | "snapchat"
  | "montserrat"
  | "poppins"
  | "inter"
  | "oswald"
  | "playfair"
  | "caveat"
  | "anton"
  | "bebas"
  | "bangers"
  | "pacifico";

export interface ReelFont {
  readonly family: ReelFontFamily;
  readonly weight: number;
  readonly size: number;
}

interface Timed {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

export type ReelBackgroundFill =
  | { readonly type: "color"; readonly color: string }
  | {
      readonly type: "gradient";
      readonly from: string;
      readonly to: string;
      readonly angle: number;
    }
  | {
      readonly type: "image";
      readonly url: string;
      readonly motion: "none" | "ken-burns";
    }
  | { readonly type: "video"; readonly url: string; readonly mediaStartSec: number };

export interface ReelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type ReelLayer =
  | (Timed & {
      readonly kind: "background";
      readonly z: number;
      readonly fill: ReelBackgroundFill;
      readonly transitionIn: {
        readonly kind: ReelTransition;
        readonly durationSec: number;
      };
    })
  | (Timed & {
      readonly kind: "clip";
      readonly z: number;
      readonly url: string;
      readonly chroma: "green" | "blue" | "alpha" | "none";
      readonly fit: "cover" | "contain";
      readonly rect: ReelRect;
      readonly mediaStartSec: number;
      readonly volume: number;
      readonly loop: boolean;
    })
  | (Timed & {
      readonly kind: "image";
      readonly z: number;
      readonly url: string;
      readonly fit: "cover" | "contain";
      readonly rect: ReelRect;
      readonly animation:
        "none" | "fade-up" | "pop" | "slide-left" | "zoom-blur" | "wipe-reveal";
      readonly exit: "none" | "fade";
    })
  | (Timed & {
      readonly kind: "text";
      readonly z: number;
      readonly text: string;
      readonly font: ReelFont;
      readonly color: string;
      readonly stroke: { readonly width: number; readonly color: string };
      readonly background: {
        readonly color: string;
        readonly opacity: number;
        readonly style: "pill" | "full-width";
      } | null;
      readonly position: { readonly x: number; readonly y: number };
      readonly widthPercent: number;
      readonly animation: ReelTextAnimation;
      readonly exit: "none" | "fade";
      readonly highlightColor?: string;
    })
  | (Timed & {
      readonly kind: "captions";
      readonly z: number;
      readonly sourceLayerId: string;
      readonly words?: readonly {
        readonly text: string;
        readonly start: number;
        readonly end: number;
      }[];
      readonly style: "bold-pop" | "clean" | "karaoke";
      readonly font: ReelFont;
      readonly color: string;
      readonly activeColor: string;
      readonly stroke: { readonly width: number; readonly color: string };
      readonly positionY: number;
      readonly wordsPerChunk: number;
    })
  | (Timed & {
      readonly kind: "audio";
      readonly role: "music" | "voice";
      readonly url: string;
      readonly volume: number;
      readonly mediaStartSec: number;
      readonly fadeInSec: number;
      readonly fadeOutSec: number;
      readonly loop: boolean;
    });

export interface ReelTheme {
  readonly background: string;
  readonly primary: string;
  readonly accent: string;
  readonly text: string;
}

export interface ReelSpec {
  readonly version: 1;
  readonly durationSec: number;
  readonly canvas: { readonly width: 1080; readonly height: 1920 };
  readonly fps: 30;
  readonly language?: string;
  readonly theme: ReelTheme;
  readonly mix: { readonly duckMusic: boolean; readonly duckLevel: number };
  readonly layers: readonly ReelLayer[];
}
