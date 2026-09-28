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
import { REEL_DEFAULT_LOOK, type ReelBrandLook } from "./look.js";
import type {
  ReelFont,
  ReelLayer,
  ReelSpec,
  ReelTextAnimation,
  ReelTheme,
  ReelTransition,
} from "./types.js";

export type ReelCaptionStyle = "bold-pop" | "clean" | "karaoke";

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

export interface ReelMotion {
  readonly hook?: ReelTextAnimation;
  readonly punchline?: ReelTextAnimation;
  /** Una por beat, en ciclo. */
  readonly beats?: readonly ReelTextAnimation[];
  readonly captions?: ReelCaptionStyle;
}

export interface ReelPlan {
  readonly template: ReelTemplate;
  readonly copy: ReelCopy;
  readonly assets: ReelPlanAssets;
  readonly theme: ReelTheme;
  /**
   * Sprint 9 (U): fuentes, colores, logo y motivo de la marca (`look.ts`).
   * Ausente = {@link REEL_DEFAULT_LOOK}, lo de antes.
   */
  readonly look?: ReelBrandLook | undefined;
  /**
   * Sprint 9 (U): animaciones y estilo de subtítulos elegidos por el
   * planificador (preferencias + exploración). Ausente = los de la plantilla.
   */
  readonly motion?: ReelMotion | undefined;
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
  /** Sprint 9 (U): la marca (design system). Manda sobre `theme`. */
  readonly look?: ReelBrandLook | undefined;
  readonly motion?: ReelMotion | undefined;
}): ReelPlan {
  const copy = input.copy ?? reelCopyFromPrompt(input.prompt);
  return {
    template: input.template ?? chooseReelTemplate(input.assets, copy),
    copy,
    assets: input.assets,
    theme: input.look?.theme ?? input.theme ?? REEL_PLAN_DEFAULT_THEME,
    language: input.language ?? null,
    ...(input.look === undefined ? {} : { look: input.look }),
    ...(input.motion === undefined ? {} : { motion: input.motion }),
  };
}

// ── construcción del spec ──────────────────────────────────────────────────

const r1 = (n: number): number => Math.round(n * 10) / 10;

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
  look: ReelBrandLook,
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
    color: opts.color ?? look.colors.text,
    stroke: opts.stroke ?? look.colors.stroke,
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
  look: ReelBrandLook,
  captionStyle: ReelCaptionStyle,
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
      style: captionStyle,
      font: look.fonts.caption,
      color: look.colors.caption,
      activeColor: look.colors.captionActive,
      stroke: look.colors.captionStroke,
      positionY: 29,
      wordsPerChunk: 3,
    });
  }
  return layers;
}

/**
 * El look efectivo del plan: el de la marca si hay; si no, el de siempre con
 * el acento del tema (un `theme` suelto, sin design system, sigue pintando la
 * caja de los beats y la palabra activa como antes).
 */
function lookOf(plan: ReelPlan): ReelBrandLook {
  if (plan.look !== undefined) return plan.look;
  const d = REEL_DEFAULT_LOOK;
  return {
    ...d,
    theme: plan.theme,
    colors: { ...d.colors, beatBox: plan.theme.accent, captionActive: plan.theme.accent },
  };
}

/** Capa del logo: arriba, encima de todo el texto, toda la duración. */
function logoLayer(look: ReelBrandLook, durationSec: number): ReelLayer[] {
  if (look.logo === null) return [];
  return [
    {
      id: "logo",
      kind: "image",
      start: 0,
      end: durationSec,
      z: 30,
      url: look.logo.url,
      fit: "contain",
      rect: look.logo.rect,
      animation: "none",
      exit: "none",
    },
  ];
}

/**
 * El motivo del design system como capa decorativa: en la esquina opuesta al
 * logo, detrás del texto. Sólo `list-beats` lo pide (es la plantilla con aire
 * alrededor de las cajas; en las otras compite con el clip o el antes/después).
 */
function motifLayer(look: ReelBrandLook, start: number, end: number): ReelLayer[] {
  if (look.motif === null || end - start < 0.2) return [];
  return [
    {
      id: "motif",
      kind: "image",
      start,
      end,
      z: 8,
      url: look.motif.url,
      fit: "contain",
      rect: { x: 18, y: 84, width: 34, height: 19 },
      animation: "fade-up",
      exit: "fade",
    },
  ];
}

/** Arma el spec. Un plan sin gancho no se construye (no hay reel sin texto). */
export function reelSpecFromPlan(plan: ReelPlan): ReelSpec {
  const L = REEL_PLAN_LIMITS;
  const { copy, assets, theme } = plan;
  if (copy.hook.trim() === "") throw new Error("un reel necesita al menos un gancho");
  const look = lookOf(plan);
  const F = look.fonts;
  const C = look.colors;
  const motion = plan.motion ?? {};
  const captionStyle = motion.captions ?? "bold-pop";
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
      layers.push(
        ...clipLayers(assets.clip, L.clipDelaySec, clipSec, look, captionStyle),
      );
    layers.push(
      text(look, "hook", 0.2, r1(L.clipDelaySec + Math.min(2.8, clipSec)), copy.hook, {
        font: F.hook,
        // Con logo arriba, el gancho baja lo justo para no pisarlo.
        y: look.logo === null ? 13 : 17,
        animation: motion.hook ?? "kinetic-bounce",
      }),
    );
    if (punch !== null) {
      layers.push(
        text(look, "punchline", bodyEnd, durationSec, punch, {
          font: F.punch,
          y: 50,
          animation: motion.punchline ?? "pop",
          color: C.punchText,
          stroke: NO_STROKE,
          background: { ...C.punchBox, style: "pill" },
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
    const animations: readonly ReelTextAnimation[] = motion.beats ?? [
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
          look,
          captionStyle,
        ),
      );
    }
    layers.push(
      text(look, "hook", 0.2, L.hookSec, copy.hook, {
        font: { ...F.hook, size: 48 },
        y: 40,
        animation: motion.hook ?? "zoom-blur",
      }),
    );
    beats.forEach((beat, i) => {
      const start = r1(L.hookSec + i * L.beatSec);
      layers.push(
        text(
          look,
          `beat-${String(i + 1)}`,
          start,
          r1(start + L.beatSec),
          `${String(i + 1)}. ${beat}`,
          {
            font: F.body,
            y: assets.clip === null ? 45 : 16,
            animation: animations[i % animations.length] as ReelTextAnimation,
            color: C.beatText,
            stroke: NO_STROKE,
            background: { color: C.beatBox, opacity: 0.95, style: "pill" },
            width: 86,
          },
        ),
      );
    });
    if (copy.punchline !== null) {
      layers.push(
        text(look, "punchline", beatsEnd, durationSec, copy.punchline, {
          font: F.punch,
          y: 50,
          animation: motion.punchline ?? "highlight-sweep",
          color: C.beatText,
          stroke: NO_STROKE,
          width: 80,
          exit: "none",
        }),
      );
    }
    if (assets.clip === null) layers.push(...motifLayer(look, L.hookSec, durationSec));
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
      textColor: string,
    ): ReelLayer =>
      text(look, id, start, end, body, {
        font: F.label,
        // Con logo arriba a la derecha, la etiqueta (centrada, 40 % de ancho)
        // no lo toca; sí baja un poco para no quedar pegada a la barra.
        y: look.logo === null ? 8 : 9,
        animation: "pop",
        color: textColor,
        stroke: NO_STROKE,
        background: { color, opacity: 1, style: "pill" },
        width: 40,
      });
    layers.push(
      label("before-label", 0.2, half, "BEFORE", C.beforeLabel, C.beforeLabelText),
    );
    layers.push(
      label(
        "after-label",
        r1(half + 0.3),
        durationSec,
        "AFTER",
        C.afterLabel,
        C.afterLabelText,
      ),
    );
    layers.push(
      text(look, "hook", 0.4, half, copy.hook, {
        font: F.hook,
        y: 30,
        animation: motion.hook ?? "fade-up",
      }),
    );
    const after = copy.punchline ?? copy.beats[0] ?? null;
    if (after !== null) {
      layers.push(
        text(look, "after-text", r1(half + 0.5), durationSec, after, {
          font: F.punch,
          y: 30,
          animation: motion.punchline ?? "typewriter",
          color: C.punchText,
          stroke: NO_STROKE,
          background: { ...C.punchBox, style: "pill" },
          width: 84,
          exit: "none",
        }),
      );
    }
  }

  layers.push(...logoLayer(look, durationSec));
  layers.push(...music(assets, durationSec));
  const usedBrand = new Set(
    layers.flatMap((l) =>
      (l.kind === "text" || l.kind === "captions") && l.font.family.startsWith("brand:")
        ? [`${l.font.family.slice(6)}:${String(l.font.weight)}`]
        : [],
    ),
  );
  const brandFonts = look.brandFonts.filter((f) =>
    usedBrand.has(`${f.id}:${String(f.weight)}`),
  );
  return {
    version: 1,
    durationSec,
    canvas: { width: 1080, height: 1920 },
    fps: 30,
    ...(plan.language === null ? {} : { language: plan.language }),
    theme,
    ...(brandFonts.length === 0 ? {} : { brandFonts }),
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
