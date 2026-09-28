/**
 * Qué necesita cada formato — `formatNeeds`. Sprint 9 (O).
 *
 * Los formatos nuevos de este sprint (`video`, `carousel`, `static`, D-20) y
 * los de Blitz que ya existen (`green-screen`, `wall-of-text`, `video-hook`,
 * `slideshow`). Por **rol**: el decisor elige un asset por rol, no «los assets
 * de la pieza» de una vez (el meme y el fondo se juzgan por separado).
 *
 * ## De dónde salen los números
 *
 * - Meme: hasta `MEME_SEARCH_LIMITS.maxSeconds` (30 s), el mismo tope que usa
 *   la búsqueda automática de memes (`discovery/meme-search.ts`): un clip más
 *   largo no es un meme, es un video.
 * - Aspecto: short-form vertical (9:16) para los formatos de video; el
 *   carrusel y el estático aceptan 1:1 y 4:5 además (los de Instagram). Un
 *   asset sin aspecto conocido **pasa** (ver `types.ts`).
 * - El resto de las duraciones no tienen número en el PRD y no se inventan:
 *   sin tope.
 */
import type { AssetAspect, AssetKind } from "./types.js";
import { MEME_SEARCH_LIMITS } from "../../discovery/meme-search.js";

export const DECISION_FORMATS = [
  "video",
  "carousel",
  "static",
  "green-screen",
  "wall-of-text",
  "video-hook",
  "slideshow",
] as const;

export type DecisionFormat = (typeof DECISION_FORMATS)[number];

export const ASSET_ROLES = [
  "meme",
  "background",
  "video",
  "image",
  "music",
  "character",
] as const;

export type AssetRole = (typeof ASSET_ROLES)[number];

export interface RoleNeeds {
  readonly role: AssetRole;
  /** Qué clases de asset sirven para el rol. */
  readonly kinds: readonly AssetKind[];
  readonly minDurationSec?: number;
  readonly maxDurationSec?: number;
  /** Vacío/ausente = cualquiera. */
  readonly aspects?: readonly AssetAspect[];
}

const VERTICAL: readonly AssetAspect[] = ["9:16"];
const FEED: readonly AssetAspect[] = ["1:1", "4:5", "9:16"];

const MUSIC: RoleNeeds = { role: "music", kinds: ["audio"] };
const CHARACTER: RoleNeeds = { role: "character", kinds: ["character"] };

const NEEDS: Readonly<Record<DecisionFormat, readonly RoleNeeds[]>> = {
  "green-screen": [
    {
      role: "meme",
      kinds: ["meme_clip"],
      maxDurationSec: MEME_SEARCH_LIMITS.maxSeconds,
    },
    // El fondo va detrás del recorte: imagen o video, vertical.
    {
      role: "background",
      kinds: ["background_image", "background_video"],
      aspects: VERTICAL,
    },
    MUSIC,
    CHARACTER,
  ],
  "wall-of-text": [
    { role: "background", kinds: ["background_video"], aspects: VERTICAL },
    MUSIC,
    CHARACTER,
  ],
  "video-hook": [
    { role: "video", kinds: ["video_clip", "background_video"] },
    MUSIC,
    CHARACTER,
  ],
  slideshow: [
    { role: "image", kinds: ["image", "background_image"], aspects: FEED },
    CHARACTER,
  ],
  video: [
    { role: "video", kinds: ["video_clip", "background_video"], aspects: VERTICAL },
    { role: "background", kinds: ["background_image", "background_video"] },
    MUSIC,
    CHARACTER,
  ],
  carousel: [
    { role: "image", kinds: ["image", "background_image"], aspects: FEED },
    MUSIC,
    CHARACTER,
  ],
  static: [
    { role: "image", kinds: ["image", "background_image"], aspects: FEED },
    CHARACTER,
  ],
};

/** Los roles de un formato y qué pide cada uno. */
export function formatNeeds(format: DecisionFormat): readonly RoleNeeds[] {
  return NEEDS[format];
}

/** Lo que pide un rol en un formato, o `null` si el formato no tiene ese rol. */
export function roleNeeds(format: DecisionFormat, role: AssetRole): RoleNeeds | null {
  return NEEDS[format].find((n) => n.role === role) ?? null;
}
