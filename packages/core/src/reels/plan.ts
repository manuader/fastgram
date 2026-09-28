/**
 * Plan de un reel desde una idea (`PU-S9-010`): idea + assets elegidos + textos
 * → `ReelSpec`, con una de tres **plantillas de estructura**.
 *
 * Es determinístico y sin IO a propósito: el mismo plan da el mismo spec (y
 * por lo tanto el mismo render cacheado). Qué assets usar lo decide quien
 * llama (hoy la API con la biblioteca de la marca; en la segunda tanda, el
 * decisor de O y el planificador semanal). El ritmo sale de lo que hacen los
 * reels que retienen (y de la skill `brag`: plan → brief → composición):
 * gancho en los primeros 0,2 s, un cambio visual cada 2–3 s, remate al final
 * con aire para leerlo, música que baja cuando alguien habla.
 */
import type {
  ReelFont,
  ReelLayer,
  ReelSpec,
  ReelTextAnimation,
  ReelTheme,
  ReelTransition,
} from "./types.js";

export const REEL_TEMPLATES = [
  "hook-reaction-punchline",
  "list-beats",
  "before-after",
] as const;
export type ReelTemplate = (typeof REEL_TEMPLATES)[number];

export const REEL_PLAN_DEFAULT_THEME: ReelTheme = {
  background: "#111111",
  primary: "#FFFFFF",
  accent: "#FFE14D",
  text: "#FFFFFF",
};

/** Topes del plan (el contrato valida los suyos; éstos son de ritmo). */
export const REEL_PLAN_LIMITS = {
  minSec: 6,
  maxSec: 30,
  maxBeats: 5,
  /** Segundos por beat en `list-beats`: da para leer ~8 palabras. */
  beatSec: 2.2,
  hookSec: 2.4,
  punchlineSec: 2.8,
  /** El clip de reacción entra después del gancho. */
  clipDelaySec: 1.2,
  /** Un clip nunca ocupa menos que esto (si es más corto, se repite). */
  clipMinSec: 4,
  clipMaxSec: 20,
  textMaxChars: 120,
} as const;

export interface ReelVisualAsset {
  readonly url: string;
  readonly kind: "image" | "video";
}

export interface ReelClipAsset {
  readonly url: string;
  readonly chroma: "green" | "blue" | "alpha" | "none";
  /** Duración del archivo; sin ella se asume 6 s. */
  readonly durationSec?: number | null;
  /** `false` = sabemos que no habla: sin subtítulos. Sin dato, se transcribe. */
  readonly hasSpeech?: boolean | null;
}

export interface ReelPlanAssets {
  /** Fondos en orden (el primero es el principal). Vacío = degradé del tema. */
  readonly backgrounds: readonly ReelVisualAsset[];
  readonly clip: ReelClipAsset | null;
  readonly music: { readonly url: string } | null;
}

export interface ReelCopy {
  readonly hook: string;
  readonly beats: readonly string[];
  readonly punchline: string | null;
}

export interface ReelPlan {
  readonly template: ReelTemplate;
  readonly copy: ReelCopy;
  readonly assets: ReelPlanAssets;
  readonly theme: ReelTheme;
  /** ISO 639-1 de la marca: idioma de los subtítulos. */
  readonly language: string | null;
}

const clampText = (text: string): string => {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= REEL_PLAN_LIMITS.textMaxChars) return t;
  return `${t.slice(0, REEL_PLAN_LIMITS.textMaxChars - 1).trimEnd()}…`;
};

/**
 * Copy a partir del prompt, sin modelo: una oración por pieza. La primera es
 * el gancho, la última el remate (si hay más de una), el medio son los beats.
 * Un prompt de una sola oración queda como gancho, sin remate inventado.
 */
export function reelCopyFromPrompt(prompt: string): ReelCopy {
  const parts = prompt
    .split(/(?<=[.!?¡¿…])\s+|\n+|;\s*/u)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const [first, ...rest] = parts;
  if (first === undefined) return { hook: "", beats: [], punchline: null };
  if (rest.length === 0) return { hook: clampText(first), beats: [], punchline: null };
  const last = rest[rest.length - 1] as string;
  const middle = rest.slice(0, -1).slice(0, REEL_PLAN_LIMITS.maxBeats);
  return {
    hook: clampText(first),
    beats: middle.map(clampText),
    punchline: clampText(last),
  };
}

/** La plantilla que mejor usa lo que hay, si quien llama no eligió. */
export function chooseReelTemplate(assets: ReelPlanAssets, copy: ReelCopy): ReelTemplate {
  if (assets.clip !== null) return "hook-reaction-punchline";
  if (assets.backgrounds.length >= 2 && copy.beats.length <= 1) return "before-after";
  return "list-beats";
}

export function planReel(input: {
  readonly prompt: string;
  readonly template?: ReelTemplate | undefined;
  readonly assets: ReelPlanAssets;
  readonly theme?: ReelTheme | undefined;
  readonly language?: string | null | undefined;
  readonly copy?: ReelCopy | undefined;
}): ReelPlan {
  const copy = input.copy ?? reelCopyFromPrompt(input.prompt);
  return {
    template: input.template ?? chooseReelTemplate(input.assets, copy),
    copy,
    assets: input.assets,
    theme: input.theme ?? REEL_PLAN_DEFAULT_THEME,
    language: input.language ?? null,
  };
}

// ── construcción del spec ──────────────────────────────────────────────────

const r1 = (n: number): number => Math.round(n * 10) / 10;

const HOOK_FONT: ReelFont = { family: "anton", weight: 400, size: 44 };
const BODY_FONT: ReelFont = { family: "montserrat", weight: 700, size: 28 };
const PUNCH_FONT: ReelFont = { family: "poppins", weight: 600, size: 30 };
const CAPTION_FONT: ReelFont = { family: "montserrat", weight: 700, size: 28 };
const BLACK_STROKE = { width: 3, color: "#000000" } as const;
const NO_STROKE = { width: 0, color: "#000000" } as const;

function background(
  id: string,
  start: number,
  end: number,
  z: number,
  asset: ReelVisualAsset | undefined,
  theme: ReelTheme,
  transition: ReelTransition,
): ReelLayer {
  return {
    id,
    kind: "background",
    start,
    end,
    z,
    fill:
      asset === undefined
        ? { type: "gradient", from: theme.background, to: theme.accent, angle: 160 }
        : asset.kind === "image"
          ? { type: "image", url: asset.url, motion: "ken-burns" }
          : { type: "video", url: asset.url, mediaStartSec: 0 },
    transitionIn: { kind: transition, durationSec: 0.4 },
  };
}

function text(
  id: string,
  start: number,
  end: number,
  body: string,
  opts: {
    font: ReelFont;
    y: number;
    animation: ReelTextAnimation;
    color?: string;
    stroke?: { width: number; color: string };
    background?: { color: string; opacity: number; style: "pill" | "full-width" } | null;
    width?: number;
    exit?: "none" | "fade";
  },
): ReelLayer {
  return {
    id,
    kind: "text",
    start,
    end,
    z: 10,
    text: body,
    font: opts.font,
    color: opts.color ?? "#FFFFFF",
    stroke: opts.stroke ?? BLACK_STROKE,
    background: opts.background ?? null,
    position: { x: 50, y: opts.y },
    widthPercent: opts.width ?? 90,
    animation: opts.animation,
    exit: opts.exit ?? "fade",
  };
}

function music(assets: ReelPlanAssets, durationSec: number): ReelLayer[] {
  if (assets.music === null) return [];
  return [
    {
      id: "music",
      kind: "audio",
      role: "music",
      start: 0,
      end: durationSec,
      url: assets.music.url,
      volume: 0.5,
      mediaStartSec: 0,
      fadeInSec: 0.8,
      fadeOutSec: 1.5,
      loop: true,
    },
  ];
}

function clipLayers(
  clip: ReelClipAsset,
  start: number,
  sec: number,
  theme: ReelTheme,
): ReelLayer[] {
  const source = clip.durationSec ?? 6;
  const layers: ReelLayer[] = [
    {
      id: "clip",
      kind: "clip",
      start,
      end: r1(start + sec),
      z: 5,
      url: clip.url,
      chroma: clip.chroma,
      // Trampa 66: `contain` en el tramo de abajo, nunca `cover` a lienzo completo.
      fit: "contain",
      rect: { x: 50, y: 68, width: 100, height: 64 },
      mediaStartSec: 0,
      volume: 1,
      loop: source < sec - 0.05,
    },
  ];
  if (clip.hasSpeech !== false) {
    layers.push({
      id: "captions",
      kind: "captions",
      start,
      end: r1(start + sec),
      z: 20,
      sourceLayerId: "clip",
      style: "bold-pop",
      font: CAPTION_FONT,
      color: "#FFFFFF",
      activeColor: theme.accent,
      stroke: BLACK_STROKE,
      positionY: 29,
      wordsPerChunk: 3,
    });
  }
  return layers;
}

/** Arma el spec. Un plan sin gancho no se construye (no hay reel sin texto). */
export function reelSpecFromPlan(plan: ReelPlan): ReelSpec {
  const L = REEL_PLAN_LIMITS;
  const { copy, assets, theme } = plan;
  if (copy.hook.trim() === "") throw new Error("un reel necesita al menos un gancho");
  const layers: ReelLayer[] = [];
  let durationSec: number;

  if (plan.template === "hook-reaction-punchline") {
    const clipSec =
      assets.clip === null
        ? L.clipMinSec
        : Math.min(L.clipMaxSec, Math.max(L.clipMinSec, assets.clip.durationSec ?? 6));
    const bodyEnd = r1(L.clipDelaySec + clipSec);
    const punch = copy.punchline ?? copy.beats[copy.beats.length - 1] ?? null;
    durationSec = Math.min(
      L.maxSec,
      Math.max(L.minSec, r1(bodyEnd + (punch === null ? 0.8 : L.punchlineSec))),
    );
    layers.push(background("bg", 0, durationSec, 0, assets.backgrounds[0], theme, "cut"));
    if (assets.clip !== null)
      layers.push(...clipLayers(assets.clip, L.clipDelaySec, clipSec, theme));
    layers.push(
      text("hook", 0.2, r1(L.clipDelaySec + Math.min(2.8, clipSec)), copy.hook, {
        font: HOOK_FONT,
        y: 13,
        animation: "kinetic-bounce",
      }),
    );
    if (punch !== null) {
      layers.push(
        text("punchline", bodyEnd, durationSec, punch, {
          font: PUNCH_FONT,
          y: 50,
          animation: "pop",
          stroke: NO_STROKE,
          background: { color: "#000000", opacity: 0.6, style: "pill" },
          width: 80,
          exit: "none",
        }),
      );
    }
  } else if (plan.template === "list-beats") {
    const beats = copy.beats.length > 0 ? copy.beats.slice(0, L.maxBeats) : [];
    const beatsEnd = r1(L.hookSec + beats.length * L.beatSec);
    durationSec = Math.min(
      L.maxSec,
      Math.max(L.minSec, r1(beatsEnd + (copy.punchline === null ? 0.8 : L.punchlineSec))),
    );
    const transitions: ReelTransition[] = ["slide-left", "zoom-in", "whip", "crossfade"];
    const animations: ReelTextAnimation[] = [
      "word-by-word",
      "slide-left",
      "fade-up",
      "wipe-reveal",
      "kinetic-bounce",
    ];
    if (assets.backgrounds.length > 1 && beats.length > 0) {
      // Un fondo por beat (cambio visual cada ~2 s), ciclando los que haya.
      layers.push(background("bg", 0, L.hookSec, 0, assets.backgrounds[0], theme, "cut"));
      beats.forEach((_, i) => {
        const start = r1(L.hookSec + i * L.beatSec);
        const end = i === beats.length - 1 ? durationSec : r1(start + L.beatSec);
        const asset = assets.backgrounds[(i + 1) % assets.backgrounds.length];
        layers.push(
          background(
            `bg-${String(i + 1)}`,
            start,
            end,
            i + 1,
            asset,
            theme,
            transitions[i % transitions.length] as ReelTransition,
          ),
        );
      });
    } else {
      layers.push(
        background("bg", 0, durationSec, 0, assets.backgrounds[0], theme, "cut"),
      );
    }
    if (assets.clip !== null) {
      layers.push(
        ...clipLayers(
          assets.clip,
          L.hookSec,
          Math.max(L.clipMinSec, r1(beatsEnd - L.hookSec)),
          theme,
        ),
      );
    }
    layers.push(
      text("hook", 0.2, L.hookSec, copy.hook, {
        font: { ...HOOK_FONT, size: 48 },
        y: 40,
        animation: "zoom-blur",
      }),
    );
    beats.forEach((beat, i) => {
      const start = r1(L.hookSec + i * L.beatSec);
      layers.push(
        text(
          `beat-${String(i + 1)}`,
          start,
          r1(start + L.beatSec),
          `${String(i + 1)}. ${beat}`,
          {
            font: BODY_FONT,
            y: assets.clip === null ? 45 : 16,
            animation: animations[i % animations.length] as ReelTextAnimation,
            color: "#111111",
            stroke: NO_STROKE,
            background: { color: theme.accent, opacity: 0.95, style: "pill" },
            width: 86,
          },
        ),
      );
    });
    if (copy.punchline !== null) {
      layers.push(
        text("punchline", beatsEnd, durationSec, copy.punchline, {
          font: PUNCH_FONT,
          y: 50,
          animation: "highlight-sweep",
          color: "#111111",
          stroke: NO_STROKE,
          width: 80,
          exit: "none",
        }),
      );
    }
  } else {
    // before-after: dos escenas separadas por un `whip`.
    durationSec = 10;
    const half = 5;
    layers.push(background("before", 0, half, 0, assets.backgrounds[0], theme, "cut"));
    layers.push(
      background("after", half, durationSec, 1, assets.backgrounds[1], theme, "whip"),
    );
    const label = (
      id: string,
      start: number,
      end: number,
      body: string,
      color: string,
    ): ReelLayer =>
      text(id, start, end, body, {
        font: { family: "anton", weight: 400, size: 30 },
        y: 8,
        animation: "pop",
        stroke: NO_STROKE,
        background: { color, opacity: 1, style: "pill" },
        width: 40,
      });
    layers.push(label("before-label", 0.2, half, "BEFORE", "#E5484D"));
    layers.push(label("after-label", r1(half + 0.3), durationSec, "AFTER", "#30A46C"));
    layers.push(
      text("hook", 0.4, half, copy.hook, {
        font: HOOK_FONT,
        y: 30,
        animation: "fade-up",
      }),
    );
    const after = copy.punchline ?? copy.beats[0] ?? null;
    if (after !== null) {
      layers.push(
        text("after-text", r1(half + 0.5), durationSec, after, {
          font: PUNCH_FONT,
          y: 30,
          animation: "typewriter",
          stroke: NO_STROKE,
          background: { color: "#000000", opacity: 0.6, style: "pill" },
          width: 84,
          exit: "none",
        }),
      );
    }
  }

  layers.push(...music(assets, durationSec));
  return {
    version: 1,
    durationSec,
    canvas: { width: 1080, height: 1920 },
    fps: 30,
    ...(plan.language === null ? {} : { language: plan.language }),
    theme,
    mix: { duckMusic: true, duckLevel: 0.3 },
    layers,
  };
}

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  english: "en",
  spanish: "es",
  español: "es",
  espanol: "es",
  portuguese: "pt",
  português: "pt",
  french: "fr",
  german: "de",
  italian: "it",
};

/**
 * El idioma de la marca (`brand_strategy.language`, texto libre) como ISO
 * 639-1 para el ASR de los subtítulos. `null` = que el motor lo detecte: mejor
 * que forzar un idioma equivocado, que con whisper traduce en vez de transcribir.
 */
export function reelLanguageOf(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  const byName = LANGUAGE_NAMES[v];
  if (byName !== undefined) return byName;
  const iso = /^([a-z]{2})(?:[-_][a-z]{2,4})?$/.exec(v);
  return iso?.[1] ?? null;
}
