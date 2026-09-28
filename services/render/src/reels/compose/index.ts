/**
 * Compilador `ReelSpec → composición HyperFrames` (`PU-S9-009`).
 *
 * Función **pura**: mismo spec + mismos assets → mismo HTML, byte a byte (lo
 * fija el snapshot de `compose.test.ts`). No lee disco ni red: quien llama
 * resuelve cada capa a una URL/ruta (`CompileAssets`) — el render le pasa
 * rutas relativas del proyecto temporal; la preview, URLs firmadas y data URIs.
 * Así la preview del editor es **esta misma** composición.
 *
 * Contrato de HyperFrames que se respeta acá (skill `hyperframes-core`):
 *  · raíz `data-composition-id` + `data-width/height/duration`, sin timeline
 *    GSAP → `data-no-timeline` (si no, el productor espera 45 s por uno);
 *  · cada capa visible es un clip de primer nivel (`data-start`/`data-duration`,
 *    `class="clip"`); los `<video>` llevan su propio tiempo y viven dentro de
 *    un contenedor **sin** tiempo (un video dentro de un nodo con tiempo sale
 *    con frames equivocados: `video_nested_in_timed_element`);
 *  · el audio es siempre un `<audio id>` aparte, aunque salga del mismo archivo
 *    que el video (el `<video>` va mudo);
 *  · animaciones con Web Animations API (ver `motion.ts`).
 */
import type {
  ReelAudioLayer,
  ReelBackgroundLayer,
  ReelCaptionWord,
  ReelCaptionsLayer,
  ReelClipLayer,
  ReelImageLayer,
  ReelLayer,
  ReelRect,
  ReelSpec,
  ReelTextLayer,
} from "../spec.js";
import {
  automationFor,
  envelopePoints,
  mergeIntervals,
  segmentsOf,
  type Interval,
} from "./audio.js";
import { chunkCaptions } from "./captions.js";
import {
  cssString,
  escapeAttr,
  escapeHtml,
  jsonForScript,
  ms,
  num,
  rgba,
} from "./html.js";
import {
  animatesWords,
  blockEntrance,
  EASE_OUT,
  exitFade,
  kenBurns,
  typewriter,
  wordEntrance,
  type MotionEntry,
} from "./motion.js";
import {
  backgroundWindows,
  flashMotion,
  flashWindow,
  transitionIn,
} from "./transitions.js";

export const REEL_COMPOSITION_ID = "fastgram-reel";
/** `FR-051`/`FR-070`: unidades de editor × `canvas.width / 360`. */
const EDITOR_REFERENCE_WIDTH = 360;
/** Mismo factor que el render de texto de los formatos base (`textLayer.ts`). */
const BACKGROUND_PADDING_RATIO = 0.35;
/** Por encima de cualquier `z` del spec (0–99). */
const FLASH_Z = 1000;

export interface ResolvedMedia {
  /** Lo que va en `src`: ruta relativa del proyecto, URL firmada o data URI. */
  readonly src: string;
  /** Duración de la fuente, si se conoce (para los loops). */
  readonly durationSec: number | null;
  readonly hasAudio: boolean;
}

export interface CompileAssets {
  /** Capa → lo que se ve (para un clip con croma, el webm con alfa). */
  readonly visual: ReadonlyMap<string, ResolvedMedia>;
  /** Capa → de dónde sale el sonido (el archivo original del clip, o el audio). */
  readonly sound: ReadonlyMap<string, ResolvedMedia>;
  /** `familia-peso` → `src` del archivo de fuente. */
  readonly fonts: ReadonlyMap<string, string>;
  /** Capa de subtítulos → palabras (dadas por el spec o transcriptas). */
  readonly captions: ReadonlyMap<string, readonly ReelCaptionWord[]>;
}

export interface CompileOptions {
  /** HTML extra en `<head>` (la preview inyecta el runtime de HyperFrames). */
  readonly extraHead?: string;
}

export interface CompiledReel {
  readonly html: string;
  readonly durationSec: number;
  readonly warnings: readonly string[];
}

/** Las fuentes (`familia-peso`) que usa el spec, en orden estable. */
export function requiredFonts(spec: Pick<ReelSpec, "layers">): string[] {
  const keys = new Set<string>();
  for (const layer of spec.layers) {
    if (layer.kind === "text" || layer.kind === "captions") {
      keys.add(fontKey(layer.font.family, layer.font.weight));
    }
  }
  return [...keys].sort();
}

export function fontKey(family: string, weight: number): string {
  return `${family}-${String(weight)}`;
}

/**
 * El nombre CSS de una familia. Las de marca (`brand:<id>`) pierden el `:`:
 * el id ya es `[a-z0-9-]`, así que `fg-brand-<id>` no choca con ninguna de las
 * 12 y no hay nada que escapar dentro de `style="…"`.
 */
const cssFamily = (family: string): string => `fg-${family.replace(":", "-")}`;

function px(units: number): number {
  return Math.round((units * 1080) / EDITOR_REFERENCE_WIDTH);
}

/** Rect de media (% del lienzo, centro) → caja en px. */
function rectPx(rect: ReelRect, W: number, H: number): string {
  const w = (rect.width * W) / 100;
  const h = (rect.height * H) / 100;
  const left = (rect.x * W) / 100 - w / 2;
  const top = (rect.y * H) / 100 - h / 2;
  return `left:${num(left, 1)}px;top:${num(top, 1)}px;width:${num(w, 1)}px;height:${num(h, 1)}px`;
}

function timed(start: number, end: number, track: number): string {
  return `data-start="${num(start)}" data-duration="${num(end - start)}" data-track-index="${String(track)}"`;
}

interface Ctx {
  readonly spec: ReelSpec;
  readonly assets: CompileAssets;
  readonly motion: MotionEntry[];
  readonly warnings: string[];
  track: number;
}

function nextTrack(ctx: Ctx): number {
  ctx.track += 1;
  return ctx.track;
}

// ── fondos ─────────────────────────────────────────────────────────────────

function backgroundNode(
  ctx: Ctx,
  layer: ReelBackgroundLayer,
  window: { start: number; end: number },
): string {
  const id = `L-${layer.id}`;
  const fill = layer.fill;
  const inner = `#${id} .bgin`;
  if (fill.type === "video") {
    // Video: contenedor sin tiempo (animable) con los `<video>` con tiempo adentro.
    const media = ctx.assets.visual.get(layer.id);
    if (media === undefined) {
      ctx.warnings.push(`background ${layer.id}: missing media, skipped`);
      return "";
    }
    ctx.motion.push(
      ...transitionIn(
        layer.transitionIn.kind,
        `#${id}`,
        layer.start,
        layer.transitionIn.durationSec,
      ),
    );
    const videos = segmentsOf(
      window.start,
      window.end,
      fill.mediaStartSec,
      media.durationSec,
      true,
    )
      .map(
        (seg, i) =>
          `<video id="${id}-v${String(i)}" src="${escapeAttr(media.src)}" ${timed(seg.start, seg.end, nextTrack(ctx))} data-media-start="${num(seg.mediaStart)}" muted playsinline class="fill-media" style="object-fit:cover"></video>`,
      )
      .join("");
    return `<div id="${id}" class="vwrap" style="left:0;top:0;width:100%;height:100%;z-index:${String(layer.z)}">${videos}</div>`;
  }

  ctx.motion.push(
    ...transitionIn(
      layer.transitionIn.kind,
      inner,
      layer.start,
      layer.transitionIn.durationSec,
    ),
  );
  let body: string;
  if (fill.type === "color") {
    body = `<div class="bgin" style="background:${fill.color}"></div>`;
  } else if (fill.type === "gradient") {
    body = `<div class="bgin" style="background:linear-gradient(${num(fill.angle, 1)}deg,${fill.from},${fill.to})"></div>`;
  } else {
    const media = ctx.assets.visual.get(layer.id);
    if (media === undefined) {
      ctx.warnings.push(`background ${layer.id}: missing media, skipped`);
      return "";
    }
    if (fill.motion === "ken-burns") {
      ctx.motion.push(kenBurns(`#${id} .bgimg`, window.start, window.end - window.start));
    }
    body = `<div class="bgin"><img class="bgimg" src="${escapeAttr(media.src)}" alt=""/></div>`;
  }
  return `<div id="${id}" class="clip layer" ${timed(window.start, window.end, nextTrack(ctx))} style="z-index:${String(layer.z)}">${body}</div>`;
}

// ── clips y fotos ──────────────────────────────────────────────────────────

function clipNode(ctx: Ctx, layer: ReelClipLayer, W: number, H: number): string {
  const id = `L-${layer.id}`;
  const media = ctx.assets.visual.get(layer.id);
  if (media === undefined) {
    ctx.warnings.push(`clip ${layer.id}: missing media, skipped`);
    return "";
  }
  const videos = segmentsOf(
    layer.start,
    layer.end,
    layer.mediaStartSec,
    media.durationSec,
    layer.loop,
  )
    .map(
      (seg, i) =>
        `<video id="${id}-v${String(i)}" src="${escapeAttr(media.src)}" ${timed(seg.start, seg.end, nextTrack(ctx))} data-media-start="${num(seg.mediaStart)}" muted playsinline class="fill-media" style="object-fit:${layer.fit}"></video>`,
    )
    .join("");
  return `<div id="${id}" class="vwrap" style="${rectPx(layer.rect, W, H)};z-index:${String(layer.z)}">${videos}</div>`;
}

function imageNode(ctx: Ctx, layer: ReelImageLayer, W: number, H: number): string {
  const id = `L-${layer.id}`;
  const media = ctx.assets.visual.get(layer.id);
  if (media === undefined) {
    ctx.warnings.push(`image ${layer.id}: missing media, skipped`);
    return "";
  }
  const sec = layer.end - layer.start;
  ctx.motion.push(...blockEntrance(layer.animation, `#${id} .min`, layer.start, sec));
  if (layer.exit === "fade") ctx.motion.push(...exitFade(`#${id} .mbox`, layer.end, sec));
  return (
    `<div id="${id}" class="clip layer" ${timed(layer.start, layer.end, nextTrack(ctx))} style="z-index:${String(layer.z)}">` +
    `<div class="mbox" style="${rectPx(layer.rect, W, H)}"><div class="min">` +
    `<img src="${escapeAttr(media.src)}" alt="" style="object-fit:${layer.fit}"/></div></div></div>`
  );
}

// ── texto ──────────────────────────────────────────────────────────────────

function textNode(ctx: Ctx, layer: ReelTextLayer, W: number, H: number): string {
  const id = `L-${layer.id}`;
  const sec = layer.end - layer.start;
  const fontPx = px(layer.font.size);
  const strokePx = px(layer.stroke.width);
  const width = (layer.widthPercent * W) / 100;
  const left = (layer.position.x * W) / 100 - width / 2;
  const top = (layer.position.y * H) / 100;

  const boxStyle = [
    `left:${num(left, 1)}px`,
    `top:${num(top, 1)}px`,
    `width:${num(width, 1)}px`,
    `font-family:'${cssFamily(layer.font.family)}'`,
    `font-weight:${String(layer.font.weight)}`,
    `font-size:${String(fontPx)}px`,
    `color:${layer.color}`,
    ...(strokePx > 0
      ? [`-webkit-text-stroke:${String(strokePx * 2)}px ${layer.stroke.color}`]
      : []),
  ].join(";");

  const bg = layer.background;
  const pad = Math.round(fontPx * BACKGROUND_PADDING_RATIO);
  const tinStyle =
    bg !== null && bg.style === "full-width"
      ? ` style="background:${rgba(bg.color, bg.opacity)};padding:${String(Math.round(pad / 2))}px ${String(pad)}px;border-radius:${String(Math.round(pad / 2))}px"`
      : "";
  const lineStyles: string[] = [];
  let boxLineHeight: string | null = null;
  if (bg !== null && bg.style === "pill") {
    // Con 1,15 el fondo de un renglón pisa el del siguiente (el fondo inline
    // cubre ascendente + descendente, que en estas fuentes pasa de 1,2 em).
    boxLineHeight = "1.6";
    lineStyles.push(
      `background-color:${rgba(bg.color, bg.opacity)}`,
      `padding:${String(Math.round(pad / 3))}px ${String(pad)}px`,
      `border-radius:${String(pad)}px`,
    );
  }
  if (layer.animation === "highlight-sweep") {
    const hl = layer.highlightColor ?? ctx.spec.theme.accent;
    lineStyles.push(
      `background-image:linear-gradient(${hl},${hl})`,
      "background-repeat:no-repeat",
      "background-size:100% 100%",
      `padding:0 ${String(Math.round(pad / 2))}px`,
    );
  }
  const lineStyle = lineStyles.length > 0 ? ` style="${lineStyles.join(";")}"` : "";
  const fullBoxStyle =
    boxLineHeight === null ? boxStyle : `${boxStyle};line-height:${boxLineHeight}`;

  // Palabras o letras sueltas sólo si la animación las usa: menos nodos por frame.
  let content: string;
  const tokens = layer.text.split(/(\s+)/).filter((t) => t !== "");
  const space = (t: string): string => (t.includes("\n") ? "\n" : " ");
  if (animatesWords(layer.animation)) {
    const selectors: string[] = [];
    content = tokens
      .map((tok) => {
        if (/^\s+$/.test(tok)) return space(tok);
        const wid = `${id}-w${String(selectors.length)}`;
        selectors.push(`#${wid}`);
        return `<span class="w" id="${wid}">${escapeHtml(tok)}</span>`;
      })
      .join("");
    ctx.motion.push(
      ...wordEntrance(
        layer.animation as "word-by-word" | "kinetic-bounce",
        selectors,
        layer.start,
        sec,
      ),
    );
  } else if (layer.animation === "typewriter") {
    const selectors: string[] = [];
    content = tokens
      .map((tok) => {
        if (/^\s+$/.test(tok)) return space(tok);
        return Array.from(tok)
          .map((ch) => {
            const cid = `${id}-c${String(selectors.length)}`;
            selectors.push(`#${cid}`);
            return `<span class="ch" id="${cid}">${escapeHtml(ch)}</span>`;
          })
          .join("");
      })
      .join("");
    ctx.motion.push(...typewriter(selectors, layer.start, sec));
  } else {
    content = tokens
      .map((tok) => (/^\s+$/.test(tok) ? space(tok) : escapeHtml(tok)))
      .join("");
    ctx.motion.push(...blockEntrance(layer.animation, `#${id} .tin`, layer.start, sec));
  }
  if (layer.exit === "fade") ctx.motion.push(...exitFade(`#${id} .tbox`, layer.end, sec));

  return (
    `<div id="${id}" class="clip layer" ${timed(layer.start, layer.end, nextTrack(ctx))} style="z-index:${String(layer.z)}">` +
    `<div class="tbox" style="${fullBoxStyle}"><div class="tin"${tinStyle}>` +
    `<span class="tline"${lineStyle}>${content}</span></div></div></div>`
  );
}

// ── subtítulos ─────────────────────────────────────────────────────────────

function captionNodes(ctx: Ctx, layer: ReelCaptionsLayer): string {
  const words = ctx.assets.captions.get(layer.id) ?? layer.words ?? [];
  const chunks = chunkCaptions(words, layer.wordsPerChunk, layer.start, layer.end);
  if (chunks.length === 0) return "";
  const fontPx = px(layer.font.size);
  const strokePx = layer.style === "clean" ? 0 : px(layer.stroke.width);
  const boxStyle = [
    `top:${num(layer.positionY, 2)}%`,
    `font-family:'${cssFamily(layer.font.family)}'`,
    `font-weight:${String(layer.font.weight)}`,
    `font-size:${String(fontPx)}px`,
    `color:${layer.color}`,
    ...(layer.style === "bold-pop" ? ["text-transform:uppercase"] : []),
    ...(strokePx > 0
      ? [`-webkit-text-stroke:${String(strokePx * 2)}px ${layer.stroke.color}`]
      : []),
  ].join(";");
  const pad = Math.round(fontPx * BACKGROUND_PADDING_RATIO);
  const cinStyle =
    layer.style === "clean"
      ? ` style="background:rgba(0,0,0,0.55);padding:${String(Math.round(pad / 2))}px ${String(pad)}px;border-radius:${String(pad)}px"`
      : "";

  return chunks
    .map((chunk, i) => {
      const cid = `L-${layer.id}-k${String(i)}`;
      ctx.motion.push({
        s: `#${cid} .cin`,
        k: [
          { opacity: 0, transform: "scale(0.85)" },
          { opacity: 1, transform: "scale(1)" },
        ],
        t: ms(chunk.start),
        d: ms(Math.min(0.12, (chunk.end - chunk.start) / 2)),
        e: EASE_OUT,
        f: "both",
      });
      const spans = chunk.words
        .map((w, j) => {
          const wid = `${cid}-w${String(j)}`;
          const until = layer.style === "karaoke" ? chunk.end : w.end;
          const dur = Math.max(0.05, Math.min(until, chunk.end) - w.start);
          ctx.motion.push({
            s: `#${wid}`,
            k:
              layer.style === "bold-pop"
                ? [
                    { color: layer.activeColor, transform: "scale(1.14)", offset: 0 },
                    { color: layer.activeColor, transform: "scale(1)", offset: 0.35 },
                    { color: layer.activeColor, transform: "scale(1)", offset: 1 },
                  ]
                : [{ color: layer.activeColor }, { color: layer.activeColor }],
            t: ms(w.start),
            d: ms(dur),
            e: "linear",
            // `none`: fuera de la palabra vuelve al color base (bold-pop, clean);
            // karaoke la deja pintada hasta que se va el renglón.
            f: "none",
          });
          return `<span class="cw" id="${wid}">${escapeHtml(w.text)}</span>`;
        })
        .join(" ");
      return (
        `<div id="${cid}" class="clip layer" ${timed(chunk.start, chunk.end, nextTrack(ctx))} style="z-index:${String(layer.z)}">` +
        `<div class="cbox" style="${boxStyle}"><div class="cin"${cinStyle}>${spans}</div></div></div>`
      );
    })
    .join("");
}

// ── audio ──────────────────────────────────────────────────────────────────

/** Tramos donde hay habla: clips con volumen y sonido, y la voz. */
function speechIntervals(ctx: Ctx): Interval[] {
  const out: Interval[] = [];
  for (const layer of ctx.spec.layers) {
    if (
      layer.kind === "clip" &&
      layer.volume > 0 &&
      ctx.assets.sound.get(layer.id)?.hasAudio === true
    ) {
      out.push({ start: layer.start, end: layer.end });
    }
    if (layer.kind === "audio" && layer.role === "voice" && layer.volume > 0) {
      out.push({ start: layer.start, end: layer.end });
    }
  }
  return mergeIntervals(out);
}

function audioNodes(
  ctx: Ctx,
  layerId: string,
  media: { src: string; durationSec: number | null },
  window: { start: number; end: number; mediaStartSec: number; loop: boolean },
  envelope: {
    volume: number;
    fadeInSec: number;
    fadeOutSec: number;
    ducks: readonly Interval[];
    duckLevel: number;
  },
): string {
  const points = envelopePoints({ start: window.start, end: window.end, ...envelope });
  return segmentsOf(
    window.start,
    window.end,
    window.mediaStartSec,
    media.durationSec,
    window.loop,
  )
    .map((seg, i) => {
      const lane = automationFor(points, seg.start, seg.end);
      const volume = lane === null ? num(envelope.volume, 3) : "1";
      return (
        `<audio id="A-${layerId}-${String(i)}" src="${escapeAttr(media.src)}" ${timed(seg.start, seg.end, nextTrack(ctx))} ` +
        `data-media-start="${num(seg.mediaStart)}" data-volume="${volume}"` +
        // El carril es JSON de números y claves fijas: no trae `'` ni `<`.
        (lane === null ? "" : ` data-automation='${lane}'`) +
        `></audio>`
      );
    })
    .join("");
}

function soundNodes(ctx: Ctx): string {
  const ducks = ctx.spec.mix.duckMusic ? speechIntervals(ctx) : [];
  let html = "";
  for (const layer of ctx.spec.layers) {
    if (layer.kind === "clip") {
      const sound = ctx.assets.sound.get(layer.id);
      if (sound === undefined || !sound.hasAudio || layer.volume <= 0) continue;
      html += audioNodes(
        ctx,
        layer.id,
        sound,
        {
          start: layer.start,
          end: layer.end,
          mediaStartSec: layer.mediaStartSec,
          loop: layer.loop,
        },
        { volume: layer.volume, fadeInSec: 0, fadeOutSec: 0, ducks: [], duckLevel: 1 },
      );
    } else if (layer.kind === "audio") {
      html += audioLayerNodes(ctx, layer, layer.role === "music" ? ducks : []);
    }
  }
  return html;
}

function audioLayerNodes(
  ctx: Ctx,
  layer: ReelAudioLayer,
  ducks: readonly Interval[],
): string {
  const sound = ctx.assets.sound.get(layer.id);
  if (sound === undefined) {
    ctx.warnings.push(`audio ${layer.id}: missing media, skipped`);
    return "";
  }
  return audioNodes(
    ctx,
    layer.id,
    sound,
    {
      start: layer.start,
      end: layer.end,
      mediaStartSec: layer.mediaStartSec,
      loop: layer.loop,
    },
    {
      volume: layer.volume,
      fadeInSec: layer.fadeInSec,
      fadeOutSec: layer.fadeOutSec,
      ducks,
      duckLevel: ctx.spec.mix.duckLevel,
    },
  );
}

// ── documento ──────────────────────────────────────────────────────────────

const BASE_CSS = [
  "html,body{margin:0;padding:0;background:#000}",
  "#root{position:relative;width:100%;height:100%;overflow:hidden}",
  ".layer{position:absolute;left:0;top:0;width:100%;height:100%}",
  ".vwrap{position:absolute;overflow:hidden}",
  ".fill-media{position:absolute;left:0;top:0;width:100%;height:100%}",
  ".bgin{position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden}",
  ".bgimg{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;display:block}",
  ".mbox{position:absolute}",
  ".min{width:100%;height:100%}",
  ".min img{width:100%;height:100%;display:block}",
  ".tbox{position:absolute;transform:translateY(-50%);text-align:center;line-height:1.15;paint-order:stroke fill;overflow-wrap:break-word}",
  ".tin{display:block}",
  ".tline{white-space:pre-line;-webkit-box-decoration-break:clone;box-decoration-break:clone}",
  ".w{display:inline-block}",
  ".cbox{position:absolute;left:5%;width:90%;transform:translateY(-50%);text-align:center;line-height:1.1;paint-order:stroke fill}",
  ".cin{display:inline-block}",
  ".cw{display:inline-block;margin:0 0.1em}",
  ".fx-flash{background:#fff}",
].join("\n");

/** El único script de la composición: convierte la lista de movimiento en WAAPI. */
const MOTION_RUNNER =
  "(function(){var M=JSON.parse(document.getElementById('fg-motion').textContent);" +
  "for(var i=0;i<M.length;i++){var m=M[i];var els=document.querySelectorAll(m.s);" +
  "for(var j=0;j<els.length;j++){els[j].animate(m.k,{duration:m.d,delay:m.t,easing:m.e,fill:m.f,iterations:1}).pause();}}})();";

function fontFaces(
  spec: ReelSpec,
  fonts: ReadonlyMap<string, string>,
  warnings: string[],
): string {
  return requiredFonts(spec)
    .map((key) => {
      const src = fonts.get(key);
      const cut = key.lastIndexOf("-");
      const family = key.slice(0, cut);
      const weight = key.slice(cut + 1);
      if (src === undefined) {
        warnings.push(`font ${key}: file not available, the browser falls back`);
        return "";
      }
      if (family.startsWith("brand:")) {
        // Sin `format()`: un OTF con curvas CFF no es «truetype» y Chrome
        // decide por el contenido. El estilo, el de la cara que vino.
        const id = family.slice("brand:".length);
        const face =
          (spec.brandFonts ?? []).find(
            (f) => f.id === id && String(f.weight) === weight && f.style === "normal",
          ) ?? (spec.brandFonts ?? []).find((f) => f.id === id && String(f.weight) === weight);
        return `@font-face{font-family:"${cssFamily(family)}";src:url("${cssString(src)}");font-weight:${weight};font-style:${face?.style ?? "normal"};font-display:block}`;
      }
      return `@font-face{font-family:"${cssFamily(family)}";src:url("${cssString(src)}") format("truetype");font-weight:${weight};font-style:normal;font-display:block}`;
    })
    .join("\n");
}

function orderOf(layer: ReelLayer): number {
  return layer.kind === "audio" ? -1 : layer.z;
}

export function compileReel(
  spec: ReelSpec,
  assets: CompileAssets,
  options: CompileOptions = {},
): CompiledReel {
  const W = spec.canvas.width;
  const H = spec.canvas.height;
  const ctx: Ctx = { spec, assets, motion: [], warnings: [], track: -1 };

  const backgrounds = spec.layers.filter(
    (l): l is ReelBackgroundLayer => l.kind === "background",
  );
  const windows = backgroundWindows(backgrounds, spec.durationSec);

  // Orden del DOM = orden de apilado: por `z` y, a igual `z`, por orden del spec.
  const visual = spec.layers
    .map((layer, index) => ({ layer, index }))
    .filter(({ layer }) => layer.kind !== "audio")
    .sort((a, b) => orderOf(a.layer) - orderOf(b.layer) || a.index - b.index);

  let body = "";
  const flashes: string[] = [];
  for (const { layer } of visual) {
    switch (layer.kind) {
      case "background": {
        const window = windows.get(layer.id) ?? { start: layer.start, end: layer.end };
        body += backgroundNode(ctx, layer, window);
        if (layer.transitionIn.kind === "flash" && layer.start > 0) {
          const fw = flashWindow(
            layer.start,
            layer.transitionIn.durationSec,
            spec.durationSec,
          );
          const fid = `FX-${layer.id}`;
          ctx.motion.push(flashMotion(`#${fid}`, fw));
          flashes.push(
            `<div id="${fid}" class="clip layer fx-flash" ${timed(fw.start, fw.end, nextTrack(ctx))} style="z-index:${String(FLASH_Z)}"></div>`,
          );
        }
        break;
      }
      case "clip":
        body += clipNode(ctx, layer, W, H);
        break;
      case "image":
        body += imageNode(ctx, layer, W, H);
        break;
      case "text":
        body += textNode(ctx, layer, W, H);
        break;
      case "captions":
        body += captionNodes(ctx, layer);
        break;
      case "audio":
        break;
    }
  }
  body += flashes.join("");
  body += soundNodes(ctx);

  const css = [BASE_CSS, fontFaces(spec, assets.fonts, ctx.warnings)]
    .filter((s) => s !== "")
    .join("\n");
  const html =
    `<!doctype html>\n<html lang="${spec.language ?? "en"}"><head><meta charset="UTF-8"/>` +
    `<meta name="viewport" content="width=${String(W)}, height=${String(H)}"/>` +
    `<title>FastGram reel</title>` +
    (options.extraHead ?? "") +
    // El lienzo fijo también en `html/body`: en el render el productor fija el
    // viewport, pero en el iframe del editor la raíz al 100 % colapsaba.
    `<style>\nhtml,body{width:${String(W)}px;height:${String(H)}px;overflow:hidden}\n${css}\n</style></head><body>\n` +
    `<div id="root" data-composition-id="${REEL_COMPOSITION_ID}" data-no-timeline data-start="0" ` +
    `data-width="${String(W)}" data-height="${String(H)}" data-duration="${num(spec.durationSec)}" data-fps="${String(spec.fps)}" ` +
    `style="background:${spec.theme.background}">\n${body}\n</div>\n` +
    `<script type="application/json" id="fg-motion">${jsonForScript(ctx.motion)}</script>\n` +
    `<script>${MOTION_RUNNER}</script>\n</body></html>\n`;

  return { html, durationSec: spec.durationSec, warnings: ctx.warnings };
}
